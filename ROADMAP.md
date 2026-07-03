# Lockbook v2.0.0 — Roadmap

Working document / single source of truth for the v2.0.0 effort. Built directly
on `main` (no feature branch).

## Goals

Make Lockbook feel right for **non-technical people** while staying **secure,
fast, and reliable**, and keeping the on-disk artifact as **one `.lbook` file**.

The two headline changes:
- Replace the Markdown *Write/Preview* split with a **WYSIWYG editor** where you
  type and immediately see formatting and inline images.
- Introduce a **v2 container format** that only decrypts what is needed
  (lazy image loading) and compresses text.

## Locked-in decisions

- **Entry content is stored as sanitized HTML** (not Markdown). Markdown stays
  only as an *export* format.
- **Migration happens on save**: a v1.3.0 journal is converted to v2 in memory
  on open, but only written back as v2 when the user actually saves a change.
  The existing crash-safe save (atomic rename + hidden `.bak`) protects the old
  file.
- **Inline vs. attachment choice is kept — also for images.** Images can live
  inline in the text *or* as a file in the attachments panel.
- **Compression is applied smartly** (see P5): compress the text/metadata
  section, do **not** re-compress already-compressed image blobs.
- **Modes:** every journal is either `journal` or `general`, chosen at creation
  and switchable in settings.

## Backward compatibility (v1.3.0 is public!)

- Must decrypt existing v1.3.0 `.lbook` files (TimENC container format is
  unchanged — this keeps working).
- On open, detect v1 (`version` == "1.x" / content looks like Markdown) and
  migrate in memory:
  - Markdown content → sanitized HTML.
  - `![alt](attachment:<id> "width=..")` → `<img data-att-id="<id>" ...>`.
  - Image attachments → `placement: "inline"`, file attachments → `"panel"`.
  - `version` → "2.0".
- First real save writes v2 (old version preserved as `.bak`).

## Data model changes

- `JournalData.version` → `"2.0"`.
- `JournalMetadata.mode`: `"journal" | "general"` (default `"journal"`).
- `Attachment.placement`: `"inline" | "panel"`.
- Entry `content`: sanitized HTML string.

## Security notes

- **Sanitize HTML** on both paste and render via a strict tag/attribute
  whitelist: `p, br, b/strong, i/em, u, h1-h3, ul/ol/li, blockquote, a[href],
  img[data-att-id, style(width)]`. No scripts, no event handlers, no external
  `src`. CSP already blocks external resources.
- **Compression before encryption** is safe here: CRIME/BREACH-style attacks
  need an adaptive online oracle; a local, non-transmitted file has none.
- **Container nonces:** one Argon2 KDF → one master key; every section gets a
  unique nonce (prefer XChaCha20-Poly1305 random nonces). Authenticate the
  index/offsets so blobs can't be swapped.

## Phases (increasing risk; one commit + test per phase)

- **P1 — Format v2 groundwork + migration.** New data-model fields; MD→HTML +
  `attachment:`→`<img data-att-id>` migration on open; save writes v2. No editor
  yet (content still shown, just as HTML).
- **P2 — WYSIWYG editor.** `contenteditable` single pane + curated toolbar
  (bold, italic, H1/H2, bullet list, numbered list, quote, link, image, file).
  Replaces Write/Preview. Inline images render live. Port drag-resize to `<img>`.
- **P3 — Modes + inline/panel images.** `journal` vs `general` (date-as-title,
  mood only in journal mode). Attachments panel shows `placement:"panel"` images
  too; prune only drops inline images whose `data-att-id` vanished from the HTML.
- **P4 — Search & export.** Search strips HTML→text before matching. Markdown
  export converts HTML→Markdown.
- **P5 — Container + lazy-decrypt + compression.** Single `.lbook` container:
  one KDF → master key; small compressed metadata/index section decrypted on
  open; image blobs decrypted on demand (`get_attachment_data(id)` from the
  container). Requires a keyed-session capability (extend TimENC, or use
  `argon2` + `chacha20poly1305` directly in Lockbook). Biggest/riskiest — do
  last, with heavy testing.
- **P6 — Extras + release.** Auto-lock after inactivity; whole-journal export
  (Markdown/PDF or encrypted backup). Version bump to 2.0.0 (Cargo.toml,
  tauri.conf.json, package.json, footer).

## In scope for 2.0.0

Core (P1–P5) + **Auto-lock** + **whole-journal export** (P6).

## Deferred to v2.1+

- Journal templates / daily prompts.
- Calendar / streak view.

## Already shipped on `main` (pre-v2, bug fixes for v1.3.0)

- Argon2/crypto build-speed fix (dev + release `opt-level = 3`) — unlock/create
  ~17× faster in `tauri dev`.
- Unlock button busy-state + spinner (prevents concurrent decrypts).
- Ctrl+V image paste via native clipboard (`read_clipboard_image`), since
  WebKitGTK doesn't expose pasted images to the DOM.
