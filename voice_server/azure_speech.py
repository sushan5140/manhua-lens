"""Azure Korean TTS adapter. Keys stay in this local server, never in the extension."""
import os
import re
from urllib import error, request as urllib_request
from xml.sax.saxutils import escape

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

router = APIRouter()

VOICES = {
    "sunhi": "ko-KR-SunHiNeural",
    "hyunsu": "ko-KR-HyunsuMultilingualNeural",
}
# Extension pages can call the localhost service; ordinary sites cannot
# consume somebody's Azure quota simply by fetching localhost.
_EXTENSION_ORIGIN = re.compile(r"^chrome-extension://[a-p]{32}$")


class AzureTTSRequest(BaseModel):
    text: str
    voice: str


@router.post("/azure-tts")
def azure_tts(payload: AzureTTSRequest, incoming: Request):
    origin = incoming.headers.get("origin")
    if origin and not _EXTENSION_ORIGIN.fullmatch(origin):
        raise HTTPException(status_code=403, detail="Azure TTS is available to the Manhua Lens extension only.")

    voice_name = VOICES.get(payload.voice)
    if not voice_name:
        raise HTTPException(status_code=400, detail="Unsupported Korean voice.")
    text = payload.text.strip()
    if not text or len(text) > 400:
        raise HTTPException(status_code=400, detail="Speech text must contain 1–400 characters.")

    key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
    region = os.environ.get("AZURE_SPEECH_REGION", "").strip().lower()
    if not key or not re.fullmatch(r"[a-z0-9-]+", region):
        raise HTTPException(
            status_code=503,
            detail="Azure voice is not configured. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in the local voice server, then restart it.",
        )

    ssml = (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR">'
        f'<voice name="{voice_name}">{escape(text)}</voice>'
        "</speak>"
    ).encode("utf-8")
    url = f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"
    req = urllib_request.Request(
        url,
        data=ssml,
        headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml; charset=utf-8",
            "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
            "User-Agent": "ManhuaLens",
        },
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=30) as result:
            audio = result.read()
    except error.HTTPError as exc:
        # Never reflect authentication material or raw upstream responses.
        raise HTTPException(status_code=502, detail=f"Azure Speech returned HTTP {exc.code}. Check the voice, region, and Speech resource.") from None
    except (error.URLError, TimeoutError) as exc:
        raise HTTPException(status_code=502, detail="Could not reach Azure Speech. Check your connection and Azure Speech region.") from None
    if not audio.startswith(b"RIFF"):
        raise HTTPException(status_code=502, detail="Azure Speech did not return WAV audio.")

    return Response(audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})
