"""Reproducible model setup inside a Python 3.10 venv (Windows or notebook)."""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

OPENVOICE_REV = "74a1d147b17a8c3092dd5430504bd83ef6c7eb23"
MELO_REV = "209145371cff8fc3bd60d7be902ea69cbdb7965a"
CHECKPOINT_REV = "f36e7edfe1684461a8343844af60babc2efbb727"
HERE = Path(__file__).resolve().parent


def run(*args):
    subprocess.run([str(a) for a in args], check=True)


def download_checkpoints(destination):
    from huggingface_hub import hf_hub_download

    destination = Path(destination)
    # Only the converter and Korean base speaker are needed for this pipeline.
    files = ["converter/config.json", "converter/checkpoint.pth", "base_speakers/ses/kr.pth"]
    if all((destination / name).is_file() for name in files):
        return
    for name in files:
        cached = hf_hub_download("myshell-ai/OpenVoiceV2", name, revision=CHECKPOINT_REV)
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(target.suffix + ".partial")
        shutil.copyfile(cached, partial)
        partial.replace(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--torch-index", choices=["cpu", "cu121"], default="cpu")
    parser.add_argument("--checkpoints", type=Path, default=HERE / "OpenVoice/checkpoints_v2")
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 10) or sys.prefix == sys.base_prefix:
        raise SystemExit("Run this with Python 3.10 inside an isolated venv. See README.md.")
    pip = [sys.executable, "-m", "pip"]
    run(*pip, "install", "pip==24.3.1", "setuptools==69.5.1", "wheel==0.45.1")
    run(*pip, "install", "torch==2.5.1", "torchaudio==2.5.1", "--index-url",
        "https://download.pytorch.org/whl/" + args.torch_index)
    run(*pip, "install", "-r", HERE / "requirements-models.txt", "-r", HERE / "requirements.txt")
    # Install audited inference dependencies explicitly, avoiding old OpenVoice ASR
    # pins and unused Gradio servers. No faster-whisper/Whisper extraction is used.
    for repo, revision in [("OpenVoice", OPENVOICE_REV), ("MeloTTS", MELO_REV)]:
        run(*pip, "install", "--no-deps", "--no-build-isolation",
            f"https://github.com/myshell-ai/{repo}/archive/{revision}.zip")
    run(sys.executable, "-m", "nltk.downloader", "-d", Path(sys.prefix) / "nltk_data",
        "cmudict", "averaged_perceptron_tagger", "punkt")
    # Melo's eager Japanese cleaner imports require the dictionary even for KR.
    run(sys.executable, "-m", "unidic", "download")
    run(sys.executable, "-c", "import sys; sys.path.insert(0, " + repr(str(HERE)) + "); from korean_frontend import create_phonemizer; assert create_phonemizer()('안녕하세요'); print('Korean phonemizer OK')")
    download_checkpoints(args.checkpoints)
    run(sys.executable, "-c", "from melo.api import TTS; from openvoice.api import ToneColorConverter; print('Model imports OK')")
    marker = {"openvoice": OPENVOICE_REV, "melo": MELO_REV, "checkpoints": CHECKPOINT_REV,
              "torch": "2.5.1", "index": args.torch_index}
    (Path(sys.prefix) / "manhua-ready.json").write_text(json.dumps(marker), encoding="utf-8")
    print("Runtime installed. Model weights/tokenizers may download on first inference.")


if __name__ == "__main__":
    main()
