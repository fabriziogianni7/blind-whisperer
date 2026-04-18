import { useCallback, useEffect, useId, useRef, useState } from "react";

const DEFAULT_API = "http://127.0.0.1:8000";
const apiBase = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API).replace(/\/$/, "");

const ONBOARDING_STORAGE_KEY = "blind-whisperer-onboarding-done-v1";
const WAKE_PHRASE = "hey blindr";

/** Avoids duplicate onboarding speech when React Strict Mode mounts twice in development. */
let onboardingPlaybackSessionStarted = false;

type ScenePayload = {
  description: string;
  audio_mime: string;
  audio_base64: string;
};

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

/** Text after the last wake phrase, for command parsing */
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

function getSpeechRecognition(): (new () => SpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const statusId = useId();
  const liveId = useId();
  const voiceStatusId = useId();

  const [whispering, setWhispering] = useState(false);
  const [intervalSec, setIntervalSec] = useState(4);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("Camera idle.");
  const [lastDescription, setLastDescription] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<string>("Checking voice support.");
  const [onboardingDone, setOnboardingDone] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(ONBOARDING_STORAGE_KEY) === "1",
  );

  const whisperingRef = useRef(false);
  const inFlightRef = useRef(false);
  const sceneAudioPlayingRef = useRef(false);
  const voiceListenEnabledRef = useRef(false);

  useEffect(() => {
    whisperingRef.current = whispering;
  }, [whispering]);

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
      "To start hands-free, say: hey blindr, then start watching.",
      "To stop, say: hey blindr, stop.",
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

  const restartRecognitionIfNeeded = useCallback(() => {
    const Rec = getSpeechRecognition();
    const rec = recognitionRef.current;
    if (!Rec || !rec || !voiceListenEnabledRef.current || sceneAudioPlayingRef.current) return;
    try {
      rec.start();
    } catch {
      /* already started */
    }
  }, []);

  const stopRecognitionSafe = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      /* noop */
    }
  }, []);

  const playBase64Audio = useCallback(
    async (mime: string, b64: string) => {
      const el = audioRef.current;
      if (!el) return;
      el.pause();
      sceneAudioPlayingRef.current = true;
      stopRecognitionSafe();
      speakUi("Playing scene description.");

      const url = `data:${mime};base64,${b64}`;
      el.src = url;

      await new Promise<void>((resolve, reject) => {
        el.onended = () => resolve();
        el.onerror = () => reject(new Error("Audio playback failed"));
        el.play().catch(reject);
      }).catch(() => {
        setApiError("Audio was blocked by the browser. Tap the page once and try again.");
      });

      sceneAudioPlayingRef.current = false;
      speakUi("Listening for: hey blindr, then start or stop.");
      restartRecognitionIfNeeded();
    },
    [restartRecognitionIfNeeded, speakUi, stopRecognitionSafe],
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

  const sendFrame = useCallback(async () => {
    if (!whisperingRef.current || inFlightRef.current) return;
    const blob = await captureFrameBlob();
    if (!blob) {
      setStatusMessage("Waiting for camera frames.");
      return;
    }
    inFlightRef.current = true;
    setStatusMessage("Sending snapshot and generating speech.");
    setApiError(null);
    const form = new FormData();
    form.append("image", blob, "frame.jpg");
    try {
      const res = await fetch(`${apiBase}/api/scene`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Request failed (${res.status})`);
      }
      const data = (await res.json()) as ScenePayload;
      if (!whisperingRef.current) return;
      setLastDescription(data.description);
      setStatusMessage("Playing whisper.");
      await playBase64Audio(data.audio_mime || "audio/mpeg", data.audio_base64);
      setStatusMessage("Next snapshot on interval.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setApiError(msg);
      setStatusMessage("Error while describing scene.");
    } finally {
      inFlightRef.current = false;
    }
  }, [captureFrameBlob, playBase64Audio]);

  useEffect(() => {
    if (!whispering) return;

    let stream: MediaStream | null = null;
    let timer: number | undefined;

    const start = async () => {
      setCameraError(null);
      setApiError(null);
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
      if (video) {
        video.srcObject = null;
      }
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [whispering, intervalSec, sendFrame]);

  const startWhisper = useCallback(() => {
    setWhispering(true);
  }, []);

  const stopWhisper = useCallback(() => {
    setWhispering(false);
    setStatusMessage("Whispering stopped.");
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
    }
    sceneAudioPlayingRef.current = false;
    restartRecognitionIfNeeded();
  }, [restartRecognitionIfNeeded]);

  useEffect(() => {
    if (whispering) {
      stopRef.current?.focus();
    }
  }, [whispering]);

  const handleVoiceTranscript = useCallback(
    (raw: string) => {
      const normalized = normalizeSpeechText(raw);
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
          "I did not understand. Say hey blindr, then start watching, or hey blindr, stop.",
        );
      }
    },
    [speakError, speakUi, startWhisper, stopWhisper],
  );

  useEffect(() => {
    const Rec = getSpeechRecognition();
    if (!Rec) {
      voiceListenEnabledRef.current = false;
      setVoiceStatus(
        "Voice commands need a browser with speech recognition (for example Chrome with HTTPS). Buttons still work.",
      );
      return;
    }

    if (!onboardingDone) {
      voiceListenEnabledRef.current = false;
      return;
    }

    const rec = new Rec();
    recognitionRef.current = rec;
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;

    voiceListenEnabledRef.current = true;
    setVoiceStatus("Listening for: hey blindr, then start or stop.");

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let said = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        said += event.results[i][0].transcript;
      }
      if (said.trim()) handleVoiceTranscript(said);
    };

    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "not-allowed") {
        setVoiceStatus("Microphone denied. Allow mic for voice commands, or use buttons.");
      } else if (event.error !== "aborted" && event.error !== "no-speech") {
        setVoiceStatus(`Voice recognition paused (${event.error}). Will retry.`);
      }
    };

    rec.onend = () => {
      if (voiceListenEnabledRef.current && !sceneAudioPlayingRef.current) {
        try {
          rec.start();
        } catch {
          /* ignore */
        }
      }
    };

    try {
      rec.start();
    } catch {
      setVoiceStatus("Could not start voice recognition. Use buttons to control the app.");
    }

    return () => {
      voiceListenEnabledRef.current = false;
      try {
        rec.abort();
      } catch {
        try {
          rec.stop();
        } catch {
          /* noop */
        }
      }
      recognitionRef.current = null;
    };
  }, [handleVoiceTranscript, onboardingDone]);

  const replayOnboarding = useCallback(() => {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    onboardingPlaybackSessionStarted = false;
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    setOnboardingDone(false);
  }, []);

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
            spaces. Say <span className="nowrap">{WAKE_PHRASE}</span>, then{" "}
            <span className="nowrap">start watching</span> or <span className="nowrap">stop</span>.
          </p>
        </header>

        <main id="main" tabIndex={-1}>
          <section className="panel" aria-labelledby="voice-heading">
            <h2 id="voice-heading">Voice</h2>
            <p id={voiceStatusId} role="status" aria-live="polite" className="transcript" style={{ marginTop: 0 }}>
              {voiceStatus}
            </p>
            <p className="help-text">
              Web Speech API is used for commands (offline in many browsers). Requires a secure
              context (HTTPS or localhost). Speech recognition may send audio to your browser
              vendor; see your browser documentation.
            </p>
            <div className="controls">
              <button type="button" className="btn-ghost" onClick={replayOnboarding}>
                Replay spoken onboarding
              </button>
            </div>
          </section>

          <section className="panel" aria-labelledby="camera-heading">
            <h2 id="camera-heading">Camera</h2>
            <p id={statusId} role="status" aria-live="polite" className="transcript" style={{ marginTop: 0 }}>
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
          </section>
        </main>

        <audio ref={audioRef} className="visually-hidden" />
      </div>
    </>
  );
}
