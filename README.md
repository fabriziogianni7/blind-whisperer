# Blind Whisperer

Boilerplate for an assistive app: the browser captures periodic camera frames, your **FastAPI** backend sends them to **OpenAI** multimodal vision, then **ElevenLabs** turns the description into speech. The React UI favors **keyboard navigation**, **visible focus**, **skip link**, **live regions**, and **large controls**.

## Architecture

- **frontend**: Vite + React + TypeScript. Captures JPEG frames, `POST` multipart to `/api/scene`, plays returned MP3.
- **backend**: FastAPI. OpenAI Chat Completions with `image_url`, then ElevenLabs `text-to-speech` (returns base64 audio).
- **Meta glasses wrapper (mobile)**: The same web UI is packaged with **Capacitor** as an Android and iOS app (`frontend/android`, `frontend/ios`). The WebView uses the **phone camera and mic** like the browser. Routing audio to the glasses speakers and using the **glasses camera** requires Meta’s **Wearables Device Access Toolkit** in a native layer (see below)—this repo gives you the installable shell and permissions; you plug in the toolkit per Meta’s docs.

## Prerequisites

- Node 20+ recommended
- Python 3.11+
- Accounts and keys: **OpenAI** and **ElevenLabs** (voice ID from the ElevenLabs dashboard)

## Backend setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env: OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Health check: `GET http://127.0.0.1:8000/health`

## Frontend setup

```bash
cd frontend
npm install
cp .env.example .env.local   # optional: set VITE_API_BASE_URL
npm run dev
```

Open the printed local URL (default `http://127.0.0.1:5173`).

## Meta smart glasses (Ray-Ban Meta / Meta Ray-Ban Display)

Meta does not run arbitrary web apps on the glasses firmware. The supported path is a **phone companion app** that talks to the glasses over Bluetooth using Meta’s **Wearables Device Access Toolkit** ([Wearables Developer Center](https://wearables.developer.meta.com/docs/)). This repository includes a **Capacitor** wrapper so you can ship the same React UI as a native Android/iOS app and iterate toward that integration.

### What is included here

- `frontend/android` and `frontend/ios` — Capacitor native projects that load the built web app from the bundled assets.
- **Camera and microphone** — Declared on Android (`CAMERA`, `RECORD_AUDIO`) and iOS (`NSCameraUsageDescription`, `NSMicrophoneUsageDescription`) so `getUserMedia` works in the WebView.
- **HTTP to a LAN backend** — Android allows cleartext traffic; iOS allows local networking in `Info.plist` so you can point the app at `http://<your-computer-ip>:8000` while developing. Use **HTTPS** for anything beyond local testing.

### Build and run the mobile app

From `frontend`:

```bash
npm install
# For a phone talking to a backend on your machine, use your computer's LAN IP:
# echo 'VITE_API_BASE_URL=http://192.168.1.10:8000' > .env.local
npm run build
npx cap sync
```

Then open the native IDE and run on a device:

```bash
npm run cap:open:android   # Android Studio
npm run cap:open:ios       # Xcode (macOS; run `pod install` in ios/App if needed)
```

Ensure the **backend** is reachable from the phone (same Wi‑Fi, firewall allows the port). Scripts: `cap:sync` runs `build` + `cap sync`; `cap:open:android` / `cap:open:ios` open the IDE.

### Using Meta glasses hardware (next step)

To use the **glasses camera, microphones, or speakers** instead of only the phone, add Meta’s toolkit to the **native** project and bridge frames or audio to your backend—the FastAPI contract (`POST /api/scene`) stays the same. Follow [Setup](https://wearables.developer.meta.com/docs/getting-started-toolkit) and [Build an integration](https://wearables.developer.meta.com/docs/build-overview) in the Wearables Developer Center; you will need Meta AI app developer mode and compatible glasses firmware.

### Simulation (browser, emulator, Mock Device Kit)

You can run and test without physical glasses in several ways: local web dev, Android/iOS simulators with the Capacitor shell, and Meta’s **Mock Device Kit** after you integrate their native SDK. See **[docs/meta-glasses-simulation.md](docs/meta-glasses-simulation.md)** for step-by-step instructions.

## API

`POST /api/scene` — multipart field `image` (JPEG/PNG). Response JSON:

```json
{
  "description": "Plain text scene summary",
  "audio_mime": "audio/mpeg",
  "audio_base64": "..."
}
```

## Privacy and safety

This prototype sends **camera frames to your server** and onward to third-party APIs. For production you need consent, data handling policies, rate limits, and safer defaults (blur faces, avoid recording, HTTPS only, etc.).

## License

See repository root for license information if present.
