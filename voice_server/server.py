"""Optional live server; default Windows startup uses cache_server.py."""
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, StrictStr
from voice_assets import normalize_text, read_cached

HERE = Path(__file__).resolve().parent
ASSETS = Path(os.environ.get("MANHUA_VOICE_ASSETS", HERE / "private"))
OPENVOICE_ROOT = Path(os.environ.get("OPENVOICE_ROOT", HERE / "OpenVoice"))
CHECKPOINT_ROOT = Path(os.environ.get("OPENVOICE_CHECKPOINTS", OPENVOICE_ROOT / "checkpoints_v2"))
EMBEDDING = Path(os.environ.get("MANHUA_VOICE_EMBEDDING", ASSETS / "target_se.pth"))


@asynccontextmanager
async def lifespan(app):
    from engine import KoreanVoice
    if not EMBEDDING.is_file():
        raise RuntimeError("Missing PRIVATE target_se.pth. Run the preparation notebook and import its bundle.")
    app.state.voice = KoreanVoice(CHECKPOINT_ROOT, EMBEDDING, os.environ.get("MANHUA_VOICE_DEVICE"))
    yield


app = FastAPI(title="Manhua Lens Korean Voice", version="2.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origin_regex=r"chrome-extension://[a-p]{32}",
                   allow_methods=["POST", "GET"], allow_headers=["Content-Type"])


class TTSRequest(BaseModel):
    text: StrictStr


@app.get("/health")
def health():
    return {"ok": True, "mode": "live", "device": app.state.voice.device}


@app.post("/tts")
def tts(payload: TTSRequest):
    try:
        text = normalize_text(payload.text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        audio = read_cached(ASSETS, text)
        if audio is None:
            audio = app.state.voice.synthesize(text)
    except (RuntimeError, ValueError, OSError) as exc:
        raise HTTPException(status_code=503, detail="Custom voice unavailable; use device Korean TTS") from exc
    return Response(audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})
