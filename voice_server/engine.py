"""Optional full OpenVoice V2 + MeloTTS Korean inference."""
import tempfile
import threading
from pathlib import Path


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
        self.target = torch.load(embedding, map_location=self.device, weights_only=True)
        if not isinstance(self.target, torch.Tensor) or self.target.ndim != 3 or not torch.isfinite(self.target).all():
            raise ValueError("Invalid target speaker embedding")
        self.model = TTS(language="KR", device=self.device)
        speakers = self.model.hps.data.spk2id
        if "KR" not in speakers:
            raise RuntimeError("Expected the MeloTTS Korean KR speaker")
        self.speaker = speakers["KR"]
        self.source = torch.load(root / "base_speakers/ses/kr.pth", map_location=self.device, weights_only=True)
        if self.target.shape != self.source.shape:
            raise ValueError("Target embedding does not match OpenVoice V2")

    def synthesize(self, text):
        if not self.lock.acquire(blocking=False):
            raise RuntimeError("Voice service is busy")
        try:
            with tempfile.TemporaryDirectory(prefix="mhl-tts-") as tmp:
                source, output = Path(tmp) / "source.wav", Path(tmp) / "cloned.wav"
                self.model.tts_to_file(text, self.speaker, str(source), speed=0.95, quiet=True)
                self.converter.convert(audio_src_path=str(source), src_se=self.source,
                                       tgt_se=self.target, output_path=str(output), message="@ManhuaLens")
                return output.read_bytes()
        finally:
            self.lock.release()
