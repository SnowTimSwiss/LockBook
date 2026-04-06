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

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Helper alias ──
const $id = (id) => document.getElementById(id);

// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
  loadRecentJournals();
  checkTimEnc();
  bindWelcomeButtons();
  bindCreateScreen();
  bindLockScreen();
  bindJournalUI();
  setupEmojiPicker();
  setupKeyboardShortcuts();
});

// ═══════════════════════════════════════════════════════════════
//  SCREEN VISIBILITY
// ═══════════════════════════════════════════════════════════════

function showScreen(screenId) {
  ["welcome-screen", "create-screen", "lock-screen", "journal-ui"].forEach((id) => {
    const el = $id(id);
    if (el) el.style.display = id === screenId ? "flex" : "none";
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

// Make it globally accessible for inline onclick handlers
window.removeFromRecent = removeFromRecent;

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
      <button class="ri-remove" onclick="event.stopPropagation();removeFromRecent('${escapeJs(
        r.path
      )}');renderRecentJournals();" title="Remove">✕</button>
    </div>`
      )
      .join("")}`;

  // Bind clicks on recent items
  container.querySelectorAll(".recent-item").forEach((item) => {
    item.addEventListener("click", () => {
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
        filters: [{ name: "TimENC Journal", extensions: ["timenc-journal"] }],
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

  const filePath = `${folder}/${name}.timenc-journal`;

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
        version: "1.0.1",
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
  $id("entry-title-input")?.addEventListener("input", () => markDirty());

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

function enterJournalUI() {
  // Normalize journal data to ensure all entries have required fields
  normalizeJournalData();
  
  showScreen("journal-ui");
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
  markDirty();
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
  const entries = currentJournal.entries;

  const metaCreated = $id("meta-created");
  if (metaCreated) metaCreated.textContent = `Created: ${formatDate(meta.created)}`;
  const metaModified = $id("meta-modified");
  if (metaModified) metaModified.textContent = `Modified: ${formatDate(meta.modified)}`;

  // Journal title in topbar
  const jTitle = $id("journal-title");
  if (jTitle) jTitle.textContent = meta.name || currentFilePath.split(/[\\/]/).pop() || "Journal";

  updateWordCount();
}

// ── Dirty state ──
function markDirty() {
  isDirty = true;
  const dot = $id("status-dot");
  if (dot) dot.classList.add("unsaved");
  const statusText = $id("status-text");
  if (statusText) statusText.textContent = "Unsaved changes";
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

// Ensure all entries have required fields (for compatibility with Rust backend)
function normalizeJournalData() {
  if (!currentJournal || !currentJournal.entries) return;
  
  const validMoods = ["happy", "neutral", "sad", "angry", "anxious"];
  
  currentJournal.entries.forEach((entry) => {
    if (!entry.attachments) entry.attachments = [];
    if (!entry.tags) entry.tags = [];
    if (!entry.mood || !validMoods.includes(entry.mood.toLowerCase())) {
      entry.mood = "neutral";
    } else {
      entry.mood = entry.mood.toLowerCase();
    }
  });
}

// ── Save ──
async function saveJournal() {
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

  const name = currentJournal.metadata?.name || currentFilePath?.split(/[\\/]/).pop() || "journal";
  let md = `# ${name}\n\n`;
  md += `*Exportiert am ${formatDate(Date.now())}*\n\n---\n\n`;

  const sorted = [...currentJournal.entries].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );

  for (const entry of sorted) {
    md += `## ${entry.title || "(Kein Titel)"}\n\n`;
    md += `*${formatEntryDate(entry.timestamp)}*`;
    if (entry.mood) md += ` ${entry.mood}`;
    md += `\n\n`;
    if (entry.tags?.length) md += `Tags: ${entry.tags.map((t) => `#${t}`).join(", ")}\n\n`;
    md += `${entry.content}\n\n---\n\n`;
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
