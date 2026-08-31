// === Lockbook — Journal App Main Logic ===

// ── Tauri v2 compatibility shim ──
// In Tauri v2 the global API moved under `window.__TAURI__.core` (e.g.
// `core.invoke`). Re-expose `invoke` at the top level so the call sites below
// keep working unchanged.
if (window.__TAURI__ && !window.__TAURI__.invoke && window.__TAURI__.core) {
  window.__TAURI__.invoke = window.__TAURI__.core.invoke;
}

// Single source of truth for the version shown in the UI (footers, settings
// "About" section). Keep in sync with Cargo.toml / tauri.conf.json / package.json.
const APP_VERSION = "2.0.0";

// ── State ──
let currentJournal = null;
let currentFilePath = null;
let currentPassword = null;
let currentKeyfile = null;
let activeEntryId = null;
let autoSaveTimer = null;
let recentJournals = [];
let isDirty = false;
let savePromise = null;
let dirtyRevision = 0;
let lastWindowTitle = "Lockbook";
let sidebarWidth = null;

const SIDEBAR_WIDTH_KEY = "lockbook_sidebar_width";
const SIDEBAR_DEFAULT_WIDTH = 270;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;

let attachmentsHeight = null;
const ATTACHMENTS_HEIGHT_KEY = "lockbook_attachments_height";
const ATTACHMENTS_DEFAULT_HEIGHT = 92;
const ATTACHMENTS_MIN_HEIGHT = 44;
const ATTACHMENTS_MAX_HEIGHT = 320;

// "inline" | "attachment" — remembered choice for pasted images, see
// resolvePasteImageChoice().
const PASTE_IMAGE_PREF_KEY = "lockbook_paste_image_pref";

// Auto-lock: minutes of inactivity before the open journal is locked (0 = off).
// App-wide preference (not per-journal), so it applies before any journal is open.
const AUTO_LOCK_KEY = "lockbook_autolock_minutes";
const AUTO_LOCK_DEFAULT_MINUTES = 5;
let autoLockMinutes = AUTO_LOCK_DEFAULT_MINUTES;
let autoLockTimer = null;

// Lazy attachment bytes: v2 journals open without decrypting any attachment
// blobs. Bytes are fetched from the encrypted container on demand and cached
// here for the session (keyed by attachment id). Cleared on open/close/lock.
const attachmentCache = new Map();

// Attachments the user opened in an external app (id → { path, data }), where
// `path` is the decrypted temp copy handed to the OS and `data` is the base64 we
// last wrote/read for it. Editing that file in an external editor (e.g. saving a
// MuseScore file) changes the temp copy but not the journal, so before every
// save we read these back and fold any external edits into the attachment.
// Cleared on close/lock.
const externalAttachmentEdits = new Map();

// Small inline "close/remove" icon reused by dynamically-built list rows.
// Inline SVG (not an emoji) so it renders identically on every platform.
const IC_X = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>';

// Matches `![alt](attachment:<id> "width=<px>")` — the "width" part is optional.
const ATTACHMENT_IMG_SOURCE = String.raw`!\[([^\]]*)\]\(attachment:([\w-]+)(?:\s+"width=(\d+)")?\)`;

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Helper alias ──
const $id = (id) => document.getElementById(id);

// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
  applyAppVersionLabels();
  loadSidebarWidth();
  bindSidebarResize();
  loadAttachmentsHeight();
  bindAttachmentsResize();
  window.addEventListener("resize", () => {
    if (sidebarWidth !== null) {
      applySidebarWidth(sidebarWidth, false, true);
    }
  });
  loadRecentJournals();
  loadAutoLockMinutes();
  bindAutoLockActivity();
  bindExternalAttachmentSync();
  scheduleTimEncCheck();
  bindWelcomeButtons();
  bindCreateScreen();
  bindLockScreen();
  bindJournalUI();
  bindSettingsUI();
  setupEmojiPicker();
  setupKeyboardShortcuts();
  setupCloseGuard();

  $id("timenc-download-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    window.__TAURI__.shell.open("https://github.com/SnowTimSwiss/TimENC/releases/latest");
  });
  $id("shortcuts-close-btn")?.addEventListener("click", () => {
    $id("shortcuts-modal")?.classList.add("hidden");
  });
});

// Guard against closing the window mid-save. A save rewrites the encrypted
// journal file; if the process dies partway through, the file is left truncated
// and can no longer be decrypted. When a close is requested with unsaved changes
// or a save still in flight, we hold the window open, flush the save, and only
// then destroy it.
function setupCloseGuard() {
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!win || typeof win.onCloseRequested !== "function") return;

  win.onCloseRequested(async (event) => {
    // Nothing open, clean, and no save running → let the window close normally.
    if (!currentJournal || (!isDirty && !savePromise)) return;

    // Keep the window alive until the save has fully landed on disk.
    event.preventDefault();
    try {
      await persistJournal({ skipIfClean: true });
    } catch (err) {
      console.error("Save on close failed:", err);
    }
    await win.destroy();
  });
}

// ═══════════════════════════════════════════════════════════════
//  SCREEN VISIBILITY
// ═══════════════════════════════════════════════════════════════

const SCREEN_AUTOFOCUS = {
  "create-screen": "create-name",
  "lock-screen": "lock-password",
};

function showScreen(screenId) {
  ["welcome-screen", "create-screen", "lock-screen", "journal-ui"].forEach((id) => {
    const el = $id(id);
    if (el) el.style.display = id === screenId ? "flex" : "none";
  });

  const focusId = SCREEN_AUTOFOCUS[screenId];
  if (focusId) $id(focusId)?.focus();
}

function loadSidebarWidth() {
  try {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    sidebarWidth = clampSidebarWidth(Number.isFinite(stored) ? stored : SIDEBAR_DEFAULT_WIDTH, false);
  } catch {
    sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
  }

  applySidebarWidth(sidebarWidth, false);
}

function clampSidebarWidth(width, respectLayout = true) {
  const parsed = Number(width);
  let clamped = Number.isFinite(parsed) ? parsed : SIDEBAR_DEFAULT_WIDTH;
  clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, clamped));

  if (respectLayout) {
    const main = $id("main");
    const rect = main?.getBoundingClientRect();
    if (rect && rect.width > 0) {
      const maxByLayout = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(rect.width - 420)));
      clamped = Math.min(clamped, maxByLayout);
    }
  }

  return Math.round(clamped);
}

function applySidebarWidth(width, persist = false, respectLayout = true) {
  const clamped = clampSidebarWidth(width, respectLayout);
  sidebarWidth = clamped;
  document.documentElement.style.setProperty("--sidebar-width", `${clamped}px`);

  if (persist) {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
  }

  return clamped;
}

function bindSidebarResize() {
  const handle = $id("sidebar-resizer");
  if (!handle || handle.dataset.bound === "true") return;
  handle.dataset.bound = "true";

  let dragging = false;
  let startX = 0;
  let startWidth = SIDEBAR_DEFAULT_WIDTH;

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    document.documentElement.classList.remove("resizing-sidebar");
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", stopDragging);
    document.removeEventListener("pointercancel", stopDragging);
    applySidebarWidth(sidebarWidth, true);
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    applySidebarWidth(startWidth + (event.clientX - startX), false);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();

    dragging = true;
    startX = event.clientX;
    startWidth = sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;

    document.documentElement.classList.add("resizing-sidebar");
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", stopDragging);
    document.addEventListener("pointercancel", stopDragging);
  });

  handle.addEventListener("dblclick", () => {
    applySidebarWidth(SIDEBAR_DEFAULT_WIDTH, true);
  });
}

function loadAttachmentsHeight() {
  try {
    const stored = Number(localStorage.getItem(ATTACHMENTS_HEIGHT_KEY));
    attachmentsHeight = clampAttachmentsHeight(Number.isFinite(stored) ? stored : ATTACHMENTS_DEFAULT_HEIGHT);
  } catch {
    attachmentsHeight = ATTACHMENTS_DEFAULT_HEIGHT;
  }

  applyAttachmentsHeight(attachmentsHeight, false);
}

function clampAttachmentsHeight(height) {
  const parsed = Number(height);
  const value = Number.isFinite(parsed) ? parsed : ATTACHMENTS_DEFAULT_HEIGHT;
  return Math.round(Math.max(ATTACHMENTS_MIN_HEIGHT, Math.min(ATTACHMENTS_MAX_HEIGHT, value)));
}

function applyAttachmentsHeight(height, persist = false) {
  const clamped = clampAttachmentsHeight(height);
  attachmentsHeight = clamped;
  document.documentElement.style.setProperty("--attachments-height", `${clamped}px`);

  if (persist) {
    localStorage.setItem(ATTACHMENTS_HEIGHT_KEY, String(clamped));
  }

  return clamped;
}

// Dragging the handle grows the panel upward (shrinking the editor above
// it), so the height delta is the inverse of the pointer's vertical delta.
function bindAttachmentsResize() {
  const handle = $id("attachments-resizer");
  if (!handle || handle.dataset.bound === "true") return;
  handle.dataset.bound = "true";

  let dragging = false;
  let startY = 0;
  let startHeight = ATTACHMENTS_DEFAULT_HEIGHT;

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    document.documentElement.classList.remove("resizing-attachments");
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", stopDragging);
    document.removeEventListener("pointercancel", stopDragging);
    applyAttachmentsHeight(attachmentsHeight, true);
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    applyAttachmentsHeight(startHeight - (event.clientY - startY), false);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();

    dragging = true;
    startY = event.clientY;
    startHeight = attachmentsHeight ?? ATTACHMENTS_DEFAULT_HEIGHT;

    document.documentElement.classList.add("resizing-attachments");
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", stopDragging);
    document.addEventListener("pointercancel", stopDragging);
  });

  handle.addEventListener("dblclick", () => {
    applyAttachmentsHeight(ATTACHMENTS_DEFAULT_HEIGHT, true);
  });
}

function applyAppVersionLabels() {
  document.querySelectorAll(".app-version").forEach((el) => {
    el.textContent = `v${APP_VERSION}`;
  });
}

// ═══════════════════════════════════════════════════════════════
//  TIMENC CHECK
// ═══════════════════════════════════════════════════════════════

async function checkTimEnc() {
  try {
    const info = await window.__TAURI__.invoke("get_timenc_info");
    if (info.found) {
      const warn = $id("timenc-warning");
      if (warn) warn.classList.remove("visible");
    } else {
      const warn = $id("timenc-warning");
      if (warn) warn.classList.add("visible");
      const msg = $id("timenc-warn-msg");
      if (msg) msg.textContent = info.message || "TimENC CLI not found on PATH.";
      if (info.searched_in) {
        const ver = $id("timenc-ver");
        if (ver) ver.textContent = `searched: ${info.searched_in}`;
      }
    }
  } catch {
    const warn = $id("timenc-warning");
    if (warn) warn.classList.add("visible");
  }
}

// ═══════════════════════════════════════════════════════════════
//  RECENT JOURNALS
// ═══════════════════════════════════════════════════════════════

function scheduleTimEncCheck() {
  const run = () => {
    checkTimEnc().catch((err) => console.warn("TimENC check failed:", err));
  };

  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(run, { timeout: 1500 });
  } else {
    setTimeout(run, 250);
  }
}

function loadRecentJournals() {
  try {
    recentJournals = JSON.parse(localStorage.getItem("lockbook_recent") || "[]");
  } catch {
    recentJournals = [];
  }
  renderRecentJournals();
}

function saveRecentJournals() {
  localStorage.setItem("lockbook_recent", JSON.stringify(recentJournals));
  renderRecentJournals();
}

function addToRecent(path, name) {
  recentJournals = recentJournals.filter((r) => r.path !== path);
  recentJournals.unshift({ path, name: name || path.split(/[\\/]/).pop(), opened: Date.now() });
  recentJournals = recentJournals.slice(0, 5);
  saveRecentJournals();
}

function removeFromRecent(path) {
  recentJournals = recentJournals.filter((r) => r.path !== path);
  saveRecentJournals();
}

function renderRecentJournals() {
  const container = $id("recent-journals");
  if (!container) return;

  if (recentJournals.length === 0) {
    container.style.display = "none";
    return;
  }

  container.style.display = "block";
  container.innerHTML = `
    <div class="recent-label">Recent Journals</div>
    ${recentJournals
      .map(
        (r) => `
    <div class="recent-item" data-path="${escapeHtml(r.path)}">
      <span class="ri-icon">📔</span>
      <div class="ri-info">
        <span class="ri-name" title="${escapeHtml(r.path)}">${escapeHtml(r.name)}</span>
        <span class="ri-date">${formatDate(r.opened)}</span>
      </div>
      <button class="ri-remove" data-path="${escapeHtml(r.path)}" title="Remove">${IC_X}</button>
    </div>`
      )
      .join("")}`;

  container.querySelectorAll(".ri-remove").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const path = button.dataset.path;
      if (!path) return;
      removeFromRecent(path);
    });
  });

  // Bind clicks on recent items
  container.querySelectorAll(".recent-item").forEach((item) => {
    item.addEventListener("click", (event) => {
      if (event.target.closest(".ri-remove")) return;
      const path = item.dataset.path;
      if (path) openRecentJournal(path);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
//  WELCOME SCREEN
// ═══════════════════════════════════════════════════════════════

function bindWelcomeButtons() {
  const btnNew = $id("btn-new-journal");
  if (btnNew) btnNew.addEventListener("click", () => showScreen("create-screen"));

  const btnOpen = $id("btn-open-journal");
  if (btnOpen)
    btnOpen.addEventListener("click", async () => {
      const path = await window.__TAURI__.dialog.open({
        filters: [{ name: "Lockbook Journal", extensions: ["lbook", "timenc-journal"] }],
      });
      if (path) {
        currentFilePath = path;
        currentKeyfile = null;
        // Reset lock screen
        const pwInput = $id("lock-password");
        if (pwInput) pwInput.value = "";
        const kfInput = $id("lock-keyfile");
        if (kfInput) kfInput.value = "";
        const lockMode = $id("lock-mode");
        if (lockMode) lockMode.textContent = "Unlock Journal";
        const lockHint = $id("lock-file-hint");
        if (lockHint) lockHint.textContent = path.split(/[\\/]/).pop();
        $id("lock-error").textContent = "";
        showScreen("lock-screen");
      }
    });
}

async function openRecentJournal(path) {
  currentFilePath = path;
  currentKeyfile = null;
  // Reset lock screen
  const pwInput = $id("lock-password");
  if (pwInput) pwInput.value = "";
  const kfInput = $id("lock-keyfile");
  if (kfInput) kfInput.value = "";
  const lockMode = $id("lock-mode");
  if (lockMode) lockMode.textContent = "Unlock Journal";
  const lockHint = $id("lock-file-hint");
  if (lockHint) lockHint.textContent = path.split(/[\\/]/).pop();
  $id("lock-error").textContent = "";
  showScreen("lock-screen");
}

// ═══════════════════════════════════════════════════════════════
//  JOURNAL MODE (journal ↔ general)
// ═══════════════════════════════════════════════════════════════

// "journal" enables diary features (date-as-title, mood); "general" is plain
// notes; "music" is plain notes plus tablature blocks. Used both for the active
// journal and for the mode picker shared by the create screen and settings modal.
const JOURNAL_MODES = ["journal", "general", "music"];

function getJournalMode() {
  const m = currentJournal?.metadata?.mode;
  return JOURNAL_MODES.includes(m) ? m : "journal";
}

function setModeToggleValue(containerId, mode) {
  document.querySelectorAll(`#${containerId} .mode-toggle-btn`).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
}

function getModeToggleValue(containerId) {
  const m = document.querySelector(`#${containerId} .mode-toggle-btn.active`)?.dataset.mode;
  return JOURNAL_MODES.includes(m) ? m : "journal";
}

function bindModeToggle(containerId) {
  document.querySelectorAll(`#${containerId} .mode-toggle-btn`).forEach((btn) => {
    btn.addEventListener("click", () => setModeToggleValue(containerId, btn.dataset.mode));
  });
}

// Shows/hides mode-specific controls per the active journal's mode: the mood
// picker and date-as-title button are diary-only; the insert-tablature button
// is music-only.
function applyModeUi() {
  const mode = getJournalMode();
  const isJournal = mode === "journal";
  const mood = $id("mood-select");
  const dateBtn = $id("btn-date-title");
  const tabBtn = $id("btn-insert-tab");
  const tabSep = $id("fmt-sep-tab");
  const staffBtn = $id("btn-insert-staff");
  if (mood) mood.style.display = isJournal ? "" : "none";
  if (dateBtn) dateBtn.style.display = isJournal ? "" : "none";
  const showTab = mode === "music" ? "" : "none";
  if (tabBtn) tabBtn.style.display = showTab;
  if (tabSep) tabSep.style.display = showTab;
  if (staffBtn) staffBtn.style.display = showTab;
}

// ═══════════════════════════════════════════════════════════════
//  CREATE SCREEN
// ═══════════════════════════════════════════════════════════════

function bindCreateScreen() {
  bindModeToggle("create-mode-toggle");

  // Browse folder
  $id("create-browse-btn")?.addEventListener("click", async () => {
    const dir = await window.__TAURI__.dialog.open({ directory: true });
    if (dir) $id("create-path").value = dir;
  });

  // Browse keyfile
  $id("create-browse-keyfile")?.addEventListener("click", async () => {
    const file = await window.__TAURI__.dialog.open({
      filters: [{ name: "Keyfile", extensions: ["key"] }],
    });
    if (file) {
      currentKeyfile = file;
      $id("create-keyfile").value = file;
    }
  });

  // Generate keyfile
  $id("create-gen-keyfile")?.addEventListener("click", async () => {
    const dir = await window.__TAURI__.dialog.open({ directory: true });
    if (!dir) return;
    const kfPath = `${dir}/lockbook-key.key`;
    try {
      await window.__TAURI__.invoke("generate_keyfile", { path: kfPath });
      currentKeyfile = kfPath;
      $id("create-keyfile").value = kfPath;
      showStatus("Keyfile generiert: lockbook-key.key", 3000);
    } catch (err) {
      const errEl = $id("create-error");
      if (errEl) {
        errEl.textContent = `Keyfile Error: ${err}`;
        errEl.style.display = "block";
      }
    }
  });

  // Submit
  $id("create-submit-btn")?.addEventListener("click", doCreateJournal);

  // Back
  $id("create-back-btn")?.addEventListener("click", () => showScreen("welcome-screen"));

  // Enter-to-submit
  ["create-password", "create-confirm-pw"].forEach((id) => {
    $id(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $id("create-submit-btn")?.click();
    });
  });
}

async function doCreateJournal() {
  const name = $id("create-name")?.value.trim();
  const password = $id("create-password")?.value;
  const confirm = $id("create-confirm-pw")?.value;
  const folder = $id("create-path")?.value.trim();

  const errEl = $id("create-error");
  if (errEl) {
    errEl.textContent = "";
    errEl.style.display = "none";
  }

  if (!name) return showCreateError("Name eingeben");
  if (!folder) return showCreateError("Ordner auswählen");
  if (!password) return showCreateError("Passwort eingeben");
  if (password !== confirm) return showCreateError("Passwörter stimmen nicht überein");
  if (password.length < 4) return showCreateError("Passwort zu kurz (min. 4 Zeichen)");

  const filePath = `${folder}/${name}.lbook`;

  try {
    await window.__TAURI__.invoke("create_journal", {
      path: filePath,
      password,
      keyfile: currentKeyfile || null,
    });

    currentFilePath = filePath;
    currentPassword = password;

    currentJournal = {
      version: "2.0",
      entries: [],
      metadata: {
        name,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        app: "Lockbook",
        version: "2.0",
        mode: getModeToggleValue("create-mode-toggle"),
      },
    };

    addToRecent(filePath, name);
    enterJournalUI();
  } catch (err) {
    showCreateError(err.toString());
  }
}

function showCreateError(msg) {
  const el = $id("create-error");
  if (el) {
    el.textContent = msg;
    el.style.display = "block";
  }
}

// ═══════════════════════════════════════════════════════════════
//  LOCK SCREEN
// ═══════════════════════════════════════════════════════════════

function bindLockScreen() {
  // Browse keyfile
  $id("lock-browse-keyfile")?.addEventListener("click", async () => {
    const file = await window.__TAURI__.dialog.open({
      filters: [{ name: "Keyfile", extensions: ["key"] }],
    });
    if (file) {
      currentKeyfile = file;
      $id("lock-keyfile").value = file;
    }
  });

  // Submit
  $id("lock-submit-btn")?.addEventListener("click", doUnlockJournal);

  // Back
  $id("lock-back-btn")?.addEventListener("click", () => {
    currentFilePath = null;
    currentKeyfile = null;
    showScreen("welcome-screen");
  });

  // Enter-to-submit
  ["lock-password", "lock-keyfile"].forEach((id) => {
    $id(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $id("lock-submit-btn")?.click();
    });
  });
}

// Guards against a second unlock being started while one is already running.
// Decrypting a large (image-heavy) journal can take seconds, and the button
// gives no built-in feedback — without this, impatient re-clicks would each
// kick off another concurrent decryption, competing for CPU and making every
// attempt slower ("only works on the third try").
let isUnlocking = false;

async function doUnlockJournal() {
  if (isUnlocking) return;

  const password = $id("lock-password")?.value;
  const keyfile = $id("lock-keyfile")?.value;

  const errEl = $id("lock-error");
  if (errEl) {
    errEl.textContent = "";
    errEl.style.display = "none";
  }

  if (!password) return showLockError("Passwort eingeben");
  if (!currentFilePath) return showLockError("Kein Journal ausgewählt");

  currentKeyfile = keyfile || null;

  isUnlocking = true;
  setUnlockBusy(true);
  try {
    const result = await window.__TAURI__.invoke("open_journal", {
      path: currentFilePath,
      password,
      keyfile: currentKeyfile || null,
    });

    attachmentCache.clear(); // fresh journal → drop any cached blob bytes
    externalAttachmentEdits.clear(); // …and forget any prior external-edit tracking
    currentJournal = result;
    currentPassword = password;

    addToRecent(currentFilePath, result.metadata?.name);
    enterJournalUI();
  } catch (err) {
    showLockError(err.toString());
  } finally {
    isUnlocking = false;
    setUnlockBusy(false);
  }
}

// Toggle the unlock button between its idle label and a disabled "busy" state
// with a spinner, so the user gets immediate feedback and can't re-trigger the
// decryption mid-flight.
function setUnlockBusy(busy) {
  const btn = $id("lock-submit-btn");
  if (!btn) return;
  if (busy) {
    btn.dataset.idleLabel = btn.textContent;
    btn.disabled = true;
    btn.classList.add("btn-loading");
    btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>Decrypting…';
  } else {
    btn.disabled = false;
    btn.classList.remove("btn-loading");
    btn.textContent = btn.dataset.idleLabel || "Unlock";
  }
}

function showLockError(msg) {
  const el = $id("lock-error");
  if (el) {
    let clean = msg.replace(/\\u274c/g, "").replace(/\\u2705/g, "");
    clean = clean.replace(/^Error:\s*/i, "");
    if (clean.includes("exit code 1") || clean.includes("exit 1") || clean.includes("exitcode1")) {
      clean = "Falsches Passwort oder korrupte Datei.";
    }
    el.textContent = clean;
    el.style.display = "block";
  }
}

// ═══════════════════════════════════════════════════════════════
//  JOURNAL UI
// ═══════════════════════════════════════════════════════════════

function bindJournalUI() {
  // New entry
  $id("btn-new-entry")?.addEventListener("click", createNewEntry);

  // Save
  $id("btn-save")?.addEventListener("click", saveJournal);

  // Export
  $id("btn-export-md")?.addEventListener("click", exportMarkdown);

  // Close
  $id("btn-close")?.addEventListener("click", closeJournal);

  // Date as title
  $id("btn-date-title")?.addEventListener("click", setDateAsTitle);

  // Emoji picker
  $id("btn-emoji-picker")?.addEventListener("click", toggleEmojiPicker);

  // Rich-text editor
  bindFormatToolbar();
  bindImageResize();

  // Attachments
  bindAttachmentButtons();
  bindDragAndDropAttach();
  bindImagePaste();

  // Delete entry
  $id("delete-entry-btn")?.addEventListener("click", deleteCurrentEntry);

  // Tag input
  $id("add-tag-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  });

  // Mood change
  $id("mood-select")?.addEventListener("change", () => {
    const entry = currentJournal?.entries?.find((e) => e.id === activeEntryId);
    if (entry) {
      entry.mood = $id("mood-select").value;
      markDirty();
    }
  });

  // Title input → mark dirty
  $id("entry-title-input")?.addEventListener("input", handleTitleInput);

  // Content editor → mark dirty
  $id("content-editor")?.addEventListener("input", () => {
    markDirty();
    updateWordCount();
    updateEditorEmptyState();
  });

  // Search
  $id("search-input")?.addEventListener("input", (e) => {
    const query = e.target.value.trim().toLowerCase();
    if (!query || !currentJournal) {
      renderEntryList();
      return;
    }
    const results = currentJournal.entries.filter(
      (en) =>
        (en.title || "").toLowerCase().includes(query) ||
        htmlToPlainText(en.content || "").toLowerCase().includes(query) ||
        (en.tags || []).some((t) => t.toLowerCase().includes(query))
    );
    renderSearchResults(results, query);
  });

  // Shortcuts help
  $id("btn-shortcuts-help")?.addEventListener("click", toggleShortcutsModal);
}

function bindSettingsUI() {
  bindModeToggle("settings-mode-toggle");

  // Auto-lock applies immediately — it's an app-wide preference (localStorage),
  // not tied to the journal-name/password "Save Settings" flow below.
  $id("settings-autolock")?.addEventListener("change", () => {
    setAutoLockMinutes(Number($id("settings-autolock").value) || 0);
  });

  $id("btn-settings")?.addEventListener("click", openSettingsModal);
  $id("settings-close-btn")?.addEventListener("click", closeSettingsModal);
  $id("settings-cancel-btn")?.addEventListener("click", closeSettingsModal);
  $id("settings-save-btn")?.addEventListener("click", saveSettings);

  // Enter-to-submit
  ["settings-current-password", "settings-new-password", "settings-confirm-password"].forEach((id) => {
    $id(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $id("settings-save-btn")?.click();
    });
  });
}

function openSettingsModal() {
  if (!currentJournal) return;

  const modal = $id("settings-modal");
  if (!modal) return;

  clearSettingsError();
  $id("settings-journal-name").value = getJournalDisplayName();
  setModeToggleValue("settings-mode-toggle", getJournalMode());
  const autolockSelect = $id("settings-autolock");
  if (autolockSelect) autolockSelect.value = String(autoLockMinutes);
  $id("settings-current-password").value = "";
  $id("settings-new-password").value = "";
  $id("settings-confirm-password").value = "";

  const timencEl = $id("settings-timenc-version");
  if (timencEl) {
    timencEl.textContent = "…";
    window.__TAURI__.invoke("get_timenc_version")
      .then((v) => { timencEl.textContent = v || "unknown"; })
      .catch(() => { timencEl.textContent = "unknown"; });
  }

  modal.classList.remove("hidden");
  $id("settings-journal-name")?.focus();
}

function closeSettingsModal() {
  $id("settings-modal")?.classList.add("hidden");
}

function clearSettingsError() {
  const el = $id("settings-error");
  if (!el) return;
  el.textContent = "";
  el.style.display = "none";
}

function showSettingsError(message) {
  const el = $id("settings-error");
  if (!el) return;
  el.textContent = message;
  el.style.display = "block";
}

async function saveSettings() {
  if (!currentJournal || !currentFilePath || !currentPassword) return;

  clearSettingsError();

  const saveButton = $id("settings-save-btn");
  const name = ($id("settings-journal-name")?.value || "").trim();
  const currentPasswordInput = $id("settings-current-password")?.value || "";
  const newPassword = $id("settings-new-password")?.value || "";
  const confirmPassword = $id("settings-confirm-password")?.value || "";
  const wantsPasswordChange = Boolean(currentPasswordInput || newPassword || confirmPassword);
  const previousMetadata = currentJournal.metadata ? { ...currentJournal.metadata } : null;

  if (!name) return showSettingsError("Journal name eingeben");

  if (wantsPasswordChange) {
    if (!currentPasswordInput) return showSettingsError("Aktuelles Passwort eingeben");
    if (!newPassword) return showSettingsError("Neues Passwort eingeben");
    if (newPassword !== confirmPassword) return showSettingsError("Neue Passwoerter stimmen nicht ueberein");
    if (newPassword.length < 4) return showSettingsError("Neues Passwort zu kurz (min. 4 Zeichen)");
  }

  const previousPassword = currentPassword;
  try {
    if (saveButton) saveButton.disabled = true;
    syncActiveEntry();

    if (!currentJournal.metadata || typeof currentJournal.metadata !== "object") {
      currentJournal.metadata = {};
    }
    currentJournal.metadata.name = name;
    currentJournal.metadata.mode = getModeToggleValue("settings-mode-toggle");
    currentJournal.metadata.modified = new Date().toISOString();
    normalizeJournalData();

    if (wantsPasswordChange) {
      const payload = buildJournalPayload();
      await window.__TAURI__.invoke("change_journal_password", {
        path: currentFilePath,
        currentPassword: currentPasswordInput,
        newPassword,
        keyfile: currentKeyfile || null,
        data: payload,
      });
      currentPassword = newPassword;
      clearDirty();
      showStatus("Settings saved", 3000);
    } else {
      const saved = await persistJournal({
        successMessage: "Settings saved",
        successDuration: 3000,
        errorPrefix: "Settings save failed: ",
      });
      if (!saved) return;
    }

    addToRecent(currentFilePath, name);
    updateMetadata();
    updateTitleSurfaces();
    applyModeUi();
    renderEntryList();
    closeSettingsModal();
  } catch (err) {
    currentPassword = previousPassword;
    if (previousMetadata) currentJournal.metadata = previousMetadata;
    const message = err?.toString?.() || String(err);
    showSettingsError(message.replace(/^Error:\s*/i, ""));
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

function enterJournalUI() {
  // Migrate v1.3.0 (Markdown) journals to the v2 HTML model in memory.
  migrateJournalToV2();
  // Normalize journal data to ensure all entries have required fields
  normalizeJournalData();

  applyModeUi();
  showScreen("journal-ui");
  applySidebarWidth(sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH, false, true);
  renderEntryList();
  updateMetadata();
  startAutoSave();
  resetAutoLockTimer();
}

function renderEntryList() {
  const container = $id("entry-list");
  if (!container || !currentJournal) return;

  const entries = [...currentJournal.entries].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );

  if (entries.length === 0) {
    container.innerHTML = `
      <div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px">
        Noch keine Einträge. Erstelle den ersten!
      </div>`;
    return;
  }

  const showMood = getJournalMode() === "journal";

  container.innerHTML = entries
    .map(
      (e) => `
    <div class="entry-item ${e.id === activeEntryId ? "active" : ""}" data-id="${e.id}">
      <div class="ei-title">${escapeHtml(e.title || "(Kein Titel)")}</div>
      <div class="ei-meta">
        ${showMood && e.mood ? `<span class="ei-mood">${e.mood}</span>` : ""}
        <span class="ei-date">${formatEntryDate(e.timestamp)}</span>
      </div>
      ${e.tags?.length ? `<div class="ei-tags">${e.tags.map((t) => `<span class="tag-badge">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    </div>`
    )
    .join("");

  // Bind clicks
  container.querySelectorAll(".entry-item").forEach((el) => {
    el.addEventListener("click", () => selectEntry(el.dataset.id));
  });
}

function selectEntry(id) {
  if (activeEntryId && activeEntryId !== id) {
    syncActiveEntry();
    updateActiveEntryListTitle();
  }

  activeEntryId = id;
  const entry = currentJournal.entries.find((e) => e.id === id);
  if (!entry) return;

  renderEntryList();

  // Show editor, hide empty state
  $id("empty-state").style.display = "none";
  $id("entry-editor").style.display = "flex";

  $id("entry-title-input").value = entry.title || "";
  setEditorContent(entry.content || "", entry.attachments);
  $id("mood-select").value = entry.mood || "neutral";

  renderTags();
  renderAttachments();
  updateWordCount();
  updateMetadata();
  updateTitleSurfaces();
}

function showEmptyState() {
  $id("empty-state").style.display = "flex";
  $id("entry-editor").style.display = "none";
}

function createNewEntry() {
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    title: "",
    content: "",
    tags: [],
    mood: "neutral",
    attachments: [],
  };

  currentJournal.entries.push(entry);
  activeEntryId = entry.id;

  renderEntryList();
  selectEntry(entry.id);
  markDirty();

  $id("entry-title-input").focus();
}

function deleteCurrentEntry() {
  if (!activeEntryId) return;
  if (!confirm("Eintrag wirklich löschen?")) return;

  currentJournal.entries = currentJournal.entries.filter((e) => e.id !== activeEntryId);
  activeEntryId = null;

  showEmptyState();
  renderEntryList();
  updateMetadata();
  updateTitleSurfaces();
  markDirty();
}

function setDateAsTitle() {
  const now = new Date();
  const options = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
  const dateStr = now.toLocaleDateString("de-DE", options);

  const input = $id("entry-title-input");
  if (input && !input.value) {
    input.value = dateStr;
  } else if (input) {
    input.value += ` — ${dateStr}`;
  }
  handleTitleInput();
}

// ── Tags ──
function addTag() {
  const input = $id("add-tag-input");
  if (!input) return;
  const tag = input.value.trim().toLowerCase();
  if (!tag) return;

  const entry = currentJournal.entries.find((e) => e.id === activeEntryId);
  if (!entry) return;
  if (!entry.tags) entry.tags = [];
  if (entry.tags.includes(tag)) {
    input.value = "";
    return;
  }

  entry.tags.push(tag);
  input.value = "";
  renderTags();
  markDirty();
}

function removeTag(tag) {
  const entry = currentJournal.entries.find((e) => e.id === activeEntryId);
  if (!entry || !entry.tags) return;
  entry.tags = entry.tags.filter((t) => t !== tag);
  renderTags();
  markDirty();
}

// Make it globally accessible for inline onclick handlers
window.removeTag = removeTag;

function renderTags() {
  const container = $id("tags-row");
  if (!container) return;

  const entry = currentJournal.entries.find((e) => e.id === activeEntryId);
  if (!entry) return;

  const tags = (entry.tags || []).map(
    (t) => `
    <span class="tag-chip">
      ${escapeHtml(t)}
      <button onclick="removeTag('${escapeJs(t)}')">${IC_X}</button>
    </span>`
  );

  // Rebuild: keep the input at the end
  const existingChips = container.querySelectorAll(".tag-chip");
  existingChips.forEach((c) => c.remove());

  const input = $id("add-tag-input");
  tags.forEach((html) => {
    input.insertAdjacentHTML("beforebegin", html);
  });
}

// ── Attachments ──

function isImageMime(mime) {
  return typeof mime === "string" && mime.startsWith("image/");
}

function isValidAttachment(a) {
  return (
    a &&
    typeof a === "object" &&
    typeof a.id === "string" &&
    typeof a.name === "string" &&
    typeof a.mime_type === "string" &&
    typeof a.data === "string"
  );
}

// Inline images are represented by an `<img data-att-id="…">` element in the
// entry's HTML content — if that element is deleted from the text, the backing
// attachment is orphaned and dropped so it doesn't bloat the journal forever.
// Panel attachments (non-images, or images the user placed as a file) are kept
// regardless; they live in the attachments panel and are removed there.
function pruneOrphanedImageAttachments(content, attachments) {
  if (!attachments.length) return attachments;
  const referenced = new Set();
  const re = /data-att-id="([\w-]+)"/g;
  let m;
  while ((m = re.exec(content || ""))) referenced.add(m[1]);
  return attachments.filter(
    (a) => !isImageMime(a.mime_type) || a.placement === "panel" || referenced.has(a.id)
  );
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentIcon(mime) {
  if (!mime) return "📄";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.startsWith("video/")) return "🎬";
  if (mime === "application/pdf") return "📕";
  if (mime === "application/zip") return "🗜";
  if (mime.startsWith("text/")) return "📝";
  return "📄";
}

// Insert a DOM node at the current caret inside the contenteditable editor.
// Falls back to appending at the end when the caret isn't inside the editor.
function insertNodeAtCursor(node) {
  const editor = $id("content-editor");
  if (!editor) return;
  editor.focus();
  const sel = window.getSelection();
  let range;
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0);
    range.deleteContents();
  } else {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Insert plain text at the caret (emoji, etc.). execCommand keeps undo history
// and caret placement correct inside contenteditable.
function insertTextAtCursor(text) {
  const editor = $id("content-editor");
  if (!editor) return;
  editor.focus();
  document.execCommand("insertText", false, text);
}

function loadImageDimensions(attachment) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: null, height: null });
    img.src = `data:${attachment.mime_type};base64,${attachment.data}`;
  });
}

function bindAttachmentButtons() {
  $id("btn-insert-image")?.addEventListener("click", handleInsertImage);
  $id("btn-attach-file")?.addEventListener("click", handleAttachFile);
  $id("btn-attach-file-2")?.addEventListener("click", handleAttachFile);
}

// Tauri intercepts native OS file drops at the window level (dataTransfer
// carries no files in the webview), so dragged-in files are picked up via
// the Tauri drag-drop event instead of DOM `drop` listeners.
async function bindDragAndDropAttach() {
  const webview = window.__TAURI__?.webview?.getCurrentWebview?.();
  if (!webview) return;

  const overlay = $id("dropzone-overlay");

  await webview.onDragDropEvent((event) => {
    const { type } = event.payload;

    if (type === "over") {
      if (getActiveEntry()) overlay?.classList.add("active");
      return;
    }

    overlay?.classList.remove("active");
    if (type !== "drop") return;

    const entry = getActiveEntry();
    if (!entry) {
      showStatus("⚠ Bitte zuerst einen Eintrag auswählen", 3000);
      return;
    }

    const paths = event.payload.paths || [];
    paths.reduce((chain, path) => chain.then(() => attachFilePath(path)), Promise.resolve());
  });
}

// Pasting an image from the clipboard (Ctrl+V) attaches it just like a
// dragged-in or picked file, but since it's ambiguous whether the user wants
// it inline or as a plain attachment, we ask — and remember the answer if
// they check the box.
function bindImagePaste() {
  $id("content-editor")?.addEventListener("paste", handleEditorPaste);
}

async function handleEditorPaste(e) {
  if (!getActiveEntry()) return;

  // Path 1 — DOM clipboard: works on most platforms/webviews.
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));

  let attachment = null;
  if (imageItem) {
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    attachment = await fileToAttachment(file);
  } else {
    // Path 2 — native clipboard: WebKitGTK (Linux) never puts pasted images
    // into the DOM event, so ask the backend. Returns null when the clipboard
    // holds no image, in which case we let the normal text paste proceed.
    try {
      attachment = await window.__TAURI__.invoke("read_clipboard_image");
    } catch {
      attachment = null;
    }
    if (!attachment) return;
  }

  try {
    const choice = await resolvePasteImageChoice();
    if (!choice) return; // user cancelled the dialog
    await finalizeAttachment(attachment, { forceAttachmentPanel: choice === "attachment" });
  } catch (err) {
    showStatus("⚠ Einfügen fehlgeschlagen: " + err, 5000);
  }
}

async function fileToAttachment(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const mimeType = file.type || "image/png";
  const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";

  return {
    id: crypto.randomUUID(),
    name: `pasted-image-${Date.now()}.${ext}`,
    mime_type: mimeType,
    size: file.size,
    data: dataUrl.split(",", 2)[1] || "",
  };
}

// Resolves to "inline" or "attachment". Uses the remembered preference if
// one was saved; otherwise shows the choice modal and waits for a click
// (or Escape, which resolves to null / cancel).
function resolvePasteImageChoice() {
  const remembered = localStorage.getItem(PASTE_IMAGE_PREF_KEY);
  if (remembered === "inline" || remembered === "attachment") return Promise.resolve(remembered);

  const modal = $id("paste-image-modal");
  const inlineBtn = $id("paste-image-inline-btn");
  const attachBtn = $id("paste-image-attach-btn");
  const rememberCheckbox = $id("paste-image-remember");
  if (!modal || !inlineBtn || !attachBtn || !rememberCheckbox) return Promise.resolve("inline");

  return new Promise((resolve) => {
    rememberCheckbox.checked = false;
    modal.classList.remove("hidden");

    const finish = (choice) => {
      if (choice && rememberCheckbox.checked) localStorage.setItem(PASTE_IMAGE_PREF_KEY, choice);
      modal.classList.add("hidden");
      inlineBtn.removeEventListener("click", onInline);
      attachBtn.removeEventListener("click", onAttach);
      document.removeEventListener("keydown", onKeydown);
      resolve(choice);
    };

    const onInline = () => finish("inline");
    const onAttach = () => finish("attachment");
    const onKeydown = (ev) => {
      if (ev.key === "Escape") finish(null);
    };

    inlineBtn.addEventListener("click", onInline);
    attachBtn.addEventListener("click", onAttach);
    document.addEventListener("keydown", onKeydown);
  });
}

function handleInsertImage() {
  return pickAndAttach([{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }]);
}

function handleAttachFile() {
  return pickAndAttach(null);
}

// Shared by both toolbar buttons: images are inserted inline at the cursor
// (and don't show up in the attachments panel); any other file type is
// simply added to entry.attachments and rendered in the panel.
async function pickAndAttach(filters) {
  const entry = getActiveEntry();
  if (!entry) return;

  const path = await window.__TAURI__.dialog.open(filters ? { filters } : {});
  if (!path) return;

  await attachFilePath(path);
}

// Also used by drag-and-drop, which hands us a filesystem path directly
// instead of going through the native file picker dialog.
async function attachFilePath(path) {
  const entry = getActiveEntry();
  if (!entry) return;

  try {
    const attachment = await window.__TAURI__.invoke("read_attachment_file", { path });
    await finalizeAttachment(attachment);
  } catch (err) {
    showStatus("⚠ Anhängen fehlgeschlagen: " + err, 5000);
  }
}

// Shared tail end of every "attach this file to the active entry" flow
// (file picker, drag-and-drop, clipboard paste). Images normally go inline
// at the cursor; `forceAttachmentPanel` lets a pasted image be added to the
// attachments panel instead, per the user's paste choice.
async function finalizeAttachment(attachment, { forceAttachmentPanel = false } = {}) {
  const entry = getActiveEntry();
  if (!entry) return;

  if (!Array.isArray(entry.attachments)) entry.attachments = [];

  if (isImageMime(attachment.mime_type) && !forceAttachmentPanel) {
    const { width, height } = await loadImageDimensions(attachment);
    attachment.width = width;
    attachment.height = height;
    attachment.placement = "inline";
    const displayWidth = Math.min(width || 480, 480);

    entry.attachments.push(attachment);
    insertInlineImage(attachment, displayWidth);
  } else {
    attachment.placement = "panel";
    entry.attachments.push(attachment);
    showStatus(`Angehängt: ${attachment.name}`, 3000);
  }

  markDirty();
  renderAttachments();
}

// Builds a hydrated inline <img> (with its base64 src for display) and drops it
// at the caret. On save the src is stripped again; only `data-att-id` persists.
function insertInlineImage(attachment, displayWidth) {
  const img = document.createElement("img");
  img.setAttribute("data-att-id", attachment.id);
  img.setAttribute("contenteditable", "false");
  img.setAttribute("draggable", "false");
  if (Number.isFinite(displayWidth)) img.style.width = `${Math.round(displayWidth)}px`;
  img.src = `data:${attachment.mime_type};base64,${attachment.data}`;
  insertNodeAtCursor(img);
  updateEditorEmptyState();
}

// ── Tablature editor (music mode) ────────────────────────────────────────────
// A structured, non-editable grid living inside the WYSIWYG editor. Its state is
// a tuning + a list of columns (one fret per string, "" = empty), stored compactly
// in `data-tab` as `label,label,…;col;col;…`. The grid is rendered by JS; only the
// data attributes persist (see the sanitizer). Cells are edited by click + typing,
// so a fret never shifts its neighbours.

const TAB_TUNINGS = {
  guitar: ["e", "B", "G", "D", "A", "E"], // high-e (top) → low-E (bottom)
  bass: ["G", "D", "A", "E"],
};
// Columns are stored flat; bars are purely a view grouping (every BEATS_PER_BAR
// columns), so the stored format stays unchanged. +/− add/remove a whole bar.
const TAB_BEATS_PER_BAR = 8;
const TAB_DEFAULT_COLS = TAB_BEATS_PER_BAR * 2;
const TAB_CELL_W = 20; // px per beat cell — must match the inline grid template
const TAB_LABEL_W = 26; // px reserved for the string-label column when measuring

function makeDefaultTabModel(tuning, nCols = TAB_DEFAULT_COLS) {
  const cols = [];
  for (let c = 0; c < nCols; c++) cols.push(tuning.map(() => ""));
  return { tuning: tuning.slice(), cols };
}

// Parse `data-tab` back into a model. Returns null on anything malformed so the
// caller can fall back to a fresh default rather than render garbage.
function parseTab(data) {
  if (typeof data !== "string" || !data) return null;
  const segs = data.split(";");
  const tuning = segs[0].split(",").filter((s) => /^[A-Za-z]$/.test(s));
  if (!tuning.length) return null;
  const cols = segs.slice(1).map((s) => {
    const arr = s.split(",");
    return tuning.map((_, i) => (/^\d{1,2}$/.test(arr[i]) ? arr[i] : ""));
  });
  return { tuning, cols: cols.length ? cols : makeDefaultTabModel(tuning).cols };
}

function serializeTab(model) {
  return [model.tuning.join(","), ...model.cols.map((col) => col.join(","))].join(";");
}

// Plain-text tab for Markdown export: each column is two chars wide so it stays
// aligned (e.g. "-3", "12", "--").
function tabToAscii(model) {
  if (!model) return "";
  return model.tuning
    .map((label, r) => {
      let line = label + "|";
      for (const col of model.cols) {
        const f = col[r] || "";
        line += f.length === 2 ? f : f.length === 1 ? f + "-" : "--";
      }
      return line + "|";
    })
    .join("\n");
}

// Drops a fresh tablature block at the caret, followed by an empty paragraph so
// the caret has somewhere to land after the (non-editable) block.
function insertTabBlock() {
  const block = document.createElement("div");
  block.setAttribute("data-music", "tab");
  block.setAttribute("data-tab", serializeTab(makeDefaultTabModel(TAB_TUNINGS.guitar)));
  insertNodeAtCursor(block);
  renderTabBlock(block);

  const after = document.createElement("p");
  after.appendChild(document.createElement("br"));
  block.after(after);

  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.setStart(after, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  markDirty();
  updateEditorEmptyState();
}

// Re-render every tab block from its data-tab (called on entry load).
function hydrateTabBlocks() {
  const editor = $id("content-editor");
  if (!editor) return;
  editor.querySelectorAll('[data-music="tab"]').forEach(renderTabBlock);
}

// Build (or rebuild) the interactive grid for one block from its data-tab.
function renderTabBlock(block) {
  const model = parseTab(block.getAttribute("data-tab")) || makeDefaultTabModel(TAB_TUNINGS.guitar);
  block.setAttribute("data-tab", serializeTab(model)); // normalize
  block.classList.add("music-tab");
  block.setAttribute("contenteditable", "false");
  block.tabIndex = 0;
  block.innerHTML = "";

  // Keep the selection across a rerender, but only if it still exists (changing
  // instrument shrinks the string count).
  const prev = block.__tab?.sel || null;
  const prevSel =
    prev && prev.r < model.tuning.length && prev.c < model.cols.length ? prev : null;
  const st = { model, sel: prevSel, cellAt: [], twoDigit: false, lastWidth: 0 };
  block.__tab = st;

  // ── Header: instrument, add/remove column, delete block ──
  const head = document.createElement("div");
  head.className = "mt-head";

  const select = document.createElement("select");
  select.className = "mt-select";
  for (const [key, tuning] of Object.entries(TAB_TUNINGS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = key[0].toUpperCase() + key.slice(1);
    if (tuning.join(",") === model.tuning.join(",")) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    const tuning = TAB_TUNINGS[select.value] || TAB_TUNINGS.guitar;
    block.setAttribute("data-tab", serializeTab(makeDefaultTabModel(tuning, model.cols.length)));
    markDirty();
    renderTabBlock(block);
  });

  const spacer = document.createElement("span");
  spacer.className = "mt-spacer";

  const remBtn = mtButton("−", "Remove last bar", () => {
    if (st.model.cols.length > TAB_BEATS_PER_BAR) {
      st.model.cols.splice(-TAB_BEATS_PER_BAR);
      if (st.sel && st.sel.c >= st.model.cols.length) st.sel = null;
      block.setAttribute("data-tab", serializeTab(st.model));
      markDirty();
      layoutTab(block);
    }
  });
  const addBtn = mtButton("+", "Add bar", () => {
    for (let i = 0; i < TAB_BEATS_PER_BAR; i++) {
      st.model.cols.push(st.model.tuning.map(() => ""));
    }
    block.setAttribute("data-tab", serializeTab(st.model));
    markDirty();
    layoutTab(block);
  });
  const delBtn = mtButton("✕", "Delete tablature", () => {
    block.remove();
    markDirty();
    updateEditorEmptyState();
  });
  delBtn.classList.add("mt-del");

  head.append(select, spacer, remBtn, addBtn, delBtn);
  block.appendChild(head);

  // The staves are (re)built by layoutTab, which depends on the available width.
  const body = document.createElement("div");
  body.className = "mt-body";
  block.appendChild(body);
  layoutTab(block);

  // The block element survives rerenders, so bind these only once.
  if (!block.__tabKeydownBound) {
    block.addEventListener("keydown", onTabKeydown);
    block.__tabKeydownBound = true;
  }
  if (!block.__tabResizeBound && typeof ResizeObserver === "function") {
    // Reflow when the editor gets wider/narrower. Only width matters — our own
    // relayout changes the height, so reacting to that would loop.
    const ro = new ResizeObserver(() => {
      const st2 = block.__tab;
      const w = block.clientWidth;
      if (!st2 || w === st2.lastWidth) return;
      layoutTab(block);
    });
    ro.observe(block);
    block.__tabResizeBound = true;
  }
}

// Lay the columns out as one or more staves ("systems"): as many whole bars as
// fit the current width, then wrap onto the next stave instead of scrolling.
function layoutTab(block) {
  const st = block.__tab;
  if (!st) return;
  const { model } = st;
  const body = block.querySelector(".mt-body");
  if (!body) return;

  st.lastWidth = block.clientWidth;
  body.innerHTML = "";
  st.cellAt = model.tuning.map(() => []);

  const barW = TAB_BEATS_PER_BAR * TAB_CELL_W;
  const avail = Math.max(0, (body.clientWidth || block.clientWidth) - TAB_LABEL_W - 4);
  const barsPerRow = Math.max(1, Math.floor(avail / barW));
  const colsPerRow = barsPerRow * TAB_BEATS_PER_BAR;
  const total = model.cols.length;

  for (let start = 0; start < total; start += colsPerRow) {
    const count = Math.min(colsPerRow, total - start);
    const stave = document.createElement("div");
    stave.className = "mt-stave";
    stave.style.gridTemplateColumns = `${TAB_LABEL_W}px repeat(${count}, ${TAB_CELL_W}px)`;

    for (let r = 0; r < model.tuning.length; r++) {
      const label = document.createElement("div");
      label.className = "mt-label";
      label.textContent = model.tuning[r];
      stave.appendChild(label);

      for (let i = 0; i < count; i++) {
        const c = start + i;
        const cell = document.createElement("div");
        cell.className = "mt-cell";
        // Bar lines: one before each bar's first beat, one closing the stave.
        if (c % TAB_BEATS_PER_BAR === 0) cell.classList.add("mt-barstart");
        const val = model.cols[c][r];
        if (val) {
          const s = document.createElement("span");
          s.className = "mt-fret";
          s.textContent = val;
          cell.appendChild(s);
        }
        cell.addEventListener("mousedown", (e) => {
          e.preventDefault();
          block.focus();
          selectTabCell(block, r, c);
        });
        stave.appendChild(cell);
        st.cellAt[r][c] = cell;
      }
    }
    body.appendChild(stave);
  }

  // Restore the highlight after a reflow.
  if (st.sel) st.cellAt[st.sel.r]?.[st.sel.c]?.classList.add("sel");
}

function mtButton(label, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mt-btn";
  b.textContent = label;
  b.title = title;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", onClick);
  return b;
}

function selectTabCell(block, r, c) {
  const st = block.__tab;
  if (!st) return;
  if (st.sel) st.cellAt[st.sel.r]?.[st.sel.c]?.classList.remove("sel");
  st.sel = { r, c };
  st.twoDigit = false;
  st.cellAt[r]?.[c]?.classList.add("sel");
}

function setTabCell(block, r, c, val) {
  const st = block.__tab;
  st.model.cols[c][r] = val;
  const cell = st.cellAt[r]?.[c];
  if (cell) {
    cell.innerHTML = "";
    if (val) {
      const s = document.createElement("span");
      s.className = "mt-fret";
      s.textContent = val;
      cell.appendChild(s);
    }
  }
  block.setAttribute("data-tab", serializeTab(st.model));
  markDirty();
}

function onTabKeydown(e) {
  const block = e.currentTarget;
  const st = block.__tab;
  if (!st) return;
  if (!st.sel) {
    if (e.key.startsWith("Arrow")) {
      selectTabCell(block, 0, 0);
      e.preventDefault();
    }
    return;
  }
  const { r, c } = st.sel;
  const lastCol = st.model.cols.length - 1;
  const lastRow = st.model.tuning.length - 1;

  if (/^[0-9]$/.test(e.key)) {
    const cur = st.model.cols[c][r] || "";
    let val;
    if (st.twoDigit && cur.length === 1 && Number(cur + e.key) <= 24) {
      val = cur + e.key;
      st.twoDigit = false;
    } else {
      val = e.key;
      st.twoDigit = true;
    }
    setTabCell(block, r, c, val);
    e.preventDefault();
    return;
  }
  switch (e.key) {
    case "Backspace":
    case "Delete":
      setTabCell(block, r, c, "");
      st.twoDigit = false;
      e.preventDefault();
      break;
    case "ArrowRight": selectTabCell(block, r, Math.min(c + 1, lastCol)); e.preventDefault(); break;
    case "ArrowLeft":  selectTabCell(block, r, Math.max(c - 1, 0)); e.preventDefault(); break;
    case "ArrowUp":    selectTabCell(block, Math.max(r - 1, 0), c); e.preventDefault(); break;
    case "ArrowDown":  selectTabCell(block, Math.min(r + 1, lastRow), c); e.preventDefault(); break;
  }
}

// ── Staff-notation editor (music mode) ───────────────────────────────────────
// A second, independent block type alongside the tablature block above: a
// real 5-line staff with pitched noteheads, rendered as inline SVG (pitch
// position is continuous, unlike the tab grid's discrete string×beat cells).
// State is a clef + a flat sequence of time-slots, each a rest or 1+
// simultaneous pitches (a chord shares one stem), stored compactly in
// `data-staff` as `clef;slot;slot;…` where a slot is `<dur><rest-or-chord>`,
// e.g. `t;qC4+E4+G4;eBb4;sr;hD#5`. Barlines are never stored — like the tab
// editor's bar grouping, they're a pure view computed from accumulated
// duration (fixed 4/4).

const STAFF_CLEFS = {
  t: { label: "Treble", bottomLetter: "E", bottomOctave: 4 },
  b: { label: "Bass", bottomLetter: "G", bottomOctave: 2 },
};
const STAFF_DUR_BEATS = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25 };
const STAFF_BEATS_PER_BAR = 4;
const STAFF_DEFAULT_SLOTS = STAFF_BEATS_PER_BAR * 2; // two bars of quarter rests
const STAFF_SLOT_W = 40; // px per slot — must match the SVG layout math
const STAFF_LINE_GAP = 10; // px between staff lines
const STAFF_TOP_PAD = 24; // px above the top line, room for ledger lines
const STAFF_BOTTOM_PAD = 24; // px below the bottom line
const STAFF_CLEF_W = 46; // px reserved for the clef text badge ("Treble"/"Bass")
const LETTER_STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const STEP_LETTER = ["C", "D", "E", "F", "G", "A", "B"];
const CHROMATIC = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const STAFF_KB_OCTAVES = [2, 3, 4, 5]; // covers both clefs' practical ranges

function makeDefaultStaffModel(clef = "t", nSlots = STAFF_DEFAULT_SLOTS) {
  const slots = [];
  for (let i = 0; i < nSlots; i++) slots.push({ dur: "q", pitches: [] });
  return { clef, slots };
}

// Parse `data-staff` back into a model. Returns null on a bad clef (caller
// falls back to a fresh default); an individual malformed slot is coerced to
// a quarter rest rather than nulling the whole block.
function parseStaff(data) {
  if (typeof data !== "string" || !data) return null;
  const segs = data.split(";");
  const clef = segs[0];
  if (clef !== "t" && clef !== "b") return null;
  const slotRe = /^([whqes])(r|[A-G](?:#|b)?[0-8](?:\+[A-G](?:#|b)?[0-8])*)$/;
  const slots = segs.slice(1).map((seg) => {
    const m = slotRe.exec(seg);
    if (!m) return { dur: "q", pitches: [] };
    return { dur: m[1], pitches: m[2] === "r" ? [] : m[2].split("+") };
  });
  return { clef, slots: slots.length ? slots : makeDefaultStaffModel(clef).slots };
}

function serializeStaff(model) {
  return [
    model.clef,
    ...model.slots.map((s) => s.dur + (s.pitches.length ? s.pitches.join("+") : "r")),
  ].join(";");
}

// Plain-text listing for Markdown export — one line per slot. Unlike the tab
// editor's aligned ASCII, staff art isn't attempted here; low value for the
// effort at this fidelity level.
function staffToText(model) {
  if (!model) return "";
  const durName = { w: "whole", h: "half", q: "quarter", e: "eighth", s: "sixteenth" };
  const header = (STAFF_CLEFS[model.clef] || STAFF_CLEFS.t).label + " clef";
  const lines = model.slots.map(
    (s) => `${durName[s.dur] || s.dur}: ${s.pitches.length ? s.pitches.join(" + ") : "rest"}`
  );
  return [header, ...lines].join("\n");
}

// Drops a fresh staff block at the caret — mirrors insertTabBlock exactly.
function insertStaffBlock() {
  const block = document.createElement("div");
  block.setAttribute("data-music", "staff");
  block.setAttribute("data-staff", serializeStaff(makeDefaultStaffModel("t")));
  insertNodeAtCursor(block);
  renderStaffBlock(block);

  const after = document.createElement("p");
  after.appendChild(document.createElement("br"));
  block.after(after);

  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.setStart(after, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  markDirty();
  updateEditorEmptyState();
}

// Re-render every staff block from its data-staff (called on entry load).
function hydrateStaffBlocks() {
  const editor = $id("content-editor");
  if (!editor) return;
  editor.querySelectorAll('[data-music="staff"]').forEach(renderStaffBlock);
}

// Build (or rebuild) one block's DOM from its data-staff: a header (clef
// select, +/− bar, delete — reusing the tab editor's mtButton/mt-* chrome),
// the SVG staff systems (layoutStaff), and a virtual piano keyboard.
function renderStaffBlock(block) {
  const model = parseStaff(block.getAttribute("data-staff")) || makeDefaultStaffModel("t");
  block.setAttribute("data-staff", serializeStaff(model));
  block.classList.add("music-staff");
  block.setAttribute("contenteditable", "false");
  block.tabIndex = 0;
  block.innerHTML = "";

  const prevSel = block.__staff?.sel;
  const sel = Number.isInteger(prevSel) && prevSel < model.slots.length ? prevSel : null;
  const kbOpen = block.__staff?.kbOpen || false;
  const st = { model, sel, slotAt: [], keyEls: [], lastWidth: 0, durBuffer: "", kbOpen };
  block.__staff = st;

  const head = document.createElement("div");
  head.className = "ms-head";

  const clefSelect = document.createElement("select");
  clefSelect.className = "mt-select";
  for (const [key, def] of Object.entries(STAFF_CLEFS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = def.label;
    if (key === model.clef) opt.selected = true;
    clefSelect.appendChild(opt);
  }
  clefSelect.addEventListener("change", () => {
    st.model.clef = clefSelect.value;
    block.setAttribute("data-staff", serializeStaff(st.model));
    markDirty();
    layoutStaff(block);
  });

  const spacer = document.createElement("span");
  spacer.className = "mt-spacer";

  const remBtn = mtButton("−", "Remove last bar", () => {
    if (st.model.slots.length > STAFF_BEATS_PER_BAR) {
      st.model.slots.splice(-STAFF_BEATS_PER_BAR);
      if (st.sel != null && st.sel >= st.model.slots.length) st.sel = null;
      block.setAttribute("data-staff", serializeStaff(st.model));
      markDirty();
      layoutStaff(block);
    }
  });
  const addBtn = mtButton("+", "Add bar", () => {
    for (let i = 0; i < STAFF_BEATS_PER_BAR; i++) st.model.slots.push({ dur: "q", pitches: [] });
    block.setAttribute("data-staff", serializeStaff(st.model));
    markDirty();
    layoutStaff(block);
  });
  const delBtn = mtButton("✕", "Delete staff", () => {
    block.remove();
    markDirty();
    updateEditorEmptyState();
  });
  delBtn.classList.add("mt-del");

  // Keyboard starts collapsed — it's only needed while actively entering
  // notes, and otherwise just eats vertical space.
  const kbToggle = mtButton("🎹", "Show/hide the on-screen keyboard", () => {
    st.kbOpen = !st.kbOpen;
    kbToggle.classList.toggle("mt-active", st.kbOpen);
    const keys = block.querySelector(".ms-keys");
    if (keys) keys.hidden = !st.kbOpen;
  });
  kbToggle.classList.toggle("mt-active", st.kbOpen);

  head.append(clefSelect, spacer, kbToggle, remBtn, addBtn, delBtn);
  block.appendChild(head);

  const body = document.createElement("div");
  body.className = "ms-body";
  block.appendChild(body);
  layoutStaff(block);

  bindStaffKeyboard(block);

  if (!block.__staffKeydownBound) {
    block.addEventListener("keydown", onStaffKeydown);
    block.__staffKeydownBound = true;
  }
  if (!block.__staffResizeBound && typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => {
      const st2 = block.__staff;
      const w = block.clientWidth;
      if (!st2 || w === st2.lastWidth) return;
      layoutStaff(block);
    });
    ro.observe(block);
    block.__staffResizeBound = true;
  }
}

function svgEl(tag, attrs, text) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

// A plain text badge rather than a drawn/Unicode clef symbol — verified via a
// MiniBrowser test page (same WebKitGTK engine as the app) that neither a
// hand-built SVG path nor the Unicode Musical Symbols glyphs (U+1D11E/1D122)
// render legibly with the fonts available on a stock Linux desktop: the SVG
// <text> case produced nothing at all, and even plain HTML text rendered the
// glyph as an illegible sliver. A text label sidesteps both failure modes.
function drawClefGlyph(clef, staffTop, staffBottom) {
  const midY = (staffTop + staffBottom) / 2;
  const label = clef === "b" ? "Bass" : "Treble";
  return svgEl(
    "text",
    {
      x: 2, y: midY + 4, "font-size": 11, "font-weight": "600",
      fill: "var(--text-secondary)", "font-family": "sans-serif",
    },
    label
  );
}

// step is a diatonic index (octave*7 + letter offset); inverse of
// pitchDiatonicIndex, used both for click-to-pitch and Up/Down navigation.
function stepToPitchStr(step) {
  const octave = Math.floor(step / 7);
  const letter = STEP_LETTER[((step % 7) + 7) % 7];
  return letter + octave;
}

function parsePitch(p) {
  const m = /^([A-G])(#|b)?(\d)$/.exec(p || "");
  if (!m) return null;
  return { letter: m[1], accidental: m[2] || "", octave: Number(m[3]) };
}

function pitchDiatonicIndex(pitch) {
  return pitch.octave * 7 + LETTER_STEP[pitch.letter];
}

// Absolute semitone number (enharmonic-agnostic) — used to match a pitch
// against the virtual keyboard regardless of sharp/flat spelling.
function pitchSemitone(pitch) {
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[pitch.letter];
  const acc = pitch.accidental === "#" ? 1 : pitch.accidental === "b" ? -1 : 0;
  return pitch.octave * 12 + base + acc;
}

// Vertical position for a clef: each diatonic step is half a line-gap: lines
// sit at even step-offsets from the clef's bottom-line reference note, spaces
// at odd offsets.
function pitchToStaffY(pitchStr, clef, staffTop, staffBottom) {
  const pitch = parsePitch(pitchStr);
  if (!pitch) return (staffTop + staffBottom) / 2;
  const def = STAFF_CLEFS[clef] || STAFF_CLEFS.t;
  const refStep = def.bottomOctave * 7 + LETTER_STEP[def.bottomLetter];
  const lineGap = (staffBottom - staffTop) / 4;
  return staffBottom - (pitchDiatonicIndex(pitch) - refStep) * (lineGap / 2);
}

// Inverse of pitchToStaffY: nearest diatonic (natural) pitch for a click's Y.
function pitchFromStaffY(y, clef, staffTop, staffBottom) {
  const def = STAFF_CLEFS[clef] || STAFF_CLEFS.t;
  const refStep = def.bottomOctave * 7 + LETTER_STEP[def.bottomLetter];
  const lineGap = (staffBottom - staffTop) / 4;
  const stepFloat = (staffBottom - y) / (lineGap / 2);
  return stepToPitchStr(Math.round(stepFloat) + refStep);
}

function drawLedgerLines(g, y, cx, staffTop, staffBottom, lineGap) {
  if (y < staffTop - 0.1) {
    for (let ly = staffTop - lineGap; ly >= y - 0.1; ly -= lineGap) {
      g.appendChild(svgEl("line", { x1: cx - 8, y1: ly, x2: cx + 8, y2: ly, stroke: "var(--text-muted)", "stroke-width": 1 }));
    }
  } else if (y > staffBottom + 0.1) {
    for (let ly = staffBottom + lineGap; ly <= y + 0.1; ly += lineGap) {
      g.appendChild(svgEl("line", { x1: cx - 8, y1: ly, x2: cx + 8, y2: ly, stroke: "var(--text-muted)", "stroke-width": 1 }));
    }
  }
}

// Draws one slot: a rest glyph, or notehead(s) + shared stem + flags (chords
// stack noteheads on one stem). No automatic beam-grouping in v1 — eighth and
// sixteenth notes each get their own flag(s) rather than being beamed.
function drawStaffSlot(slot, clef, x, staffTop, staffBottom, slotW, lineGap, svgHeight) {
  const g = svgEl("g", { class: "ms-slot" });
  const cx = x + slotW / 2;
  const midY = (staffTop + staffBottom) / 2;

  // Invisible hit-area spanning the whole slot column (including above/below
  // the staff, for ledger-line notes) — without this, only the tiny notehead
  // itself (or nothing, for hollow whole/half notes with fill:none) is
  // clickable, which makes note entry all but unusable.
  g.appendChild(svgEl("rect", { x, y: 0, width: slotW, height: svgHeight, fill: "transparent" }));

  if (!slot.pitches.length) {
    if (slot.dur === "w") {
      g.appendChild(svgEl("rect", { x: cx - 5, y: staffTop + lineGap - 3, width: 10, height: 4, fill: "var(--text-primary)" }));
    } else if (slot.dur === "h") {
      g.appendChild(svgEl("rect", { x: cx - 5, y: midY - 1, width: 10, height: 4, fill: "var(--text-primary)" }));
    } else {
      const extra = slot.dur === "s" ? " q 4,3 -2,5" : "";
      g.appendChild(
        svgEl("path", {
          d: `M ${cx - 3},${midY - 10} q 6,4 0,8 q -6,4 0,8${extra}`,
          fill: "none", stroke: "var(--text-primary)", "stroke-width": 1.6, "stroke-linecap": "round",
        })
      );
    }
    return g;
  }

  const hollow = slot.dur === "w" || slot.dur === "h";
  const hasStem = slot.dur !== "w";
  const flags = slot.dur === "e" ? 1 : slot.dur === "s" ? 2 : 0;
  const ys = slot.pitches.map((p) => pitchToStaffY(p, clef, staffTop, staffBottom));

  slot.pitches.forEach((pStr, idx) => {
    const y = ys[idx];
    drawLedgerLines(g, y, cx, staffTop, staffBottom, lineGap);
    const pitch = parsePitch(pStr);
    if (pitch && pitch.accidental) {
      g.appendChild(
        svgEl("text", { x: cx - 13, y: y + 3.5, "font-size": 11, fill: "var(--text-primary)" }, pitch.accidental === "#" ? "♯" : "♭")
      );
    }
    g.appendChild(
      svgEl("ellipse", {
        cx, cy: y, rx: 5, ry: 3.5,
        fill: hollow ? "none" : "var(--text-primary)",
        stroke: "var(--text-primary)", "stroke-width": 1.3,
      })
    );
  });

  if (hasStem) {
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const farthest = ys.reduce((a, b) => (Math.abs(b - midY) > Math.abs(a - midY) ? b : a), ys[0]);
    const stemUp = farthest > midY; // note below the middle line → stem up
    const stemLen = 26;
    const stemX = stemUp ? cx + 5 : cx - 5;
    const stemY1 = stemUp ? maxY : minY;
    const stemY2 = stemUp ? minY - stemLen : maxY + stemLen;
    g.appendChild(svgEl("line", { x1: stemX, y1: stemY1, x2: stemX, y2: stemY2, stroke: "var(--text-primary)", "stroke-width": 1.3 }));
    for (let f = 0; f < flags; f++) {
      const dir = stemUp ? 1 : -1;
      const fy = stemY2 + f * 6 * dir;
      g.appendChild(
        svgEl("path", {
          d: `M ${stemX},${fy} q 8,${4 * dir} 8,${10 * dir}`,
          fill: "none", stroke: "var(--text-primary)", "stroke-width": 1.5, "stroke-linecap": "round",
        })
      );
    }
  }

  return g;
}

// Lays the slots out as one or more SVG "systems", wrapping onto the next
// row instead of scrolling — mirrors layoutTab's wrap logic. Barlines are
// placed purely by accumulated duration (fixed 4/4), never stored.
function layoutStaff(block) {
  const st = block.__staff;
  if (!st) return;
  const { model } = st;
  const body = block.querySelector(".ms-body");
  if (!body) return;

  st.lastWidth = block.clientWidth;
  body.innerHTML = "";
  st.slotAt = [];

  const avail = Math.max(STAFF_SLOT_W, (body.clientWidth || block.clientWidth) - STAFF_CLEF_W - 8);
  const slotsPerRow = Math.max(STAFF_BEATS_PER_BAR, Math.floor(avail / STAFF_SLOT_W));
  const total = model.slots.length;
  const lineGap = STAFF_LINE_GAP;
  const staffTop = STAFF_TOP_PAD;
  const staffBottom = staffTop + 4 * lineGap;
  const svgHeight = staffBottom + STAFF_BOTTOM_PAD;

  for (let start = 0; start < total; start += slotsPerRow) {
    const count = Math.min(slotsPerRow, total - start);
    const width = STAFF_CLEF_W + count * STAFF_SLOT_W + 10;
    const svg = svgEl("svg", { class: "ms-system", width, height: svgHeight, viewBox: `0 0 ${width} ${svgHeight}` });

    for (let li = 0; li < 5; li++) {
      const y = staffTop + li * lineGap;
      svg.appendChild(svgEl("line", { x1: 0, y1: y, x2: width, y2: y, stroke: "var(--border)", "stroke-width": 1 }));
    }
    svg.appendChild(drawClefGlyph(model.clef, staffTop, staffBottom));

    let beatAcc = 0;
    let x = STAFF_CLEF_W;
    for (let i = 0; i < count; i++) {
      const idx = start + i;
      const slot = model.slots[idx];
      if (beatAcc === 0) {
        svg.appendChild(svgEl("line", { x1: x, y1: staffTop, x2: x, y2: staffBottom, stroke: "var(--text-muted)", "stroke-width": 1 }));
      }
      const g = drawStaffSlot(slot, model.clef, x, staffTop, staffBottom, STAFF_SLOT_W, lineGap, svgHeight);
      g.addEventListener("mousedown", (e) => {
        e.preventDefault();
        block.focus();
        const rect = svg.getBoundingClientRect();
        const clickY = e.clientY - rect.top;
        const pitchStr = pitchFromStaffY(clickY, model.clef, staffTop, staffBottom);
        selectStaffSlot(block, idx);
        applyPitchToSlot(block, idx, pitchStr, e.shiftKey);
      });
      svg.appendChild(g);
      st.slotAt[idx] = g;

      beatAcc += STAFF_DUR_BEATS[slot.dur] || 1;
      if (beatAcc >= STAFF_BEATS_PER_BAR) beatAcc = 0;
      x += STAFF_SLOT_W;
    }
    svg.appendChild(svgEl("line", { x1: x, y1: staffTop, x2: x, y2: staffBottom, stroke: "var(--text-muted)", "stroke-width": 1 }));

    body.appendChild(svg);
  }

  if (st.sel != null) st.slotAt[st.sel]?.classList.add("sel");
}

// Builds the virtual piano keyboard once per render. Click = replace the
// selected slot's pitch; Shift-click = toggle that pitch into/out of the
// chord — both feed through applyPitchToSlot, the same choke point
// click-on-staff uses, so the two input styles share one cursor.
function bindStaffKeyboard(block) {
  const st = block.__staff;
  const keys = document.createElement("div");
  keys.className = "ms-keys";
  for (const oct of STAFF_KB_OCTAVES) {
    for (const name of CHROMATIC) {
      const key = document.createElement("div");
      key.className = "ms-key" + (name.includes("#") ? " black" : "");
      const pitchStr = name + oct;
      key.dataset.pitch = pitchStr;
      key.title = pitchStr;
      key.addEventListener("mousedown", (e) => {
        e.preventDefault();
        block.focus();
        onStaffKeyClick(block, pitchStr, e.shiftKey);
      });
      keys.appendChild(key);
    }
  }
  keys.hidden = !st.kbOpen;
  block.appendChild(keys);
  st.keyEls = Array.from(keys.querySelectorAll(".ms-key"));
  highlightStaffKeyboard(block);
}

function highlightStaffKeyboard(block) {
  const st = block.__staff;
  if (!st || !st.keyEls) return;
  const activePitches = st.sel != null ? st.model.slots[st.sel].pitches : [];
  const active = new Set(activePitches.map((p) => pitchSemitone(parsePitch(p))));
  for (const key of st.keyEls) {
    key.classList.toggle("active", active.has(pitchSemitone(parsePitch(key.dataset.pitch))));
  }
}

function onStaffKeyClick(block, pitchStr, addToChord) {
  const st = block.__staff;
  if (!st) return;
  if (st.sel == null) selectStaffSlot(block, 0);
  applyPitchToSlot(block, st.sel, pitchStr, addToChord);
}

// Shared by both input paths: plain entry replaces the slot's pitch set
// (fast single-note entry), addToChord toggles the pitch into/out of it.
function applyPitchToSlot(block, i, pitchStr, addToChord) {
  const st = block.__staff;
  if (!st) return;
  const cur = st.model.slots[i].pitches;
  let pitches;
  if (addToChord) {
    const sem = pitchSemitone(parsePitch(pitchStr));
    const already = cur.some((p) => pitchSemitone(parsePitch(p)) === sem);
    pitches = already ? cur.filter((p) => pitchSemitone(parsePitch(p)) !== sem) : [...cur, pitchStr];
  } else {
    pitches = [pitchStr];
  }
  setStaffSlotPitches(block, i, pitches);
}

function selectStaffSlot(block, i) {
  const st = block.__staff;
  if (!st) return;
  if (st.sel != null) st.slotAt[st.sel]?.classList.remove("sel");
  st.sel = i;
  st.slotAt[i]?.classList.add("sel");
  highlightStaffKeyboard(block);
}

function setStaffSlotPitches(block, i, pitches) {
  const st = block.__staff;
  if (!st) return;
  st.model.slots[i].pitches = pitches;
  block.setAttribute("data-staff", serializeStaff(st.model));
  markDirty();
  layoutStaff(block);
  highlightStaffKeyboard(block);
}

function setStaffSlotDuration(block, i, dur) {
  const st = block.__staff;
  if (!st) return;
  st.model.slots[i].dur = dur;
  block.setAttribute("data-staff", serializeStaff(st.model));
  markDirty();
  layoutStaff(block);
}

function onStaffKeydown(e) {
  const block = e.currentTarget;
  const st = block.__staff;
  if (!st) return;
  if (st.sel == null) {
    if (e.key.startsWith("Arrow")) {
      selectStaffSlot(block, 0);
      e.preventDefault();
    }
    return;
  }
  const i = st.sel;
  const last = st.model.slots.length - 1;
  const slot = st.model.slots[i];

  if (/^[0-9]$/.test(e.key)) {
    const digit = e.key;
    if (digit === "0") {
      setStaffSlotPitches(block, i, []);
      st.durBuffer = "";
      e.preventDefault();
      return;
    }
    if (st.durBuffer === "1" && digit === "6") {
      setStaffSlotDuration(block, i, "s");
      st.durBuffer = "";
    } else {
      const map = { "1": "w", "2": "h", "4": "q", "8": "e" };
      if (map[digit]) setStaffSlotDuration(block, i, map[digit]);
      st.durBuffer = digit === "1" ? "1" : "";
    }
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case "Backspace":
    case "Delete":
      setStaffSlotPitches(block, i, []);
      break;
    case "ArrowRight": selectStaffSlot(block, Math.min(i + 1, last)); break;
    case "ArrowLeft": selectStaffSlot(block, Math.max(i - 1, 0)); break;
    case "ArrowUp":
      if (slot.pitches.length === 1) {
        const step = pitchDiatonicIndex(parsePitch(slot.pitches[0])) + 1;
        setStaffSlotPitches(block, i, [stepToPitchStr(step)]);
      }
      break;
    case "ArrowDown":
      if (slot.pitches.length === 1) {
        const step = pitchDiatonicIndex(parsePitch(slot.pitches[0])) - 1;
        setStaffSlotPitches(block, i, [stepToPitchStr(step)]);
      }
      break;
    default:
      return;
  }
  e.preventDefault();
}

function renderAttachments() {
  const panel = $id("attachments-panel");
  const resizer = $id("attachments-resizer");
  const list = $id("attachments-list");
  const title = $id("attachments-title");
  if (!panel || !list || !title) return;

  const entry = getActiveEntry();
  const files = (entry?.attachments || []).filter(
    (a) => !isImageMime(a.mime_type) || a.placement === "panel"
  );

  if (files.length === 0) {
    panel.style.display = "none";
    if (resizer) resizer.style.display = "none";
    list.innerHTML = "";
    return;
  }

  panel.style.display = "";
  if (resizer) resizer.style.display = "";
  title.textContent = `Attachments (${files.length})`;

  list.innerHTML = files
    .map(
      (a) => `
    <div class="attachment-chip" data-id="${escapeHtml(a.id)}" title="Click to open — ${escapeHtml(a.name)}">
      <span class="ac-icon">${attachmentIcon(a.mime_type)}</span>
      <span class="ac-name">${escapeHtml(a.name)}</span>
      <span class="ac-size">${formatFileSize(a.size)}</span>
      <button class="ac-remove" data-id="${escapeHtml(a.id)}" title="Remove">${IC_X}</button>
    </div>`
    )
    .join("");

  list.querySelectorAll(".attachment-chip").forEach((chip) => {
    chip.addEventListener("click", () => openAttachment(chip.dataset.id));
  });
  list.querySelectorAll(".ac-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAttachment(btn.dataset.id);
    });
  });
}

async function openAttachment(id) {
  const entry = getActiveEntry();
  const attachment = entry?.attachments?.find((a) => a.id === id);
  if (!attachment) return;

  // Already opened externally this session: reopen the very same temp copy so
  // the user keeps working on their edited file instead of a fresh export of the
  // (possibly stale) in-memory bytes. Their edits are folded back on save/focus.
  const existing = externalAttachmentEdits.get(id);
  if (existing) {
    try {
      await window.__TAURI__.shell.open(existing.path);
      return;
    } catch {
      externalAttachmentEdits.delete(id); // temp copy is gone — re-export below
    }
  }

  try {
    const dataBase64 = await getAttachmentBytes(attachment);
    if (!dataBase64) {
      showStatus("⚠ Could not load attachment", 5000);
      return;
    }
    const path = await window.__TAURI__.invoke("write_temp_attachment", {
      name: attachment.name,
      dataBase64,
    });
    // Remember this temp copy so external edits get folded back in on save.
    externalAttachmentEdits.set(id, { path, data: dataBase64 });
    await window.__TAURI__.shell.open(path);
  } catch (err) {
    showStatus("⚠ Could not open attachment: " + err, 5000);
  }
}

// Find an attachment by id across every entry (external edits may target an
// attachment that isn't in the currently-open entry).
function findAttachmentById(id) {
  for (const entry of currentJournal?.entries || []) {
    const att = entry.attachments?.find((a) => a.id === id);
    if (att) return att;
  }
  return null;
}

// Re-read every externally-opened attachment's temp copy and, if the file
// changed on disk, fold the new bytes back into the attachment so the next save
// persists them. Marks the journal dirty when anything changed. Best-effort:
// a missing/unreadable temp file just leaves the stored copy untouched.
async function syncExternalAttachmentEdits() {
  if (externalAttachmentEdits.size === 0) return;
  let changedNames = [];
  let tooLargeNames = [];
  let touchedImage = false;
  for (const [id, info] of externalAttachmentEdits) {
    const att = findAttachmentById(id);
    if (!att) {
      externalAttachmentEdits.delete(id);
      continue;
    }
    let updated;
    try {
      updated = await window.__TAURI__.invoke("read_attachment_file", { path: info.path });
    } catch (err) {
      // A file edited past the attachment size limit must NOT be dropped
      // silently — the user would think their edit was saved. Flag it loudly.
      // Other errors (temp copy gone/unreadable) just keep the stored bytes.
      if (/too large/i.test(err?.toString?.() || String(err))) tooLargeNames.push(att.name);
      continue;
    }
    if (!updated || typeof updated.data !== "string" || updated.data === info.data) continue;

    att.data = updated.data;
    att.size = updated.size;
    info.data = updated.data;
    attachmentCache.set(id, updated.data);
    changedNames.push(att.name);
    if (isImageMime(att.mime_type)) touchedImage = true;
  }
  if (changedNames.length) {
    markDirty();
    // Reflect the new bytes in the live UI immediately (not only after reopen):
    // refresh inline images in the editor and the attachments panel's metadata.
    if (touchedImage) hydrateEditorImages(getActiveEntry()?.attachments);
    renderAttachments();
    showStatus(`Updated attachment: ${changedNames.join(", ")}`, 3000);
  }
  if (tooLargeNames.length) {
    showStatus(
      `⚠ Changes NOT saved — over the 25 MB limit: ${tooLargeNames.join(", ")}`,
      8000,
    );
  }
}

// Sync external attachment edits the moment the user returns to Lockbook (e.g.
// after saving in MuseScore and Alt-Tabbing back), so changes appear live rather
// than only on the next save/reopen.
function bindExternalAttachmentSync() {
  const trigger = () => {
    if (currentJournal && externalAttachmentEdits.size > 0) syncExternalAttachmentEdits();
  };
  window.addEventListener("focus", trigger);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") trigger();
  });
}

function removeAttachment(id) {
  const entry = getActiveEntry();
  if (!entry) return;
  const attachment = entry.attachments?.find((a) => a.id === id);
  if (!attachment) return;

  if (!confirm(`"${attachment.name}" wirklich entfernen?`)) return;

  entry.attachments = (entry.attachments || []).filter((a) => a.id !== id);
  markDirty();
  renderAttachments();
}

// ── Inline image selection + drag-resize inside the editor ──
// Clicking an inline image selects it and shows a floating handle overlaid on
// its bottom-right corner (kept out of the editable DOM so it can't be typed
// into or serialized). Dragging the handle rewrites the image's width; on save
// only `style="width:…px"` persists on the <img data-att-id>.
let selectedImg = null;

function bindImageResize() {
  const editor = $id("content-editor");
  const handle = $id("img-resize-handle");
  if (!editor || !handle || editor.dataset.resizeBound === "true") return;
  editor.dataset.resizeBound = "true";

  editor.addEventListener("click", (e) => {
    const img = e.target.closest("img[data-att-id]");
    if (img) selectImage(img);
    else deselectImage();
  });
  editor.addEventListener("scroll", positionResizeHandle);

  let drag = null;
  handle.addEventListener("pointerdown", (e) => {
    if (!selectedImg) return;
    e.preventDefault();
    drag = { startX: e.clientX, startWidth: selectedImg.getBoundingClientRect().width };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag || !selectedImg) return;
    const maxW = Math.max(60, editor.clientWidth - 48);
    const w = Math.max(60, Math.min(maxW, Math.round(drag.startWidth + (e.clientX - drag.startX))));
    selectedImg.style.width = `${w}px`;
    positionResizeHandle();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    markDirty();
    positionResizeHandle();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  window.addEventListener("resize", positionResizeHandle);
}

function selectImage(img) {
  deselectImage();
  selectedImg = img;
  img.classList.add("selected");
  positionResizeHandle();
}

function deselectImage() {
  if (selectedImg) selectedImg.classList.remove("selected");
  selectedImg = null;
  $id("img-resize-handle")?.classList.remove("visible");
}

function positionResizeHandle() {
  const handle = $id("img-resize-handle");
  const wrap = $id("content-wrap");
  if (!handle || !wrap || !selectedImg) return;
  const imgR = selectedImg.getBoundingClientRect();
  const wrapR = wrap.getBoundingClientRect();
  if (imgR.bottom < wrapR.top || imgR.top > wrapR.bottom) {
    handle.classList.remove("visible");
    return;
  }
  handle.style.left = `${imgR.right - wrapR.left - 8}px`;
  handle.style.top = `${imgR.bottom - wrapR.top - 8}px`;
  handle.classList.add("visible");
}

// ── Rich-text content (HTML) ──

// Whitelisted tags for stored/edited HTML. Anything else is unwrapped (its
// text kept) or, for images without a valid attachment id, dropped entirely.
const SANITIZE_TAGS = new Set([
  "p", "div", "br", "span", "b", "strong", "i", "em", "u", "code",
  "h1", "h2", "h3", "ul", "ol", "li", "blockquote", "a", "img",
]);

// A music tablature block persists as an empty `<div data-music="tab" data-tab="…">`.
// The interactive grid is rendered by JS on load and stripped on save, so only the
// two data-* attributes survive sanitization (see sanitizeNode / sanitizeAttributes).
function isTabBlock(node) {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    node.tagName.toLowerCase() === "div" &&
    node.getAttribute("data-music") === "tab"
  );
}

// A staff-notation block persists as an empty `<div data-music="staff" data-staff="…">`,
// mirroring the tab block above — see makeDefaultStaffModel / renderStaffBlock.
function isStaffBlock(node) {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    node.tagName.toLowerCase() === "div" &&
    node.getAttribute("data-music") === "staff"
  );
}

// Only http(s)/mailto and scheme-less (relative / anchor) URLs are allowed —
// this rejects `javascript:` and other script-bearing schemes.
function isSafeUrl(url) {
  const u = String(url || "").trim();
  if (/^(https?:|mailto:)/i.test(u)) return true;
  return !/:/.test(u);
}

function sanitizeHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html || "");
  sanitizeNode(tpl.content);
  return tpl.innerHTML;
}

function sanitizeNode(parent) {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) continue;
    if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); continue; }

    const tag = node.tagName.toLowerCase();
    if (!SANITIZE_TAGS.has(tag)) {
      // Unwrap unknown element: sanitize + keep its children, drop the wrapper.
      sanitizeNode(node);
      const frag = document.createDocumentFragment();
      while (node.firstChild) frag.appendChild(node.firstChild);
      node.replaceWith(frag);
      continue;
    }

    sanitizeAttributes(node, tag);
    if (tag === "img" && !node.getAttribute("data-att-id")) {
      node.remove();
      continue;
    }
    // Music blocks store their state in data-tab / data-staff; the rendered grid
    // or staff is disposable. Drop the children so only the empty, attribute-
    // bearing <div> is persisted.
    if (isTabBlock(node) || isStaffBlock(node)) {
      node.textContent = "";
      continue;
    }
    sanitizeNode(node);
  }
}

function sanitizeAttributes(el, tag) {
  const keepWidth = tag === "img" ? el.style.width : null;
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (tag === "a" && name === "href" && isSafeUrl(attr.value)) continue;
    if (tag === "img" && name === "data-att-id" && /^[\w-]+$/.test(attr.value)) continue;
    if (tag === "div" && name === "data-music" && /^[\w-]+$/.test(attr.value)) continue;
    if (tag === "div" && name === "data-tab" && /^[A-Za-z0-9,;]*$/.test(attr.value)) continue;
    if (tag === "div" && name === "data-staff" && /^[tbwhqesr#A-G0-9;+]*$/.test(attr.value)) continue;
    el.removeAttribute(attr.name);
  }
  if (tag === "img" && keepWidth && /^\d+(\.\d+)?px$/.test(keepWidth)) {
    el.style.width = keepWidth;
  }
}

// Plain-text view of stored HTML (search matching, snippets, word count).
function htmlToPlainText(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html || "");
  return (tpl.content.textContent || "").replace(/\s+/g, " ").trim();
}

// Convert stored HTML back to Markdown for export. `imgRelPaths` maps inline
// image attachment ids → exported file paths.
function htmlToMarkdown(html, imgRelPaths) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html || "");
  return serializeMdChildren(tpl.content, imgRelPaths || {})
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function serializeMdChildren(parent, imgRelPaths) {
  let out = "";
  for (const node of parent.childNodes) out += serializeMdNode(node, imgRelPaths);
  return out;
}

function serializeMdNode(node, imgRelPaths) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName.toLowerCase();
  if (isTabBlock(node)) {
    const ascii = tabToAscii(parseTab(node.getAttribute("data-tab")));
    return ascii ? "```\n" + ascii + "\n```\n\n" : "";
  }
  if (isStaffBlock(node)) {
    const text = staffToText(parseStaff(node.getAttribute("data-staff")));
    return text ? "```\n" + text + "\n```\n\n" : "";
  }
  const inner = () => serializeMdChildren(node, imgRelPaths);
  switch (tag) {
    case "br": return "\n";
    case "p": case "div": return inner() + "\n\n";
    case "h1": return "# " + inner() + "\n\n";
    case "h2": return "## " + inner() + "\n\n";
    case "h3": return "### " + inner() + "\n\n";
    case "strong": case "b": return "**" + inner() + "**";
    case "em": case "i": return "*" + inner() + "*";
    case "u": return "<u>" + inner() + "</u>";
    case "code": return "`" + inner() + "`";
    case "blockquote": return "> " + inner().trim().replace(/\n/g, "\n> ") + "\n\n";
    case "ul": return listToMarkdown(node, imgRelPaths, false) + "\n";
    case "ol": return listToMarkdown(node, imgRelPaths, true) + "\n";
    case "a": return `[${inner()}](${node.getAttribute("href") || ""})`;
    case "img": {
      const rel = imgRelPaths[node.getAttribute("data-att-id")];
      return rel ? `![](${rel})` : "";
    }
    default: return inner();
  }
}

function listToMarkdown(listEl, imgRelPaths, ordered) {
  let out = "";
  let i = 1;
  for (const li of listEl.children) {
    if (li.tagName.toLowerCase() !== "li") continue;
    const marker = ordered ? `${i++}. ` : "- ";
    out += marker + serializeMdChildren(li, imgRelPaths).trim() + "\n";
  }
  return out;
}

// Load stored HTML into the editor: sanitize, then hydrate each inline image's
// base64 `src` from the entry's attachments (only `data-att-id` is persisted).
function setEditorContent(html, attachments) {
  const editor = $id("content-editor");
  if (!editor) return;
  deselectImage();
  editor.innerHTML = sanitizeHtml(html || "");
  hydrateEditorImages(attachments);
  hydrateTabBlocks();
  hydrateStaffBlocks();
  updateEditorEmptyState();
}

// Returns an attachment's base64 bytes. Attachments the user just added still
// carry their bytes in memory, so those are used directly. Otherwise the bytes
// are decrypted on demand from the encrypted container (a single blob, no Argon2)
// and cached for the session. Returns "" if the bytes can't be obtained.
async function getAttachmentBytes(att) {
  if (att && typeof att.data === "string" && att.data) return att.data;
  const id = typeof att === "string" ? att : att && att.id;
  if (!id) return "";
  if (attachmentCache.has(id)) return attachmentCache.get(id);
  try {
    const b64 = await window.__TAURI__.invoke("get_attachment_data", { id });
    const val = typeof b64 === "string" ? b64 : "";
    attachmentCache.set(id, val);
    return val;
  } catch (err) {
    console.warn("get_attachment_data failed for", id, err);
    return "";
  }
}

function replaceImageWithMissing(img) {
  const missing = document.createElement("span");
  missing.className = "att-img-missing";
  missing.setAttribute("contenteditable", "false");
  missing.textContent = "🖼 image (missing)";
  img.replaceWith(missing);
}

// Hydrate the editor's inline images. Attributes and genuine-orphan handling run
// synchronously; the actual image bytes are then loaded lazily (per image). A
// transient load failure keeps the <img data-att-id> element in place — never
// replaced — so the attachment isn't pruned as orphaned and its data survives.
async function hydrateEditorImages(attachments) {
  const editor = $id("content-editor");
  if (!editor) return;
  const byId = new Map((attachments || []).map((a) => [a.id, a]));

  const jobs = [];
  editor.querySelectorAll("img[data-att-id]").forEach((img) => {
    img.setAttribute("contenteditable", "false");
    img.setAttribute("draggable", "false");
    const att = byId.get(img.getAttribute("data-att-id"));
    if (att && isImageMime(att.mime_type)) {
      jobs.push([img, att]);
    } else {
      // No matching image attachment at all — a real orphan (e.g. legacy data).
      replaceImageWithMissing(img);
    }
  });

  for (const [img, att] of jobs) {
    const data = await getAttachmentBytes(att);
    // The user may have switched entries while we were decrypting; the editor
    // content is replaced wholesale, so a detached <img> is stale — skip it.
    if (!img.isConnected) continue;
    if (data) {
      img.src = `data:${att.mime_type};base64,${data}`;
      img.classList.remove("att-img-unloaded");
    } else {
      // Couldn't load the bytes right now. Keep the element (so the attachment
      // is preserved on save) but mark it so it renders as a placeholder.
      img.classList.add("att-img-unloaded");
    }
  }
}

// Serialize the editor for saving: sanitize (which also strips the base64 src
// and contenteditable flags), and collapse a visually-empty editor to "".
function getEditorHtml() {
  const editor = $id("content-editor");
  if (!editor) return "";
  const html = sanitizeHtml(editor.innerHTML);
  if (/<img\b/i.test(html) || /data-music=/i.test(html)) return html;
  return htmlToPlainText(html).replace(/ /g, "").trim() ? html : "";
}

function updateEditorEmptyState() {
  const editor = $id("content-editor");
  if (!editor) return;
  const empty =
    !editor.querySelector("img, [data-music]") &&
    (editor.textContent || "").replace(/ /g, "").trim() === "";
  editor.classList.toggle("is-empty", empty);
}

// ── v1 → v2 migration (Markdown content → sanitized HTML) ──

// Lightweight inline markdown → HTML for a plain text segment (no image tags).
function mdSegmentToHtml(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

// Convert a v1 entry's markdown content (with `attachment:` image tags) into the
// v2 stored-HTML form (`<img data-att-id …>` for inline images).
function markdownToStoredHtml(content, attachments) {
  const byId = new Map((attachments || []).map((a) => [a.id, a]));
  const re = new RegExp(ATTACHMENT_IMG_SOURCE, "g");
  let out = "";
  let lastIndex = 0;
  let match;
  while ((match = re.exec(content))) {
    const [full, , id, widthStr] = match;
    out += mdSegmentToHtml(content.slice(lastIndex, match.index));
    const att = byId.get(id);
    const width = widthStr ? parseInt(widthStr, 10) : Math.min(att?.width || 480, 480);
    out += `<img data-att-id="${escapeHtml(id)}" style="width:${width}px">`;
    lastIndex = match.index + full.length;
  }
  out += mdSegmentToHtml(content.slice(lastIndex));
  return sanitizeHtml(out);
}

// A v1.3.0 journal has content stored as Markdown and no attachment placements.
// Convert it to the v2 model in memory on open. Migration is NOT marked dirty:
// the crash-safe save only writes v2 back once the user actually edits, so the
// original file is preserved until then (per the roadmap).
function migrateJournalToV2() {
  if (!currentJournal || currentJournal.version === "2.0") return;

  for (const entry of currentJournal.entries || []) {
    const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
    for (const att of attachments) {
      if (att.placement !== "inline" && att.placement !== "panel") {
        att.placement = isImageMime(att.mime_type) ? "inline" : "panel";
      }
    }
    // Only convert content that still looks like v1 markdown (no HTML tags yet).
    if (typeof entry.content === "string" && !/<[a-z][\s\S]*>/i.test(entry.content)) {
      entry.content = markdownToStoredHtml(entry.content, attachments);
    }
  }

  currentJournal.version = "2.0";
  if (currentJournal.metadata) currentJournal.metadata.version = "2.0";
}

// ── Formatting toolbar ──
function bindFormatToolbar() {
  const bar = $id("format-toolbar");
  if (!bar) return;
  try { document.execCommand("styleWithCSS", false, false); } catch {}

  // Keep the editor selection when a toolbar button is pressed.
  bar.addEventListener("mousedown", (e) => {
    if (e.target.closest(".fmt-btn")) e.preventDefault();
  });
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".fmt-btn");
    if (btn) applyFormatCommand(btn.dataset.cmd);
  });

  const editor = $id("content-editor");
  editor?.addEventListener("keyup", updateFormatButtonStates);
  editor?.addEventListener("mouseup", updateFormatButtonStates);
}

function applyFormatCommand(cmd) {
  const editor = $id("content-editor");
  if (!editor) return;
  editor.focus();
  try { document.execCommand("styleWithCSS", false, false); } catch {}

  switch (cmd) {
    case "bold": document.execCommand("bold"); break;
    case "italic": document.execCommand("italic"); break;
    case "underline": document.execCommand("underline"); break;
    case "h1": toggleBlockFormat("h1"); break;
    case "h2": toggleBlockFormat("h2"); break;
    case "ul": document.execCommand("insertUnorderedList"); break;
    case "ol": document.execCommand("insertOrderedList"); break;
    case "quote": toggleBlockFormat("blockquote"); break;
    case "link": insertLink(); break;
    case "tab": insertTabBlock(); break;
    case "staff": insertStaffBlock(); break;
  }

  markDirty();
  updateWordCount();
  updateEditorEmptyState();
  updateFormatButtonStates();
}

function toggleBlockFormat(tag) {
  let current = "";
  try { current = String(document.queryCommandValue("formatBlock")).toLowerCase(); } catch {}
  document.execCommand("formatBlock", false, current === tag ? "p" : tag);
}

function insertLink() {
  const url = prompt("Link-URL:");
  if (!url) return;
  if (!isSafeUrl(url)) {
    showStatus("⚠ Ungültige URL", 3000);
    return;
  }
  document.execCommand("createLink", false, url);
}

function updateFormatButtonStates() {
  const bar = $id("format-toolbar");
  if (!bar) return;
  let block = "";
  try { block = String(document.queryCommandValue("formatBlock")).toLowerCase(); } catch {}
  bar.querySelectorAll(".fmt-btn").forEach((btn) => {
    const cmd = btn.dataset.cmd;
    let active = false;
    try {
      if (cmd === "bold" || cmd === "italic" || cmd === "underline") active = document.queryCommandState(cmd);
      else if (cmd === "ul") active = document.queryCommandState("insertUnorderedList");
      else if (cmd === "ol") active = document.queryCommandState("insertOrderedList");
      else if (cmd === "quote") active = block === "blockquote";
      else if (cmd === "h1" || cmd === "h2") active = block === cmd;
    } catch {}
    btn.classList.toggle("active", active);
  });
}

function updateWordCount() {
  const content = $id("content-editor")?.textContent || "";
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  const chars = content.length;
  const metaWords = $id("meta-words");
  if (metaWords) metaWords.textContent = `${words} words`;
  const metaChars = $id("meta-chars");
  if (metaChars) metaChars.textContent = `${chars} chars`;
  const sbWords = $id("sb-wordcount");
  if (sbWords) sbWords.textContent = `${words} words`;
}

// ── Metadata ──
function updateMetadata() {
  if (!currentJournal || !currentJournal.metadata) return;
  const meta = currentJournal.metadata;
  const metaCreated = $id("meta-created");
  if (metaCreated) metaCreated.textContent = `Created: ${formatDate(meta.created)}`;
  const metaModified = $id("meta-modified");
  if (metaModified) metaModified.textContent = `Modified: ${formatDate(meta.modified)}`;

  updateTitleSurfaces();

  updateWordCount();
}

// ── Dirty state ──
function getJournalDisplayName() {
  return currentJournal?.metadata?.name || currentFilePath?.split(/[\\/]/).pop() || "Journal";
}

function getActiveEntry() {
  if (!currentJournal || !activeEntryId) return null;
  return currentJournal.entries.find((e) => e.id === activeEntryId) || null;
}

function getActiveEntryDisplayTitle() {
  const title = getActiveEntry()?.title?.trim();
  return title || "Untitled entry";
}

function updateTitleSurfaces() {
  if (!currentJournal) {
    if (lastWindowTitle !== "Lockbook") {
      document.title = "Lockbook";
      lastWindowTitle = "Lockbook";
      try {
        window.__TAURI__?.window?.getCurrentWindow?.()?.setTitle("Lockbook");
      } catch (err) {
        console.warn("Window title update failed:", err);
      }
    }
    return;
  }

  const journalName = getJournalDisplayName();
  const entryTitle = activeEntryId ? getActiveEntryDisplayTitle() : null;
  const fullTitle = entryTitle ? `${entryTitle} - ${journalName} - Lockbook` : `${journalName} - Lockbook`;

  if (lastWindowTitle !== fullTitle) {
    document.title = fullTitle;
    lastWindowTitle = fullTitle;
    try {
      window.__TAURI__?.window?.getCurrentWindow?.()?.setTitle(fullTitle);
    } catch (err) {
      console.warn("Window title update failed:", err);
    }
  }

  const jTitle = $id("journal-title");
  if (jTitle) jTitle.textContent = entryTitle ? `${journalName} / ${entryTitle}` : journalName;
}

function updateActiveEntryListTitle() {
  const entry = getActiveEntry();
  if (!entry) return;

  const container = $id("entry-list");
  if (!container) return;

  const item = [...container.querySelectorAll(".entry-item")].find((el) => el.dataset.id === entry.id);
  const titleEl = item?.querySelector(".ei-title");
  if (titleEl) titleEl.textContent = entry.title || "(Kein Titel)";
}

function handleTitleInput() {
  const entry = getActiveEntry();
  if (!entry) return;

  entry.title = $id("entry-title-input")?.value || "";
  touchJournalModified();
  updateActiveEntryListTitle();
  updateTitleSurfaces();
  markDirty();
}

function touchJournalModified() {
  if (!currentJournal) return;
  if (!currentJournal.metadata || typeof currentJournal.metadata !== "object") {
    currentJournal.metadata = {};
  }
  currentJournal.metadata.modified = new Date().toISOString();
}

function markDirty() {
  touchJournalModified();
  isDirty = true;
  dirtyRevision += 1;
  updateMetadata();
  const dot = $id("status-dot");
  if (dot) dot.classList.add("unsaved");
  const statusText = $id("status-text");
  if (statusText) statusText.textContent = "Unsaved changes";
  scheduleAutoSave();
}

function clearDirty() {
  isDirty = false;
  const dot = $id("status-dot");
  if (dot) dot.classList.remove("unsaved");
  const statusText = $id("status-text");
  if (statusText) statusText.textContent = "Ready";
}

// ── Auto-Save ──
function startAutoSave() {
  // Auto-save every 30 seconds
  if (window._autoSaveInterval) clearInterval(window._autoSaveInterval);
  window._autoSaveInterval = setInterval(() => {
    if (isDirty) doAutoSave();
  }, 30000);
}

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    if (isDirty) doAutoSave();
  }, 2000);
}

async function doAutoSave() {
  return persistJournal({
    successMessage: "Auto-saved ✓",
    successDuration: 2000,
    errorPrefix: "⚠ Auto-save failed: ",
    skipIfClean: true,
  });
}

// ── Auto-Lock ──
function loadAutoLockMinutes() {
  const stored = Number(localStorage.getItem(AUTO_LOCK_KEY));
  autoLockMinutes = Number.isFinite(stored) && stored >= 0 ? stored : AUTO_LOCK_DEFAULT_MINUTES;
}

function setAutoLockMinutes(minutes) {
  autoLockMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : 0;
  localStorage.setItem(AUTO_LOCK_KEY, String(autoLockMinutes));
  resetAutoLockTimer();
}

// 0 disables auto-lock. Any tracked user activity restarts the countdown
// (see bindAutoLockActivity); the timer itself only runs while a journal is open.
function resetAutoLockTimer() {
  clearTimeout(autoLockTimer);
  autoLockTimer = null;
  if (!currentJournal || !autoLockMinutes) return;
  autoLockTimer = setTimeout(lockJournal, autoLockMinutes * 60000);
}

function bindAutoLockActivity() {
  ["mousemove", "mousedown", "keydown", "wheel", "touchstart"].forEach((evt) => {
    document.addEventListener(evt, resetAutoLockTimer, { passive: true });
  });
}

// Saves (if dirty) and drops back to the password-entry screen, clearing the
// decrypted journal from both frontend state and the Rust-side JournalState.
// Unlike closeJournal(), the file path/keyfile are kept so re-unlocking is a
// single password entry instead of browsing for the file again.
async function lockJournal() {
  if (!currentJournal || !currentFilePath || !currentPassword) return;

  // skipIfClean lets persistJournal first sync external attachment edits (which
  // may mark the journal dirty) and only then decide whether a save is needed.
  const saved = await persistJournal({
    skipIfClean: true,
    errorPrefix: "⚠ Auto-lock: save failed, journal stays unlocked: ",
  });
  if (!saved) {
    resetAutoLockTimer();
    return;
  }

  externalAttachmentEdits.clear();

  clearTimeout(autoSaveTimer);
  if (window._autoSaveInterval) {
    clearInterval(window._autoSaveInterval);
    window._autoSaveInterval = null;
  }
  clearTimeout(autoLockTimer);
  autoLockTimer = null;

  try {
    await window.__TAURI__.invoke("close_journal");
  } catch (err) {
    console.warn("close_journal failed:", err);
  }

  const path = currentFilePath;
  const keyfile = currentKeyfile;

  currentJournal = null;
  currentPassword = null;
  activeEntryId = null;
  isDirty = false;
  attachmentCache.clear(); // locked → drop decrypted blob bytes from memory

  currentFilePath = path;
  currentKeyfile = keyfile;

  updateTitleSurfaces();
  showEmptyState();

  const pwInput = $id("lock-password");
  if (pwInput) pwInput.value = "";
  const kfInput = $id("lock-keyfile");
  if (kfInput) kfInput.value = keyfile || "";
  const lockMode = $id("lock-mode");
  if (lockMode) lockMode.textContent = "🔒 Auto-locked";
  const lockHint = $id("lock-file-hint");
  if (lockHint) lockHint.textContent = path.split(/[\\/]/).pop();
  const lockErr = $id("lock-error");
  if (lockErr) lockErr.textContent = "";
  showScreen("lock-screen");
}

function syncActiveEntry() {
  if (!activeEntryId) return;
  const entry = currentJournal.entries.find((e) => e.id === activeEntryId);
  if (!entry) return;
  entry.title = $id("entry-title-input")?.value || "";
  entry.content = getEditorHtml();
  entry.mood = $id("mood-select")?.value || "neutral";
}

function normalizeMoodValue(mood) {
  const validMoods = ["happy", "neutral", "sad", "angry", "anxious"];
  if (typeof mood !== "string") return "neutral";
  const normalized = mood.toLowerCase();
  return validMoods.includes(normalized) ? normalized : "neutral";
}

function normalizeEntryData(entry) {
  const safeEntry = entry && typeof entry === "object" ? entry : {};
  const content = typeof safeEntry.content === "string" ? safeEntry.content : "";
  const attachments = Array.isArray(safeEntry.attachments)
    ? safeEntry.attachments.filter(isValidAttachment)
    : [];

  return {
    id: typeof safeEntry.id === "string" && safeEntry.id ? safeEntry.id : crypto.randomUUID(),
    timestamp: safeEntry.timestamp || new Date().toISOString(),
    title: typeof safeEntry.title === "string" ? safeEntry.title : "",
    content,
    tags: Array.isArray(safeEntry.tags) ? safeEntry.tags.filter((tag) => typeof tag === "string") : [],
    mood: normalizeMoodValue(safeEntry.mood),
    attachments: pruneOrphanedImageAttachments(content, attachments),
  };
}

// Ensure all entries have required fields (for compatibility with Rust backend)
function normalizeJournalData() {
  if (!currentJournal || typeof currentJournal !== "object") return null;

  const nowIso = new Date().toISOString();

  if (!Array.isArray(currentJournal.entries)) {
    currentJournal.entries = [];
  }
  currentJournal.entries = currentJournal.entries.map((entry) => normalizeEntryData(entry));

  if (!currentJournal.metadata || typeof currentJournal.metadata !== "object") {
    currentJournal.metadata = {};
  }

  if (typeof currentJournal.metadata.name !== "string") currentJournal.metadata.name = "";
  if (!currentJournal.metadata.created) currentJournal.metadata.created = nowIso;
  if (!currentJournal.metadata.modified) currentJournal.metadata.modified = nowIso;
  if (!currentJournal.metadata.app) currentJournal.metadata.app = "Lockbook";
  if (!currentJournal.metadata.version) currentJournal.metadata.version = "1.2.1";
  if (!JOURNAL_MODES.includes(currentJournal.metadata.mode)) {
    currentJournal.metadata.mode = "journal";
  }
  if (!currentJournal.version) currentJournal.version = "1.0";

  return currentJournal;
}

function buildJournalPayload() {
  const journal = normalizeJournalData();
  if (!journal) return null;
  return JSON.parse(JSON.stringify(journal));
}

async function persistJournal({
  successMessage = null,
  successDuration = 3000,
  errorPrefix = "⚠ Speichern fehlgeschlagen: ",
  skipIfClean = false,
} = {}) {
  if (!currentJournal || !currentFilePath || !currentPassword) return false;

  // Pull in any edits made to attachments opened in an external editor; this may
  // mark the journal dirty, so it must run before the clean check below.
  await syncExternalAttachmentEdits();

  if (skipIfClean && !isDirty) return true;

  if (savePromise) {
    const result = await savePromise;
    if (result && isDirty) {
      return persistJournal({ successMessage, successDuration, errorPrefix, skipIfClean });
    }
    return result;
  }

  syncActiveEntry();
  normalizeJournalData();
  currentJournal.metadata.modified = new Date().toISOString();

  const payload = buildJournalPayload();
  if (!payload) return false;

  const revisionAtStart = dirtyRevision;

  // Encrypting the container runs Argon2, so a save takes a beat — surface a
  // brief "Saving…" like the unlock spinner so it never looks frozen. The
  // success or error message below replaces it.
  showStatus("Saving…", 0);

  savePromise = (async () => {
    try {
      await window.__TAURI__.invoke("save_journal", {
        path: currentFilePath,
        password: currentPassword,
        keyfile: currentKeyfile || null,
        data: payload,
      });

      if (dirtyRevision === revisionAtStart) {
        clearDirty();
        showStatus(successMessage || "Saved ✓", successDuration);
      }

      return true;
    } catch (err) {
      const message = err?.toString?.() || String(err);
      console.error("Save failed:", err);
      showStatus(errorPrefix + message, 5000);
      return false;
    } finally {
      savePromise = null;
    }
  })();

  return savePromise;
}

// ── Save ──
async function saveJournal() {
  return persistJournal({
    successMessage: "Saved ✓",
    successDuration: 3000,
    errorPrefix: "⚠ Save failed: ",
  });
}

// ── Close ──
async function closeJournal() {
  // skipIfClean lets persistJournal first sync external attachment edits (which
  // may mark the journal dirty) and only then decide whether a save is needed.
  const saved = await persistJournal({
    skipIfClean: true,
    errorPrefix: "⚠ Could not save before closing: ",
  });
  if (!saved) return;
  externalAttachmentEdits.clear();

  clearTimeout(autoSaveTimer);
  if (window._autoSaveInterval) {
    clearInterval(window._autoSaveInterval);
    window._autoSaveInterval = null;
  }
  clearTimeout(autoLockTimer);
  autoLockTimer = null;

  try {
    await window.__TAURI__.invoke("close_journal");
  } catch (err) {
    console.warn("close_journal failed:", err);
  }

  currentJournal = null;
  currentFilePath = null;
  currentPassword = null;
  currentKeyfile = null;
  activeEntryId = null;
  isDirty = false;
  attachmentCache.clear(); // closed → drop decrypted blob bytes from memory
  updateTitleSurfaces();
  showEmptyState();
  showScreen("welcome-screen");
  renderRecentJournals();
}

// ── Export ──

// Writes an attachment's bytes into the export's `_attachments` folder
// (once per attachment id, even if referenced multiple times) and returns
// the path relative to the exported .md file.
async function ensureAttachmentExported(attachment, dirPath, dirLabel, written) {
  if (written.has(attachment.id)) return written.get(attachment.id);

  const safeName = attachment.name.replace(/[\\/:]/g, "_");
  const fileName = `${attachment.id.slice(0, 8)}_${safeName}`;
  const relPath = `${dirLabel}/${fileName}`;

  const dataBase64 = await getAttachmentBytes(attachment);
  await window.__TAURI__.invoke("write_binary_file", {
    path: `${dirPath}/${fileName}`,
    dataBase64,
  });

  written.set(attachment.id, relPath);
  return relPath;
}

async function exportMarkdown() {
  if (!currentJournal) return;

  syncActiveEntry();
  normalizeJournalData();

  const name = currentJournal.metadata?.name || currentFilePath?.split(/[\\/]/).pop() || "journal";

  const path = await window.__TAURI__.dialog.save({
    defaultPath: `${name}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) return;

  const attachmentsDirPath = `${path.replace(/\.md$/i, "")}_attachments`;
  const attachmentsDirLabel = attachmentsDirPath.split(/[\\/]/).pop();
  const written = new Map();

  const sorted = [...currentJournal.entries].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );
  const showMood = getJournalMode() === "journal";

  let md = `# ${name}\n\n`;
  md += `Exportiert am: ${formatDate(Date.now())}\n`;
  md += `Eintraege: ${currentJournal.entries.length}\n\n`;
  md += `---\n\n`;

  try {
    for (const entry of sorted) {
      md += `## ${entry.title || "(Kein Titel)"}\n\n`;
      md += `Titel: ${entry.title || "(Kein Titel)"}\n`;
      md += `Datum: ${formatDate(entry.timestamp)}\n`;
      if (showMood) md += `Emotion: ${entry.mood || "neutral"}\n`;
      if (entry.tags?.length) md += `Tags: ${entry.tags.map((t) => `#${t}`).join(", ")}\n\n`;
      else md += `\n`;

      const content = entry.content || "";
      const imgRelPaths = {};
      const fileAttachments = [];

      for (const attachment of entry.attachments || []) {
        const relPath = await ensureAttachmentExported(attachment, attachmentsDirPath, attachmentsDirLabel, written);
        const inlineRef =
          isImageMime(attachment.mime_type) && content.includes(`data-att-id="${attachment.id}"`);
        if (inlineRef) imgRelPaths[attachment.id] = relPath;
        else fileAttachments.push({ attachment, relPath });
      }

      md += `${htmlToMarkdown(content, imgRelPaths)}\n\n`;

      if (fileAttachments.length) {
        md += `**Anhänge:**\n\n`;
        for (const { attachment, relPath } of fileAttachments) {
          md += `- [${attachment.name}](${relPath}) (${formatFileSize(attachment.size)})\n`;
        }
        md += `\n`;
      }

      md += `---\n\n`;
    }

    await window.__TAURI__.invoke("write_text_file", { path, content: md });
    showStatus("Exportiert ✓", 3000);
  } catch (err) {
    showStatus("⚠ Export fehlgeschlagen: " + err, 5000);
  }
}

// ── Search ──
function renderSearchResults(results, query) {
  const container = $id("entry-list");
  if (!container) return;

  if (results.length === 0) {
    container.innerHTML = `
      <div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px">
        Keine Ergebnisse für "${escapeHtml(query)}"
      </div>`;
    return;
  }

  const showMood = getJournalMode() === "journal";

  container.innerHTML = results
    .map(
      (e) => `
    <div class="entry-item" data-id="${e.id}">
      <div class="ei-title">${highlightQuery(e.title || "(Kein Titel)", query)}</div>
      <div class="ei-meta">
        ${showMood && e.mood ? `<span class="ei-mood">${e.mood}</span>` : ""}
        <span class="ei-date">${formatEntryDate(e.timestamp)}</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:3px">
        ${highlightQuery(snippet(htmlToPlainText(e.content), query), query)}
      </div>
    </div>`
    )
    .join("");

  container.querySelectorAll(".entry-item").forEach((el) => {
    el.addEventListener("click", () => selectEntry(el.dataset.id));
  });
}

function snippet(text, query, len = 100) {
  if (!text) return "";
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return text.slice(0, len);
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + query.length + len);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function highlightQuery(text, query) {
  if (!query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
  return escaped.replace(regex, "<mark>$1</mark>");
}

// ── Status bar ──
function showStatus(msg, duration = 3000) {
  const statusText = $id("status-text");
  if (statusText) statusText.textContent = msg;
  if (duration) {
    setTimeout(() => {
      if (!isDirty) {
        const st = $id("status-text");
        if (st) st.textContent = "Ready";
      }
    }, duration);
  }
}

// ═══════════════════════════════════════════════════════════════
//  EMOJI PICKER
// ═══════════════════════════════════════════════════════════════

function setupEmojiPicker() {
  const searchInput = $id("emoji-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => filterEmojis(searchInput.value));
  }
  $id("emoji-close-btn")?.addEventListener("click", () => {
    $id("emoji-modal")?.classList.add("hidden");
  });
}

function toggleEmojiPicker() {
  const modal = $id("emoji-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  renderEmojiGrid();
  const search = $id("emoji-search");
  if (search) {
    search.value = "";
    search.focus();
  }
}

function renderEmojiGrid(filter = "") {
  const grid = $id("emoji-grid");
  if (!grid) return;

  const lowerFilter = filter.toLowerCase();
  let html = "";

  if (typeof EMOJI_DATA === "undefined") {
    grid.innerHTML = '<p style="padding:16px;color:var(--text-muted)">Emoji data not loaded.</p>';
    return;
  }

  EMOJI_DATA.forEach((category) => {
    const filtered = category.emojis.filter(
      (e) =>
        !lowerFilter ||
        e.n.toLowerCase().includes(lowerFilter)
    );

    if (filtered.length === 0) return;

    html += `<div class="emoji-cat-label" style="padding:4px 0;font-size:11px;color:var(--text-muted);grid-column:1/-1">${category.category}</div>`;
    filtered.forEach((e) => {
      html += `<button class="ep-emoji" title="${escapeHtml(e.n)}" data-char="${e.e}">${e.e}</button>`;
    });
  });

  grid.innerHTML = html;

  // Bind clicks
  grid.querySelectorAll(".ep-emoji").forEach((btn) => {
    btn.addEventListener("click", () => insertEmoji(btn.dataset.char));
  });
}

function filterEmojis(query) {
  renderEmojiGrid(query);
}

function insertEmoji(char) {
  insertTextAtCursor(char);
  updateWordCount();
  updateEditorEmptyState();
  markDirty();
}

// ═══════════════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Ctrl+S → Save
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      if (currentJournal) saveJournal();
    }

    // Ctrl+N → New Entry
    if ((e.ctrlKey || e.metaKey) && e.key === "n") {
      e.preventDefault();
      if (currentJournal) createNewEntry();
    }

    // Ctrl+E → Emoji picker
    if ((e.ctrlKey || e.metaKey) && e.key === "e") {
      e.preventDefault();
      if (currentJournal) toggleEmojiPicker();
    }

    // Ctrl+F → Focus search
    if ((e.ctrlKey || e.metaKey) && e.key === "f" && currentJournal) {
      e.preventDefault();
      const searchInput = $id("search-input");
      if (searchInput) searchInput.focus();
    }

    // Ctrl+/ → Shortcuts help
    if ((e.ctrlKey || e.metaKey) && e.key === "/") {
      e.preventDefault();
      toggleShortcutsModal();
    }

    // Escape → close modals
    if (e.key === "Escape") {
      $id("emoji-modal")?.classList.add("hidden");
      $id("shortcuts-modal")?.classList.add("hidden");
      $id("settings-modal")?.classList.add("hidden");
      $id("paste-image-modal")?.classList.add("hidden");
    }
  });
}

function toggleShortcutsModal() {
  const modal = $id("shortcuts-modal");
  if (modal) modal.classList.toggle("hidden");
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeJs(str) {
  if (!str) return "";
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function formatDate(isoOrTs) {
  if (!isoOrTs) return "";
  const d = new Date(isoOrTs);
  return d.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatEntryDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;

  if (diff < 60000) return "Gerade eben";
  if (diff < 3600000) return `vor ${Math.floor(diff / 60000)} Min.`;
  if (diff < 86400000) return `vor ${Math.floor(diff / 3600000)} Std.`;

  return d.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "short",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
