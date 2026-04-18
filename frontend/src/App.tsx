import { useCallback, useEffect, useId, useRef, useState } from "react";

const DEFAULT_API = "http://127.0.0.1:8000";
const apiBase = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API).replace(/\/$/, "");

const ONBOARDING_STORAGE_KEY = "blind-whisperer-onboarding-done-v1";
const WAKE_PHRASE = "hey blindr";

/** Avoids duplicate onboarding speech when React Strict Mode mounts twice in development. */
let onboardingPlaybackSessionStarted = false;

const MAX_HISTORY = 12; // 6 user + 6 assistant turns
const GRACE_MS = 3000; // suppress auto-capture for this long after a barge-in

type ScenePayload = {
  description: string;
  audio_mime: string;
  audio_base64: string;
  speak: boolean;
};

type Turn = { role: "user" | "assistant"; text: string };

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives?: number;
  onresult: ((ev: { resultIndex?: number; results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }> }) => void) | null;
  onspeechstart: (() => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function normalizeSpeechText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function transcriptHasWakePhrase(normalized: string): boolean {
  return normalized.includes(WAKE_PHRASE);
}

function textAfterWakePhrase(normalized: string): string {
  const idx = normalized.lastIndexOf(WAKE_PHRASE);
  if (idx === -1) return "";
  return normalized.slice(idx + WAKE_PHRASE.length).trim();
}

function parseVoiceIntent(normalizedFull: string): "start" | "stop" | null {
  if (!transcriptHasWakePhrase(normalizedFull)) return null;
  const tail = textAfterWakePhrase(normalizedFull);
  const cmd = tail.length > 0 ? tail : normalizedFull;

  if (/\b(stop|halt)(\s+watching)?\b/.test(cmd)) return "stop";
  if (/\b(start|begin)(\s+watching)?\b/.test(cmd)) return "start";
  return null;
}

/** Pause or resume wake listening (not the camera watch session). */
function parseWakeListeningControl(normalizedFull: string): "pause" | "resume" | null {
  if (!transcriptHasWakePhrase(normalizedFull)) return null;
  const tail = textAfterWakePhrase(normalizedFull);
  const cmd = tail.length > 0 ? tail : normalizedFull;

  if (/\b(pause|stop|mute)\s+listening\b/.test(cmd)) return "pause";
  if (/\b(resume|unmute)\s+listening\b/.test(cmd)) return "resume";
  return null;
}

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const wakeRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const bargeRecognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const statusId = useId();
  const liveId = useId();
  const voiceStatusId = useId();

  const [whispering, setWhispering] = useState(false);
  const [intervalSec, setIntervalSec] = useState(5);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("Camera idle.");
  const [lastDescription, setLastDescription] = useState("");
  const [lastHeard, setLastHeard] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<string>("Checking voice support.");
  const [onboardingDone, setOnboardingDone] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(ONBOARDING_STORAGE_KEY) === "1",
  );
  /** When true, wake recognition is off for privacy; user can resume via UI or voice. */
  const [micListeningPaused, setMicListeningPaused] = useState(false);
  /** Browsers may require a user gesture before SpeechRecognition.start(); then show Enable. */
  const [wakeNeedsUserGesture, setWakeNeedsUserGesture] = useState(false);

  const whisperingRef = useRef(false);
  const inFlightRef = useRef(false);
  const historyRef = useRef<Turn[]>([]);
  const pendingQueryRef = useRef<string | null>(null);
  const graceUntilRef = useRef(0);
  const wakeListenEnabledRef = useRef(false);
  const micListeningPausedRef = useRef(false);
  /** Avoids double attach when Resume is clicked (gesture) and the effect runs on the same state. */
  const skipNextWakeEffectAttachRef = useRef(false);
  const onWakeTranscriptRef = useRef<(raw: string) => void>(() => {});

  useEffect(() => {
    whisperingRef.current = whispering;
  }, [whispering]);

  useEffect(() => {
    micListeningPausedRef.current = micListeningPaused;
  }, [micListeningPaused]);

  const speakUi = useCallback((text: string, priority: "polite" | "assertive" = "polite") => {
    setVoiceStatus(text);
    const el = document.getElementById(voiceStatusId);
    if (el) el.setAttribute("aria-live", priority);
  }, [voiceStatusId]);

  const speakError = useCallback(
    (text: string) => {
      speakUi(text, "assertive");
      if (typeof speechSynthesis !== "undefined") {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1;
        speechSynthesis.speak(u);
      }
    },
    [speakUi],
  );

  const playOnboarding = useCallback(() => {
    if (typeof speechSynthesis === "undefined") {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
      setOnboardingDone(true);
      setVoiceStatus("Spoken onboarding unavailable in this browser. Use buttons or another browser.");
      return;
    }
    const script = [
      "Welcome to Blind Whisperer.",
      "This app uses your camera to capture snapshots, sends them to your server for vision understanding, then speaks a short description through Eleven Labs.",
      "Grant camera access when asked so the app can see the scene. For voice commands, your browser may ask for microphone access for speech recognition.",
      "After this message, the microphone stays on for voice commands by default. Say hey blindr, pause listening to stop the microphone, or hey blindr, resume listening to turn it back on. You can also use the pause and resume buttons on screen.",
      "If the browser requires a tap first, use the Enable microphone listening button when it appears.",
      "While watching, you can speak any time to interrupt and ask a question about the scene.",
      "To start hands-free before watching, say: hey blindr, then start watching.",
      "To stop the camera session, say: hey blindr, stop.",
      "Privacy note: camera frames are sent to your server and may be processed by third party services. Use a secure connection in production.",
    ].join(" ");

    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(script);
    utterance.rate = 1;
    utterance.onend = () => {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
      setOnboardingDone(true);
      speakUi("Onboarding finished. Voice commands are active when supported.");
    };
    utterance.onerror = () => {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
      setOnboardingDone(true);
      speakUi("Onboarding audio had an issue. Voice commands may still work.");
    };
    speechSynthesis.speak(utterance);
    speakUi("Playing onboarding guidance.");
  }, [speakUi]);

  useEffect(() => {
    if (onboardingDone) return;
    if (onboardingPlaybackSessionStarted) return;
    onboardingPlaybackSessionStarted = true;
    playOnboarding();
  }, [onboardingDone, playOnboarding]);

  const stopPlayback = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    try {
      el.currentTime = 0;
    } catch {
      /* some browsers throw on empty src */
    }
  }, []);

  const pushTurn = useCallback((role: Turn["role"], text: string) => {
    const next = [...historyRef.current, { role, text }];
    if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
    historyRef.current = next;
  }, []);

  const playBase64Audio = useCallback(
    async (mime: string, b64: string) => {
      const el = audioRef.current;
      if (!el) return;
      el.pause();
      el.src = `data:${mime};base64,${b64}`;
      if (whisperingRef.current) {
        speakUi("Playing scene description.");
      }
      try {
        await el.play();
      } catch {
        setApiError("Audio was blocked by the browser. Tap the page once and try again.");
      }
      if (whisperingRef.current) {
        speakUi("Session active. Speak to ask a question, or say hey blindr, then stop.");
      }
    },
    [speakUi],
  );

  const captureFrameBlob = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return null;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.82);
    });
  }, []);

  const sendFrame = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!whisperingRef.current || inFlightRef.current) return;
      if (!opts?.force && Date.now() < graceUntilRef.current) return;

      const blob = await captureFrameBlob();
      if (!blob) {
        setStatusMessage("Waiting for camera frames.");
        return;
      }

      const query = pendingQueryRef.current;
      pendingQueryRef.current = null;

      inFlightRef.current = true;
      setStatusMessage(query ? `Asking: "${query}"` : "Describing scene.");
      setApiError(null);

      const form = new FormData();
      form.append("image", blob, "frame.jpg");
      form.append("history", JSON.stringify(historyRef.current));
      if (query) form.append("user_query", query);

      try {
        const res = await fetch(`${apiBase}/api/scene`, { method: "POST", body: form });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Request failed (${res.status})`);
        }
        const data = (await res.json()) as ScenePayload;

        if (query) pushTurn("user", query);

        if (data.speak && data.description) {
          pushTurn("assistant", data.description);
          setLastDescription(data.description);
          setStatusMessage("Playing whisper.");
          await playBase64Audio(data.audio_mime || "audio/mpeg", data.audio_base64);
          setStatusMessage("Waiting for next tick.");
        } else {
          setStatusMessage("Scene unchanged.");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        setApiError(msg);
        setStatusMessage("Error while describing scene.");
      } finally {
        inFlightRef.current = false;
      }
    },
    [captureFrameBlob, playBase64Audio, pushTurn],
  );

  const stopWakeRecognitionSafe = useCallback(() => {
    const rec = wakeRecognitionRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      /* noop */
    }
  }, []);

  const abortWakeRecognition = useCallback(() => {
    wakeListenEnabledRef.current = false;
    const rec = wakeRecognitionRef.current;
    wakeRecognitionRef.current = null;
    if (!rec) return;
    try {
      rec.abort();
    } catch {
      try {
        rec.stop();
      } catch {
        /* noop */
      }
    }
  }, []);

  const startWhisper = useCallback(() => {
    setWhispering(true);
  }, []);

  const stopWhisper = useCallback(() => {
    setWhispering(false);
    stopPlayback();
    const el = audioRef.current;
    if (el) {
      try {
        el.removeAttribute("src");
      } catch {
        /* noop */
      }
    }
    setStatusMessage("Whispering stopped.");
    speakUi("Microphone listening is on. Say hey blindr, then start or stop.");
  }, [speakUi, stopPlayback]);

  const pauseMicListening = useCallback(() => {
    setWakeNeedsUserGesture(false);
    abortWakeRecognition();
    setMicListeningPaused(true);
    speakUi(
      "Microphone listening paused. Say hey blindr, resume listening, or use the Resume button.",
    );
  }, [abortWakeRecognition, speakUi]);

  const attachWakeRecognition = useCallback((): boolean => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setWakeNeedsUserGesture(false);
      setVoiceStatus(
        "Voice commands need a browser with speech recognition (for example Chrome with HTTPS). Buttons still work.",
      );
      return false;
    }

    abortWakeRecognition();

    const rec = new Ctor();
    wakeRecognitionRef.current = rec;
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;
    rec.onspeechstart = null;

    rec.onresult = (ev) => {
      const startIdx = typeof ev.resultIndex === "number" ? ev.resultIndex : 0;
      let said = "";
      for (let i = startIdx; i < ev.results.length; i += 1) {
        const r = ev.results[i];
        const alt = r[0];
        if (alt) said += alt.transcript;
      }
      if (said.trim()) onWakeTranscriptRef.current(said);
    };

    rec.onerror = (ev) => {
      if (ev.error === "not-allowed") {
        setWakeNeedsUserGesture(false);
        wakeListenEnabledRef.current = false;
        setVoiceStatus("Microphone denied. Allow mic for voice commands, or use buttons.");
      } else if (ev.error === "service-not-allowed") {
        setWakeNeedsUserGesture(true);
        speakUi("Tap Enable microphone listening to start the microphone.");
      } else if (ev.error !== "aborted" && ev.error !== "no-speech") {
        setVoiceStatus(`Voice recognition issue (${ev.error}).`);
      }
    };

    rec.onend = () => {
      if (
        wakeListenEnabledRef.current &&
        !whisperingRef.current &&
        !micListeningPausedRef.current
      ) {
        try {
          rec.start();
          setWakeNeedsUserGesture(false);
        } catch {
          setWakeNeedsUserGesture(true);
          speakUi("Tap Enable microphone listening to resume.");
        }
      }
    };

    try {
      rec.start();
      wakeListenEnabledRef.current = true;
      setWakeNeedsUserGesture(false);
      setVoiceStatus("Microphone listening is on. Say hey blindr, then start or stop.");
      return true;
    } catch {
      wakeListenEnabledRef.current = false;
      try {
        rec.abort();
      } catch {
        /* noop */
      }
      wakeRecognitionRef.current = null;
      setWakeNeedsUserGesture(true);
      setVoiceStatus(
        "Microphone listening needs a tap or key press in this browser. Tap Enable microphone listening.",
      );
      speakUi(
        "Tap Enable microphone listening. Some browsers require a tap or key press before the microphone can start.",
      );
      return false;
    }
  }, [abortWakeRecognition, speakUi]);

  const resumeMicListening = useCallback(() => {
    skipNextWakeEffectAttachRef.current = true;
    setMicListeningPaused(false);
    void attachWakeRecognition();
  }, [attachWakeRecognition]);

  const resumeMicListeningFromVoice = useCallback(() => {
    speakUi("Resuming microphone listening.");
    resumeMicListening();
  }, [resumeMicListening, speakUi]);

  const handleVoiceTranscript = useCallback(
    (raw: string) => {
      const normalized = normalizeSpeechText(raw);
      const listenCtl = parseWakeListeningControl(normalized);
      if (listenCtl === "pause") {
        pauseMicListening();
        return;
      }
      if (listenCtl === "resume") {
        resumeMicListeningFromVoice();
        return;
      }
      const intent = parseVoiceIntent(normalized);
      if (intent === "start") {
        setApiError(null);
        speakUi("Starting watch.");
        startWhisper();
        return;
      }
      if (intent === "stop") {
        speakUi("Stopping watch.");
        stopWhisper();
        return;
      }
      if (transcriptHasWakePhrase(normalized) && !intent) {
        speakError(
          "I did not understand. Say hey blindr, then start watching, or hey blindr, stop. Say hey blindr, pause listening to mute the microphone.",
        );
      }
    },
    [pauseMicListening, resumeMicListeningFromVoice, speakError, speakUi, startWhisper, stopWhisper],
  );

  useEffect(() => {
    onWakeTranscriptRef.current = handleVoiceTranscript;
  }, [handleVoiceTranscript]);

  const enableMicListeningFromGesture = useCallback(() => {
    void attachWakeRecognition();
  }, [attachWakeRecognition]);

  // Camera + auto-capture loop
  useEffect(() => {
    if (!whispering) return;

    let stream: MediaStream | null = null;
    let timer: number | undefined;

    const start = async () => {
      setCameraError(null);
      setApiError(null);
      historyRef.current = [];
      pendingQueryRef.current = null;
      graceUntilRef.current = 0;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }
        setStatusMessage("Camera on. First snapshot soon.");
        await sendFrame();
        timer = window.setInterval(() => {
          void sendFrame();
        }, Math.max(2, intervalSec) * 1000);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not access camera.";
        setCameraError(msg);
        setWhispering(false);
        setStatusMessage("Camera could not start.");
      }
    };

    void start();

    return () => {
      if (timer) window.clearInterval(timer);
      const video = videoRef.current;
      if (video) video.srcObject = null;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [whispering, intervalSec, sendFrame]);

  // Wake phrase + start/stop when not watching (mic on by default after onboarding)
  useEffect(() => {
    if (!onboardingDone || whispering || micListeningPaused) {
      setWakeNeedsUserGesture(false);
      abortWakeRecognition();
      return;
    }

    if (skipNextWakeEffectAttachRef.current) {
      skipNextWakeEffectAttachRef.current = false;
      return;
    }

    void attachWakeRecognition();

    return () => {
      abortWakeRecognition();
    };
  }, [
    onboardingDone,
    whispering,
    micListeningPaused,
    abortWakeRecognition,
    attachWakeRecognition,
  ]);

  // Barge-in: speech recognition while watching (questions + hey blindr stop)
  useEffect(() => {
    if (!whispering || micListeningPaused) return;

    stopWakeRecognitionSafe();

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setStatusMessage("Voice interrupt unsupported in this browser.");
      return;
    }

    const rec = new Ctor();
    bargeRecognitionRef.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";

    let restartTimer: number | undefined;
    let stopped = false;

    rec.onspeechstart = () => {
      if (!whisperingRef.current) return;
      stopPlayback();
      graceUntilRef.current = Date.now() + GRACE_MS;
      setStatusMessage("Listening to you.");
    };

    rec.onresult = (ev) => {
      if (!whisperingRef.current) return;
      let finalText = "";
      let interim = "";
      for (let i = 0; i < ev.results.length; i += 1) {
        const r = ev.results[i];
        const alt = r[0];
        if (!alt) continue;
        if (r.isFinal) finalText += alt.transcript;
        else interim += alt.transcript;
      }
      if (interim && !finalText) {
        stopPlayback();
        graceUntilRef.current = Date.now() + GRACE_MS;
      }
      if (finalText) {
        const cleaned = finalText.trim();
        if (!cleaned) return;
        setLastHeard(cleaned);
        const normalized = normalizeSpeechText(cleaned);
        if (parseVoiceIntent(normalized) === "stop") {
          stopWhisper();
          return;
        }
        pendingQueryRef.current = cleaned;
        graceUntilRef.current = Date.now() + GRACE_MS;
        void sendFrame({ force: true });
      }
    };

    rec.onerror = (ev) => {
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      setStatusMessage(`Speech recognition error: ${ev.error}`);
    };

    rec.onend = () => {
      if (stopped || !whisperingRef.current) return;
      restartTimer = window.setTimeout(() => {
        try {
          rec.start();
        } catch {
          /* already started or mic denied */
        }
      }, 200);
    };

    try {
      rec.start();
    } catch {
      setStatusMessage("Microphone denied or unavailable.");
    }

    return () => {
      stopped = true;
      if (restartTimer) window.clearTimeout(restartTimer);
      rec.onresult = null;
      rec.onspeechstart = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* noop */
      }
      bargeRecognitionRef.current = null;
    };
  }, [micListeningPaused, whispering, sendFrame, stopPlayback, stopWakeRecognitionSafe, stopWhisper]);

  const replayOnboarding = useCallback(() => {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    onboardingPlaybackSessionStarted = false;
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    setOnboardingDone(false);
  }, []);

  useEffect(() => {
    if (whispering) stopRef.current?.focus();
  }, [whispering]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <div className="app-shell">
        <header>
          <h1>Blind Whisperer</h1>
          <p className="lead">
            Sends camera snapshots to your server for vision plus speech. Use headphones in public
            spaces. After onboarding, the microphone is on for voice commands by default. Before
            watching, say <span className="nowrap">{WAKE_PHRASE}</span>, then{" "}
            <span className="nowrap">start watching</span> or <span className="nowrap">stop</span>.
            Say <span className="nowrap">hey blindr, pause listening</span> or use Pause to mute the
            mic. While watching, speak any time to interrupt and ask a question.
          </p>
        </header>

        <main id="main" tabIndex={-1}>
          <section className="panel" aria-labelledby="voice-heading">
            <h2 id="voice-heading">Voice</h2>
            <p
              id={voiceStatusId}
              role="status"
              aria-live="polite"
              className="transcript"
              style={{ marginTop: 0 }}
            >
              {voiceStatus}
            </p>
            <p className="help-text">
              Web Speech API is used for commands and questions. Requires a secure context (HTTPS or
              localhost). Some browsers only start the microphone after you tap or press a key; use
              Enable microphone listening if it appears. Speech recognition may send audio to your
              browser vendor; see your browser documentation.
            </p>
            <div className="controls">
              {wakeNeedsUserGesture ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={enableMicListeningFromGesture}
                >
                  Enable microphone listening
                </button>
              ) : !micListeningPaused ? (
                <button type="button" className="btn-ghost" onClick={pauseMicListening}>
                  Pause microphone listening
                </button>
              ) : (
                <button type="button" className="btn-primary" onClick={resumeMicListening}>
                  Resume microphone listening
                </button>
              )}
              <button type="button" className="btn-ghost" onClick={replayOnboarding}>
                Replay spoken onboarding
              </button>
            </div>
          </section>

          <section className="panel" aria-labelledby="camera-heading">
            <h2 id="camera-heading">Camera</h2>
            <p
              id={statusId}
              role="status"
              aria-live="polite"
              className="transcript"
              style={{ marginTop: 0 }}
            >
              {statusMessage}
            </p>
            <div className="video-wrap" aria-hidden={!whispering}>
              <video ref={videoRef} playsInline muted />
              <canvas ref={canvasRef} className="visually-hidden" />
            </div>
            <div className="controls">
              {!whispering ? (
                <button type="button" className="btn-primary" onClick={startWhisper}>
                  Start whispering
                </button>
              ) : (
                <button ref={stopRef} type="button" className="btn-danger" onClick={stopWhisper}>
                  Stop whispering
                </button>
              )}
            </div>
            {cameraError ? (
              <p className="error" role="alert">
                {cameraError}
              </p>
            ) : null}
            {apiError ? (
              <p className="error" role="alert">
                {apiError}
              </p>
            ) : null}
          </section>

          <section className="panel" aria-labelledby="settings-heading">
            <h2 id="settings-heading">Timing</h2>
            <div className="field">
              <label htmlFor="interval">Seconds between snapshots</label>
              <input
                id="interval"
                type="number"
                inputMode="numeric"
                min={2}
                max={60}
                value={intervalSec}
                disabled={whispering}
                onChange={(e) => setIntervalSec(Number(e.target.value) || 2)}
              />
              <span className="visually-hidden" aria-live="polite">
                Changes apply when whispering is off.
              </span>
            </div>
          </section>

          <section className="panel" aria-labelledby="speech-heading">
            <h2 id="speech-heading">Last description</h2>
            <div id={liveId} className="live-region" aria-live="polite" aria-atomic="true">
              {lastDescription ? (
                <p className="transcript">{lastDescription}</p>
              ) : (
                <p className="transcript" style={{ color: "var(--muted)" }}>
                  No description yet.
                </p>
              )}
            </div>
            {lastHeard ? (
              <p className="transcript" style={{ color: "var(--muted)" }}>
                Heard: "{lastHeard}"
              </p>
            ) : null}
          </section>
        </main>

        <audio ref={audioRef} className="visually-hidden" />
      </div>
    </>
  );
}
