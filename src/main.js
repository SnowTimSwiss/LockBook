// === Lockbook — Journal App Main Logic ===

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

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Helper alias ──
const $id = (id) => document.getElementById(id);

// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
  loadSidebarWidth();
  bindSidebarResize();
  window.addEventListener("resize", () => {
    if (sidebarWidth !== null) {
      applySidebarWidth(sidebarWidth, false, true);
    }
  });
  loadRecentJournals();
  scheduleTimEncCheck();
  bindWelcomeButtons();
  bindCreateScreen();
  bindLockScreen();
  bindJournalUI();
  bindSettingsUI();
  setupEmojiPicker();
  setupKeyboardShortcuts();

  $id("timenc-download-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    window.__TAURI__.shell.open("https://github.com/SnowTimSwiss/TimENC/releases/latest");
  });
  $id("shortcuts-close-btn")?.addEventListener("click", () => {
    $id("shortcuts-modal")?.classList.add("hidden");
  });
});

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
      <button class="ri-remove" data-path="${escapeHtml(r.path)}" title="Remove">✕</button>
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
//  CREATE SCREEN
// ═══════════════════════════════════════════════════════════════

function bindCreateScreen() {
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
      version: "1.0",
      entries: [],
      metadata: {
        name,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        app: "Lockbook",
        version: "1.2.1",
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

async function doUnlockJournal() {
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

  try {
    const result = await window.__TAURI__.invoke("open_journal", {
      path: currentFilePath,
      password,
      keyfile: currentKeyfile || null,
    });

    currentJournal = result;
    currentPassword = password;

    addToRecent(currentFilePath, result.metadata?.name);
    enterJournalUI();
  } catch (err) {
    showLockError(err.toString());
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
        (en.content || "").toLowerCase().includes(query) ||
        (en.tags || []).some((t) => t.includes(query))
    );
    renderSearchResults(results, query);
  });

  // Editor tabs (Write / Preview)
  $$("#editor-tabs .etab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$("#editor-tabs .etab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const mode = tab.dataset.tab;
      const editor = $id("content-editor");
      const preview = $id("content-preview");
      if (mode === "write") {
        editor.style.display = "";
        preview.classList.remove("active");
      } else {
        editor.style.display = "none";
        renderMarkdownPreview();
        preview.classList.add("active");
      }
    });
  });

  // Shortcuts help
  $id("btn-shortcuts-help")?.addEventListener("click", toggleShortcutsModal);
}

function bindSettingsUI() {
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
  $id("settings-current-password").value = "";
  $id("settings-new-password").value = "";
  $id("settings-confirm-password").value = "";

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
  // Normalize journal data to ensure all entries have required fields
  normalizeJournalData();

  showScreen("journal-ui");
  applySidebarWidth(sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH, false, true);
  renderEntryList();
  updateMetadata();
  startAutoSave();
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

  container.innerHTML = entries
    .map(
      (e) => `
    <div class="entry-item ${e.id === activeEntryId ? "active" : ""}" data-id="${e.id}">
      <div class="ei-title">${escapeHtml(e.title || "(Kein Titel)")}</div>
      <div class="ei-meta">
        ${e.mood ? `<span class="ei-mood">${e.mood}</span>` : ""}
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
  $id("content-editor").value = entry.content || "";
  $id("mood-select").value = entry.mood || "neutral";

  renderTags();
  updateWordCount();
  updateMetadata();
  updateTitleSurfaces();

  // Reset to write tab
  $$("#editor-tabs .etab").forEach((t) => t.classList.remove("active"));
  $$('#editor-tabs .etab[data-tab="write"]')?.classList.add("active");
  $id("content-editor").style.display = "";
  $id("content-preview").classList.remove("active");
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
      <button onclick="removeTag('${escapeJs(t)}')">✕</button>
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

// ── Markdown Preview ──
function renderMarkdownPreview() {
  const container = $id("content-preview");
  if (!container) return;
  const content = $id("content-editor")?.value || "";
  let html = escapeHtml(content);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\n/g, "<br>");
  container.innerHTML = html;
}

function updateWordCount() {
  const content = $id("content-editor")?.value || "";
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
        window.__TAURI__?.window?.appWindow?.setTitle("Lockbook");
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
      window.__TAURI__?.window?.appWindow?.setTitle(fullTitle);
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
  if (!currentJournal || !currentFilePath || !currentPassword) return;

  // Sync active entry from editor
  syncActiveEntry();
  currentJournal.metadata.modified = new Date().toISOString();

  // Ensure all required fields exist
  normalizeJournalData();

  try {
    await window.__TAURI__.invoke("save_journal", {
      path: currentFilePath,
      password: currentPassword,
      keyfile: currentKeyfile || null,
      data: JSON.parse(JSON.stringify(currentJournal)),
    });
    clearDirty();
    showStatus("Auto-saved ✓", 2000);
  } catch (err) {
    console.error("Auto-save failed:", err);
    showStatus("⚠ Auto-save failed", 5000);
  }
}

function syncActiveEntry() {
  if (!activeEntryId) return;
  const entry = currentJournal.entries.find((e) => e.id === activeEntryId);
  if (!entry) return;
  entry.title = $id("entry-title-input")?.value || "";
  entry.content = $id("content-editor")?.value || "";
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
  return {
    id: typeof safeEntry.id === "string" && safeEntry.id ? safeEntry.id : crypto.randomUUID(),
    timestamp: safeEntry.timestamp || new Date().toISOString(),
    title: typeof safeEntry.title === "string" ? safeEntry.title : "",
    content: typeof safeEntry.content === "string" ? safeEntry.content : "",
    tags: Array.isArray(safeEntry.tags) ? safeEntry.tags.filter((tag) => typeof tag === "string") : [],
    mood: normalizeMoodValue(safeEntry.mood),
    attachments: Array.isArray(safeEntry.attachments)
      ? safeEntry.attachments.filter((attachment) => typeof attachment === "string")
      : [],
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
        if (successMessage) showStatus(successMessage, successDuration);
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
    successMessage: "Gespeichert ✓",
    successDuration: 3000,
    errorPrefix: "⚠ Speichern fehlgeschlagen: ",
  });
  if (!currentJournal || !currentFilePath || !currentPassword) return;

  syncActiveEntry();
  currentJournal.metadata.modified = new Date().toISOString();

  // Ensure all required fields exist
  normalizeJournalData();

  try {
    await window.__TAURI__.invoke("save_journal", {
      path: currentFilePath,
      password: currentPassword,
      keyfile: currentKeyfile || null,
      data: JSON.parse(JSON.stringify(currentJournal)),
    });
    clearDirty();
    showStatus("Gespeichert ✓", 3000);
  } catch (err) {
    showStatus("⚠ Speichern fehlgeschlagen: " + err, 5000);
  }
}

// ── Close ──
async function closeJournal() {
  if (isDirty) {
    const saved = await persistJournal({
      errorPrefix: "⚠ Vor dem Schließen konnte nicht gespeichert werden: ",
    });
    if (!saved) return;
  }

  clearTimeout(autoSaveTimer);
  if (window._autoSaveInterval) {
    clearInterval(window._autoSaveInterval);
    window._autoSaveInterval = null;
  }

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
  updateTitleSurfaces();
  showEmptyState();
  showScreen("welcome-screen");
  renderRecentJournals();
  return;
  if (isDirty) await doAutoSave();
  currentJournal = null;
  currentFilePath = null;
  currentPassword = null;
  currentKeyfile = null;
  activeEntryId = null;
  isDirty = false;
  showEmptyState();
  showScreen("welcome-screen");
  renderRecentJournals();
}

// ── Export ──
async function exportMarkdown() {
  if (!currentJournal) return;

  syncActiveEntry();
  normalizeJournalData();

  const name = currentJournal.metadata?.name || currentFilePath?.split(/[\\/]/).pop() || "journal";
  let md = `# ${name}\n\n`;
  md += `Exportiert am: ${formatDate(Date.now())}\n`;
  md += `Eintraege: ${currentJournal.entries.length}\n\n`;
  md += `---\n\n`;

  const sorted = [...currentJournal.entries].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );

  for (const entry of sorted) {
    md += `## ${entry.title || "(Kein Titel)"}\n\n`;
    md += `Titel: ${entry.title || "(Kein Titel)"}\n`;
    md += `Datum: ${formatDate(entry.timestamp)}\n`;
    md += `Emotion: ${entry.mood || "neutral"}\n`;
    if (entry.tags?.length) md += `Tags: ${entry.tags.map((t) => `#${t}`).join(", ")}\n\n`;
    else md += `\n`;
    md += `${entry.content || ""}\n\n---\n\n`;
  }

  const path = await window.__TAURI__.dialog.save({
    defaultPath: `${name}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });

  if (path) {
    try {
      await window.__TAURI__.fs.writeTextFile(path, md);
      showStatus("Exportiert ✓", 3000);
    } catch (err) {
      showStatus("⚠ Export fehlgeschlagen: " + err, 5000);
    }
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

  container.innerHTML = results
    .map(
      (e) => `
    <div class="entry-item" data-id="${e.id}">
      <div class="ei-title">${highlightQuery(e.title || "(Kein Titel)", query)}</div>
      <div class="ei-meta">
        ${e.mood ? `<span class="ei-mood">${e.mood}</span>` : ""}
        <span class="ei-date">${formatEntryDate(e.timestamp)}</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:3px">
        ${highlightQuery(snippet(e.content, query), query)}
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
  const textarea = $id("content-editor");
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  textarea.value = text.slice(0, start) + char + text.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + char.length;
  textarea.focus();
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
