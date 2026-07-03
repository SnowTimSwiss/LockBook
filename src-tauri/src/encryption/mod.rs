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
/// **Round-trip safety net:** before the atomic rename, the freshly-written
/// staging container is decrypted again and compared byte-for-byte against the
/// input. If they differ, the save aborts and the original file is left
/// untouched — so a bug in the container format can at worst *refuse* to save,
/// never corrupt or lose data.
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

    let mut session = match container::write_container(&staging, password, keyfile, data) {
        Ok(session) => session,
        Err(e) => {
            // The original journal was never touched; just clean up any partial staging.
            let _ = std::fs::remove_file(&staging);
            return Err(e);
        }
    };

    // Round-trip verification: re-read the staging container and confirm it
    // decrypts back to exactly the data we were asked to save. Both sides are
    // compared via canonical JSON, which is deterministic for our data model.
    match container::read_container(&staging, password, keyfile) {
        Ok(reloaded) => {
            let want = data.to_json()?;
            let got = reloaded.to_json()?;
            if want != got {
                let _ = std::fs::remove_file(&staging);
                return Err(JournalError::EncryptionFailed(
                    "container round-trip verification failed; save aborted, original file kept"
                        .to_string(),
                ));
            }
        }
        Err(e) => {
            let _ = std::fs::remove_file(&staging);
            return Err(JournalError::EncryptionFailed(format!(
                "container round-trip verification failed ({e}); save aborted, original file kept"
            )));
        }
    }

    // Keep a hidden rolling backup of the previous version next to the journal.
    // Best-effort: the atomic rename below already guarantees crash-safety, so a
    // failed backup must not block the save. The name is dot-prefixed so file
    // managers hide it — the user only ever sees the journal file itself.
    if target.exists() {
        let backup = hidden_backup_path_for(&target);
        let _ = std::fs::rename(&target, &backup)
            .or_else(|_| std::fs::copy(&target, &backup).map(|_| ()));
    }

    // Atomically move the finished file into place.
    if let Err(e) = std::fs::rename(&staging, &target) {
        let _ = std::fs::remove_file(&staging);
        return Err(JournalError::Io(e));
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
