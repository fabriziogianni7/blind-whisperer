import asyncio
import base64
import logging
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from openai import AzureOpenAI, OpenAI
from pydantic import BaseModel

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


def get_settings() -> Settings:
    return settings


class SceneResponse(BaseModel):
    description: str
    audio_mime: str = "audio/mpeg"
    audio_base64: str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/scene", response_model=SceneResponse)
async def describe_scene(
    image: Annotated[UploadFile, File(description="Camera frame as JPEG or PNG")],
    s: Annotated[Settings, Depends(get_settings)],
):
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
                status_code=500,
                detail=f"Missing Azure settings: {', '.join(missing)}",
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

    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty image upload")

    mime = image.content_type or "image/jpeg"
    if not mime.startswith("image/"):
        mime = "image/jpeg"

    b64 = base64.b64encode(raw).decode("ascii")
    data_url = f"data:{mime};base64,{b64}"

    if provider == "azure":
        endpoint = s.azure_openai_endpoint.rstrip("/")
        # Strip Foundry project path ("/api/projects/<name>") — OpenAI SDK needs the resource root.
        marker = "/api/projects/"
        if marker in endpoint:
            endpoint = endpoint.split(marker, 1)[0]
        client = AzureOpenAI(
            api_key=s.azure_openai_api_key,
            azure_endpoint=endpoint,
            api_version=s.azure_openai_api_version,
        )
        model = s.azure_openai_deployment
    else:
        client = OpenAI(api_key=s.openai_api_key)
        model = s.openai_model
    try:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You help blind users understand their surroundings. "
                        "Describe the image briefly and clearly for spoken audio: "
                        "no markdown, no bullet lists, one or two short sentences unless "
                        "the scene is complex. Mention important hazards, people, text, and objects."
                    ),
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "What do you see? Respond as plain speech.",
                        },
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                },
            ],
            max_tokens=300,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("%s vision failed", provider)
        raise HTTPException(status_code=502, detail=f"{provider} error: {exc}") from exc

    description = (completion.choices[0].message.content or "").strip()
    if not description:
        raise HTTPException(status_code=502, detail="Empty description from model")

    tts_url = f"https://api.elevenlabs.io/v1/text-to-speech/{s.elevenlabs_voice_id}"
    tts_resp = None
    try:
        async with httpx.AsyncClient(timeout=60.0) as http:
            for attempt in range(4):
                tts_resp = await http.post(
                    tts_url,
                    headers={
                        "xi-api-key": s.elevenlabs_api_key,
                        "Accept": "audio/mpeg",
                    },
                    json={
                        "text": description,
                        "model_id": s.elevenlabs_model_id,
                    },
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

    audio_bytes = tts_resp.content
    audio_b64 = base64.b64encode(audio_bytes).decode("ascii")
    return SceneResponse(description=description, audio_mime="audio/mpeg", audio_base64=audio_b64)
