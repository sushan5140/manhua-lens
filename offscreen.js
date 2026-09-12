let activeAudio = null;
let activeUrl = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "MHL_PLAY_AUDIO") return;

  playAudio(message.audioBase64, message.mimeType || "audio/wav")
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ error: true, message: err.message || String(err) }));

  return true;
});

async function playAudio(base64, mimeType) {
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

  await new Promise((resolve, reject) => {
    activeAudio.addEventListener("ended", resolve, { once: true });
    activeAudio.addEventListener("error", () => reject(new Error("Audio playback failed.")), { once: true });
    activeAudio.play().catch(reject);
  });

  activeAudio = null;
  URL.revokeObjectURL(activeUrl);
  activeUrl = null;
}
