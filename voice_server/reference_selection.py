"""Conservative acoustic screening; not diarization or a perceptual quality judge."""
import numpy as np


def db(value):
    return float(20 * np.log10(max(float(value), 1e-8)))


def safe_normalize(audio, target_db=-22.0, peak_db=-3.0):
    audio = np.asarray(audio, dtype=np.float32)
    if not audio.size or not np.isfinite(audio).all():
        raise ValueError('Invalid reference samples')
    # One constant gain preserves dynamics; no compression, limiting or denoising.
    audio = audio - np.mean(audio)
    rms = float(np.sqrt(np.mean(audio ** 2)))
    peak = float(np.max(np.abs(audio)))
    if rms < 1e-5:
        raise ValueError('Reference is silent')
    gain = min(10 ** (target_db / 20) / rms, 10 ** (peak_db / 20) / peak, 4.0)
    return audio * gain, {'gain_db': db(gain), 'rms_dbfs': db(rms * gain), 'peak_dbfs': db(peak * gain)}


def select_segments(audio, sr, intervals, target_seconds=25, pitch_spread=None, clipping_mask=None):
    """Screen unnormalized VAD speech; rank calm blocks and select 20–30 seconds.

    Pitch spread is an optional callback returning a robust semitone range.
    Noise estimates use VAD-negative audio. They are proxies, not measured SNR.
    """
    if not 20 <= target_seconds <= 30:
        raise ValueError('Target duration must be 20–30 seconds')
    audio = np.asarray(audio, dtype=np.float32)
    if not audio.size or not np.isfinite(audio).all():
        raise ValueError('Invalid audio')
    clipped = np.abs(audio) >= .995
    if clipping_mask is not None:
        evidence = np.asarray(clipping_mask, dtype=bool)
        if evidence.shape != audio.shape:
            raise ValueError('Clipping mask must match the audio')
        clipped |= evidence
    mask = np.zeros(len(audio), dtype=bool)
    bounded = []
    last_end = 0
    for start, end in sorted(intervals):
        start, end = max(last_end, int(start)), min(len(audio), int(end))
        if end <= start:
            continue
        bounded.append((start, end))
        mask[start:end] = True
        last_end = end
    frame = max(1, int(sr * .03))
    noise_frames = [float(np.sqrt(np.mean(audio[i:i + frame] ** 2)))
                    for i in range(0, len(audio) - frame + 1, frame)
                    if not mask[i:i + frame].any()]
    noise = max(float(np.percentile(noise_frames, 75)), 1e-5) if noise_frames else None
    candidates, rejected = [], []
    for start, end in bounded:
        # Equal blocks avoid a tiny tail; retaining whole VAD spans avoids long blanks.
        count = max(1, int(np.ceil((end - start) / (5 * sr))))
        edges = np.linspace(start, end, count + 1, dtype=int)
        for a, b in zip(edges[:-1], edges[1:]):
            chunk = audio[a:b]
            duration = (b - a) / sr
            rms = float(np.sqrt(np.mean(chunk ** 2)))
            levels = np.array([db(np.sqrt(np.mean(chunk[i:i + frame] ** 2)))
                               for i in range(0, len(chunk) - frame + 1, frame)])
            clipping = float(np.mean(clipped[a:b]))
            spread = float(np.percentile(levels, 90) - np.percentile(levels, 20)) if levels.size else 99.0
            snr = db(rms / noise) if noise is not None else None
            pitch = pitch_spread(chunk, sr) if pitch_spread else None
            reasons = []
            if duration < 1.5:
                reasons.append('too_short')
            if db(rms) < -38:
                reasons.append('low_volume')
            if clipping > .0005:
                reasons.append('clipping')
            if snr is not None and snr < 12:
                reasons.append('poor_speech_to_background_proxy')
            if spread > 18 or (pitch is not None and pitch > 14):
                reasons.append('large_expression_proxy')
            item = {'start_seconds': a / sr, 'end_seconds': b / sr, 'duration': duration,
                    'rms_dbfs': db(rms), 'clipping_fraction': clipping,
                    'level_spread_db': spread, 'background_margin_db': snr,
                    'pitch_spread_semitones': pitch, 'reasons': reasons}
            if reasons:
                rejected.append(item)
            else:
                # Prefer lower variation and stronger speech/background margin.
                score = spread + (pitch or 0) * .5 - min(snr or 20, 40) * .2
                candidates.append((score, a, b, item))
    chosen, total = [], 0.0
    for _, a, b, item in sorted(candidates, key=lambda entry: entry[0]):
        remaining = target_seconds - total
        if remaining < 1.5:
            break
        if (b - a) / sr > remaining:
            b = a + int(remaining * sr)
            item = dict(item, end_seconds=b / sr, duration=(b - a) / sr)
        chosen.append((a, b, item))
        total += (b - a) / sr
    if total < 20:
        raise ValueError(f'Only {total:.1f}s passes screening; provide 20–30s of calmer clean speech. Do not relax checks blindly.')
    chosen.sort(key=lambda entry: entry[0])
    # Brief separator prevents discontinuities from turning into false sustained speech.
    pieces = []
    for a, b, _ in chosen:
        chunk = audio[a:b].copy()
        fade = min(int(sr * .005), len(chunk) // 2)
        chunk[:fade] *= np.linspace(0, 1, fade)
        chunk[-fade:] *= np.linspace(1, 0, fade)
        pieces.extend([chunk, np.zeros(int(sr * .08), dtype=np.float32)])
    return np.concatenate(pieces[:-1]), {'selected_speech_seconds': total,
        'selected': [item for _, _, item in chosen], 'rejected': rejected,
        'candidate_count': len(candidates), 'noise_estimate_dbfs': db(noise) if noise is not None else None,
        'warning': 'VAD/acoustics cannot verify one speaker, no music, or perceptual quality. Listen before extraction.'}
