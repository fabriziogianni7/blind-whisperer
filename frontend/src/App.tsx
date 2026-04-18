import { useCallback, useEffect, useId, useRef, useState } from "react";

// Default to same-origin so Vite's /api proxy (see vite.config.ts) handles local dev and ngrok
// tunnels without CORS. Override with VITE_API_BASE_URL only when hitting a remote backend.
const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

const ONBOARDING_STORAGE_KEY = "blind-whisperer-onboarding-done-v1";
// Speech recognizers mishear the coined word "blindr". Accept common substitutions
// produced by Chrome/Safari so the wake phrase still triggers reliably.
const WAKE_WORD_VARIANTS = [
  "blindr",
  "blinder",
  "blenders",
  "blender",
  "blinker",
  "bliner",
  "blinders",
  "binder",
  "blunder",
];
const WAKE_WORD_RE = new RegExp(
  `\\b(?:hey|hi|okay|ok)\\s+(?:${WAKE_WORD_VARIANTS.join("|")})\\b`,
  "gi",
);

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

// Voice activity detection thresholds. The threshold is adaptive: it tracks a rolling noise
// floor, so in a loud room only louder-than-ambient speech (the user's own voice, since they
// are closest to the mic) crosses the bar.
const VAD_BASE_RMS = 0.04; // absolute floor, never go below this
const VAD_NOISE_MULTIPLIER = 3.0; // speech must exceed noise floor by this factor
const VAD_SILENCE_MS = 900; // stop recording after this much continuous silence
const VAD_MIN_UTTERANCE_MS = 400; // drop utterances shorter than this (cough / click)
const VAD_MAX_UTTERANCE_MS = 9000; // hard cap on a single clip
const VAD_MIN_TRANSCRIPT_WORDS = 2; // STT output shorter than this is likely noise

function pickRecorderMime(): string {
  const MR = (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (!MR) return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  for (const t of candidates) {
    if (MR.isTypeSupported?.(t)) return t;
  }
  return "";
}

function normalizeSpeechText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lastWakeMatch(normalized: string): RegExpMatchArray | null {
  WAKE_WORD_RE.lastIndex = 0;
  const matches = Array.from(normalized.matchAll(WAKE_WORD_RE));
  return matches.length ? matches[matches.length - 1] : null;
}

function transcriptHasWakePhrase(normalized: string): boolean {
  return lastWakeMatch(normalized) !== null;
}

function textAfterWakePhrase(normalized: string): string {
  const m = lastWakeMatch(normalized);
  if (!m || m.index === undefined) return "";
  return normalized.slice(m.index + m[0].length).trim();
}

function parseVoiceIntent(normalizedFull: string): "start" | "stop" | null {
  const hasWake = transcriptHasWakePhrase(normalizedFull);
  const tail = textAfterWakePhrase(normalizedFull);
  const cmd = tail.length > 0 ? tail : normalizedFull;
  let intent: "start" | "stop" | null = null;
  if (hasWake) {
    if (/\b(stop|halt)(\s+watching)?\b/.test(cmd)) intent = "stop";
    else if (/\b(start|begin)(\s+watching)?\b/.test(cmd)) intent = "start";
  }
  console.debug("[voice] parseVoiceIntent", {
    normalized: normalizedFull,
    hasWake,
    tail,
    cmd,
    intent,
  });
  return intent;
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
  const statusId = useId();
  const liveId = useId();
  const voiceStatusId = useId();

  const [whispering, setWhispering] = useState(false);
  const [intervalSec] = useState(5);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("Camera idle.");
  const [lastDescription, setLastDescription] = useState("");
  const [lastHeard, setLastHeard] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<string>("Checking voice support.");
  const [micGranted, setMicGranted] = useState<boolean | null>(null);
  const [onboardingDone, setOnboardingDone] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(ONBOARDING_STORAGE_KEY) === "1",
  );
  /** When true, the VAD/STT pipeline is off for privacy; user can resume via UI or voice. */
  const [micListeningPaused, setMicListeningPaused] = useState(false);

  const whisperingRef = useRef(false);
  const inFlightRef = useRef(false);
  const historyRef = useRef<Turn[]>([]);
  const pendingQueryRef = useRef<string | null>(null);
  const graceUntilRef = useRef(0);
  const micListeningPausedRef = useRef(false);

  useEffect(() => {
    whisperingRef.current = whispering;
  }, [whispering]);

  useEffect(() => {
    micListeningPausedRef.current = micListeningPaused;
  }, [micListeningPaused]);

  const requestMicPermission = useCallback(async (): Promise<boolean> => {
    console.debug("[voice] mic probe starting", {
      secureContext: window.isSecureContext,
      host: window.location.host,
      protocol: window.location.protocol,
      userAgent: navigator.userAgent,
    });

    if (navigator.permissions?.query) {
      try {
        const p = await navigator.permissions.query({ name: "microphone" as PermissionName });
        console.debug("[voice] permissions.microphone =", p.state);
      } catch (e) {
        console.debug("[voice] permissions.query threw", e);
      }
    }

    if (navigator.mediaDevices?.enumerateDevices) {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        console.debug(
          "[voice] audio input devices",
          devs.filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId, label: d.label })),
        );
      } catch (e) {
        console.debug("[voice] enumerateDevices threw", e);
      }
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceStatus("This browser does not expose microphone access.");
      setMicGranted(false);
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      console.debug("[voice] getUserMedia succeeded");
      setMicGranted(true);
      setVoiceStatus("Microphone ready. Listening for: hey blindr.");
      return true;
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "UnknownError";
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[voice] getUserMedia rejected", { name, message, err });
      setMicGranted(false);
      let hint: string;
      switch (name) {
        case "NotAllowedError":
        case "SecurityError":
          hint =
            "Microphone blocked by permission. Click the padlock in the address bar, set Microphone to Allow, then press Retry.";
          break;
        case "NotFoundError":
        case "OverconstrainedError":
          hint = "No microphone was found. Plug one in or select one in the OS, then Retry.";
          break;
        case "NotReadableError":
          hint =
            "The OS or another app is holding the microphone (e.g. Zoom, Meet, Teams). Close it and press Retry.";
          break;
        case "AbortError":
          hint = "Microphone request was aborted. Press Retry.";
          break;
        default:
          hint = `Microphone error: ${name} — ${message}. Press Retry after fixing.`;
      }
      setVoiceStatus(hint);
      return false;
    }
  }, []);

  useEffect(() => {
    if (!onboardingDone) return;
    if (micGranted !== null) return;
    void requestMicPermission();
  }, [onboardingDone, micGranted, requestMicPermission]);

  const speakUi = useCallback((text: string, priority: "polite" | "assertive" = "polite") => {
    setVoiceStatus(text);
    const el = document.getElementById(voiceStatusId);
    if (el) el.setAttribute("aria-live", priority);
  }, [voiceStatusId]);

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
    async (opts?: { force?: boolean; oneShot?: boolean }) => {
      if (inFlightRef.current) return;
      if (!opts?.oneShot && !whisperingRef.current) return;
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
    setMicListeningPaused(true);
    speakUi(
      "Microphone listening paused. Say hey blindr, resume listening, or use the Resume button.",
    );
  }, [speakUi]);

  const resumeMicListeningFromVoice = useCallback(() => {
    speakUi("Resuming microphone listening.");
    setMicListeningPaused(false);
  }, [speakUi]);

  const handleVoiceTranscript = useCallback(
    (raw: string) => {
      const normalized = normalizeSpeechText(raw);
      console.debug("[voice] handleVoiceTranscript", { raw, normalized });
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
      if (transcriptHasWakePhrase(normalized)) {
        const tail = textAfterWakePhrase(normalized);
        if (tail.length === 0) {
          speakUi("Yes? Ask a question, or say start watching.");
          return;
        }
        // Question for the assistant. Capture the current frame and answer.
        // During watching we queue the query for the running interval; otherwise one-shot.
        pendingQueryRef.current = tail;
        pushTurn("user", tail);
        setLastHeard(tail);
        speakUi(`Checking: ${tail}`);
        if (whisperingRef.current) {
          stopPlayback();
          graceUntilRef.current = Date.now() + GRACE_MS;
          void sendFrame({ force: true });
        } else {
          void sendFrame({ force: true, oneShot: true });
        }
        return;
      }
      // No wake phrase — background noise / conversation. Ignore.
      console.debug("[voice] dropping transcript without wake phrase", { raw });
    },
    [
      pauseMicListening,
      pushTurn,
      resumeMicListeningFromVoice,
      sendFrame,
      speakUi,
      startWhisper,
      stopPlayback,
      stopWhisper,
    ],
  );

  // Live camera preview — starts as soon as onboarding is done, stays on for the whole session.
  useEffect(() => {
    if (!onboardingDone) return;

    let stream: MediaStream | null = null;
    let cancelled = false;

    const start = async () => {
      setCameraError(null);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not access camera.";
        setCameraError(msg);
        setStatusMessage("Camera could not start.");
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          /* iOS may block autoplay until user gesture — the stage's tap handler covers that */
        }
      }
      setStatusMessage("Camera ready. Say hey blindr to ask a question.");
    };

    void start();

    return () => {
      cancelled = true;
      const video = videoRef.current;
      if (video) video.srcObject = null;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onboardingDone]);

  // Auto-capture loop when user says "start watching" — uses the already-live camera.
  useEffect(() => {
    if (!whispering) return;
    historyRef.current = [];
    pendingQueryRef.current = null;
    graceUntilRef.current = 0;
    setApiError(null);
    setStatusMessage("Watching. Describing the scene.");
    void sendFrame();
    const timer = window.setInterval(() => {
      void sendFrame();
    }, Math.max(2, intervalSec) * 1000);
    return () => window.clearInterval(timer);
  }, [whispering, intervalSec, sendFrame]);

  // Continuous capture: VAD-driven MediaRecorder → POST /api/stt → transcript pipeline.
  // Handles both pre-watch wake-phrase detection and in-watch barge-in/questions.
  useEffect(() => {
    if (!onboardingDone || micGranted !== true) return;
    if (micListeningPaused) {
      setVoiceStatus(
        "Microphone listening paused. Say nothing is heard. Press Resume to re-enable.",
      );
      return;
    }

    const mime = pickRecorderMime();
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let rafId = 0;
    let silenceStart: number | null = null;
    let recordStart = 0;
    let cancelled = false;
    // Adaptive noise floor — slowly tracks ambient RMS when no speech is active, so the
    // speech threshold floats above room noise (chatter, HVAC, traffic, etc.).
    let noiseFloor = 0.015;

    const stopRecordingSoon = () => {
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch (e) {
          console.debug("[voice:vad] recorder.stop threw", e);
        }
      }
    };

    const startRecording = () => {
      if (!stream || recorder) return;
      try {
        recorder = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);
      } catch (e) {
        console.warn("[voice:vad] MediaRecorder ctor failed", e);
        return;
      }
      chunks = [];
      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size) chunks.push(ev.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mime || "audio/webm" });
        const durMs = performance.now() - recordStart;
        chunks = [];
        recorder = null;
        silenceStart = null;
        console.debug("[voice:vad] recorder stopped", {
          durMs: Math.round(durMs),
          bytes: blob.size,
        });
        if (cancelled) return;
        if (durMs < VAD_MIN_UTTERANCE_MS || blob.size < 1024) return;
        void uploadClip(blob);
      };
      recorder.start();
      recordStart = performance.now();
      console.debug("[voice:vad] recording started", { mime });
      if (whisperingRef.current) {
        setStatusMessage("Listening.");
      }
    };

    const uploadClip = async (blob: Blob) => {
      const ext = (mime || "audio/webm").split("/")[1]?.split(";")[0] || "webm";
      const fd = new FormData();
      fd.append("audio", blob, `clip.${ext}`);
      try {
        const res = await fetch(`${apiBase}/api/stt`, { method: "POST", body: fd });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `STT failed (${res.status})`);
        }
        const data = (await res.json()) as { text: string };
        const text = (data.text || "").trim();
        console.debug("[voice:stt] transcript", { text, bytes: blob.size });
        if (!text) return;
        // Drop STT noise artifacts: very short transcripts are usually stray sounds.
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        if (wordCount < VAD_MIN_TRANSCRIPT_WORDS) {
          console.debug("[voice:stt] dropping short transcript", { text, wordCount });
          return;
        }
        // In a noisy room we only want to act on speech addressed to the assistant.
        // handleVoiceTranscript already no-ops on anything without the wake phrase.
        setLastHeard(text);
        handleVoiceTranscript(text);
      } catch (e) {
        console.warn("[voice:stt] upload failed", e);
      }
    };

    const tick = () => {
      if (cancelled || !analyser) return;
      const bufLen = analyser.fftSize;
      const data = new Float32Array(bufLen);
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < bufLen; i += 1) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / bufLen);
      const now = performance.now();

      const threshold = Math.max(VAD_BASE_RMS, noiseFloor * VAD_NOISE_MULTIPLIER);

      if (rms > threshold) {
        silenceStart = null;
        if (!recorder) startRecording();
      } else {
        // Only update the noise floor when not actively recording, using a slow EWMA so
        // sporadic loud moments don't immediately raise the bar.
        if (!recorder) noiseFloor = noiseFloor * 0.98 + rms * 0.02;
        if (recorder) {
          if (silenceStart === null) silenceStart = now;
          const silent = now - silenceStart;
          const recording = now - recordStart;
          if (silent >= VAD_SILENCE_MS || recording >= VAD_MAX_UTTERANCE_MS) {
            stopRecordingSoon();
          }
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        console.warn("[voice:vad] getUserMedia failed", e);
        setVoiceStatus("Could not open microphone for voice input.");
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) {
        setVoiceStatus("AudioContext unsupported in this browser.");
        return;
      }
      audioCtx = new Ctx();
      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      setVoiceStatus(
        whisperingRef.current
          ? "Watching. Speak to ask, or say hey blindr, stop."
          : "Listening for: hey blindr, then start or stop.",
      );
      rafId = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* noop */
        }
      }
      recorder = null;
      if (audioCtx) {
        try {
          void audioCtx.close();
        } catch {
          /* noop */
        }
      }
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [
    handleVoiceTranscript,
    micGranted,
    micListeningPaused,
    onboardingDone,
    sendFrame,
    stopPlayback,
    stopWhisper,
  ]);

  useEffect(() => {
    if (whispering) stopRef.current?.focus();
  }, [whispering]);

  const needsTap = micGranted !== true;
  const onStageTap = needsTap ? () => void requestMicPermission() : undefined;

  return (
    <div
      className="stage"
      onClick={onStageTap}
      role={needsTap ? "button" : undefined}
      tabIndex={needsTap ? 0 : -1}
      aria-label={needsTap ? "Tap anywhere to enable the microphone" : undefined}
    >
      <video ref={videoRef} className="stage-video" playsInline muted />
      <canvas ref={canvasRef} className="visually-hidden" />

      <span id={statusId} role="status" aria-live="polite" className="visually-hidden">
        {statusMessage}
      </span>
      <span id={voiceStatusId} role="status" aria-live="polite" className="visually-hidden">
        {voiceStatus}
      </span>
      <span id={liveId} aria-live="polite" aria-atomic="true" className="visually-hidden">
        {lastDescription || "No description yet."}
      </span>
      {lastHeard ? <span className="visually-hidden">Heard: {lastHeard}</span> : null}
      {cameraError ? <span className="visually-hidden" role="alert">{cameraError}</span> : null}
      {apiError ? <span className="visually-hidden" role="alert">{apiError}</span> : null}
      {/* Keep these refs mounted but not visible — tests/ESLint still expect them. */}
      <button ref={stopRef} type="button" className="visually-hidden" onClick={stopWhisper}>
        Stop whispering
      </button>
      <audio ref={audioRef} className="visually-hidden" />
    </div>
  );
}
