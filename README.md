# Lockbook

<div align="center">

🔒📖 **A secure, encrypted personal diary**

*Built with Rust + Tauri · Powered by TimENC*

</div>

---

Every journal file is a `.timenc-journal` — a TimENC-encrypted container protecting your entries with **ChaCha20-Poly1305 AEAD** and **Argon2id** key derivation.

## ✨ Features

- 🔐 **End-to-end encryption** via TimENC CLI (ChaCha20-Poly1305 + Argon2id)
- 📓 **Create & manage** multiple encrypted journals
- ✍️ **Markdown editor** with live preview
- 🏷️ **Tags & mood** tracking for every entry
- 🔍 **Full-text search** across all entries
- 😀 **Emoji picker** with ~370 searchable emojis
- 📅 **Date-as-title** button for quick logging
- 📊 **Metadata panel** — word count, char count, created/modified dates
- 📤 **Markdown export** for backups
- 🕐 **Recent journals** with quick-open
- 🎨 **Dark theme** inspired by TimENC
- ⌨️ **Keyboard shortcuts** — Ctrl+S, Ctrl+N, Ctrl+E, Ctrl+/
- 💾 **Auto-save** every 30 seconds
- 🖥️ **Cross-platform** — Windows, macOS, Linux

## 📸 Screenshots

> *Add screenshots here after first build*

## 🔧 Prerequisites

| Requirement | Minimum | Notes |
|---|---|---|
| [TimENC CLI](https://github.com/SnowTimSwiss/TimENC/releases/latest) | V20.0+ | Must be on `PATH` |
| [Rust + Cargo](https://rustup.rs) | 1.70 | |
| [Node.js](https://nodejs.org) | 18 | For `@tauri-apps/cli` |
| Tauri system deps | – | See [Tauri prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites) |

### Install TimENC CLI

Download from [TimENC releases](https://github.com/SnowTimSwiss/TimENC/releases/latest) and place it on your `PATH`:

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
┌─────────────────────────────────────────────────┐
│                   Frontend (JS)                  │
│  index.html  ·  src/main.js  ·  src/style.css   │
│  src/emoji-data.js                              │
└─────────────────────┬───────────────────────────┘
                      │  Tauri IPC (invoke_handler)
┌─────────────────────▼───────────────────────────┐
│                 Tauri / Rust                     │
│  commands.rs  ·  journal/  ·  encryption/       │
│  error.rs  ·  main.rs                           │
└─────────────────────┬───────────────────────────┘
                      │  Process (stdin/stdout)
┌─────────────────────▼───────────────────────────┐
│               TimENC CLI (external)              │
│  timenc encrypt / decrypt / generate-keyfile     │
└──────────────────────────────────────────────────┘
```

### Project Structure

```
.
├── .github/workflows/release.yml    # CI — builds on GitHub Release
├── .gitignore
├── README.md
├── package.json
├── index.html                       # App shell
├── src/
│   ├── main.js                      # Frontend logic
│   ├── style.css                    # Dark theme
│   └── emoji-data.js               # ~370 searchable emojis
├── dist/                            # Frontend copy served by Tauri
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    └── src/
        ├── main.rs                  # Tauri entry point
        ├── commands.rs              # Tauri commands
        ├── error.rs                 # Error types
        ├── journal/
        │   ├── mod.rs               # JournalData, OpenJournal
        │   └── entry.rs             # JournalEntry, Mood enum
        └── encryption/
            ├── mod.rs               # load/save/create journal
            ├── timenc_cli.rs        # TimENC CLI wrapper
            └── temp.rs              # SecureTempDir, SecurePassword
```

## 🔒 Security

- **Plaintext never permanently on disk** — JSON is written to a temp file, encrypted, then securely overwritten with zeros before deletion.
- **Passwords live only in RAM** — zeroed on drop via the `zeroize` crate.
- **Keyfile paths** are session-only; never persisted.
- Encryption is handled entirely by TimENC: ChaCha20-Poly1305 AEAD + Argon2id (time=4, mem=128 MB, par=4).

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
