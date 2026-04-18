import asyncio
import base64
import json
import logging
from typing import Annotated, Literal

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from openai import AzureOpenAI, OpenAI
from pydantic import BaseModel, Field

from app.config import Settings, settings

logger = logging.getLogger(__name__)

app = FastAPI(title="Blind Whisperer API", version="0.1.0")

_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

NO_CHANGE_SENTINEL = "__NO_CHANGE__"
MAX_HISTORY_TURNS = 6  # user+assistant pairs, capped to fit the vision model's context budget

SYSTEM_PROMPT = (
    "You narrate a live camera feed for a blind user. Follow these rules strictly:\n"
    "1. If the user provides an explicit question or focus in their latest message, answer it directly "
    "using the image. Ignore unrelated scene elements.\n"
    "2. Otherwise, compare the new image to the prior descriptions in the conversation. If the scene is "
    f"substantively unchanged (same place, same people, no new hazards, no new text), reply with exactly "
    f"{NO_CHANGE_SENTINEL} and nothing else.\n"
    "3. If the scene changed, describe only the delta: what is new, what moved, what hazard appeared. "
    "Do not re-describe unchanged elements.\n"
    "4. Output is spoken aloud. Use plain prose, no markdown, no bullets, one or two short sentences. "
    "Prioritize hazards, people, doorways, stairs, vehicles, and readable text.\n"
    "5. Never apologize, never mention that you are an AI, never describe the image format."
)


class HistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(max_length=2000)


class SceneResponse(BaseModel):
    description: str
    audio_mime: str = "audio/mpeg"
    audio_base64: str
    speak: bool = True


class TranscriptResponse(BaseModel):
    text: str
    language_code: str | None = None


def get_settings() -> Settings:
    return settings


def _validate_credentials(s: Settings) -> str:
    provider = s.openai_provider.lower()
    if provider == "azure":
        missing = [
            name
            for name, value in (
                ("AZURE_OPENAI_API_KEY", s.azure_openai_api_key),
                ("AZURE_OPENAI_ENDPOINT", s.azure_openai_endpoint),
                ("AZURE_OPENAI_DEPLOYMENT", s.azure_openai_deployment),
            )
            if not value
        ]
        if missing:
            raise HTTPException(
                status_code=500, detail=f"Missing Azure settings: {', '.join(missing)}"
            )
    elif provider == "openai":
        if not s.openai_api_key:
            raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not configured")
    else:
        raise HTTPException(
            status_code=500,
            detail=f"Unsupported OPENAI_PROVIDER: {s.openai_provider!r} (expected 'openai' or 'azure')",
        )
    if not s.elevenlabs_api_key or not s.elevenlabs_voice_id:
        raise HTTPException(
            status_code=500,
            detail="ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID must be configured",
        )
    return provider


def _build_client(s: Settings, provider: str) -> tuple[AzureOpenAI | OpenAI, str]:
    if provider == "azure":
        endpoint = s.azure_openai_endpoint.rstrip("/")
        marker = "/api/projects/"
        if marker in endpoint:
            endpoint = endpoint.split(marker, 1)[0]
        client = AzureOpenAI(
            api_key=s.azure_openai_api_key,
            azure_endpoint=endpoint,
            api_version=s.azure_openai_api_version,
        )
        return client, s.azure_openai_deployment
    return OpenAI(api_key=s.openai_api_key), s.openai_model


def _parse_history(raw: str | None) -> list[HistoryMessage]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid history JSON: {exc}") from exc
    if not isinstance(data, list):
        raise HTTPException(status_code=400, detail="history must be a JSON array")
    messages = [HistoryMessage.model_validate(item) for item in data]
    return messages[-MAX_HISTORY_TURNS * 2 :]


async def _synthesize_speech(s: Settings, text: str) -> bytes:
    tts_url = f"https://api.elevenlabs.io/v1/text-to-speech/{s.elevenlabs_voice_id}"
    tts_resp = None
    try:
        async with httpx.AsyncClient(timeout=60.0) as http:
            for attempt in range(4):
                tts_resp = await http.post(
                    tts_url,
                    headers={"xi-api-key": s.elevenlabs_api_key, "Accept": "audio/mpeg"},
                    json={"text": text, "model_id": s.elevenlabs_model_id},
                )
                # Retry transient contention on the same voice (409 already_running, 429 rate-limit).
                if tts_resp.status_code not in (409, 429) or attempt == 3:
                    break
                await asyncio.sleep(0.4 * (2**attempt))
    except httpx.HTTPError as exc:
        logger.exception("ElevenLabs request failed")
        raise HTTPException(status_code=502, detail=f"ElevenLabs network error: {exc}") from exc

    assert tts_resp is not None
    if tts_resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs error {tts_resp.status_code}: {tts_resp.text[:500]}",
        )
    return tts_resp.content


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/stt", response_model=TranscriptResponse)
async def speech_to_text(
    audio: Annotated[UploadFile, File(description="Audio clip (webm/ogg/mp3/wav)")],
    s: Annotated[Settings, Depends(get_settings)],
):
    if not s.elevenlabs_api_key:
        raise HTTPException(status_code=500, detail="ELEVENLABS_API_KEY is not configured")

    raw = await audio.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio upload")
    if len(raw) < 1024:
        # Too short to transcribe usefully; skip the API call.
        return TranscriptResponse(text="", language_code=None)

    mime = audio.content_type or "audio/webm"
    filename = audio.filename or f"clip.{mime.split('/')[-1].split(';')[0] or 'webm'}"

    try:
        async with httpx.AsyncClient(timeout=60.0) as http:
            resp = await http.post(
                "https://api.elevenlabs.io/v1/speech-to-text",
                headers={"xi-api-key": s.elevenlabs_api_key},
                data={"model_id": s.elevenlabs_stt_model},
                files={"file": (filename, raw, mime)},
            )
    except httpx.HTTPError as exc:
        logger.exception("ElevenLabs STT request failed")
        raise HTTPException(status_code=502, detail=f"ElevenLabs STT network error: {exc}") from exc

    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs STT error {resp.status_code}: {resp.text[:500]}",
        )

    try:
        payload = resp.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"ElevenLabs STT non-JSON response: {exc}") from exc

    return TranscriptResponse(
        text=(payload.get("text") or "").strip(),
        language_code=payload.get("language_code"),
    )


@app.post("/api/scene", response_model=SceneResponse)
async def describe_scene(
    image: Annotated[UploadFile, File(description="Camera frame as JPEG or PNG")],
    s: Annotated[Settings, Depends(get_settings)],
    user_query: Annotated[str | None, Form()] = None,
    history: Annotated[str | None, Form(description="JSON array of {role, text}")] = None,
):
    provider = _validate_credentials(s)

    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty image upload")

    mime = image.content_type or "image/jpeg"
    if not mime.startswith("image/"):
        mime = "image/jpeg"
    data_url = f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"

    past = _parse_history(history)

    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in past:
        messages.append({"role": turn.role, "content": turn.text})

    query_text = (user_query or "").strip()
    prompt_text = query_text if query_text else "Describe the scene now."
    messages.append(
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt_text},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }
    )

    client, model = _build_client(s, provider)
    try:
        completion = client.chat.completions.create(
            model=model, messages=messages, max_tokens=250
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("%s vision failed", provider)
        raise HTTPException(status_code=502, detail=f"{provider} error: {exc}") from exc

    description = (completion.choices[0].message.content or "").strip()
    if not description:
        raise HTTPException(status_code=502, detail="Empty description from model")

    if NO_CHANGE_SENTINEL in description:
        return SceneResponse(description="", audio_mime="audio/mpeg", audio_base64="", speak=False)

    audio_bytes = await _synthesize_speech(s, description)
    return SceneResponse(
        description=description,
        audio_mime="audio/mpeg",
        audio_base64=base64.b64encode(audio_bytes).decode("ascii"),
        speak=True,
    )
