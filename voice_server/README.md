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

## Azure Korean voice choices (Sun-Hi and Hyunsu Multilingual)

The extension now supports two opt-in Azure Speech voices:
- **Sun-Hi (female)**: `ko-KR-SunHiNeural`
- **Hyunsu Multilingual (male)**: `ko-KR-HyunsuMultilingualNeural`

Select either voice from the Voice menu beside Pace on the reading panel, or from the extension settings. `Auto` stays the default so current users keep their existing MeloTTS/device fallback. Pace choices 0.75–1.25× apply to both voices at playback.

**Required:** Your own Azure Speech resource. The public Chrome extension must NEVER contain a shared Azure subscription key or call Azure's private-key endpoint directly. This implementation uses the existing loopback service at `127.0.0.1:8765`; Azure credentials remain in that local process. A public/community deployment needs a separate authenticated backend with quota/rate limiting before enabling these voices for everyone.

For the lightweight **Azure-only** server, no MeloTTS/OpenVoice models are required:

1. In Azure, create a Speech resource; get its **Key** and exact **Region ID** (for example `centralindia` or `koreacentral`). Check that your region lists both voice IDs (Hyunsu Multilingual availability can vary).
2. In PowerShell, switch to `voice_server` and set environment variables only in that shell:

   ```powershell
   $env:AZURE_SPEECH_KEY = "PASTE_YOUR_PRIVATE_AZURE_SPEECH_RESOURCE_KEY_HERE"
   $env:AZURE_SPEECH_REGION = "YOUR_AZURE_SPEECH_REGION_ID"
   python -m pip install fastapi uvicorn
   python -m uvicorn azure_server:app --host 127.0.0.1 --port 8765
   ```

3. Keep that terminal running while testing the voices. Open `http://127.0.0.1:8765/health` to verify the service.
4. Reload the extension at `chrome://extensions`. Pick Sun-Hi or Hyunsu in the on-page Voice menu; select Korean and tap a speaker.

If OpenVoice is already running on **that same port**, stop it first and run the Azure-only server above. Alternatively, restart the updated `server:app`, which now exposes both `/tts` and `/azure-tts` together when its full OpenVoice dependencies are installed. Only one process can bind port 8765.

Azure selection **does not silently replace** the chosen voice with MeloTTS when Azure is offline or not configured: the panel shows an error. Switch Voice to `Auto` for the older fallback. Azure incurs service usage and may have a free monthly allocation, but availability, quotas and pricing depend on your Azure account and selected voice/tier.

Do not commit Azure credentials to Git, paste them in issues, or share screenshots of the resource key.
