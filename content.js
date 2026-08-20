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

  // ---------- floating window customization state ----------
  // (position/size/rotation/accent/shape — layered on top of the existing
  // selection popup without touching translation, OCR, or audio logic)
  let currentRotation = 0;
  let currentAccent = "default";
  let currentShape = "classic";
  let lastAnchorRect = null; // selection rect the panel last anchored to, used by "reset window"
  let viewportResizeTimer = null;

  const MIN_WIDTH = 280;
  const MIN_HEIGHT = 160;
  const MAX_LOCAL_DIMENSION = 900;
  const ROTATE_STEP = 5;
  const ROTATE_MAX = 45;
  const ANGLE_PRESETS = [-45, -30, -15, -10, -5, 0, 5, 10, 15, 30, 45];
  const SHAPE_KEYS = ["classic", "soft", "compact", "square", "bubble"];
  const ACCENT_PRESETS = {
    default: { light: "#2E5E99", dark: "#0D2440" },
    neutral: { light: "#5C6B7A", dark: "#232B33" },
    pink: { light: "#A94A6E", dark: "#4A1930" },
    purple: { light: "#7B5EA7", dark: "#2E1F4A" },
    blue: { light: "#2F80D6", dark: "#123A66" },
    cyan: { light: "#1E8F99", dark: "#0B343A" },
    green: { light: "#3D8556", dark: "#12351F" },
    orange: { light: "#B8631F", dark: "#4A2408" },
    red: { light: "#A6432F", dark: "#4A180F" }
  };

  const LABELS = {
    en: "English", ja: "日本語", ko: "한국어", zh: "中文", fr: "Français", es: "Español",
    it: "Italiano", de: "Deutsch", pt: "Português", cs: "Čeština", tr: "Türkçe", la: "Latina"
  };
  const SOURCE_LANGS = ["ko", "ja", "zh", "fr", "es", "it", "de", "pt", "cs", "tr", "la"];
  const TARGET_LANGS = ["en", ...SOURCE_LANGS];

  // ---------- pure geometry / color helpers (no DOM access — unit testable) ----------

  function clampNumber(value, min, max) {
    if (typeof value !== "number" || Number.isNaN(value)) return min;
    return Math.min(Math.max(value, min), max);
  }

  // Rotates a screen-space pointer delta into the panel's own (unrotated)
  // coordinate space so a resize handle keeps tracking the cursor correctly
  // no matter what angle the panel is currently rotated to.
  function rotateDelta(dx, dy, angleDeg) {
    const rad = (-angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  }

  // Axis-aligned bounding box of a width x height rectangle rotated by angleDeg.
  function rotatedBoundingBox(width, height, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    return { width: width * cos + height * sin, height: width * sin + height * cos };
  }

  function hexToRgb(hex) {
    const clean = String(hex).replace("#", "");
    const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    const num = parseInt(full, 16) || 0;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map((v) => clampNumber(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("")}`;
  }

  function darkenHex(hex, factor) {
    const { r, g, b } = hexToRgb(hex);
    return rgbToHex(r * factor, g * factor, b * factor);
  }

  function hexToRgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function perceivedBrightness(hex) {
    const { r, g, b } = hexToRgb(hex);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function isValidHexColor(value) {
    return typeof value === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
  }

  function normalizeAccent(value) {
    if (typeof value === "string" && ACCENT_PRESETS[value]) return value;
    if (isValidHexColor(value)) return value.toLowerCase();
    return "default";
  }

  function normalizeWindowStyle(value) {
    return SHAPE_KEYS.includes(value) ? value : "classic";
  }

  function normalizeRotation(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return clampNumber(Math.round(num), -ROTATE_MAX, ROTATE_MAX);
  }

  // Sanitizes a saved/restored geometry so a window position or size saved
  // on one screen never leaves the panel inaccessible on a smaller one.
  function clampWindowGeometry({ x, y, width, height, rotation }, viewportWidth, viewportHeight) {
    const margin = 8;
    const safeRotation = normalizeRotation(rotation);
    const safeWidth = typeof width === "number"
      ? clampNumber(width, MIN_WIDTH, Math.max(MIN_WIDTH, viewportWidth - margin * 2))
      : null;
    const safeHeight = typeof height === "number"
      ? clampNumber(height, MIN_HEIGHT, Math.max(MIN_HEIGHT, viewportHeight - margin * 2))
      : null;

    let safeX = typeof x === "number" ? x : null;
    let safeY = typeof y === "number" ? y : null;
    if (safeX !== null && safeY !== null && safeWidth !== null && safeHeight !== null) {
      const box = rotatedBoundingBox(safeWidth, safeHeight, safeRotation);
      const maxX = Math.max(margin, viewportWidth - box.width - margin);
      const maxY = Math.max(margin, viewportHeight - box.height - margin);
      safeX = clampNumber(safeX, margin, maxX);
      safeY = clampNumber(safeY, margin, maxY);
    }

    return { x: safeX, y: safeY, width: safeWidth, height: safeHeight, rotation: safeRotation };
  }

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
    currentRotation = normalizeRotation(prefs.windowRotation);
    currentAccent = normalizeAccent(prefs.windowAccent);
    currentShape = normalizeWindowStyle(prefs.windowStyle);

    popupEl = document.createElement("div");
    popupEl.className = `mhl-lens mhl-theme-${prefs.theme} mhl-size-${prefs.panelSize} mhl-shape-${currentShape}`;
    popupEl.innerHTML = renderSkeleton(text, prefs);
    document.body.appendChild(popupEl);

    applyAccent(currentAccent);
    applyRotation(currentRotation);
    if (typeof prefs.windowWidth === "number") popupEl.style.width = `${prefs.windowWidth}px`;
    if (typeof prefs.windowHeight === "number") popupEl.style.height = `${prefs.windowHeight}px`;

    if (typeof prefs.windowX === "number" && typeof prefs.windowY === "number") {
      // The user has moved the panel before — restore it as a persistent
      // utility window instead of re-anchoring next to this new selection.
      lastAnchorRect = null;
      positionAtViewportPoint(prefs.windowX, prefs.windowY);
    } else {
      lastAnchorRect = rect;
      popupEl.style.left = `${window.scrollX + rect.left}px`;
      popupEl.style.top = `${window.scrollY + rect.bottom + 8}px`;
    }
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
    wireResizing();
    wireAppearanceMenu();
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
          <div class="mhl-appearance" id="mhl-appearance">
            <button title="customize window" id="mhl-appearance-toggle">🎨</button>
            ${renderAppearancePanel()}
          </div>
          <button title="fold panel" id="mhl-fold">⌃</button>
          <button title="close" id="mhl-close">✕</button>
        </div>
      </div>

      <div class="mhl-resize-e" id="mhl-resize-e"></div>
      <div class="mhl-resize-s" id="mhl-resize-s"></div>
      <div class="mhl-resize-se" id="mhl-resize-se"></div>

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

  function renderAppearancePanel() {
    const accentSwatches = Object.keys(ACCENT_PRESETS)
      .map(
        (key) => `
        <button type="button" class="mhl-swatch" data-accent="${key}" style="background:${ACCENT_PRESETS[key].light}" title="${key}"></button>`
      )
      .join("");

    const shapeOptions = SHAPE_KEYS.map(
      (key) => `
        <button type="button" class="mhl-shape-option" data-shape="${key}">
          <span class="mhl-shape-preview mhl-shape-preview-${key}"></span>
          ${key.charAt(0).toUpperCase()}${key.slice(1)}
        </button>`
    ).join("");

    const angleChips = ANGLE_PRESETS.map(
      (angle) => `<button type="button" class="mhl-angle-chip" data-angle="${angle}">${angle > 0 ? "+" : ""}${angle}°</button>`
    ).join("");

    return `
      <div class="mhl-appearance-panel" id="mhl-appearance-panel">
        <div class="mhl-appearance-section">
          <p class="mhl-appearance-label">Accent color</p>
          <div class="mhl-swatch-row">
            ${accentSwatches}
            <input type="color" class="mhl-swatch-custom" id="mhl-accent-custom" title="custom color" value="#2E5E99" />
          </div>
        </div>
        <div class="mhl-appearance-section">
          <p class="mhl-appearance-label">Window style</p>
          <div class="mhl-shape-grid">${shapeOptions}</div>
        </div>
        <div class="mhl-appearance-section">
          <p class="mhl-appearance-label">Rotation</p>
          <div class="mhl-rotate-row">
            <button type="button" id="mhl-rotate-left" title="rotate left">⟲</button>
            <span class="mhl-rotate-readout" id="mhl-rotate-readout">0°</span>
            <button type="button" id="mhl-rotate-right" title="rotate right">⟳</button>
          </div>
          <div class="mhl-angle-chip-row">${angleChips}</div>
        </div>
        <div class="mhl-appearance-section">
          <p class="mhl-appearance-label">Size</p>
          <p class="mhl-size-readout" id="mhl-size-readout">340 × auto</p>
        </div>
        <button type="button" class="mhl-reset-btn" id="mhl-reset-window">Reset window</button>
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
      // A manually resized width would otherwise silently override this
      // preset cycle (inline style beats the class). Clear it so the old
      // button keeps doing exactly what it always did.
      popupEl.style.width = "";
      prefs.windowWidth = null;
      keepPanelOnScreen();
      updateAppearanceActiveStates();
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
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest("button, .mhl-lang, .mhl-dropdown, .mhl-appearance")) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = popupEl.offsetLeft;
      const startTop = popupEl.offsetTop;
      header.setPointerCapture(event.pointerId);

      // Pointermove can fire far faster than the display refreshes on
      // high-poll-rate mice. Coalesce updates to one DOM write per frame so
      // dragging stays smooth without redundant layout/paint work.
      let pendingLeft = startLeft;
      let pendingTop = startTop;
      let frameQueued = false;
      const applyFrame = () => {
        frameQueued = false;
        popupEl.style.left = `${pendingLeft}px`;
        popupEl.style.top = `${pendingTop}px`;
      };
      const move = (moveEvent) => {
        pendingLeft = startLeft + moveEvent.clientX - startX;
        pendingTop = startTop + moveEvent.clientY - startY;
        if (!frameQueued) {
          frameQueued = true;
          requestAnimationFrame(applyFrame);
        }
      };
      const stop = () => {
        header.removeEventListener("pointermove", move);
        keepPanelOnScreen();
        persistGeometry();
        updateAppearanceActiveStates();
      };
      header.addEventListener("pointermove", move);
      header.addEventListener("pointerup", stop, { once: true });
      header.addEventListener("pointercancel", stop, { once: true });
    });
  }

  // Clamps the panel back into the viewport, accounting for its current
  // rotation. getBoundingClientRect() already reports the real rotated
  // bounding box, so the clamp target is converted back to the unrotated
  // left/top the element is actually positioned with.
  function keepPanelOnScreen() {
    if (!popupEl) return;
    const margin = 8;
    const width = popupEl.offsetWidth;
    const height = popupEl.offsetHeight;
    const box = rotatedBoundingBox(width, height, currentRotation);
    const rect = popupEl.getBoundingClientRect();
    const maxAabbLeft = Math.max(margin, innerWidth - box.width - margin);
    const maxAabbTop = Math.max(margin, innerHeight - Math.min(box.height, innerHeight - 16) - margin);
    const aabbLeft = clampNumber(rect.left, margin, maxAabbLeft);
    const aabbTop = clampNumber(rect.top, margin, maxAabbTop);
    const left = aabbLeft + (box.width - width) / 2;
    const top = aabbTop + (box.height - height) / 2;
    popupEl.style.left = `${scrollX + left}px`;
    popupEl.style.top = `${scrollY + top}px`;
  }

  // Positions the panel so its rendered (rotated) top-left lands at a
  // specific viewport point — used to restore a saved screen position.
  function positionAtViewportPoint(aabbLeft, aabbTop) {
    if (!popupEl) return;
    const width = popupEl.offsetWidth;
    const height = popupEl.offsetHeight;
    const box = rotatedBoundingBox(width, height, currentRotation);
    const left = aabbLeft + (box.width - width) / 2;
    const top = aabbTop + (box.height - height) / 2;
    popupEl.style.left = `${scrollX + left}px`;
    popupEl.style.top = `${scrollY + top}px`;
  }

  function wireResizing() {
    if (!popupEl) return;
    const handles = [
      { el: document.getElementById("mhl-resize-e"), axis: "e" },
      { el: document.getElementById("mhl-resize-s"), axis: "s" },
      { el: document.getElementById("mhl-resize-se"), axis: "se" }
    ];

    handles.forEach(({ el, axis }) => {
      if (!el) return;
      el.addEventListener("pointerdown", (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();

        const startRect = popupEl.getBoundingClientRect();
        const startWidth = popupEl.offsetWidth;
        const startHeight = popupEl.offsetHeight;
        const startX = event.clientX;
        const startY = event.clientY;
        const margin = 8;

        // How much room is available before the right/bottom edge of the
        // rendered (rotated) box would leave the viewport, translated back
        // into the panel's own local width/height budget.
        const availW = Math.max(MIN_WIDTH, innerWidth - startRect.left - margin);
        const availH = Math.max(MIN_HEIGHT, innerHeight - startRect.top - margin);
        const rad = (currentRotation * Math.PI) / 180;
        const cos = Math.max(Math.abs(Math.cos(rad)), 0.0001);
        const sin = Math.abs(Math.sin(rad));
        const maxWidth = clampNumber((availW - sin * startHeight) / cos, MIN_WIDTH, MAX_LOCAL_DIMENSION);
        const maxHeight = clampNumber((availH - sin * startWidth) / cos, MIN_HEIGHT, MAX_LOCAL_DIMENSION);

        el.setPointerCapture(event.pointerId);

        let pendingWidth = startWidth;
        let pendingHeight = startHeight;
        let frameQueued = false;
        const applyFrame = () => {
          frameQueued = false;
          if (axis !== "s") popupEl.style.width = `${pendingWidth}px`;
          if (axis !== "e") popupEl.style.height = `${pendingHeight}px`;
        };
        const move = (moveEvent) => {
          const rawDx = moveEvent.clientX - startX;
          const rawDy = moveEvent.clientY - startY;
          const local = rotateDelta(rawDx, rawDy, currentRotation);
          if (axis !== "s") pendingWidth = clampNumber(startWidth + local.x, MIN_WIDTH, maxWidth);
          if (axis !== "e") pendingHeight = clampNumber(startHeight + local.y, MIN_HEIGHT, maxHeight);
          if (!frameQueued) {
            frameQueued = true;
            requestAnimationFrame(applyFrame);
          }
        };
        const stop = () => {
          el.removeEventListener("pointermove", move);
          keepPanelOnScreen();
          persistGeometry();
          updateAppearanceActiveStates();
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", stop, { once: true });
        el.addEventListener("pointercancel", stop, { once: true });
      });
    });
  }

  function applyRotation(rotation) {
    if (!popupEl) return;
    currentRotation = normalizeRotation(rotation);
    popupEl.style.transform = currentRotation ? `rotate(${currentRotation}deg)` : "";
  }

  // Rotating around the panel's own center (the CSS default transform
  // origin) never moves that center point, so no x/y correction is needed
  // here — only a re-clamp in case the now-larger rotated box no longer
  // fits the viewport.
  function setRotation(rotation) {
    if (!popupEl) return;
    applyRotation(rotation);
    keepPanelOnScreen();
  }

  function rotateBy(step) {
    setRotation(currentRotation + step);
  }

  function applyAccent(accent) {
    if (!popupEl) return;
    currentAccent = normalizeAccent(accent);
    const preset = ACCENT_PRESETS[currentAccent];
    const light = preset ? preset.light : currentAccent;
    const dark = preset ? preset.dark : darkenHex(currentAccent, 0.42);
    popupEl.style.setProperty("--mhl-accent-light", light);
    popupEl.style.setProperty("--mhl-accent-dark", dark);
    popupEl.style.setProperty("--mhl-accent-soft", hexToRgba(light, 0.14));
    popupEl.style.setProperty("--mhl-accent-fg", perceivedBrightness(light) > 170 ? "#0D2440" : "#F5F9FF");
  }

  function applyWindowStyle(style) {
    if (!popupEl) return;
    currentShape = normalizeWindowStyle(style);
    popupEl.classList.remove(...SHAPE_KEYS.map((key) => `mhl-shape-${key}`));
    popupEl.classList.add(`mhl-shape-${currentShape}`);
  }

  // Final-value persistence only — called on pointerup / resize-end / a
  // debounced viewport-resize settle, never during pointermove, so normal
  // dragging and resizing never touch chrome.storage.
  async function persistGeometry() {
    if (!popupEl) return;
    const rect = popupEl.getBoundingClientRect();
    const prefs = await getPrefs();
    prefs.windowX = Math.round(rect.left);
    prefs.windowY = Math.round(rect.top);
    prefs.windowWidth = Math.round(popupEl.offsetWidth);
    prefs.windowHeight = Math.round(popupEl.offsetHeight);
    await setPrefs(prefs);
  }

  async function persistAppearance(partial) {
    const prefs = await getPrefs();
    Object.assign(prefs, partial);
    await setPrefs(prefs);
  }

  async function resetFloatingWindow() {
    if (!popupEl) return;
    const prefs = await getPrefs();
    prefs.windowX = null;
    prefs.windowY = null;
    prefs.windowWidth = null;
    prefs.windowHeight = null;
    prefs.windowRotation = 0;
    prefs.windowAccent = "default";
    prefs.windowStyle = "classic";
    await setPrefs(prefs);

    popupEl.style.width = "";
    popupEl.style.height = "";
    applyRotation(0);
    applyAccent("default");
    applyWindowStyle("classic");

    if (lastAnchorRect) {
      popupEl.style.left = `${window.scrollX + lastAnchorRect.left}px`;
      popupEl.style.top = `${window.scrollY + lastAnchorRect.bottom + 8}px`;
    }
    keepPanelOnScreen();
    updateAppearanceActiveStates();
  }

  function wireAppearanceMenu() {
    const toggle = document.getElementById("mhl-appearance-toggle");
    const panel = document.getElementById("mhl-appearance-panel");
    if (!toggle || !panel) return;

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".mhl-dropdown.open").forEach((d) => d.classList.remove("open"));
      panel.classList.toggle("open");
    });
    panel.addEventListener("click", (e) => e.stopPropagation());
    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    panel.querySelectorAll(".mhl-swatch[data-accent]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        applyAccent(btn.dataset.accent);
        updateAppearanceActiveStates();
        await persistAppearance({ windowAccent: currentAccent });
      });
    });

    const customColor = document.getElementById("mhl-accent-custom");
    if (customColor) {
      customColor.addEventListener("input", async () => {
        applyAccent(customColor.value);
        updateAppearanceActiveStates();
        await persistAppearance({ windowAccent: currentAccent });
      });
    }

    panel.querySelectorAll(".mhl-shape-option[data-shape]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        applyWindowStyle(btn.dataset.shape);
        updateAppearanceActiveStates();
        keepPanelOnScreen();
        await persistAppearance({ windowStyle: currentShape });
      });
    });

    document.getElementById("mhl-rotate-left")?.addEventListener("click", async () => {
      rotateBy(-ROTATE_STEP);
      updateAppearanceActiveStates();
      await persistAppearance({ windowRotation: currentRotation });
    });
    document.getElementById("mhl-rotate-right")?.addEventListener("click", async () => {
      rotateBy(ROTATE_STEP);
      updateAppearanceActiveStates();
      await persistAppearance({ windowRotation: currentRotation });
    });

    panel.querySelectorAll(".mhl-angle-chip[data-angle]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        setRotation(Number(btn.dataset.angle));
        updateAppearanceActiveStates();
        await persistAppearance({ windowRotation: currentRotation });
      });
    });

    document.getElementById("mhl-reset-window")?.addEventListener("click", async () => {
      await resetFloatingWindow();
      panel.classList.remove("open");
    });

    updateAppearanceActiveStates();
  }

  function updateAppearanceActiveStates() {
    if (!popupEl) return;
    popupEl.querySelectorAll(".mhl-swatch[data-accent]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.accent === currentAccent);
    });
    popupEl.querySelectorAll(".mhl-shape-option[data-shape]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.shape === currentShape);
    });
    const readout = document.getElementById("mhl-rotate-readout");
    if (readout) readout.textContent = `${currentRotation}°`;
    popupEl.querySelectorAll(".mhl-angle-chip[data-angle]").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.angle) === currentRotation);
    });
    const sizeReadout = document.getElementById("mhl-size-readout");
    if (sizeReadout) {
      const heightLabel = popupEl.style.height ? Math.round(popupEl.offsetHeight) : "auto";
      sizeReadout.textContent = `${Math.round(popupEl.offsetWidth)} × ${heightLabel}`;
    }
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

  // clicking anywhere closes any open dropdown/appearance menu (but not the popup itself)
  document.addEventListener("click", () => {
    document.querySelectorAll(".mhl-dropdown.open").forEach((d) => d.classList.remove("open"));
    document.querySelectorAll(".mhl-appearance-panel.open").forEach((p) => p.classList.remove("open"));
  });

  // Re-clamp (and, after the resize settles, re-persist) the panel whenever
  // the viewport/resolution changes so it can never end up inaccessible.
  window.addEventListener("resize", () => {
    if (!popupEl) return;
    keepPanelOnScreen();
    clearTimeout(viewportResizeTimer);
    viewportResizeTimer = setTimeout(persistGeometry, 250);
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
      chrome.storage.sync.get(
        {
          sourceLang: "ko",
          targetLang: "en",
          theme: "paper",
          panelSize: "comfortable",
          // Floating window customization (section: appearance menu). null
          // means "not customized yet" — the panel keeps behaving exactly
          // as it always did until the user actually moves/resizes it.
          windowX: null,
          windowY: null,
          windowWidth: null,
          windowHeight: null,
          windowRotation: 0,
          windowAccent: "default",
          windowStyle: "classic"
        },
        resolve
      );
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

  // Test-only seam: a test harness can predefine globalThis.__MHL_TEST_EXPOSE__
  // before this script loads to receive direct references to the pure,
  // DOM-free geometry/color helpers above. No-op in a real browser.
  if (typeof globalThis.__MHL_TEST_EXPOSE__ === "function") {
    globalThis.__MHL_TEST_EXPOSE__({
      clampNumber,
      rotateDelta,
      rotatedBoundingBox,
      hexToRgb,
      rgbToHex,
      darkenHex,
      hexToRgba,
      perceivedBrightness,
      isValidHexColor,
      normalizeAccent,
      normalizeWindowStyle,
      normalizeRotation,
      clampWindowGeometry,
      ACCENT_PRESETS,
      SHAPE_KEYS,
      MIN_WIDTH,
      MIN_HEIGHT,
      ROTATE_MAX
    });
  }
})();
