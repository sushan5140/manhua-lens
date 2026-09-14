import io
import hashlib
import json
import sys
import tempfile
import types
import unittest
import wave
import zipfile
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'voice_server'))
from reference_selection import select_segments, safe_normalize  # noqa: E402
import prepare_voice as prep  # noqa: E402
from engine import QUALITY_MODES  # noqa: E402


def wave_bytes():
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        # Audible synthetic harmonic test signal, not a cloned or private voice.
        signal = (.12 * np.sin(2 * np.pi * 180 * np.arange(16000) / 16000) * 32767).astype('<i2')
        audio.writeframes(signal.tobytes())
    return stream.getvalue()


class SelectionTests(unittest.TestCase):
    def test_clean_speech_selection_rejects_clips_quiet_noise_and_expression(self):
        sr = 1000
        samples, intervals, cursor = [], [], 0
        for kind in ['clean'] * 8 + ['clipped', 'quiet', 'expressive', 'noisy']:
            pause = np.zeros(sr)
            chunk = .1 * np.sin(2 * np.pi * 110 * np.arange(sr * 4) / sr)
            if kind == 'clipped':
                chunk[:100] = 1.0
            elif kind == 'quiet':
                chunk *= .001
            elif kind == 'expressive':
                chunk[:sr * 2] *= .02
            elif kind == 'noisy':
                chunk *= .03
            samples.extend([pause, chunk])
            intervals.append((cursor + sr, cursor + sr * 5))
            cursor += sr * 5
        audio = np.concatenate(samples)
        selected, report = select_segments(audio, sr, intervals, 25)
        self.assertGreaterEqual(report['selected_speech_seconds'], 20)
        self.assertLessEqual(report['selected_speech_seconds'], 25)
        self.assertLess(len(selected) / sr, 27)
        reasons = {r for item in report['rejected'] for r in item['reasons']}
        self.assertIn('clipping', reasons)
        self.assertIn('low_volume', reasons)
        self.assertIn('large_expression_proxy', reasons)
        self.assertTrue(all(i['start_seconds'] < 40 for i in report['selected']))

    def test_noise_and_wide_pitch_fail_instead_of_padding_to_duration(self):
        rng = np.random.default_rng(5140)
        audio = rng.normal(0, .05, 40000).astype('float32')
        intervals = [(i * 5000 + 1000, i * 5000 + 5000) for i in range(8)]
        with self.assertRaisesRegex(ValueError, 'Only'):
            select_segments(audio, 1000, intervals)
        clean = .1 * np.sin(2 * np.pi * 120 * np.arange(30000) / 1000)
        with self.assertRaisesRegex(ValueError, 'Only'):
            select_segments(clean, 1000, [(0,30000)], pitch_spread=lambda *_: 20)

    def test_constant_normalization_preserves_timbre_and_peak_headroom(self):
        audio = .3 * np.sin(2 * np.pi * 130 * np.arange(30000) / 1000) + .01
        normalized, report = safe_normalize(audio)
        self.assertLessEqual(float(np.max(np.abs(normalized))), 10 ** (-3 / 20) + 1e-6)
        centered = audio - audio.mean()
        self.assertGreater(np.corrcoef(centered, normalized)[0,1], .99999)
        self.assertLessEqual(report['gain_db'], 12.05)
        with self.assertRaises(ValueError):
            safe_normalize(np.zeros(100))


class OfficialExtractionTests(unittest.TestCase):
    def test_comparisons_export_only_current_approved_mode_and_detect_stale_embedding(self):
        try:
            import soundfile  # noqa: F401
        except ImportError:
            self.skipTest('SoundFile required for actual WAV signal checks')

        class SyntheticVoice:
            source_path = Path('kr.pth')

            def __init__(self, *args):
                pass

            def synthesize(self, text, mode, diagnostics=None):
                data = wave_bytes()
                if diagnostics:
                    diagnostics.mkdir(parents=True, exist_ok=True)
                    for name in ['base.wav', 'self.wav', 'cloned.wav']:
                        (diagnostics / name).write_bytes(data)
                return data

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            selected = root / 'selected_reference.wav'
            selected.write_bytes(wave_bytes())
            (root / 'target_se.pth').write_bytes(b'synthetic-placeholder')
            (root / 'extraction.json').write_text(json.dumps({
                'selected_sha256': hashlib.sha256(selected.read_bytes()).hexdigest()}))
            stale = root / 'natural/cache/stale.wav'
            stale.parent.mkdir(parents=True)
            stale.write_bytes(wave_bytes())
            with patch('engine.KoreanVoice', SyntheticVoice):
                prep.generate_comparisons(root, root, [], 'cpu')
            report = json.loads((root / 'quality_report.json').read_text(encoding='utf-8'))
            self.assertFalse(report['quality_accepted'])
            self.assertEqual(len(report['samples']), 6)
            self.assertGreater(report['samples'][0]['base']['rms_dbfs'], -45)
            output = root / 'approved.zip'
            prep.export_bundle(root, output, 'natural', accepted=True)
            with zipfile.ZipFile(output) as bundle:
                names = bundle.namelist()
                self.assertEqual(len(names), len(report['cache_names']) + 2)
                self.assertNotIn('cache/stale.wav', names)
                self.assertNotIn('selected_reference.wav', names)
                self.assertTrue(json.loads(bundle.read('manifest.json'))['listening_approved'])
            (root / 'target_se.pth').write_bytes(b'changed-placeholder')
            with self.assertRaisesRegex(ValueError, 'Embedding changed'):
                prep.export_bundle(root, root / 'stale.zip', 'natural', accepted=True)

    def test_official_vad_call_fresh_directory_and_correct_kr_embedding(self):
        class Tensor:
            shape = (1, 256, 1)

            def detach(self):
                return self

            def cpu(self):
                return self

        calls, processed = [], []
        original_helper = object()
        extractor = types.ModuleType('openvoice.se_extractor')
        extractor.get_vad_segments = original_helper

        def get_se(audio, converter, target_dir, vad):
            self.assertTrue(vad)
            self.assertEqual(Path(audio).name, 'selected_reference.wav')
            self.assertIs(extractor.get_vad_segments, prep.pinned_vad)
            self.assertTrue(Path(target_dir).is_dir())
            processed.append(target_dir)
            return Tensor(), 'official-name'

        extractor.get_se = get_se
        package = types.ModuleType('openvoice')
        package.se_extractor = extractor
        api = types.ModuleType('openvoice.api')

        class Converter:
            version = 'v2'

            def __init__(self, *args, **kwargs):
                self.device = kwargs['device']
                self.assert_watermark = kwargs['enable_watermark']

            def load_ckpt(self, path):
                calls.append(path)

        api.ToneColorConverter = Converter
        torch = types.ModuleType('torch')
        torch.Tensor = Tensor
        torch.isfinite = lambda _: np.array([True])

        def load(path, **kwargs):
            self.assertEqual(Path(path).as_posix().split('/')[-3:], ['base_speakers', 'ses', 'kr.pth'])
            self.assertTrue(kwargs['weights_only'])
            return Tensor()

        torch.load = load
        torch.save = lambda tensor, path: Path(path).write_bytes(b'test-tensor-placeholder')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'selected_reference.wav').write_bytes(wave_bytes())
            (root / 'models/base_speakers/ses').mkdir(parents=True)
            (root / 'models/base_speakers/ses/kr.pth').write_bytes(b'public-source-placeholder')
            with patch.dict(sys.modules, {'torch':torch, 'openvoice':package,
                                          'openvoice.api':api, 'openvoice.se_extractor':extractor}):
                for _ in range(2):
                    prep.extract_embedding(root / 'models', root, 'cpu')
            self.assertIs(extractor.get_vad_segments, original_helper)
            self.assertNotEqual(processed[0], processed[1])
            self.assertTrue(all(not Path(p).exists() for p in processed))
            report = json.loads((root / 'extraction.json').read_text())
            self.assertEqual(report['source_embedding'], 'base_speakers/ses/kr.pth')
            self.assertEqual(report['method'], 'openvoice.se_extractor.get_se(vad=True)')

    def test_quality_modes_are_distinct_and_export_is_not_automatic(self):
        self.assertNotEqual(QUALITY_MODES['natural'], QUALITY_MODES['similarity'])
        self.assertEqual(len(prep.COMPARISON_TEXTS), 3)
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'never-exported.zip'
            with self.assertRaisesRegex(ValueError, 'listening approval'):
                prep.export_bundle(tmp, output, 'natural')
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
