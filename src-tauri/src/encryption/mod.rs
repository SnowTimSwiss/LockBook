pub mod container;
pub mod temp;

use std::path::{Path, PathBuf};

use timenc::DecryptOptions;

use crate::error::{JournalError, Result};
use crate::journal::JournalData;
use temp::{SecurePassword, SecureTempDir};

/// Name of the in-temp copy of the encrypted journal used during decryption.
const ENC_COPY_NAME: &str = "journal.enc";

/// Decrypt a journal file into a [`JournalData`], detecting the format.
///
/// Two formats coexist on disk:
/// * **v2 `LBOOK2` container** — the current format written by [`save_journal`].
/// * **legacy TimENC file** — how v1.3.0 (still public!) wrote journals; a single
///   JSON document encrypted as one TimENC blob.
///
/// We branch on the first bytes of the file: a container starts with `LBOOK2`,
/// everything else is handed to the TimENC path. Opening is read-only either way,
/// so a v1 file stays v1 on disk until the user saves (which writes v2).
pub fn load_journal(
    journal_path: &str,
    password: &str,
    keyfile: Option<&str>,
) -> Result<JournalData> {
    let _pw = SecurePassword::new(password.to_string());

    let path = Path::new(journal_path);
    if !path.exists() {
        return Err(JournalError::FileNotFound(journal_path.to_string()));
    }

    // Peek the magic bytes to pick the format. A container starts with "LBOOK2".
    let mut magic = [0u8; 6];
    if let Ok(mut f) = std::fs::File::open(path) {
        use std::io::Read as _;
        let _ = f.read(&mut magic);
    }
    if container::is_container(&magic) {
        return container::read_container(path, password, keyfile);
    }

    load_timenc_journal(journal_path, password, keyfile)
}

/// Decrypt a legacy TimENC journal file (v1.3.0 format).
///
/// TimENC's `decrypt` securely deletes its input file on success, so we never
/// hand it the user's real journal: we decrypt a throwaway copy inside a temp
/// directory and leave the original untouched.
fn load_timenc_journal(
    journal_path: &str,
    password: &str,
    keyfile: Option<&str>,
) -> Result<JournalData> {
    let tmp = SecureTempDir::new()?;
    let enc_copy = tmp.path().join(ENC_COPY_NAME);
    std::fs::copy(journal_path, &enc_copy)?;

    let out_dir = tmp.path().join("out");

    timenc::decrypt(
        &enc_copy,
        DecryptOptions {
            password: password.to_string(),
            keyfile_path: keyfile.map(PathBuf::from),
            output_dir: out_dir.clone(),
        },
    )
    .map_err(|e| JournalError::DecryptionFailed(e.to_string()))?;

    // TimENC restores the original file name inside out_dir. Our convention is
    // "journal.json", but we scan for the first JSON file to be robust.
    let json_path = find_json_in_dir(&out_dir)?;
    let raw = std::fs::read(&json_path)?;

    let data = JournalData::from_json(&raw)?;

    // Securely overwrite the plaintext JSON before the temp dir is dropped.
    secure_delete_file(&json_path);

    Ok(data)
}

/// Serialize `JournalData`, write it to `journal_path` as a v2 `LBOOK2`
/// container (see [`container`]), and verify it round-trips before committing.
///
/// The write is **crash-safe**: the container is assembled entirely in memory
/// and streamed to a sibling staging file, a `.bak` of the previous version is
/// kept, and only then is the finished file atomically `rename`d over the target.
/// `rename` on the same filesystem is atomic, so the journal on disk is always
/// either the complete old version or the complete new one — never a partial.
/// (This also means no plaintext is ever written to disk, unlike the legacy
/// TimENC path which staged a plaintext JSON copy.)
///
/// **Round-trip safety net:** the freshly-built container bytes are decrypted
/// again *in memory* and compared byte-for-byte against the input **before**
/// anything is written. If they differ, the save aborts and the original file is
/// left untouched — so a bug in the container format can at worst *refuse* to
/// save, never corrupt or lose data. Verifying the in-memory buffer (rather than
/// re-opening the staging file) also means the save cannot be blocked by a
/// location that allows writing a file but not immediately re-opening it by path,
/// such as a Flatpak document portal or some network/FUSE mounts.
pub fn save_journal(
    journal_path: &str,
    password: &str,
    keyfile: Option<&str>,
    data: &JournalData,
) -> Result<container::ContainerSession> {
    let _pw = SecurePassword::new(password.to_string());

    let target = PathBuf::from(journal_path);
    // Stage the encrypted output next to the target so the final rename stays on
    // the same filesystem (a cross-device rename is not atomic and would fall
    // back to a copy).
    let staging = staging_path_for(&target);

    // Build and verify the container entirely in memory *before* writing anything.
    // The round-trip decrypt runs against the freshly-built byte buffer, not a
    // re-opened staging file — so a save can never be blocked by a location that
    // permits writing but not immediately re-opening by path (Flatpak document
    // portals, some network/FUSE mounts). A corruption bug can therefore at worst
    // refuse to save, never write bad bytes or corrupt the existing file.
    let (bytes, mut session) = container::build_container(password, keyfile, data)?;

    match container::read_container_from_bytes(&bytes, password, keyfile) {
        Ok(reloaded) => {
            let want = data.to_json()?;
            let got = reloaded.to_json()?;
            if want != got {
                return Err(JournalError::EncryptionFailed(
                    "container round-trip verification failed; save aborted, original file kept"
                        .to_string(),
                ));
            }
        }
        Err(e) => {
            return Err(JournalError::EncryptionFailed(format!(
                "container round-trip verification failed ({e}); save aborted, original file kept"
            )));
        }
    }

    // Keep a hidden rolling backup of the previous version next to the journal.
    // Best-effort: a failed backup must not block the save. The name is
    // dot-prefixed so file managers hide it — the user only ever sees the journal.
    if target.exists() {
        let backup = hidden_backup_path_for(&target);
        let _ = std::fs::copy(&target, &backup);
    }

    // Verified in memory — commit the bytes to disk. Prefer the crash-safe path:
    // write a sibling staging file, then `rename` it atomically over the target
    // (same-filesystem rename is atomic, so the journal is always either fully the
    // old or fully the new version). If the location rejects that dance — e.g. a
    // Flatpak document portal that only exposes the originally-opened file and
    // won't accept a renamed sibling — fall back to writing the already-verified
    // bytes straight to the target. The `.bak` copy above still holds the prior
    // version either way.
    let atomic = std::fs::write(&staging, &bytes)
        .and_then(|()| std::fs::rename(&staging, &target));
    if let Err(atomic_err) = atomic {
        let _ = std::fs::remove_file(&staging);
        if let Err(direct_err) = std::fs::write(&target, &bytes) {
            return Err(JournalError::EncryptionFailed(format!(
                "could not write journal to {} (atomic: {atomic_err}; direct: {direct_err}); \
                 save aborted",
                target.display()
            )));
        }
    }

    // The bytes are unchanged by the rename; repoint the session at the final
    // path so later on-demand blob reads hit the journal, not the gone staging file.
    session.set_path(target);
    Ok(session)
}

/// Build the staging path used while encrypting: a hidden sibling of `target`
/// with a `.tmp` suffix, unique enough to avoid clashing with a concurrent save.
fn staging_path_for(target: &Path) -> PathBuf {
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "journal".to_string());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_name = format!(".{file_name}.{nanos}.tmp");
    match target.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(tmp_name),
        _ => PathBuf::from(tmp_name),
    }
}

/// Hidden sibling backup path for `target`
/// (e.g. `diary.lbook` -> `.diary.lbook.bak`). Dot-prefixed so it stays out of
/// the user's way: only the journal file itself is visible in the folder.
fn hidden_backup_path_for(target: &Path) -> PathBuf {
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "journal".to_string());
    let backup_name = format!(".{file_name}.bak");
    match target.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join(backup_name),
        _ => PathBuf::from(backup_name),
    }
}

/// Create a brand-new journal file (must not already exist), returning the empty
/// journal and a session for the newly-written container.
pub fn create_journal(
    journal_path: &str,
    password: &str,
    keyfile: Option<&str>,
) -> Result<(JournalData, container::ContainerSession)> {
    let data = JournalData::default();
    let session = save_journal(journal_path, password, keyfile, &data)?;
    Ok((data, session))
}

/// Open a journal for lazy access, detecting the format.
///
/// * **v2 `LBOOK2` container** → returns the journal with attachment bytes
///   stripped (every `data` empty) plus a [`container::ContainerSession`] to
///   decrypt blobs on demand.
/// * **legacy TimENC file** → returns the fully-populated journal and `None`;
///   there is no container to lazily read from, so its bytes stay in memory until
///   the first save migrates it to v2.
pub fn open_journal_session(
    journal_path: &str,
    password: &str,
    keyfile: Option<&str>,
) -> Result<(JournalData, Option<container::ContainerSession>)> {
    let _pw = SecurePassword::new(password.to_string());

    let path = Path::new(journal_path);
    if !path.exists() {
        return Err(JournalError::FileNotFound(journal_path.to_string()));
    }

    let mut magic = [0u8; 6];
    if let Ok(mut f) = std::fs::File::open(path) {
        use std::io::Read as _;
        let _ = f.read(&mut magic);
    }

    if container::is_container(&magic) {
        let (data, session) = container::open_session(path, password, keyfile)?;
        Ok((data, Some(session)))
    } else {
        let data = load_timenc_journal(journal_path, password, keyfile)?;
        Ok((data, None))
    }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/// Find the first `.json` file inside `dir`.
fn find_json_in_dir(dir: &Path) -> Result<PathBuf> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            return Ok(path);
        }
    }
    Err(JournalError::InvalidFormat(
        "Decrypted archive does not contain a JSON file".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::entry::{Attachment, AttachmentPlacement, JournalEntry, Mood};
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    fn journal_with_attachment(data_b64: String) -> JournalData {
        let mut data = JournalData::default();
        let mut entry = JournalEntry::new("Test");
        entry.mood = Mood::Neutral;
        entry.attachments.push(Attachment {
            id: uuid::Uuid::new_v4().to_string(),
            name: "img.png".to_string(),
            mime_type: "image/png".to_string(),
            size: 3,
            data: data_b64,
            width: Some(1),
            height: Some(1),
            placement: AttachmentPlacement::Inline,
        });
        data.entries.push(entry);
        data
    }

    /// Encrypt `journal_json` as a legacy v1.3.0-style TimENC file at
    /// `<dir>/diary.lockbook` and return its path. `dir` must outlive the file.
    fn write_legacy_journal(dir: &Path, journal_json: &str, keyfile: Option<&Path>) -> PathBuf {
        let src_dir = dir.join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        let json_path = src_dir.join("journal.json");
        std::fs::write(&json_path, journal_json.as_bytes()).unwrap();

        let legacy_path = dir.join("diary.lockbook");
        timenc::encrypt(
            &json_path,
            timenc::EncryptOptions {
                password: "pw".to_string(),
                keyfile_path: keyfile.map(|p| p.to_path_buf()),
                output_path: legacy_path.clone(),
                compress: false,
            },
        )
        .expect("legacy encrypt");
        legacy_path
    }

    #[test]
    fn save_journal_with_attachment_roundtrips() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("diary.lbook");
        let data = journal_with_attachment(BASE64.encode([1u8, 2, 3]));
        let res = save_journal(path.to_str().unwrap(), "pw", None, &data);
        assert!(res.is_ok(), "save failed: {:?}", res.err());
    }

    #[test]
    fn save_journal_with_empty_attachment_data() {
        // A migrated v1 attachment whose bytes were stripped and never refilled.
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("diary.lbook");
        let data = journal_with_attachment(String::new());
        let res = save_journal(path.to_str().unwrap(), "pw", None, &data);
        assert!(res.is_ok(), "save failed: {:?}", res.err());
    }

    #[test]
    fn save_twice_same_path() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("diary.lbook");
        let data = journal_with_attachment(BASE64.encode([9u8, 9, 9]));
        let p = path.to_str().unwrap();
        save_journal(p, "pw", None, &data).expect("first save");
        let res = save_journal(p, "pw", None, &data);
        assert!(res.is_ok(), "second save failed: {:?}", res.err());
    }

    /// The end-to-end v1.3.0 → v2 migration a user hits on close: open a legacy
    /// TimENC journal, then save it, which rewrites it as an `LBOOK2` container.
    #[test]
    fn migrate_v1_then_save() {
        let dir = tempfile::TempDir::new().unwrap();
        // v1.3.0 stored images inline in `content` as data: URIs and left
        // `entries[].attachments` empty (in v1 it was a `Vec<String>`).
        let v1_json = r#"{"version":"1.0","entries":[{"id":"e1","timestamp":"2023-01-01T00:00:00Z","title":"Old","content":"<img src=\"data:image/png;base64,iVBORw0KGgo=\">","tags":[],"mood":"happy","attachments":[]}],"metadata":{"created":"2023-01-01T00:00:00Z","modified":"2023-01-01T00:00:00Z","app":"TimENC-Journal","version":"1.3.0"}}"#;
        let legacy = write_legacy_journal(dir.path(), v1_json, None);

        let loaded = load_journal(legacy.to_str().unwrap(), "pw", None).expect("migrate load");
        let res = save_journal(legacy.to_str().unwrap(), "pw", None, &loaded);
        assert!(res.is_ok(), "migrated save failed: {:?}", res.err());
    }

    /// Same migration but the legacy journal was protected with a keyfile.
    #[test]
    fn migrate_v1_with_keyfile_then_save() {
        let dir = tempfile::TempDir::new().unwrap();
        let keyfile = dir.path().join("secret.key");
        timenc::generate_keyfile(&keyfile).expect("gen keyfile");
        let kf = keyfile.to_str().unwrap();

        let v1_json = r#"{"version":"1.0","entries":[{"id":"e1","timestamp":"2023-01-01T00:00:00Z","title":"t","content":"c","tags":[],"mood":"neutral","attachments":[]}],"metadata":{"created":"2023-01-01T00:00:00Z","modified":"2023-01-01T00:00:00Z","app":"TimENC-Journal","version":"1.3.0"}}"#;
        let legacy = write_legacy_journal(dir.path(), v1_json, Some(&keyfile));

        let loaded = load_journal(legacy.to_str().unwrap(), "pw", Some(kf)).expect("migrate load");
        let res = save_journal(legacy.to_str().unwrap(), "pw", Some(kf), &loaded);
        assert!(res.is_ok(), "keyfile migrated save failed: {:?}", res.err());
    }

    /// The in-memory round-trip verifier must genuinely decrypt: a tampered
    /// buffer must fail authentication rather than pass verification.
    #[test]
    fn in_memory_verify_detects_corruption() {
        let data = journal_with_attachment(BASE64.encode([7u8, 7, 7]));
        let (mut bytes, _s) = container::build_container("pw", None, &data).expect("build");
        let i = bytes.len() - 1;
        bytes[i] ^= 0xFF;
        let res = container::read_container_from_bytes(&bytes, "pw", None);
        assert!(res.is_err(), "tampered container must not verify");
    }
}

/// Best-effort secure delete of a plaintext file (overwrite with zeros, remove).
fn secure_delete_file(path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        let len = meta.len() as usize;
        let zeros = vec![0u8; len.min(64 * 1024)];
        if let Ok(mut file) = std::fs::OpenOptions::new().write(true).open(path) {
            use std::io::Write;
            let mut written = 0usize;
            while written < len {
                let chunk = zeros.len().min(len - written);
                if file.write_all(&zeros[..chunk]).is_err() {
                    break;
                }
                written += chunk;
            }
            let _ = file.flush();
        }
    }
    let _ = std::fs::remove_file(path);
}
