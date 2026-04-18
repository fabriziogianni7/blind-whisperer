# Blind Whisperer

**Blind Whisperer** is an assistive web app for **blind and low-vision users**: the browser captures periodic **camera** frames, your **FastAPI** backend sends them to **OpenAI** multimodal vision for a concise spoken description, and **ElevenLabs** turns that text into **speech**. The **React** UI is built for **accessibility**—keyboard navigation, visible focus, a skip link, **ARIA live regions**, and large controls.

This project was built for **Cursor Turbo Hack**.

## What it does

- **Scene understanding**: Snapshots from the camera are posted to `/api/scene`; the model returns plain-text descriptions suited for audio (no markdown).
- **Voice UX**: The app uses the **Web Speech API** for wake phrases, commands, optional barge-in while “watching,” and browser **speech synthesis** for onboarding. Behavior depends on the browser (often **Chrome** with **HTTPS** or **localhost**).
- **Privacy**: Camera frames leave the device for your server and third-party APIs—treat this as a prototype; production needs consent, policies, and safer defaults.

## Architecture


| Layer        | Stack                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| **frontend** | Vite + React + TypeScript — captures JPEG frames, `POST` multipart to `/api/scene`, plays returned audio |
| **backend**  | FastAPI — OpenAI Chat Completions with `image_url`, ElevenLabs text-to-speech (base64 MP3 in JSON)       |


## Prerequisites

- **Node** 20+ recommended
- **Python** 3.11+
- API keys: **OpenAI** (or Azure OpenAI per config) and **ElevenLabs** (voice ID from the ElevenLabs dashboard)

## Backend setup

From the repo root:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e .
cp .env.example .env
# Edit .env: OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID (and Azure vars if using Azure)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Health check: `GET http://127.0.0.1:8000/health`

## Frontend setup

```bash
cd frontend
npm install
cp .env.example .env.local   # optional: set VITE_API_BASE_URL (default http://127.0.0.1:8000)
npm run dev
```

Open the printed local URL (default `http://127.0.0.1:5173`).

## API

`POST /api/scene` — multipart fields include `image` (JPEG/PNG), optional `history` (JSON), optional `user_query`. Response JSON includes `description`, `audio_mime`, `audio_base64`, and `speak`.

## Privacy and safety

This prototype sends **camera frames to your server** and onward to third-party APIs. For production you need consent, data handling policies, rate limits, and safer defaults (blur faces, avoid recording, HTTPS only, etc.).

## License

See repository root for license information if present.