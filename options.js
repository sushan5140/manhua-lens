const sourceSelect = document.getElementById("sourceLang");
const targetSelect = document.getElementById("targetLang");
const themeSelect = document.getElementById("theme");
const panelSizeSelect = document.getElementById("panelSize");
const connectionStatus = document.getElementById("connectionStatus");
const activateButton = document.getElementById("activatePage");
let activeTabId = null;

document.getElementById("version").textContent = chrome.runtime.getManifest().version;

chrome.storage.sync.get({ sourceLang: "ko", targetLang: "en", theme: "paper", panelSize: "comfortable" }, (prefs) => {
  sourceSelect.value = prefs.sourceLang;
  targetSelect.value = prefs.targetLang;
  themeSelect.value = prefs.theme;
  panelSizeSelect.value = prefs.panelSize;
});

sourceSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ sourceLang: sourceSelect.value });
});

targetSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ targetLang: targetSelect.value });
});

themeSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ theme: themeSelect.value });
});

panelSizeSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ panelSize: panelSizeSelect.value });
});

function setConnectionStatus(message, isError = false) {
  connectionStatus.textContent = message;
  connectionStatus.classList.toggle("error", isError);
}

function pingTab(tabId, repairIfMissing) {
  chrome.tabs.sendMessage(tabId, { type: "MHL_PING" }, (response) => {
    if (!chrome.runtime.lastError && response?.active) {
      setConnectionStatus(`Active on this page — v${response.version}`);
      return;
    }

    if (repairIfMissing) activateTab(tabId);
    else setConnectionStatus("Not active on this page. Press Activate, then select the text again.", true);
  });
}

function activateTab(tabId) {
  setConnectionStatus("Activating on this page…");

  chrome.scripting.insertCSS(
    { target: { tabId, allFrames: true }, files: ["content.css"] },
    () => {
      // A CSS error in one protected frame should not prevent the script
      // from being attempted in the main page.
      void chrome.runtime.lastError;
      chrome.scripting.executeScript(
        { target: { tabId, allFrames: true }, files: ["content.js"] },
        () => {
          if (chrome.runtime.lastError) {
            setConnectionStatus("Edge blocked access here. Allow Manhua Lens on all sites, then reload the page.", true);
            return;
          }
          setTimeout(() => pingTab(tabId, false), 100);
        }
      );
    }
  );
}

activateButton.addEventListener("click", () => {
  if (activeTabId !== null) activateTab(activeTabId);
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  activeTabId = tabs[0]?.id ?? null;
  if (activeTabId === null) {
    setConnectionStatus("No active webpage was found.", true);
    return;
  }
  // Opening the extension popup is a user gesture and grants activeTab.
  // Repair a missed manifest injection automatically.
  pingTab(activeTabId, true);
});
