"""Prepare private OpenVoice V2 assets in a notebook session; no web server."""
import argparse
import json
import tempfile
import zipfile
from pathlib import Path

from voice_assets import cache_name, normalize_text, validate_wav
from setup_runtime import OPENVOICE_REV, MELO_REV, CHECKPOINT_REV

TEST_TEXT = "안녕하세요. 오늘도 한국어 공부를 시작해 볼까요?"


def prepare(reference, checkpoints, output, phrases, device=None):
    import numpy as np
    import soundfile as sf
    import torch
    from openvoice.api import ToneColorConverter
    from engine import KoreanVoice

    reference, checkpoints, output = Path(reference), Path(checkpoints), Path(output)
    texts = list(dict.fromkeys(normalize_text(t) for t in [TEST_TEXT, *phrases]))
    if len(texts) > 10000:
        raise ValueError("At most 10,000 phrases per bundle")
    device = device or ("cuda:0" if torch.cuda.is_available() else "cpu")
    info = sf.info(reference)
    if info.duration < 3 or info.duration > 600:
        raise ValueError("Use a clean single-speaker WAV lasting 3–600 seconds")
    audio, sr = sf.read(reference, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if not np.isfinite(audio).all() or np.max(np.abs(audio)) < 0.001:
        raise ValueError("Reference is silent or invalid")
    # A prepared, clean recording needs no Whisper, VAD model or ffmpeg.
    # Short voiced chunks bound extraction memory; silence-only chunks are skipped.
    with tempfile.TemporaryDirectory(prefix="mhl-private-") as tmp:
        tmp = Path(tmp)
        chunks = []
        for offset in range(0, len(audio), 10 * sr):
            chunk = audio[offset:offset + 10 * sr]
            if len(chunk) < sr or float(np.sqrt(np.mean(chunk ** 2))) < 0.003:
                continue
            path = tmp / f"reference-{len(chunks)}.wav"
            sf.write(path, chunk, sr, subtype="PCM_16")
            chunks.append(str(path))
        if not chunks:
            raise ValueError("No usable speech chunks; trim silence and check the recording level")
        converter = ToneColorConverter(str(checkpoints / "converter/config.json"), device=device)
        converter.load_ckpt(str(checkpoints / "converter/checkpoint.pth"))
        embedding = tmp / "target_se.pth"
        converter.extract_se(chunks, se_save_path=str(embedding))
        del converter
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        voice = KoreanVoice(checkpoints, embedding, device)
        cache = tmp / "cache"
        cache.mkdir()
        for index, text in enumerate(texts):
            (cache / cache_name(text)).write_bytes(validate_wav(voice.synthesize(text)))
            print(f"Prepared {index + 1}/{len(texts)} phrases")
        manifest = {"format": "manhua-lens-private-v1", "private": True,
                    "language": "KR", "openvoice": OPENVOICE_REV, "melo": MELO_REV,
                    "checkpoints": CHECKPOINT_REV,
                    "phrases": len(texts), "normalization": "NFC+strip", "speed": 0.95}
        output.parent.mkdir(parents=True, exist_ok=True)
        # Explicit allowlist: raw recordings and intermediate chunks never exported.
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("manifest.json", json.dumps(manifest))
            bundle.write(embedding, "target_se.pth")
            for path in sorted(cache.glob("*.wav")):
                bundle.write(path, "cache/" + path.name)
    print("PRIVATE bundle ready. Download it before ending the session; do not publish it.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--checkpoints", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--phrases", type=Path, help="UTF-8 text file, one phrase per line")
    parser.add_argument("--device", choices=["cpu", "cuda:0"])
    args = parser.parse_args()
    phrases = args.phrases.read_text(encoding="utf-8").splitlines() if args.phrases else []
    prepare(args.reference, args.checkpoints, args.output, [p for p in phrases if p.strip()], args.device)
