"""Optional full OpenVoice V2 + MeloTTS Korean inference."""
import tempfile
import threading
from pathlib import Path

QUALITY_MODES = {
    "natural": {"speed": 1.0, "sdp_ratio": 0.2, "noise_scale": 0.6, "noise_scale_w": 0.8, "tau": 0.3},
    # Experimental alternative, NOT a guaranteed similarity improvement.
    "similarity": {"speed": 0.98, "sdp_ratio": 0.15, "noise_scale": 0.5, "noise_scale_w": 0.7, "tau": 0.25},
}


class KoreanVoice:
    def __init__(self, checkpoints, embedding, device=None):
        import torch
        from melo.api import TTS
        from openvoice.api import ToneColorConverter
        from melo.text import korean
        from korean_frontend import create_phonemizer

        korean.g2p_kr = create_phonemizer()

        self.lock = threading.Lock()
        self.device = device or ("cuda:0" if torch.cuda.is_available() else "cpu")
        root = Path(checkpoints)
        self.converter = ToneColorConverter(str(root / "converter/config.json"), device=self.device)
        self.converter.load_ckpt(str(root / "converter/checkpoint.pth"))
        if self.converter.version != "v2":
            raise ValueError("Expected OpenVoice V2 converter checkpoints")
        self.target = torch.load(embedding, map_location=self.device, weights_only=True)
        if not isinstance(self.target, torch.Tensor) or self.target.ndim != 3 or not torch.isfinite(self.target).all():
            raise ValueError("Invalid target speaker embedding")
        self.model = TTS(language="KR", device=self.device)
        speakers = self.model.hps.data.spk2id
        if "KR" not in speakers:
            raise RuntimeError("Expected the MeloTTS Korean KR speaker")
        self.speaker = speakers["KR"]
        self.source_path = root / "base_speakers/ses/kr.pth"
        self.source = torch.load(self.source_path, map_location=self.device, weights_only=True)
        if not isinstance(self.source, torch.Tensor) or not torch.isfinite(self.source).all():
            raise ValueError("Invalid Korean source embedding")
        if self.target.shape != self.source.shape:
            raise ValueError("Target embedding does not match OpenVoice V2")

    def synthesize(self, text, mode="natural", diagnostics=None, seed=5140):
        import torch

        settings = QUALITY_MODES[mode]
        if not self.lock.acquire(blocking=False):
            raise RuntimeError("Voice service is busy")
        try:
            with tempfile.TemporaryDirectory(prefix="mhl-tts-") as tmp:
                source, output = Path(tmp) / "source.wav", Path(tmp) / "cloned.wav"
                # Seed locally so comparisons use repeatable Melo and conversion noise.
                with torch.random.fork_rng(devices=[torch.device(self.device)] if "cuda" in self.device else []):
                    torch.manual_seed(seed)
                    self.model.tts_to_file(text, self.speaker, str(source), quiet=True,
                                          **{k: v for k, v in settings.items() if k != "tau"})
                    torch.manual_seed(seed)
                    self.converter.convert(audio_src_path=str(source), src_se=self.source,
                                           tgt_se=self.target, output_path=str(output),
                                           tau=settings["tau"], message="@ManhuaLens")
                    if diagnostics is not None:
                        import shutil
                        diagnostics = Path(diagnostics)
                        diagnostics.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(source, diagnostics / "base.wav")
                        shutil.copyfile(output, diagnostics / "cloned.wav")
                        # Source->source conversion isolates converter artifacts from identity transfer.
                        torch.manual_seed(seed)
                        self.converter.convert(audio_src_path=str(source), src_se=self.source,
                                               tgt_se=self.source, output_path=str(diagnostics / "self.wav"),
                                               tau=settings["tau"], message="@ManhuaLens")
                return output.read_bytes()
        finally:
            self.lock.release()
