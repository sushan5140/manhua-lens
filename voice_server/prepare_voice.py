"""Staged PRIVATE reference selection, official VAD extraction, comparison and export."""
import argparse
import hashlib
import json
import tempfile
import zipfile
from pathlib import Path

from voice_assets import cache_name, normalize_text, validate_wav
from setup_runtime import OPENVOICE_REV, MELO_REV, CHECKPOINT_REV

TEST_TEXT = '안녕하세요. 오늘도 한국어 공부를 시작해 볼까요?'
COMPARISON_TEXTS = ['안녕하세요.', '오늘은 날씨가 좋아요.', '한국어 공부를 시작해 볼까요?']


def pinned_vad(audio, **kwargs):
    from whisper_timestamped.transcribe import get_vad_segments
    # Pin the public Silero model tag rather than tracking changing master code.
    kwargs['method'] = 'silero:v5.1'
    return get_vad_segments(audio, **kwargs)


def select_reference(reference, work_dir, target_seconds=25):
    import librosa
    import numpy as np
    import soundfile as sf
    import torch
    from reference_selection import select_segments, safe_normalize

    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    info = sf.info(reference)
    if not 20 <= info.duration <= 600:
        raise ValueError('Supply 20–600s of clean speech; 20–30s will be selected')
    original, sr = sf.read(reference, dtype='float32', always_2d=True)
    if not np.isfinite(original).all():
        raise ValueError('Reference contains invalid samples')
    # Detect clipping before resampling/gain can hide it. Channels must not cancel.
    clipped = np.max(np.abs(original), axis=1) >= .995
    mono = original.mean(axis=1)
    if np.sqrt(np.mean(mono ** 2)) < .25 * np.sqrt(np.mean(original ** 2)):
        raise ValueError('Stereo channels cancel; choose the clean microphone channel manually')
    mono = librosa.resample(mono, orig_sr=sr, target_sr=16000)
    # Preserve clipping evidence on the VAD grid for acoustic screening.
    positions = np.minimum((np.arange(len(mono)) * sr / 16000).astype(int), len(clipped) - 1)
    clipping_mask = clipped[positions].copy()
    # Downsampling must not hide individual clipped input samples. Keep evidence
    # separate so screening never injects new peaks into the selected waveform.
    clipped_positions = np.minimum((np.flatnonzero(clipped) * 16000 / sr).astype(int), len(mono) - 1)
    clipping_mask[clipped_positions] = True
    vad_audio, _ = safe_normalize(mono)
    spans = pinned_vad(torch.from_numpy(vad_audio), output_sample=True,
                       min_speech_duration=.3, min_silence_duration=.25, dilatation=.05)

    def pitch_spread(chunk, rate):
        f0, voiced, _ = librosa.pyin(chunk, fmin=65, fmax=500, sr=rate,
                                    frame_length=1024, hop_length=256)
        pitches = f0[voiced & np.isfinite(f0)]
        if len(pitches) < 8:
            return None
        return float(12 * np.log2(np.percentile(pitches, 90) / np.percentile(pitches, 10)))

    selected, report = select_segments(mono, 16000,
        [(s['start'], s['end']) for s in spans], target_seconds, pitch_spread, clipping_mask)
    selected, gain = safe_normalize(selected)
    report.update(gain, input_seconds=info.duration, input_sample_rate=sr,
                  selected_sample_rate=16000, vad='silero:v5.1', rms_target_dbfs=-22,
                  peak_ceiling_dbfs=-3, normalization='mono, resample, DC removal, constant gain; no denoising')
    sf.write(work_dir / 'selected_reference.wav', selected, 16000, subtype='PCM_16')
    (work_dir / 'selection.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(f"Selected {report['selected_speech_seconds']:.1f}s. LISTEN and confirm one calm speaker before extraction.")


def extract_embedding(checkpoints, work_dir, device=None):
    import torch
    from openvoice import se_extractor
    from openvoice.api import ToneColorConverter

    root, work_dir = Path(checkpoints), Path(work_dir)
    selected = work_dir / 'selected_reference.wav'
    if not selected.is_file():
        raise ValueError('Run reference selection first')
    device = device or ('cuda:0' if torch.cuda.is_available() else 'cpu')
    converter = ToneColorConverter(str(root / 'converter/config.json'), device=device, enable_watermark=False)
    converter.load_ckpt(str(root / 'converter/checkpoint.pth'))
    if converter.version != 'v2':
        raise ValueError('Expected OpenVoice V2')
    # Official get_se remains authoritative for VAD splitting and extraction.
    # Only pin its VAD helper; never bypass get_se or reuse an old processed cache.
    previous = se_extractor.get_vad_segments
    se_extractor.get_vad_segments = pinned_vad
    try:
        with tempfile.TemporaryDirectory(prefix='official-vad-', dir=work_dir) as processed:
            target, _ = se_extractor.get_se(str(selected), converter, target_dir=processed, vad=True)
    finally:
        se_extractor.get_vad_segments = previous
    source_path = root / 'base_speakers/ses/kr.pth'
    source = torch.load(source_path, map_location=device, weights_only=True)
    if not isinstance(target, torch.Tensor) or target.shape != source.shape or not torch.isfinite(target).all():
        raise ValueError('Invalid target embedding or mismatch with kr.pth')
    if not torch.isfinite(source).all():
        raise ValueError('Invalid Korean source embedding')
    torch.save(target.detach().cpu(), work_dir / 'target_se.pth')
    report = {'method': 'openvoice.se_extractor.get_se(vad=True)', 'vad': 'silero:v5.1',
              'source_embedding': 'base_speakers/ses/kr.pth',
              'source_sha256': hashlib.sha256(source_path.read_bytes()).hexdigest(),
              'source_shape': list(source.shape), 'target_shape': list(target.shape),
              'selected_sha256': hashlib.sha256(selected.read_bytes()).hexdigest()}
    (work_dir / 'extraction.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('Official VAD extraction complete; Korean source embedding path/shape/finite values verified.')


def audio_metrics(path):
    import numpy as np
    import soundfile as sf
    from reference_selection import db

    audio, sr = sf.read(path, dtype='float32', always_2d=True)
    if not audio.size or not np.isfinite(audio).all():
        raise ValueError('Empty or invalid generated audio')
    mono = audio.mean(axis=1)
    frame = max(1, int(sr * .03))
    levels = [db(np.sqrt(np.mean(mono[i:i + frame] ** 2))) for i in range(0, len(mono), frame)]
    result = {'duration_seconds': len(audio) / sr, 'sample_rate': sr,
              'peak_dbfs': db(np.max(np.abs(audio))), 'rms_dbfs': db(np.sqrt(np.mean(audio ** 2))),
              'clipping_fraction': float(np.mean(np.abs(audio) >= .995)),
              'silent_frame_fraction': float(np.mean(np.array(levels) < -45))}
    if result['rms_dbfs'] < -45 or result['clipping_fraction'] > .001:
        raise ValueError('Generated audio is silent or clipped; do not export')
    return result


def generate_comparisons(checkpoints, work_dir, phrases=(), device=None):
    from engine import KoreanVoice, QUALITY_MODES

    work_dir = Path(work_dir)
    extraction = json.loads((work_dir / 'extraction.json').read_text(encoding='utf-8'))
    selected = work_dir / 'selected_reference.wav'
    if extraction['selected_sha256'] != hashlib.sha256(selected.read_bytes()).hexdigest():
        raise ValueError('Reference selection changed; rerun extraction before generation')
    texts = list(dict.fromkeys(normalize_text(t) for t in [*COMPARISON_TEXTS, TEST_TEXT, *phrases]))
    if len(texts) > 10000:
        raise ValueError('At most 10,000 phrases')
    voice = KoreanVoice(checkpoints, work_dir / 'target_se.pth', device)
    report = {'quality_accepted': False, 'settings': QUALITY_MODES,
              'source_embedding': str(voice.source_path.name), 'melo_speaker': 'KR',
              'seed': 5140, 'samples': [],
              'warning': 'Signal checks do not certify naturalness, pronunciation, or identity. Listen before export.'}
    for mode in QUALITY_MODES:
        cache = work_dir / mode / 'cache'
        cache.mkdir(parents=True, exist_ok=True)
        for index, text in enumerate(texts):
            diagnostics = work_dir / 'comparisons' / mode / f'{index:02d}' if index < 3 else None
            data = validate_wav(voice.synthesize(text, mode, diagnostics=diagnostics))
            path = cache / cache_name(text)
            path.write_bytes(data)
            metrics = audio_metrics(path)
            if diagnostics:
                sample = {'mode': mode, 'text': text, 'cloned': metrics,
                          'base': audio_metrics(diagnostics / 'base.wav'),
                          'self_conversion': audio_metrics(diagnostics / 'self.wav')}
                report['samples'].append(sample)
            print(f'Generated {mode} {index + 1}/{len(texts)}')
        # Only the current phrase set is eligible for export, never leftover cache.
    report['cache_names'] = [cache_name(t) for t in texts]
    report['embedding_sha256'] = hashlib.sha256((work_dir / 'target_se.pth').read_bytes()).hexdigest()
    (work_dir / 'quality_report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Comparisons ready. No bundle exported; listen and choose a mode or reject both.')


def export_bundle(work_dir, output, mode, accepted=False):
    from engine import QUALITY_MODES

    if not accepted:
        raise ValueError('Export requires explicit listening approval; current/old bundle is not accepted')
    work_dir, output = Path(work_dir), Path(output)
    report = json.loads((work_dir / 'quality_report.json').read_text(encoding='utf-8'))
    embedding = work_dir / 'target_se.pth'
    if report['embedding_sha256'] != hashlib.sha256(embedding.read_bytes()).hexdigest():
        raise ValueError('Embedding changed; regenerate comparisons first')
    extraction = json.loads((work_dir / 'extraction.json').read_text(encoding='utf-8'))
    if extraction['selected_sha256'] != hashlib.sha256((work_dir / 'selected_reference.wav').read_bytes()).hexdigest():
        raise ValueError('Selected reference changed; rerun extraction and comparison')
    files = []
    for name in report['cache_names']:
        if name != Path(name).name or not name.endswith('.wav'):
            raise ValueError('Invalid generated cache name')
        path = work_dir / mode / 'cache' / name
        validate_wav(path.read_bytes())
        audio_metrics(path)
        files.append(path)
    manifest = {'format': 'manhua-lens-private-v1', 'private': True,
                'language': 'KR', 'openvoice': OPENVOICE_REV, 'melo': MELO_REV,
                'checkpoints': CHECKPOINT_REV, 'phrases': len(files),
                'normalization': 'NFC+strip', 'quality_mode': mode,
                'settings': QUALITY_MODES[mode], 'listening_approved': True,
                'extraction': 'official get_se with VAD on selected 20–30s'}
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr('manifest.json', json.dumps(manifest))
        bundle.write(embedding, 'target_se.pth')
        for path in files:
            bundle.write(path, 'cache/' + path.name)
    print('PRIVATE approved bundle exported; no reference or diagnostics included.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', choices=['select', 'extract', 'compare', 'export'], required=True)
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--checkpoints', type=Path)
    parser.add_argument('--work-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--phrases', type=Path)
    parser.add_argument('--target-seconds', type=float, default=25)
    parser.add_argument('--mode', choices=['natural', 'similarity'], default='natural')
    parser.add_argument('--accept-quality', action='store_true')
    parser.add_argument('--device', choices=['cpu', 'cuda:0'])
    args = parser.parse_args()
    if args.stage == 'select':
        if not args.reference:
            parser.error('--reference required for selection')
        select_reference(args.reference, args.work_dir, args.target_seconds)
    elif args.stage == 'extract':
        if not args.checkpoints:
            parser.error('--checkpoints required for extraction')
        extract_embedding(args.checkpoints, args.work_dir, args.device)
    elif args.stage == 'compare':
        if not args.checkpoints:
            parser.error('--checkpoints required for comparison')
        phrases = args.phrases.read_text(encoding='utf-8').splitlines() if args.phrases else []
        generate_comparisons(args.checkpoints, args.work_dir, [p for p in phrases if p.strip()], args.device)
    else:
        if not args.output:
            parser.error('--output required for export')
        export_bundle(args.work_dir, args.output, args.mode, args.accept_quality)
