# Local Korean OpenVoice service

This optional service gives Manhua Lens a consented cloned Korean voice without uploading the speaker recording to GitHub or a cloud provider.

## Privacy

The speaker recording is deliberately ignored by Git. Keep it local. Never commit a person's reference recording or extracted speaker embedding unless they explicitly agreed to that public distribution.

## Setup

OpenVoice V2 officially documents Linux/Python 3.9 as its primary developer setup. On Windows, WSL2 is the most reliable free route.

1. Clone OpenVoice beside this folder or set `OPENVOICE_ROOT` to your clone.
2. Follow OpenVoice V2 installation and download `checkpoints_v2`.
3. Install MeloTTS and run `python -m unidic download`.
4. Install the server dependencies:
   `pip install -r requirements.txt`
5. Put the consented reference recording at:
   `voice_server/voice_reference.wav`
   or set `MANHUA_VOICE_REFERENCE` to its full path.
6. Start:
   `uvicorn server:app --host 127.0.0.1 --port 8765`

Check `http://127.0.0.1:8765/health`. Manhua Lens automatically uses this voice for Korean. If the server is offline, it falls back to the installed device Korean voice.

## Speech pacing

The server synthesizes at `KOREAN_SPEED = 0.95` in `server.py`, which measures about 5 syllables per second with natural pauses at sentence ends (native conversational reading pace). Keep it there: the Speech speed setting in the extension is applied only at playback time, with pitch preserved, and defaults to 1.0×.

Text selected across speech bubbles often has line breaks but no punctuation. `speech_text.py` turns each line break into a short clause pause and each blank line into a sentence pause, so bubbles are not read as one run-on sentence.

## ChatGPT study flow

Manhua Lens already injects into normal webpages. On ChatGPT, select a Korean word or phrase, use the Manhua Lens speaker control, and the extension requests this local service. Audio plays in an extension offscreen document so page CSP restrictions do not block it.
