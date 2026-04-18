import { useCallback, useEffect, useId, useRef, useState } from "react";

const DEFAULT_API = "http://127.0.0.1:8000";
const apiBase = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API).replace(/\/$/, "");

type ScenePayload = {
  description: string;
  audio_mime: string;
  audio_base64: string;
};

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);

  const statusId = useId();
  const liveId = useId();

  const [whispering, setWhispering] = useState(false);
  const [intervalSec, setIntervalSec] = useState(4);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("Camera idle.");
  const [lastDescription, setLastDescription] = useState("");

  const whisperingRef = useRef(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    whisperingRef.current = whispering;
  }, [whispering]);

  const playBase64Audio = useCallback(async (mime: string, b64: string) => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    const url = `data:${mime};base64,${b64}`;
    el.src = url;
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
      setLastDescription(data.description);
      setStatusMessage("Playing whisper.");
      await playBase64Audio(data.audio_mime || "audio/mpeg", data.audio_base64);
      setStatusMessage("Listening paused until next interval.");
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

  const startWhisper = () => {
    setWhispering(true);
  };

  const stopWhisper = () => {
    setWhispering(false);
    setStatusMessage("Whispering stopped.");
  };

  useEffect(() => {
    if (whispering) {
      stopRef.current?.focus();
    }
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
            spaces.
          </p>
        </header>

        <main id="main" tabIndex={-1}>
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
