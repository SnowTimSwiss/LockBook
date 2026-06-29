pub mod temp;

use std::path::{Path, PathBuf};

use timenc::{DecryptOptions, EncryptOptions};

use crate::error::{JournalError, Result};
use crate::journal::JournalData;
use temp::{SecurePassword, SecureTempDir};

const JOURNAL_JSON_NAME: &str = "journal.json";
/// Name of the in-temp copy of the encrypted journal used during decryption.
const ENC_COPY_NAME: &str = "journal.enc";

/// Decrypt a `.lbook` or legacy `.timenc-journal` file and deserialize the contained `JournalData`.
///
/// TimENC's `decrypt` securely deletes its input file on success, so we never
/// hand it the user's real journal: we decrypt a throwaway copy inside a temp
/// directory and leave the original untouched.
pub fn load_journal(
    journal_path: &str,
    password: &str,
    keyfile: Option<&str>,
) -> Result<JournalData> {
    let _pw = SecurePassword::new(password.to_string());

    if !Path::new(journal_path).exists() {
        return Err(JournalError::FileNotFound(journal_path.to_string()));
    }

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

/// Serialize `JournalData` to JSON, encrypt it with TimENC, and write to
/// `journal_path` (overwriting any existing file).
pub fn save_journal(
    journal_path: &str,
    password: &str,
    keyfile: Option<&str>,
    data: &JournalData,
) -> Result<()> {
    let _pw = SecurePassword::new(password.to_string());

    let tmp = SecureTempDir::new()?;

    // Write plaintext JSON to the temp directory; TimENC encrypts it to the
    // target path and securely deletes this plaintext copy on success.
    let json_bytes = data.to_json()?;
    let json_path = tmp.path().join(JOURNAL_JSON_NAME);
    std::fs::write(&json_path, &json_bytes)?;

    timenc::encrypt(
        &json_path,
        EncryptOptions {
            password: password.to_string(),
            keyfile_path: keyfile.map(PathBuf::from),
            output_path: PathBuf::from(journal_path),
            compress: false,
        },
    )
    .map_err(|e| JournalError::EncryptionFailed(e.to_string()))?;

    // Defensive: TimENC removes the plaintext on success, but if anything left
    // it behind, overwrite it before the temp dir is dropped.
    secure_delete_file(&json_path);

    Ok(())
}

/// Create a brand-new journal file (must not already exist).
pub fn create_journal(
    journal_path: &str,
    password: &str,
    keyfile: Option<&str>,
) -> Result<JournalData> {
    let data = JournalData::default();
    save_journal(journal_path, password, keyfile, &data)?;
    Ok(data)
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
