import { useCallback, useEffect, useId, useRef, useState } from "react";

const DEFAULT_API = "http://127.0.0.1:8000";
const apiBase = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API).replace(/\/$/, "");

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
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }> }) => void) | null;
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

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);

  const statusId = useId();
  const liveId = useId();

  const [whispering, setWhispering] = useState(false);
  const [intervalSec, setIntervalSec] = useState(5);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("Camera idle.");
  const [lastDescription, setLastDescription] = useState("");
  const [lastHeard, setLastHeard] = useState("");

  const whisperingRef = useRef(false);
  const inFlightRef = useRef(false);
  const historyRef = useRef<Turn[]>([]);
  const pendingQueryRef = useRef<string | null>(null);
  const graceUntilRef = useRef(0);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    whisperingRef.current = whispering;
  }, [whispering]);

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

  const playBase64Audio = useCallback(async (mime: string, b64: string) => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    el.src = `data:${mime};base64,${b64}`;
    try {
      await el.play();
    } catch {
      setApiError("Audio was blocked by the browser. Tap the page once and try again.");
    }
  }, []);

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

  // Barge-in: SpeechRecognition runs while whispering is on
  useEffect(() => {
    if (!whispering) return;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setStatusMessage("Voice interrupt unsupported in this browser.");
      return;
    }

    const rec = new Ctor();
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
        if (cleaned) {
          setLastHeard(cleaned);
          pendingQueryRef.current = cleaned;
          graceUntilRef.current = Date.now() + GRACE_MS;
          // Fire a frame for the question; bypass grace so it goes immediately.
          void sendFrame({ force: true });
        }
      }
    };

    rec.onerror = (ev) => {
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      // Other errors (network, not-allowed) — surface quietly.
      setStatusMessage(`Speech recognition error: ${ev.error}`);
    };

    rec.onend = () => {
      // Chrome auto-stops recognition periodically. Restart while the session is active.
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
      recognitionRef.current = rec;
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
      recognitionRef.current = null;
    };
  }, [whispering, sendFrame, stopPlayback]);

  const startWhisper = () => setWhispering(true);
  const stopWhisper = () => {
    setWhispering(false);
    stopPlayback();
    setStatusMessage("Whispering stopped.");
  };

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
            spaces. Speak any time to interrupt and ask a question.
          </p>
        </header>

        <main id="main" tabIndex={-1}>
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
