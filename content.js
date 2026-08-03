// Manhua Lens — content script
// Runs on every page. Watches for the user selecting text, then shows
// the popup next to the selection and asks the background script to
// look up / translate whatever was selected.

(function () {
  // options.js can repair a missed Edge injection. Avoid registering a
  // second set of listeners if the manifest already loaded this script.
  if (globalThis.__MANHUA_LENS_CONTENT_LOADED__) return;
  globalThis.__MANHUA_LENS_CONTENT_LOADED__ = true;

  let popupEl = null;
  let currentSelectionText = "";
  let currentSourceLang = "ko";
  let selectionTimer = null;
  let speechInProgress = false;
  let speechRequestId = 0;
  let preservePanelUntil = 0;

  const LABELS = { en: "English", ja: "日本語", ko: "한국어", zh: "中文", fr: "Français", es: "Español" };

  // ---------- selection detection ----------

  // Capture-phase listeners still run on sites that stop mouse/key events
  // before they bubble to document. selectionchange is a fallback for
  // browser selection tools, touch selection, and scripted selections.
  document.addEventListener("mouseup", handleSelectionChange, true);
  document.addEventListener("keyup", handleSelectionChange, true);
  document.addEventListener("selectionchange", scheduleSelectionCheck, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "MHL_PING") {
      sendResponse({ active: true, version: chrome.runtime.getManifest().version });
    }
  });

  function scheduleSelectionCheck() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => handleSelectionChange(), 120);
  }

  function handleSelectionChange(e) {
    try {
      // ignore clicks happening inside our own popup
      if (e?.target && popupEl && popupEl.contains(e.target)) return;
      if (popupEl && (speechInProgress || Date.now() < preservePanelUntil)) return;

      const selection = window.getSelection();
      const text = selection ? selection.toString().trim() : "";

      if (!text) {
        // Clicking a control in the panel can momentarily clear the page
        // selection. Never close during speech or the panel interaction.
        if (speechInProgress || Date.now() < preservePanelUntil) return;
        removePopup();
        return;
      }

      if (text.length > 400) return; // guard against selecting an entire page

      currentSelectionText = text;
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      showPopup(text, rect);
    } catch (err) {
      console.error("Manhua Lens: selection handling failed", err);
    }
  }

  // ---------- popup rendering ----------

  function removePopup() {
    if (popupEl) {
      popupEl.remove();
      popupEl = null;
    }
  }

  async function showPopup(text, rect) {
    removePopup();

    const prefs = await getPrefs();
    currentSourceLang = prefs.sourceLang;

    popupEl = document.createElement("div");
    popupEl.className = "mhl-lens";
    popupEl.style.left = `${window.scrollX + rect.left}px`;
    popupEl.style.top = `${window.scrollY + rect.bottom + 8}px`;

    popupEl.innerHTML = renderSkeleton(text, prefs);
    document.body.appendChild(popupEl);

    // Keep the original page selection active when the user clicks a panel
    // control. This prevents selectionchange from treating pronunciation,
    // language, and close-button clicks as a new empty selection.
    popupEl.addEventListener(
      "mousedown",
      (e) => {
        preservePanelUntil = Date.now() + 500;
        e.preventDefault();
      },
      true
    );

    wireHeaderControls(prefs);
    wireSentenceSpeak(text);
    requestLookup(text, prefs);
  }

  function wireSentenceSpeak(text) {
    const btn = document.getElementById("mhl-speak-sentence");
    if (btn) btn.addEventListener("click", () => speak(text, currentSourceLang));
  }

  function renderSkeleton(text, prefs) {
    return `
      <div class="mhl-header">
        <div class="mhl-icon">🦊</div>
        <div class="mhl-title">Manhua Lens</div>

        <div class="mhl-lang" id="mhl-src-toggle">
          <span id="mhl-src-label">${LABELS[prefs.sourceLang] || prefs.sourceLang}</span> ▾
          ${renderDropdown("mhl-src-dropdown", prefs.sourceLang, false)}
        </div>

        <div class="mhl-actions">
          <button title="close" id="mhl-close">✕</button>
        </div>
      </div>

      <div class="mhl-translate-bar">
        <span>Translate to</span>
        <span class="mhl-arrow">→</span>
        <div class="mhl-to-lang" id="mhl-tgt-toggle">
          <span id="mhl-tgt-label">${LABELS[prefs.targetLang] || prefs.targetLang}</span> ▾
          ${renderDropdown("mhl-tgt-dropdown", prefs.targetLang, true)}
        </div>
      </div>

      <div class="mhl-body">
        <p class="mhl-source">
          <span class="mhl-speak" id="mhl-speak-sentence">▶</span>
          <span id="mhl-source-phrase">${escapeHtml(text)}</span>
        </p>
        <div id="mhl-content">
          <p class="mhl-loading">Looking that up…</p>
        </div>
      </div>
    `;
  }

  function renderDropdown(id, activeLang, isLight) {
    const langs = ["ko", "ja", "zh", "fr", "es", "en"];
    const items = langs
      .map(
        (l) => `
        <div class="mhl-item ${l === activeLang ? "active" : ""}" data-lang="${l}">
          ${LABELS[l]} <span class="mhl-check">${l === activeLang ? "✓" : ""}</span>
        </div>`
      )
      .join("");
    return `<div class="mhl-dropdown ${isLight ? "light" : ""}" id="${id}">${items}</div>`;
  }

  function wireHeaderControls(prefs) {
    document.getElementById("mhl-close").addEventListener("click", removePopup);

    wireDropdown("mhl-src-toggle", "mhl-src-dropdown", async (lang) => {
      const p = await getPrefs();
      p.sourceLang = lang;
      await setPrefs(p);
      currentSourceLang = lang;
      document.getElementById("mhl-src-label").textContent = LABELS[lang];
      requestLookup(currentSelectionText, p);
    });

    wireDropdown("mhl-tgt-toggle", "mhl-tgt-dropdown", async (lang) => {
      const p = await getPrefs();
      p.targetLang = lang;
      await setPrefs(p);
      document.getElementById("mhl-tgt-label").textContent = LABELS[lang];
      requestLookup(currentSelectionText, p);
    });
  }

  function wireDropdown(toggleId, dropdownId, onPick) {
    const toggle = document.getElementById(toggleId);
    const dropdown = document.getElementById(dropdownId);
    if (!toggle || !dropdown) return;

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      document
        .querySelectorAll(".mhl-dropdown.open")
        .forEach((d) => {
          if (d !== dropdown) d.classList.remove("open");
        });
      dropdown.classList.toggle("open");
    });

    dropdown.querySelectorAll(".mhl-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.querySelectorAll(".mhl-item").forEach((i) => {
          i.classList.remove("active");
          i.querySelector(".mhl-check").textContent = "";
        });
        item.classList.add("active");
        item.querySelector(".mhl-check").textContent = "✓";
        dropdown.classList.remove("open");
        onPick(item.dataset.lang);
      });
    });
  }

  // clicking anywhere closes any open dropdown (but not the popup itself)
  document.addEventListener("click", () => {
    document.querySelectorAll(".mhl-dropdown.open").forEach((d) => d.classList.remove("open"));
  });

  // ---------- talking to the background script ----------

  function requestLookup(text, prefs) {
    const contentEl = document.getElementById("mhl-content");
    if (contentEl) contentEl.innerHTML = `<p class="mhl-loading">Looking that up…</p>`;

    chrome.runtime.sendMessage(
      {
        type: "MHL_LOOKUP",
        text,
        sourceLang: prefs.sourceLang,
        targetLang: prefs.targetLang
      },
      (response) => {
        if (!popupEl) return; // popup was closed while waiting
        if (chrome.runtime.lastError || !response || response.error) {
          contentEl.innerHTML = `<p class="mhl-error">Couldn't complete the lookup. Check your connection and reload the extension.</p>`;
          return;
        }
        renderResult(response);
      }
    );
  }

  function renderResult(result) {
    const contentEl = document.getElementById("mhl-content");
    if (!contentEl) return;

    let html = `<p class="mhl-sentence-translation">${escapeHtml(result.sentenceTranslation || "")}</p>`;

    (result.words || []).forEach((w) => {
      if (w.pos === "particle") {
        html += `
          <div class="mhl-entry mhl-particle">
            <p class="mhl-headword mhl-headword-small">
              ${escapeHtml(w.word)}
              <span class="mhl-pos-tag">particle</span>
            </p>
            <p class="mhl-def">${escapeHtml(w.definition || "")}</p>
          </div>
        `;
        return;
      }

      const sourceDot =
        w.source === "dictionary"
          ? `<span class="mhl-source-dot mhl-source-dict" title="from offline dictionary"></span>`
          : `<span class="mhl-source-dot mhl-source-mt" title="from machine translation"></span>`;

      html += `
        <div class="mhl-entry">
          <p class="mhl-headword">
            ${escapeHtml(w.word)}
            ${w.reading ? `<span class="mhl-romanization">${escapeHtml(w.reading)}</span>` : ""}
            <span class="mhl-speak-word" data-word="${escapeHtml(w.word)}">🔊</span>
            ${sourceDot}
          </p>
          <p class="mhl-def"><span class="mhl-pos">${escapeHtml(w.pos || "")}</span> — ${escapeHtml(w.definition || "")}</p>
        </div>
      `;
    });

    contentEl.innerHTML = html;

    contentEl.querySelectorAll(".mhl-speak-word").forEach((el) => {
      el.addEventListener("click", () => speak(el.dataset.word, currentSourceLang));
    });
  }

  function speak(text, lang) {
    if (!text) return;
    const requestId = ++speechRequestId;
    speechInProgress = true;
    preservePanelUntil = Number.POSITIVE_INFINITY;

    chrome.runtime.sendMessage({ type: "MHL_SPEAK", text, lang }, (response) => {
      // A newer pronunciation request may have interrupted this one. Only
      // the newest request controls the panel's keep-open state.
      if (requestId !== speechRequestId) return;

      speechInProgress = false;
      preservePanelUntil = Date.now() + 300;
      if (chrome.runtime.lastError || !response || response.error) {
        showSpeechWarning(response?.message || "Pronunciation is unavailable on this device.");
      }

      // If the user cleared the selection while speech was playing, close
      // only after the pronunciation has completed. Do not rebuild or move
      // the existing panel when the original selection is still active.
      setTimeout(closePopupIfSelectionCleared, response?.error ? 5000 : 350);
    });
  }

  function closePopupIfSelectionCleared() {
    const selection = window.getSelection();
    if (!selection || !selection.toString().trim()) removePopup();
  }

  function showSpeechWarning(message) {
    const contentEl = document.getElementById("mhl-content");
    if (!contentEl) return;
    contentEl.querySelector(".mhl-speech-error")?.remove();
    const warning = document.createElement("p");
    warning.className = "mhl-error mhl-speech-error";
    warning.textContent = `${message} Add the language in Windows speech settings, then reload the extension.`;
    contentEl.prepend(warning);
    setTimeout(() => warning.remove(), 5000);
  }

  // ---------- preferences (persisted via chrome.storage) ----------

  function getPrefs() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ sourceLang: "ko", targetLang: "en" }, resolve);
    });
  }

  function setPrefs(prefs) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(prefs, resolve);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
