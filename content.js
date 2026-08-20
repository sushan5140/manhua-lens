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

  // Must stay large enough that the header's icon + title + language
  // toggle + 6 action buttons never overflow the panel (measured via real
  // browser QA: the header needs ~363px of content width at this font
  // size; 380 keeps a small safety margin). Keep in sync with the CSS
  // min-width on .mhl-lens.
  const MIN_WIDTH = 380;
  const MIN_HEIGHT = 160;
  const MAX_LOCAL_DIMENSION = 900;

  // Rotation. The panel ships very slightly tilted so it reads as a
  // physical card resting on the page rather than a flat browser box.
  // DEFAULT_ROTATION is only what an *uncustomized* panel shows — the
  // user can set any angle in [ROTATE_MIN, ROTATE_MAX], including a
  // deliberate 0 ("Level"), which is stored and honoured as a real choice.
  const DEFAULT_ROTATION = -3;
  const ROTATE_MIN = -180;
  const ROTATE_MAX = 180;
  const ROTATE_PRECISION = 0.5; // smallest representable angle increment
  const ROTATE_FINE_STEP = 1;
  const ROTATE_SHIFT_STEP = 5;
  const ANGLE_PRESETS = [-45, -30, -15, -10, -5, 0, 5, 10, 15, 30, 45];
  const SHAPE_KEYS = ["classic", "soft", "compact", "square", "bubble"];

  // ---------- floating window customization state ----------
  // (position/size/rotation/accent/shape — layered on top of the existing
  // selection popup without touching translation, OCR, or audio logic)
  // Declared after the constants above so the initial rotation can use
  // DEFAULT_ROTATION without hitting its temporal dead zone.
  let currentRotation = DEFAULT_ROTATION;
  let currentAccent = "default";
  let currentShape = "classic";
  let lastAnchorRect = null; // selection rect the panel last anchored to, used by "reset window"
  let viewportResizeTimer = null;
  // The size the user actually asked for, kept separate from the rendered
  // size. Rotation can force a temporary shrink to keep the panel on
  // screen; without remembering the intent, rotating out and back would
  // ratchet the panel down to its minimum and never recover. null = "no
  // explicit size", i.e. let the panel-size CSS class / content decide.
  let desiredWidth = null;
  let desiredHeight = null;
  // Every light/dark pair is verified (tests/floating-window.mjs) to give
  // white header text >=4.5:1 WCAG AA contrast against BOTH stops. blue,
  // cyan, green, and orange are darkened slightly from their first pass,
  // which measured true WCAG contrast (not perceived-brightness) as low as
  // 3.84:1 on the light stop.
  const ACCENT_PRESETS = {
    default: { light: "#2E5E99", dark: "#0D2440" },
    neutral: { light: "#5C6B7A", dark: "#232B33" },
    pink: { light: "#A94A6E", dark: "#4A1930" },
    purple: { light: "#7B5EA7", dark: "#2E1F4A" },
    blue: { light: "#2568A8", dark: "#123A66" },
    cyan: { light: "#1A7A82", dark: "#0B343A" },
    green: { light: "#37784D", dark: "#12351F" },
    orange: { light: "#A6591C", dark: "#4A2408" },
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

  // Largest uniform scale (capped at 1, i.e. never enlarges) that fits a
  // box of the given size within the available space on both axes.
  function computeFitScale(boxWidth, boxHeight, availWidth, availHeight) {
    return Math.min(1, availWidth / boxWidth, availHeight / boxHeight);
  }

  // Shrinks (width, height) just enough that its rotated bounding box fits
  // within the available space, never going below MIN_WIDTH/MIN_HEIGHT. A
  // uniform scale handles the common case; if that would push either
  // dimension below its own floor (e.g. a very tall saved height at a wide
  // minimum width and a steep rotation on a short viewport), that
  // dimension is pinned at its minimum and the other is re-solved directly
  // against the fit constraints, since a floored dimension can no longer
  // shrink in step with the other one.
  function fitSizeToViewport(width, height, rotationDeg, availWidth, availHeight) {
    const box = rotatedBoundingBox(width, height, rotationDeg);
    if (box.width <= availWidth && box.height <= availHeight) {
      return { width, height };
    }

    const scale = computeFitScale(box.width, box.height, availWidth, availHeight);
    let w = width * scale;
    let h = height * scale;

    const rad = (rotationDeg * Math.PI) / 180;
    const cos = Math.max(Math.abs(Math.cos(rad)), 0.0001);
    const sin = Math.abs(Math.sin(rad));

    if (w < MIN_WIDTH) {
      w = MIN_WIDTH;
      h = Math.min(
        (availHeight - sin * w) / cos,
        sin > 0.0001 ? (availWidth - cos * w) / sin : height
      );
    } else if (h < MIN_HEIGHT) {
      h = MIN_HEIGHT;
      w = Math.min(
        (availWidth - sin * h) / cos,
        sin > 0.0001 ? (availHeight - cos * h) / sin : width
      );
    }

    return {
      width: clampNumber(w, MIN_WIDTH, width),
      height: clampNumber(h, MIN_HEIGHT, height)
    };
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

  // WCAG relative luminance / contrast ratio (standard sRGB conversion).
  function srgbChannelToLinear(channel) {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    return (
      0.2126 * srgbChannelToLinear(r) +
      0.7152 * srgbChannelToLinear(g) +
      0.0722 * srgbChannelToLinear(b)
    );
  }

  function contrastRatio(hexA, hexB) {
    const l1 = relativeLuminance(hexA);
    const l2 = relativeLuminance(hexB);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  const ACCENT_FG_LIGHT = "#F5F9FF";
  const ACCENT_FG_DARK = "#0D2440";
  const WCAG_AA_NORMAL_TEXT = 4.5;

  // Header text can sit over either end of the accent gradient, so contrast
  // is checked against both stops and the worse of the two is what counts.
  function worstCaseContrast(fg, stopA, stopB) {
    return Math.min(contrastRatio(fg, stopA), contrastRatio(fg, stopB));
  }

  // Picks whichever foreground actually meets WCAG AA (4.5:1) against both
  // gradient stops, preferring the standard light text; for a pathological
  // custom color where neither foreground reaches 4.5:1, falls back to
  // whichever gives the better (closest-to-compliant) ratio.
  function pickAccentForeground(light, dark) {
    const lightFgContrast = worstCaseContrast(ACCENT_FG_LIGHT, light, dark);
    const darkFgContrast = worstCaseContrast(ACCENT_FG_DARK, light, dark);
    if (lightFgContrast >= WCAG_AA_NORMAL_TEXT) return ACCENT_FG_LIGHT;
    if (darkFgContrast >= WCAG_AA_NORMAL_TEXT) return ACCENT_FG_DARK;
    return lightFgContrast >= darkFgContrast ? ACCENT_FG_LIGHT : ACCENT_FG_DARK;
  }

  // A single foreground color cannot pass WCAG AA against both a near-white
  // and a near-black gradient stop at once (that's not a tuning problem —
  // contrast against a bright stop and contrast against a dark stop pull in
  // opposite directions). The curated presets are pre-verified to stay in a
  // range where white text works against both stops; a raw custom pick
  // (e.g. pure white, bright yellow) isn't, so it's darkened just enough
  // here — via binary search on a linear scale factor — before it's used
  // as the light gradient stop or to derive the dark one.
  function ensureLegibleAsBackground(hex, fg) {
    if (contrastRatio(fg, hex) >= WCAG_AA_NORMAL_TEXT) return hex;
    const { r, g, b } = hexToRgb(hex);
    let lo = 0; // factor 0 (black) always passes against any non-near-black fg
    let hi = 1; // factor 1 (original color) is known to fail here
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const candidate = rgbToHex(r * mid, g * mid, b * mid);
      if (contrastRatio(fg, candidate) >= WCAG_AA_NORMAL_TEXT) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return rgbToHex(r * lo, g * lo, b * lo);
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

  // Sanitizes any numeric angle into the supported range. Angles wrap
  // rather than clamp, because rotation is genuinely cyclic: 360 is the
  // same orientation as 0, and nudging past +180 should continue round to
  // -179 instead of sticking. The exact endpoints -180 and 180 are both
  // selectable on the slider and visually identical, so each is preserved
  // as given rather than folded into the other. Non-finite input falls
  // back to 0 (level) — the neutral angle, not the default tilt, which is
  // resolveRotationPreference()'s job.
  function normalizeRotation(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    const stepped = Math.round(num / ROTATE_PRECISION) * ROTATE_PRECISION;
    if (stepped >= ROTATE_MIN && stepped <= ROTATE_MAX) return normalizeZero(stepped);
    // Out of range: fold into [-180, 180). The two endpoints render
    // identically, so which one an out-of-range angle lands on is
    // cosmetic — 540 becoming -180 rather than 180 is the same picture.
    const wrapped = (((stepped + 180) % 360) + 360) % 360 - 180;
    return normalizeZero(Math.round(wrapped / ROTATE_PRECISION) * ROTATE_PRECISION);
  }

  // Keeps -0 from leaking into readouts and stored preferences.
  function normalizeZero(value) {
    return value === 0 ? 0 : value;
  }

  // Distinguishes "never customized" from a deliberate angle. null (or a
  // corrupted value) means the user has never touched rotation, so the
  // subtle default tilt applies; a stored number — crucially including
  // 0 — is an explicit choice and is honoured exactly. This is why the
  // codebase must never use `prefs.windowRotation || DEFAULT_ROTATION`,
  // which would silently turn a deliberate "Level" back into a tilt.
  function resolveRotationPreference(stored) {
    if (stored === null || stored === undefined || stored === "") return DEFAULT_ROTATION;
    const num = Number(stored);
    if (!Number.isFinite(num)) return DEFAULT_ROTATION;
    return normalizeRotation(num);
  }

  // "-3°", "0°", "12.5°" — integers stay integral, halves show one decimal.
  function formatAngle(value) {
    const num = normalizeRotation(value);
    return `${Number.isInteger(num) ? num : num.toFixed(1)}°`;
  }

  // Sanitizes a saved/restored geometry so a window position or size saved
  // on one screen never leaves the panel inaccessible on a smaller one.
  function clampWindowGeometry({ x, y, width, height, rotation }, viewportWidth, viewportHeight) {
    const margin = 8;
    const safeRotation = normalizeRotation(rotation);
    const availW = Math.max(MIN_WIDTH, viewportWidth - margin * 2);
    const availH = Math.max(MIN_HEIGHT, viewportHeight - margin * 2);
    let safeWidth = typeof width === "number" ? clampNumber(width, MIN_WIDTH, availW) : null;
    let safeHeight = typeof height === "number" ? clampNumber(height, MIN_HEIGHT, availH) : null;

    let safeX = typeof x === "number" ? x : null;
    let safeY = typeof y === "number" ? y : null;
    if (safeX !== null && safeY !== null && safeWidth !== null && safeHeight !== null) {
      // A rotated footprint can exceed the viewport even when its own
      // width/height individually fit (e.g. a tall panel rotated 10deg on a
      // short viewport) — no position could make that fit, so shrink first.
      const fitted = fitSizeToViewport(safeWidth, safeHeight, safeRotation, availW, availH);
      safeWidth = fitted.width;
      safeHeight = fitted.height;
      const finalBox = rotatedBoundingBox(safeWidth, safeHeight, safeRotation);
      const maxX = Math.max(margin, viewportWidth - finalBox.width - margin);
      const maxY = Math.max(margin, viewportHeight - finalBox.height - margin);
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
    // null/absent => never customized => subtle default tilt. A stored
    // number (including a deliberate 0) is used exactly as saved.
    currentRotation = resolveRotationPreference(prefs.windowRotation);
    currentAccent = normalizeAccent(prefs.windowAccent);
    currentShape = normalizeWindowStyle(prefs.windowStyle);
    // Remember the saved size as the user's intent, not the viewport-fitted
    // size derived from it, so the panel can grow back to its full size
    // again on a larger viewport or at a gentler angle.
    desiredWidth = typeof prefs.windowWidth === "number" ? prefs.windowWidth : null;
    desiredHeight = typeof prefs.windowHeight === "number" ? prefs.windowHeight : null;

    popupEl = document.createElement("div");
    popupEl.className = `mhl-lens mhl-theme-${prefs.theme} mhl-size-${prefs.panelSize} mhl-shape-${currentShape}`;
    popupEl.innerHTML = renderSkeleton(text, prefs);
    document.body.appendChild(popupEl);

    applyAccent(currentAccent);
    applyRotation(currentRotation);

    // Validate the restored geometry against *this* viewport before
    // applying it — e.g. a position/size saved on a larger monitor must
    // come back on-screen here, not get applied raw and then visibly jump.
    const restored = clampWindowGeometry(
      { x: prefs.windowX, y: prefs.windowY, width: prefs.windowWidth, height: prefs.windowHeight, rotation: currentRotation },
      innerWidth,
      innerHeight
    );
    if (restored.width != null) popupEl.style.width = `${restored.width}px`;
    if (restored.height != null) popupEl.style.height = `${restored.height}px`;

    if (restored.x != null && restored.y != null) {
      // The user has moved the panel before — restore it as a persistent
      // utility window instead of re-anchoring next to this new selection.
      lastAnchorRect = null;
      positionAtViewportPoint(restored.x, restored.y);
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

      <div class="mhl-rotate-handle" id="mhl-rotate-handle" role="slider"
        aria-label="Rotate window by dragging"
        aria-valuemin="${ROTATE_MIN}" aria-valuemax="${ROTATE_MAX}" aria-valuenow="${currentRotation}"
        title="Drag to rotate">↻</div>

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
          <div class="mhl-rotate-head">
            <p class="mhl-appearance-label" id="mhl-rotate-label">Rotation</p>
            <span class="mhl-rotate-readout" id="mhl-rotate-readout">${formatAngle(currentRotation)}</span>
          </div>

          <input
            type="range"
            class="mhl-rotate-slider"
            id="mhl-rotate-slider"
            min="${ROTATE_MIN}"
            max="${ROTATE_MAX}"
            step="${ROTATE_PRECISION}"
            value="${currentRotation}"
            aria-labelledby="mhl-rotate-label"
            aria-label="Rotation angle in degrees"
            title="Drag to rotate the window"
          />
          <div class="mhl-rotate-scale"><span>${ROTATE_MIN}°</span><span>+${ROTATE_MAX}°</span></div>

          <div class="mhl-rotate-row">
            <button type="button" class="mhl-rotate-step" id="mhl-rotate-left"
              title="Rotate left 1 degree (hold Shift for ${ROTATE_SHIFT_STEP}°)"
              aria-label="Rotate left 1 degree">−1°</button>
            <button type="button" class="mhl-rotate-action" id="mhl-rotate-level"
              title="Set rotation to level (0°)" aria-label="Set rotation to level">Level</button>
            <button type="button" class="mhl-rotate-action" id="mhl-rotate-default"
              title="Restore the default tilt (${formatAngle(DEFAULT_ROTATION)})"
              aria-label="Restore default tilt">Default</button>
            <button type="button" class="mhl-rotate-step" id="mhl-rotate-right"
              title="Rotate right 1 degree (hold Shift for ${ROTATE_SHIFT_STEP}°)"
              aria-label="Rotate right 1 degree">+1°</button>
          </div>

          <div class="mhl-rotate-exact">
            <label for="mhl-rotate-input">Angle</label>
            <input
              type="number"
              class="mhl-rotate-input"
              id="mhl-rotate-input"
              min="${ROTATE_MIN}"
              max="${ROTATE_MAX}"
              step="${ROTATE_PRECISION}"
              value="${currentRotation}"
              aria-label="Exact rotation angle in degrees"
            />
            <span class="mhl-rotate-unit">°</span>
          </div>

          <p class="mhl-appearance-sublabel">Quick angles</p>
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
      // preset cycle (inline style beats the class). Clear it — including
      // the remembered resize intent, which keepPanelOnScreen() would
      // otherwise re-apply — so the old button keeps doing exactly what it
      // always did.
      popupEl.style.width = "";
      desiredWidth = null;
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

      // Only one of pointerup/pointercancel ever fires per gesture, so a
      // plain {once:true} pair leaks one dead listener onto the header
      // every time the user drags again. An AbortController lets whichever
      // terminal event fires first remove all three listeners atomically.
      const controller = new AbortController();
      const { signal } = controller;

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
        controller.abort();
        // keepPanelOnScreen() can clamp/reposition the panel out from under
        // the cursor (e.g. a drag that ends past a viewport edge). The
        // native "mouseup" that follows this pointerup would then land
        // outside the (now-moved) popup, and handleSelectionChange would
        // read that as "clicked away with no selection" and close the
        // panel right after the user moved it. Extend the same
        // preserve-panel window already used during speech playback so
        // that stray event is ignored.
        preservePanelUntil = Date.now() + 500;
        keepPanelOnScreen();
        persistGeometry();
        updateAppearanceActiveStates();
      };
      header.addEventListener("pointermove", move, { signal });
      header.addEventListener("pointerup", stop, { signal });
      header.addEventListener("pointercancel", stop, { signal });
    });
  }

  // Clamps the panel back into the viewport, accounting for its current
  // rotation. getBoundingClientRect() already reports the real rotated
  // bounding box, so the clamp target is converted back to the unrotated
  // left/top the element is actually positioned with.
  function keepPanelOnScreen() {
    if (!popupEl) return;
    const margin = 8;
    // Repositioning alone can't help if the panel's *rotated* footprint is
    // simply larger than the viewport (a modest rotation inflates the
    // bounding box well past the element's own width/height) — no position
    // exists where such a box fits, so its size has to shrink first.
    applySizeForCurrentRotation(margin);
    const width = popupEl.offsetWidth;
    const height = popupEl.offsetHeight;
    const box = rotatedBoundingBox(width, height, currentRotation);
    const rect = popupEl.getBoundingClientRect();
    const maxAabbLeft = Math.max(margin, innerWidth - box.width - margin);
    const maxAabbTop = Math.max(margin, innerHeight - box.height - margin);
    const aabbLeft = clampNumber(rect.left, margin, maxAabbLeft);
    const aabbTop = clampNumber(rect.top, margin, maxAabbTop);
    const left = aabbLeft + (box.width - width) / 2;
    const top = aabbTop + (box.height - height) / 2;
    popupEl.style.left = `${scrollX + left}px`;
    popupEl.style.top = `${scrollY + top}px`;
  }

  // Re-applies the user's intended size, then shrinks it only as far as
  // this rotation and viewport actually require.
  //
  // Sizing always restarts from desiredWidth/desiredHeight rather than
  // from whatever is currently rendered. Measuring the rendered size would
  // compound: rotating to 90deg shrinks the panel, and rotating back would
  // then fit the *shrunken* size, so sweeping the slider would ratchet the
  // panel down to its minimum and never grow back. Starting from the
  // remembered intent makes rotation fully reversible.
  function applySizeForCurrentRotation(margin) {
    if (!popupEl) return;
    if (desiredWidth !== null) popupEl.style.width = `${desiredWidth}px`;
    else popupEl.style.width = ""; // fall back to the panel-size CSS class
    if (desiredHeight !== null) popupEl.style.height = `${desiredHeight}px`;
    else popupEl.style.height = ""; // fall back to content height

    const width = popupEl.offsetWidth;
    const height = popupEl.offsetHeight;
    const availW = Math.max(MIN_WIDTH, innerWidth - margin * 2);
    const availH = Math.max(MIN_HEIGHT, innerHeight - margin * 2);
    const fitted = fitSizeToViewport(width, height, currentRotation, availW, availH);
    if (fitted.width !== width) popupEl.style.width = `${fitted.width}px`;
    if (fitted.height !== height) popupEl.style.height = `${fitted.height}px`;
  }

  // Records the current rendered size as the user's intent. Called when
  // the user deliberately sets a size (resize-end), never after a
  // rotation-driven fit, so a temporary shrink is never mistaken for a
  // chosen size.
  function rememberDesiredSize() {
    if (!popupEl) return;
    desiredWidth = popupEl.offsetWidth;
    desiredHeight = popupEl.offsetHeight;
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

        // See wireDragging() for why this needs an AbortController rather
        // than a plain {once:true} pointerup/pointercancel pair.
        const controller = new AbortController();
        const { signal } = controller;

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
          controller.abort();
          // Capture the size the user just dragged to as the new intent
          // *before* clamping — keepPanelOnScreen() re-applies the
          // remembered size, so a stale value here would silently undo
          // the resize that just happened.
          rememberDesiredSize();
          keepPanelOnScreen();
          persistGeometry();
          updateAppearanceActiveStates();
        };
        el.addEventListener("pointermove", move, { signal });
        el.addEventListener("pointerup", stop, { signal });
        el.addEventListener("pointercancel", stop, { signal });
      });
    });
  }

  // Cheap live path: writes only the transform. Used for every frame of a
  // slider drag or rotation-handle drag, where re-fitting the size on each
  // frame would thrash layout and make the motion stutter. The size/
  // position fit runs once when the interaction settles (setRotation).
  function applyRotation(rotation) {
    if (!popupEl) return;
    currentRotation = normalizeRotation(rotation);
    popupEl.style.transform = currentRotation ? `rotate(${currentRotation}deg)` : "";
    syncRotationControls();
  }

  // Committing path. Rotating around the panel's own center (the CSS
  // default transform origin) never moves that center, so no x/y
  // correction is needed here — only a re-fit in case the now-larger
  // rotated box no longer fits the viewport.
  function setRotation(rotation) {
    if (!popupEl) return;
    applyRotation(rotation);
    keepPanelOnScreen();
  }

  // Mirrors currentRotation into the readout, slider, and numeric field.
  // The element that originated the change is skipped while it has focus
  // so typing "1" on the way to "14" is not rewritten under the caret.
  function syncRotationControls() {
    const readout = document.getElementById("mhl-rotate-readout");
    if (readout) readout.textContent = formatAngle(currentRotation);

    const slider = document.getElementById("mhl-rotate-slider");
    if (slider && Number(slider.value) !== currentRotation) slider.value = String(currentRotation);

    const field = document.getElementById("mhl-rotate-input");
    if (field && document.activeElement !== field && Number(field.value) !== currentRotation) {
      field.value = String(currentRotation);
    }

    popupEl?.querySelectorAll(".mhl-angle-chip[data-angle]").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.angle) === currentRotation);
    });

    document.getElementById("mhl-rotate-handle")?.setAttribute("aria-valuenow", String(currentRotation));
  }

  function applyAccent(accent) {
    if (!popupEl) return;
    currentAccent = normalizeAccent(accent);
    const preset = ACCENT_PRESETS[currentAccent];
    // Presets are pre-curated and verified for contrast (tests/floating-window.mjs)
    // and used as-is. A custom pick isn't curated, so it's clamped to a
    // legible brightness first — the persisted currentAccent keeps the
    // user's original choice; only the *displayed* gradient is adjusted.
    const light = preset ? preset.light : ensureLegibleAsBackground(currentAccent, ACCENT_FG_LIGHT);
    const dark = preset ? preset.dark : darkenHex(light, 0.42);
    popupEl.style.setProperty("--mhl-accent-light", light);
    popupEl.style.setProperty("--mhl-accent-dark", dark);
    popupEl.style.setProperty("--mhl-accent-soft", hexToRgba(light, 0.14));
    popupEl.style.setProperty("--mhl-accent-fg", pickAccentForeground(light, dark));
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
  // Accepts an optional extra partial to merge in the same read-modify-write
  // (e.g. a new rotation angle) rather than issuing a second, separate
  // getPrefs()/setPrefs() round trip — two independent persist* calls
  // fired concurrently would each read a stale snapshot and could clobber
  // whichever one's write lands second.
  async function persistGeometry(extra) {
    if (!popupEl) return;
    const rect = popupEl.getBoundingClientRect();
    const prefs = await getPrefs();
    prefs.windowX = Math.round(rect.left);
    prefs.windowY = Math.round(rect.top);
    // Persist the size the user ASKED for, never the rendered size. The
    // rendered size may be a temporary rotation/viewport fit; storing that
    // would make the shrink permanent — the next rebuild would read it back
    // as the new intent and the panel would ratchet smaller every time it
    // passed through a steep angle. null stays null (no explicit size).
    prefs.windowWidth = desiredWidth === null ? null : Math.round(desiredWidth);
    prefs.windowHeight = desiredHeight === null ? null : Math.round(desiredHeight);
    if (extra) Object.assign(prefs, extra);
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
    // Cleared back to "never customized" rather than written as a literal
    // -3, so a future change to DEFAULT_ROTATION reaches reset users too.
    // Visually the panel still shows the default tilt immediately below.
    prefs.windowRotation = null;
    prefs.windowAccent = "default";
    prefs.windowStyle = "classic";
    await setPrefs(prefs);

    desiredWidth = null;
    desiredHeight = null;
    popupEl.style.width = "";
    popupEl.style.height = "";
    applyRotation(DEFAULT_ROTATION);
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
      // The direct rotation handle only exists while the user is
      // deliberately customizing, so it never clutters normal reading.
      popupEl?.classList.toggle("mhl-customizing", panel.classList.contains("open"));
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

    // Rotation can shrink/reposition the panel via keepPanelOnScreen() (see
    // applySizeForCurrentRotation), so both geometry and the rotation angle
    // itself need persisting — as a single read-modify-write, not two
    // independent persist calls that could race and clobber each other.
    const commitRotation = async (angle) => {
      setRotation(angle);
      updateAppearanceActiveStates();
      await persistGeometry({ windowRotation: currentRotation });
    };

    // Slider: "input" fires continuously while dragging, so it only moves
    // the transform (no storage, no layout fit). "change" fires once when
    // the drag ends or a keyboard adjustment settles — that is where the
    // panel is re-fitted and the value is written to chrome.storage.
    const slider = document.getElementById("mhl-rotate-slider");
    if (slider) {
      slider.addEventListener("input", () => {
        applyRotation(Number(slider.value));
      });
      slider.addEventListener("change", async () => {
        await commitRotation(Number(slider.value));
      });
    }

    // Exact numeric entry. An empty or half-typed field is allowed to sit
    // there while the user edits (no rotation change, no persistence, no
    // NaN reaching the transform); it is only committed once the value
    // parses, and reverted to the live angle on blur if it never does.
    const field = document.getElementById("mhl-rotate-input");
    if (field) {
      field.addEventListener("input", () => {
        const raw = field.value.trim();
        if (raw === "" || raw === "-" || raw === "+") return;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return;
        applyRotation(parsed);
      });
      const commitField = async () => {
        const raw = field.value.trim();
        const parsed = Number(raw);
        if (raw === "" || !Number.isFinite(parsed)) {
          field.value = String(currentRotation); // discard the invalid edit
          return;
        }
        await commitRotation(parsed);
        field.value = String(currentRotation); // reflect wrapping/rounding
      };
      field.addEventListener("change", commitField);
      field.addEventListener("blur", commitField);
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitField();
        }
      });
    }

    document.getElementById("mhl-rotate-left")?.addEventListener("click", async (e) => {
      await commitRotation(currentRotation - (e.shiftKey ? ROTATE_SHIFT_STEP : ROTATE_FINE_STEP));
    });
    document.getElementById("mhl-rotate-right")?.addEventListener("click", async (e) => {
      await commitRotation(currentRotation + (e.shiftKey ? ROTATE_SHIFT_STEP : ROTATE_FINE_STEP));
    });
    document.getElementById("mhl-rotate-level")?.addEventListener("click", async () => {
      await commitRotation(0);
    });
    document.getElementById("mhl-rotate-default")?.addEventListener("click", async () => {
      await commitRotation(DEFAULT_ROTATION);
    });

    panel.querySelectorAll(".mhl-angle-chip[data-angle]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await commitRotation(Number(btn.dataset.angle));
      });
    });

    document.getElementById("mhl-reset-window")?.addEventListener("click", async () => {
      await resetFloatingWindow();
      panel.classList.remove("open");
      popupEl?.classList.remove("mhl-customizing");
    });

    wireRotationHandle();

    updateAppearanceActiveStates();
  }

  // Direct rotation: grab the handle above the panel and swing it around
  // the panel's own center, the way a design tool behaves. Only active
  // while the Appearance popover is open (.mhl-customizing).
  function wireRotationHandle() {
    const handle = document.getElementById("mhl-rotate-handle");
    if (!handle || !popupEl) return;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation(); // never let this reach the header drag

      // A rotation transform about the default origin leaves the element's
      // center invariant, so the bounding-box center IS the pivot.
      const rect = popupEl.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const pointerAngle = (e) => (Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180) / Math.PI;

      // Anchoring to the angle under the pointer at grab time is what
      // stops the panel snapping to the pointer on the first move.
      const grabAngle = pointerAngle(event);
      const startRotation = currentRotation;

      handle.setPointerCapture(event.pointerId);
      const controller = new AbortController();
      const { signal } = controller;

      let pending = startRotation;
      let frameQueued = false;
      const applyFrame = () => {
        frameQueued = false;
        applyRotation(pending); // transform only — no layout fit per frame
      };
      const move = (moveEvent) => {
        pending = startRotation + (pointerAngle(moveEvent) - grabAngle);
        if (!frameQueued) {
          frameQueued = true;
          requestAnimationFrame(applyFrame);
        }
      };
      const stop = async () => {
        controller.abort();
        // Same guard the drag/resize gestures use: the fit below can move
        // the panel out from under the cursor, and the trailing native
        // mouseup would otherwise read as "clicked away" and close it.
        preservePanelUntil = Date.now() + 500;
        setRotation(pending);
        updateAppearanceActiveStates();
        await persistGeometry({ windowRotation: currentRotation });
      };
      handle.addEventListener("pointermove", move, { signal });
      handle.addEventListener("pointerup", stop, { signal });
      handle.addEventListener("pointercancel", stop, { signal });
    });
  }

  function updateAppearanceActiveStates() {
    if (!popupEl) return;
    popupEl.querySelectorAll(".mhl-swatch[data-accent]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.accent === currentAccent);
    });
    popupEl.querySelectorAll(".mhl-shape-option[data-shape]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.shape === currentShape);
    });
    syncRotationControls();
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
    popupEl?.classList.remove("mhl-customizing");
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

    // The panel was positioned while the body still said "Looking that
    // up…", so it was measured short. Filling in the real results can make
    // it much taller — tall enough to hang off the bottom of the viewport,
    // taking the resize handles out of reach with it. Re-fit now that the
    // final content height is known.
    keepPanelOnScreen();

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

  const DEFAULT_PREFS = {
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
    // null means "rotation was never customized" and resolves to the
    // subtle DEFAULT_ROTATION tilt. A stored number is an explicit user
    // choice and is honoured exactly — including 0, which means the user
    // deliberately levelled the panel. See resolveRotationPreference().
    windowRotation: null,
    windowAccent: "default",
    windowStyle: "classic"
  };

  // Dragging, resizing, rotating, and recoloring all apply to the DOM
  // synchronously and only ever call this to persist the *final* value —
  // so a slow, failing, or unavailable chrome.storage.sync never blocks or
  // breaks live interaction, only the "remember this for next time" part.
  // A short safety timeout also guards the (rare) case where the callback
  // never fires at all, e.g. mid service-worker restart, so the panel can
  // never get stuck waiting on storage before it can even render.
  function getPrefs() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (prefs) => {
        if (settled) return;
        settled = true;
        resolve(prefs);
      };
      const timeoutId = setTimeout(() => {
        console.warn("Manhua Lens: chrome.storage.sync.get timed out, using defaults for this session.");
        finish({ ...DEFAULT_PREFS });
      }, 1500);

      try {
        chrome.storage.sync.get(DEFAULT_PREFS, (prefs) => {
          clearTimeout(timeoutId);
          if (chrome.runtime.lastError) {
            console.warn("Manhua Lens: failed to read preferences, using defaults for this session.", chrome.runtime.lastError);
            finish({ ...DEFAULT_PREFS });
            return;
          }
          finish(prefs || { ...DEFAULT_PREFS });
        });
      } catch (err) {
        clearTimeout(timeoutId);
        console.warn("Manhua Lens: chrome.storage.sync.get threw, using defaults for this session.", err);
        finish({ ...DEFAULT_PREFS });
      }
    });
  }

  function setPrefs(prefs) {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.set(prefs, () => {
          if (chrome.runtime.lastError) {
            console.warn("Manhua Lens: failed to save preferences (current session is unaffected).", chrome.runtime.lastError);
          }
          resolve();
        });
      } catch (err) {
        console.warn("Manhua Lens: chrome.storage.sync.set threw (current session is unaffected).", err);
        resolve();
      }
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
      computeFitScale,
      fitSizeToViewport,
      hexToRgb,
      rgbToHex,
      darkenHex,
      hexToRgba,
      relativeLuminance,
      contrastRatio,
      pickAccentForeground,
      ensureLegibleAsBackground,
      isValidHexColor,
      normalizeAccent,
      normalizeWindowStyle,
      normalizeRotation,
      resolveRotationPreference,
      formatAngle,
      clampWindowGeometry,
      ACCENT_PRESETS,
      SHAPE_KEYS,
      MIN_WIDTH,
      MIN_HEIGHT,
      ROTATE_MIN,
      ROTATE_MAX,
      ROTATE_PRECISION,
      DEFAULT_ROTATION,
      ANGLE_PRESETS,
      WCAG_AA_NORMAL_TEXT,
      ACCENT_FG_LIGHT,
      ACCENT_FG_DARK,
      getPrefs,
      setPrefs
    });
  }
})();
