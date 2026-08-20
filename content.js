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

  const LABELS = {
    en: "English", ja: "日本語", ko: "한국어", zh: "中文", fr: "Français", es: "Español",
    it: "Italiano", de: "Deutsch", pt: "Português", cs: "Čeština", tr: "Türkçe", la: "Latina"
  };
  const SOURCE_LANGS = ["ko", "ja", "zh", "fr", "es", "it", "de", "pt", "cs", "tr", "la"];
  const TARGET_LANGS = ["en", ...SOURCE_LANGS];

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
    popupEl.className = `mhl-lens mhl-theme-${prefs.theme} mhl-size-${prefs.panelSize}`;
    popupEl.style.left = `${window.scrollX + rect.left}px`;
    popupEl.style.top = `${window.scrollY + rect.bottom + 8}px`;

    popupEl.innerHTML = renderSkeleton(text, prefs);
    document.body.appendChild(popupEl);
    keepPanelOnScreen();

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
    wireDragging();
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
          <button title="re-read selection" id="mhl-refresh">↻</button>
          <button title="change panel size" id="mhl-size">↔</button>
          <button title="change theme" id="mhl-theme">◐</button>
          <button title="fold panel" id="mhl-fold">⌃</button>
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
    const langs = isLight ? TARGET_LANGS : SOURCE_LANGS;
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
    document.getElementById("mhl-refresh").addEventListener("click", async () => requestLookup(currentSelectionText, await getPrefs()));
    document.getElementById("mhl-fold").addEventListener("click", (event) => {
      popupEl.classList.toggle("mhl-folded");
      event.currentTarget.textContent = popupEl.classList.contains("mhl-folded") ? "⌄" : "⌃";
    });
    document.getElementById("mhl-theme").addEventListener("click", async () => {
      const themes = ["paper", "midnight", "contrast"];
      prefs.theme = themes[(themes.indexOf(prefs.theme) + 1) % themes.length];
      popupEl.classList.remove(...themes.map((theme) => `mhl-theme-${theme}`));
      popupEl.classList.add(`mhl-theme-${prefs.theme}`);
      await setPrefs(prefs);
    });
    document.getElementById("mhl-size").addEventListener("click", async () => {
      const sizes = ["compact", "comfortable", "wide"];
      prefs.panelSize = sizes[(sizes.indexOf(prefs.panelSize) + 1) % sizes.length];
      popupEl.classList.remove(...sizes.map((size) => `mhl-size-${size}`));
      popupEl.classList.add(`mhl-size-${prefs.panelSize}`);
      keepPanelOnScreen();
      await setPrefs(prefs);
    });

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

  function wireDragging() {
    const header = popupEl?.querySelector(".mhl-header");
    if (!header) return;
    header.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button, .mhl-lang, .mhl-dropdown")) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = popupEl.offsetLeft;
      const startTop = popupEl.offsetTop;
      header.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        popupEl.style.left = `${startLeft + moveEvent.clientX - startX}px`;
        popupEl.style.top = `${startTop + moveEvent.clientY - startY}px`;
      };
      const stop = () => {
        header.removeEventListener("pointermove", move);
        keepPanelOnScreen();
      };
      header.addEventListener("pointermove", move);
      header.addEventListener("pointerup", stop, { once: true });
      header.addEventListener("pointercancel", stop, { once: true });
    });
  }

  function keepPanelOnScreen() {
    if (!popupEl) return;
    const margin = 8;
    const rect = popupEl.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left, margin), Math.max(margin, innerWidth - rect.width - margin));
    const top = Math.min(Math.max(rect.top, margin), Math.max(margin, innerHeight - Math.min(rect.height, innerHeight - 16) - margin));
    popupEl.style.left = `${scrollX + left}px`;
    popupEl.style.top = `${scrollY + top}px`;
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
          ${renderMoreSenses(w.allSenses)}
        </div>
      `;
    });

    contentEl.innerHTML = html;

    contentEl.querySelectorAll(".mhl-speak-word").forEach((el) => {
      el.addEventListener("click", () => speak(el.dataset.word, currentSourceLang));
    });
  }

  function renderMoreSenses(senses) {
    if (!Array.isArray(senses) || senses.length < 2) return "";
    const extra = senses.slice(1, 8).map((sense) => `
      <li><span class="mhl-pos">${escapeHtml(sense.pos || "")}</span>${sense.pos ? " — " : ""}${escapeHtml(sense.definition || "")}</li>
    `).join("");
    return `<details class="mhl-senses"><summary>${senses.length - 1} more meaning${senses.length > 2 ? "s" : ""}</summary><ul>${extra}</ul></details>`;
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
      chrome.storage.sync.get({ sourceLang: "ko", targetLang: "en", theme: "paper", panelSize: "comfortable" }, resolve);
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
