# Lockbook

<div align="center">

🔒📖 **A secure, encrypted personal diary**

*Built with Rust + Tauri · Powered by TimENC*

</div>

---

Every journal is a single `.lbook` container file, encrypted end-to-end with **ChaCha20-Poly1305 AEAD** and **Argon2id** key derivation. TimENC's crypto is bundled directly into the app (no external CLI or PATH dependency) — opening a journal derives one master key, decrypts a small compressed index instantly, and decrypts each attachment (images, files) individually and only on demand. Legacy `.timenc-journal` (v1) files can still be opened and are transparently migrated to the new container format on next save.

## ✨ Features

- 🔐 **End-to-end encryption** — ChaCha20-Poly1305 AEAD + Argon2id KDF, bundled in-process
- 🗜️ **Compressed & lazy-decrypted** — the text index is zstd-compressed; attachments decrypt one at a time, only when opened
- 📓 **Journal or general notes mode** — diary-style (date titles, mood tracking) or plain notes
- 🖼️ **Inline images & file attachments** — paste, drag-and-drop, or attach any file; images embed directly in entries
- ✍️ **Rich text editor** (WYSIWYG) with formatting toolbar, links and quotes
- 🏷️ **Tags & mood** tracking for every entry
- 🔍 **Full-text search** across all entries
- 😀 **Emoji picker** with ~370 searchable emojis
- 📅 **Date-as-title** button for quick logging
- 🔑 **Change password** and optional **keyfiles** without losing attachments
- ⏱️ **Auto-lock** after configurable inactivity, with auto-save before locking
- 📤 **Markdown export**, including attachments
- 🕐 **Recent journals** with quick-open
- 🎨 **Dark theme**
- ⌨️ **Keyboard shortcuts** — Ctrl+S, Ctrl+N, Ctrl+E, Ctrl+F, Ctrl+/
- 💾 **Auto-save** every 30 seconds
- 🖥️ **Cross-platform** — Windows, macOS, Linux

## 🔧 Prerequisites

| Requirement | Minimum | Notes |
|---|---|---|
| [Rust + Cargo](https://rustup.rs) | 1.70 | Builds the Tauri backend; TimENC is compiled in as a dependency |
| [Node.js](https://nodejs.org) | 18 | For the `@tauri-apps/cli` dev tooling |
| Tauri system deps | – | See [Tauri prerequisites](https://tauri.app/start/prerequisites/) (e.g. WebKitGTK on Linux) |

No separate TimENC installation is required — it is pinned as a git dependency and compiled directly into the Lockbook binary.

## 🎹 Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+S` | Save journal |
| `Ctrl+N` | New entry |
| `Ctrl+E` | Open emoji picker |
| `Ctrl+F` | Focus search |
| `Ctrl+/` | Show shortcuts |
| `Escape` | Close modals |

## 🔑 Keyfiles (Optional)

A keyfile is 32 bytes of random data. When used, **both the password AND the keyfile** are required to decrypt the journal.

- Generate via the **Gen** button on the Create screen
- Keep a backup in a safe place — **if lost, the journal cannot be decrypted**

## 🏗️ Architecture

```
┌───────────────────────────────────────────────────┐
│                    Frontend (JS)                    │
│  index.html · src/main.js · src/style.css          │
│  src/emoji-data.js                                  │
└─────────────────────┬─────────────────────────────┘
                      │  Tauri IPC (invoke_handler)
┌─────────────────────▼─────────────────────────────┐
│                  Tauri / Rust                       │
│  commands.rs · journal/ · encryption/               │
│  error.rs · main.rs                                 │
│                                                       │
│  encryption::container — .lbook format, Argon2id,   │
│  ChaCha20-Poly1305, zstd, lazy per-attachment decrypt│
│  timenc::crypto — bundled in-process (no subprocess) │
└───────────────────────────────────────────────────┘
```

### The `.lbook` container format

```
┌─────────────────────────────────────────────┐
│ HEADER (plaintext): magic, version, salt,    │
│ Argon2 params, nonce, index length            │
├─────────────────────────────────────────────┤
│ INDEX (zstd-compressed, then encrypted):     │
│ all entry text, tags, metadata, blob table   │
├─────────────────────────────────────────────┤
│ BLOB per attachment (individually encrypted, │
│ unique nonce, bound to header + position)    │
└─────────────────────────────────────────────┘
```

Opening a journal derives the Argon2id key once, decrypts only the index (entries, tags, metadata appear instantly), and keeps a keyed session that decrypts individual attachment blobs on demand — without re-deriving the key or reading the rest of the file. Saving writes to a staging file, re-decrypts and byte-compares it against the input before replacing the original (with a rolling `.bak`), so a format bug can only refuse to save, never corrupt existing data.

### Project Structure

```
.
├── .github/workflows/release.yml    # CI — builds on GitHub Release
├── .gitignore
├── README.md
├── package.json
├── index.html                       # App shell
├── sync-dist.sh                     # Copies src/ + index.html → dist/
├── src/
│   ├── main.js                      # Frontend logic
│   ├── style.css                    # Dark theme
│   └── emoji-data.js                # ~370 searchable emojis
├── dist/                            # Frontend copy served by Tauri (git-tracked)
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    └── src/
        ├── main.rs                  # Tauri entry point
        ├── commands.rs              # Tauri commands
        ├── error.rs                 # Error types
        ├── journal/
        │   ├── mod.rs               # JournalData, JournalMetadata
        │   └── entry.rs             # JournalEntry, Attachment, Mood
        └── encryption/
            ├── mod.rs                # load/save/create journal, v1→v2 migration
            ├── container.rs         # .lbook format, sessions, lazy decrypt
            └── temp.rs               # SecureTempDir, SecurePassword
```

## 🔒 Security

- **Plaintext never touches disk** — encryption happens entirely in memory; only ciphertext is written, atomically, with a rolling `.bak` backup.
- **Passwords and derived keys live only in RAM** — zeroed on drop via the `zeroize` crate.
- **Keyfile paths** are session-only; never persisted.
- **Argon2id** key derivation (256 MiB memory, time cost 3, parallelism 4) — deliberately slow and memory-hard against brute-force.
- **ChaCha20-Poly1305 AEAD** — every section (index and each attachment blob) is authenticated and bound to its position in the file; tampering or reordering is detected and decryption fails closed.
- **Save-time round-trip verification** — every save is decrypted back and byte-compared before it replaces the previous file.

## 🤝 Contributing

Contributions welcome! Please open an issue or submit a PR.

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

## 📄 License

GPL-3.0 — same as TimENC. See [LICENSE](LICENSE) for details.

## 🙏 Credits

- [TimENC](https://github.com/SnowTimSwiss/TimENC) — Encryption engine
- [Tauri](https://tauri.app) — App framework
- [ChaCha20-Poly1305](https://en.wikipedia.org/wiki/ChaCha20-Poly1305) — AEAD cipher
- [Argon2](https://en.wikipedia.org/wiki/Argon2) — Key derivation

---

**Lockbook** – Built with ❤️
