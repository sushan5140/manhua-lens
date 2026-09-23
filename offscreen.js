let activeAudio = null;
let activeUrl = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "MHL_PLAY_AUDIO") return;

  playAudio(message.audioBase64, message.mimeType || "audio/wav", message.playbackRate)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ error: true, message: err.message || String(err) }));

  return true;
});

// Only the fixed speed choices from the settings are honoured; anything
// else plays at the natural 1.0x the audio was generated at.
const PLAYBACK_RATES = [0.75, 0.9, 1, 1.1, 1.25];

async function playAudio(base64, mimeType, playbackRate = 1) {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }
  if (activeUrl) {
    URL.revokeObjectURL(activeUrl);
    activeUrl = null;
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const blob = new Blob([bytes], { type: mimeType });
  activeUrl = URL.createObjectURL(blob);
  activeAudio = new Audio(activeUrl);
  // Set per clip on a fresh element so speed never carries over or
  // compounds between replays; keep the voice's pitch when not 1.0x.
  const rate = PLAYBACK_RATES.includes(Number(playbackRate)) ? Number(playbackRate) : 1;
  activeAudio.preservesPitch = true;
  activeAudio.defaultPlaybackRate = rate;
  activeAudio.playbackRate = rate;

  await new Promise((resolve, reject) => {
    activeAudio.addEventListener("ended", resolve, { once: true });
    activeAudio.addEventListener("error", () => reject(new Error("Audio playback failed.")), { once: true });
    activeAudio.play().catch(reject);
  });

  activeAudio = null;
  URL.revokeObjectURL(activeUrl);
  activeUrl = null;
}
