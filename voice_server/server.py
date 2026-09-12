import os
import tempfile
from pathlib import Path

import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from melo.api import TTS
from openvoice import se_extractor
from openvoice.api import ToneColorConverter

HERE = Path(__file__).resolve().parent
OPENVOICE_ROOT = Path(os.environ.get("OPENVOICE_ROOT", HERE / "OpenVoice")).resolve()
CHECKPOINT_ROOT = Path(os.environ.get("OPENVOICE_CHECKPOINTS", OPENVOICE_ROOT / "checkpoints_v2")).resolve()
REFERENCE_AUDIO = Path(os.environ.get("MANHUA_VOICE_REFERENCE", HERE / "voice_reference.wav")).resolve()

DEVICE = "cuda:0" if torch.cuda.is_available() else "cpu"
CONVERTER_DIR = CHECKPOINT_ROOT / "converter"
SES_DIR = CHECKPOINT_ROOT / "base_speakers" / "ses"

app = FastAPI(title="Manhua Lens Korean Voice", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

class TTSRequest(BaseModel):
    text: str

tone_color_converter = None
target_se = None
korean_model = None
speaker_id = None
source_se = None

def initialize():
    global tone_color_converter, target_se, korean_model, speaker_id, source_se

    if not REFERENCE_AUDIO.exists():
        raise RuntimeError(
            f"Missing reference audio: {REFERENCE_AUDIO}. "
            "Copy your consented speaker WAV there or set MANHUA_VOICE_REFERENCE."
        )

    tone_color_converter = ToneColorConverter(
        str(CONVERTER_DIR / "config.json"),
        device=DEVICE,
    )
    tone_color_converter.load_ckpt(str(CONVERTER_DIR / "checkpoint.pth"))

    target_se, _ = se_extractor.get_se(
        str(REFERENCE_AUDIO),
        tone_color_converter,
        vad=True,
    )

    korean_model = TTS(language="KR", device=DEVICE)
    speaker_ids = korean_model.hps.data.spk2id
    speaker_key = next(iter(speaker_ids))
    speaker_id = speaker_ids[speaker_key]
    source_key = speaker_key.lower().replace("_", "-")
    source_se = torch.load(
        SES_DIR / f"{source_key}.pth",
        map_location=DEVICE,
    )

@app.on_event("startup")
def startup_event():
    initialize()

@app.get("/health")
def health():
    return {
        "ok": True,
        "device": DEVICE,
        "reference": REFERENCE_AUDIO.name,
    }

@app.post("/tts")
def tts(payload: TTSRequest):
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is empty.")
    if len(text) > 400:
        raise HTTPException(status_code=400, detail="Text exceeds 400 characters.")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        source_path = tmp_dir / "source.wav"
        output_path = tmp_dir / "cloned.wav"

        korean_model.tts_to_file(
            text,
            speaker_id,
            str(source_path),
            speed=0.95,
        )

        tone_color_converter.convert(
            audio_src_path=str(source_path),
            src_se=source_se,
            tgt_se=target_se,
            output_path=str(output_path),
            message="@ManhuaLens",
        )

        return Response(
            content=output_path.read_bytes(),
            media_type="audio/wav",
            headers={"Cache-Control": "no-store"},
        )
