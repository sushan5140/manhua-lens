# Korean custom voice: notebook preparation + local browser playback

The default is a **model-free local phrase cache**. Generate Korean audio with
OpenVoice V2 + MeloTTS in a free Kaggle/Colab session, download your private bundle,
and serve it locally with Python's standard library. No WSL, GPU, pip packages,
or ML models are needed locally for this mode.

It speaks only phrases you prepared. Unknown text immediately returns HTTP 404,
which triggers Manhua Lens's existing Windows/browser Korean voice fallback.
For arbitrary new text in the cloned voice, optional `live` mode still needs
MeloTTS, its text dependencies, and the OpenVoice converter on your PC. A speaker
embedding is not a standalone TTS model. CPU inference may exceed the extension's
45-second timeout; device fallback remains available.

## 1. Prepare in a free notebook

Open `kaggle_prepare.ipynb` in a PRIVATE Kaggle notebook. Enable Internet and choose
a free GPU if available. CPU also works more slowly (set `TORCH_INDEX = 'cpu'`).
The notebook is self-contained: its public helper source is embedded, so it works
before these repository changes are pushed. It also works in free Colab.

Run cells interactively in order. Setup creates an isolated Python 3.10 environment,
pins PyTorch/torchaudio 2.5.1 and NumPy 1.26.4, installs specific upstream source
revisions, and downloads the V2 converter and Korean source embedding. The
checkpoints come from the official `myshell-ai/OpenVoiceV2` Hugging Face repository,
pinned to `f36e7edfe1684461a8343844af60babc2efbb727`; the old GitHub-documented
S3 `myshell-public-repo-host` download returned 404 during verification. The host
notebook Python and preinstalled packages are left intact. Upstream OpenVoice's
old NumPy pin and unused Whisper/faster-whisper/Gradio dependencies are deliberately
bypassed; Melo's eagerly imported language cleaners still need their dependencies
and UniDic. This reduces dependencies but does not make full inference tiny.
The Korean frontend uses prebuilt `python-mecab-ko` on both platforms through a
small g2pkk subclass. This avoids g2pkk's implicit Windows `eunjeon` installation,
which required C++ Build Tools in our test.

Upload `openvoice_reference_korean_full.wav` through the session upload widget.
Do NOT use Kaggle Add Data / Dataset upload. If widgets are unavailable, use the
included Colab session-upload fallback. Use clean single-speaker speech, without
music or other voices. The extractor averages short chunks from this prepared WAV;
it does not run ASR or promise to clean a noisy recording.

Edit `PHRASES` to include individual words and sentences you expect to select.
The original test sentence is always generated:

> 안녕하세요. 오늘도 한국어 공부를 시작해 볼까요?

Listen, then download `manhua-private.zip`. Exact punctuation and internal spaces
matter; matching normalizes Unicode NFC and trims outer whitespace only. More
phrases can be prepared in a later session; importing a bundle merges its cache.
Use a separate asset directory for a different speaker to avoid mixing voices.

## 2. Start on Windows

Prerequisite: free Python 3 from https://www.python.org/downloads/windows/.
Cache mode supports Python 3.9+. From the repository folder, one command imports
and starts the private cache:

```powershell
.\voice_server\start.cmd -Bundle "C:\Users\YOU\Downloads\manhua-private.zip"
```

Subsequent starts:

```powershell
.\voice_server\start.cmd
```

Keep the terminal running; Ctrl+C stops it. Check
http://127.0.0.1:8765/health (`mode: cache`, number of prepared phrases).
Select Korean text in any normal webpage and use the existing Manhua Lens speaker.
Offscreen audio playback, UI, automatic Hangul detection, and non-Korean behavior
are preserved. Install a Korean Windows/browser voice for fallback if needed.

Optional launcher arguments: `-Python "C:\path\python.exe"` and
`-Assets "C:\path\private-voice"`. Import only bundles you generated yourself.
No service is exposed beyond 127.0.0.1. Cache playback accepts extension origins
and local command-line clients; it does not serve files or embeddings by URL.

## Optional: live arbitrary-text cloning on Windows

```powershell
.\voice_server\start.cmd -Mode live -Bundle "C:\Users\YOU\Downloads\manhua-private.zip"
```

This one command bootstraps uv and a dedicated Python 3.10 environment, installs
CPU PyTorch/MeloTTS/OpenVoice dependencies, downloads public checkpoints, and starts
Uvicorn. First setup and model/tokenizer downloads can be large (multiple GB) and
slow. No paid API or WSL is required by the launcher. Native Windows compatibility
still depends on upstream wheels/dictionaries and must be verified on your PC.
A failed setup exits with an error; default cache mode remains usable. Remove only
`.runtime/manhua-ready.json` to retry setup after a dependency change.

The server loads `private/target_se.pth` with tensor-only deserialization. It never
needs the friend's raw WAV and no longer re-extracts the speaker on every startup.
Concurrent live requests are rejected as busy (503) rather than running model
inference simultaneously. Generated live audio is temporary and not cached to disk.
The bundle's prepared cache is checked before model inference.

Advanced manual startup from `voice_server` inside a prepared environment:

```text
uvicorn server:app --host 127.0.0.1 --port 8765 --no-access-log
```

Environment overrides: `MANHUA_VOICE_ASSETS`, `MANHUA_VOICE_EMBEDDING`,
`OPENVOICE_CHECKPOINTS`, `OPENVOICE_ROOT`, `MANHUA_VOICE_DEVICE`.
Migration from PR #6: `MANHUA_VOICE_REFERENCE` is replaced by the prepared embedding.
To prepare manually in a compatible environment:

```text
python prepare_voice.py --reference /private/openvoice_reference_korean_full.wav --checkpoints /models/checkpoints_v2 --output /private/manhua-private.zip --phrases /private/phrases.txt
```

## Can Kaggle serve Manhua Lens live?

**Not directly, and not as a dependable everyday free backend for this integration.**
Your browser's `127.0.0.1` refers to your PC, not a Kaggle VM. Kaggle provides bounded
notebook sessions, not a stable public inference URL for this service. A temporary
outbound tunnel plus extension endpoint/permission changes could make a demo work,
but adds exposure, authentication, and session-expiry problems. This implementation
neither opens a tunnel nor claims notebook hosting solves local live inference.
Use Kaggle for preparation; use cache mode for the smallest local footprint.

Sources checked for this implementation:
- OpenVoice V2 setup: https://github.com/myshell-ai/OpenVoice/blob/main/docs/USAGE.md
- MeloTTS dependencies/API: https://github.com/myshell-ai/MeloTTS
- Kaggle sessions: https://www.kaggle.com/docs/notebooks#technical-specifications

## Privacy and exported contents

The friend consented to cloning; these assets must still never enter the public repo.
The ZIP explicitly contains only `manifest.json`, `target_se.pth`, and
`cache/<sha256-of-normalized-text>.wav`. The embedding and generated cloned speech
are PRIVATE too. Hash filenames are identifiers, not encryption.
The ZIP excludes the raw reference and intermediate reference chunks. Public model
weights are downloaded separately for live mode, not packed into this small bundle.

All raw audio/chunks stay under `/tmp` in the notebook session, not a Dataset or
`/kaggle/working`. Preview audio and the download link contain private bytes:
**clear ALL outputs before saving/exporting; do not Save Version / publish with
those outputs.** Download first, run cleanup, then end/delete the session. Session
storage is not a promise about the platform's retention practices. Keep the notebook
private throughout and do not enable persistent session files for this workflow.

Locally `private/`, generated WAVs, audio, embeddings, model directories, and ZIPs
are gitignored. Never force-add them. Do not export an executed notebook to GitHub.
Only source and empty-output notebooks belong in the public repository.

## Verification

After editing embedded helpers, run `python voice_server/sync_notebook.py` to
refresh the notebook's public source and clear execution outputs before committing.

From repository root:

```text
python -m unittest discover -s tests -p "test_voice*.py" -v
node tests/smoke.mjs
node tests/tts.mjs
```

The Python tests cover real loopback HTTP cache playback, invalid requests, misses,
corrupt WAVs, private import allowlisting, and optional live API behavior with a fake
engine (install `voice_server/requirements.txt` and `httpx` for live API tests).
Model-free tests use synthetic silence, never a person's recording. Notebook cells
are syntax/format checked with no execution outputs. Neural synthesis, GPU speed,
voice similarity, and the Kaggle upload/download UI require an actual private
session; passing unit tests does not certify those.
