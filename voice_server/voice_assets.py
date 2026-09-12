"""Private phrase-cache format shared by preparation and playback."""
import hashlib
import io
import json
import re
import unicodedata
import wave
import zipfile
from pathlib import Path

MAX_WAV = 32 * 1024 * 1024


def normalize_text(text):
    if not isinstance(text, str):
        raise ValueError("text must be a string")
    text = unicodedata.normalize("NFC", text).strip()
    if not text or len(text) > 400:
        raise ValueError("text must contain 1–400 characters")
    return text


def cache_name(text):
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest() + ".wav"


def validate_wav(data):
    if len(data) > MAX_WAV:
        raise ValueError("WAV is too large")
    try:
        with wave.open(io.BytesIO(data), "rb") as audio:
            if audio.getnframes() == 0 or audio.getnchannels() not in (1, 2):
                raise ValueError("Empty or unsupported WAV")
            expected = audio.getnframes() * audio.getnchannels() * audio.getsampwidth()
            if len(audio.readframes(audio.getnframes())) != expected:
                raise ValueError("Truncated WAV")
    except (wave.Error, EOFError) as exc:
        raise ValueError("Expected a PCM WAV") from exc
    return data


def read_cached(root, text):
    path = Path(root) / "cache" / cache_name(text)
    if not path.is_file():
        return None
    if path.stat().st_size > MAX_WAV:
        raise ValueError("WAV is too large")
    return validate_wav(path.read_bytes())


def import_bundle(archive, destination):
    """Import only explicit asset names; never extract arbitrary archive paths."""
    destination = Path(destination)
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        if len(infos) > 10002 or sum(i.file_size for i in infos) > 512 * 1024 * 1024:
            raise ValueError("Bundle exceeds the 512 MiB / 10,000 phrase limit")
        names = [i.filename for i in infos]
        if len(names) != len(set(names)) or "manifest.json" not in names:
            raise ValueError("Missing manifest or duplicate bundle entries")
        for info in infos:
            name = info.filename
            if name not in ("manifest.json", "target_se.pth") and not re.fullmatch(r"cache/[0-9a-f]{64}\.wav", name):
                raise ValueError("Unexpected bundle entry: " + name)
            if info.file_size > (MAX_WAV if name.endswith(".wav") else 1024 * 1024):
                raise ValueError("Oversized bundle entry: " + name)
        manifest = json.loads(bundle.read("manifest.json"))
        if not isinstance(manifest, dict) or manifest.get("format") != "manhua-lens-private-v1":
            raise ValueError("Unsupported private bundle format")
        for name in names:
            if name.endswith(".wav"):
                validate_wav(bundle.read(name))
        destination.mkdir(parents=True, exist_ok=True)
        for name in names:
            target = destination / name
            if destination.is_symlink() or target.is_symlink() or target.parent.is_symlink():
                raise ValueError("Refusing a symlink in the private asset directory")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(bundle.read(name))


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Import your own PRIVATE Kaggle bundle")
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    import_bundle(args.archive, args.destination)
    print("Private assets imported. Do not commit or share this directory.")
