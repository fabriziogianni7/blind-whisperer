# Blind Whisperer

Boilerplate for an assistive app: the browser captures periodic camera frames, your **FastAPI** backend sends them to **OpenAI** multimodal vision, then **ElevenLabs** turns the description into speech. The React UI favors **keyboard navigation**, **visible focus**, **skip link**, **live regions**, and **large controls**.

## Architecture

- **frontend**: Vite + React + TypeScript. Captures JPEG frames, `POST` multipart to `/api/scene`, plays returned MP3.
- **backend**: FastAPI. OpenAI Chat Completions with `image_url`, then ElevenLabs `text-to-speech` (returns base64 audio).

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
