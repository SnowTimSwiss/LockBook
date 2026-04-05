pub mod temp;
pub mod timenc_cli;

use std::path::Path;

use crate::error::{JournalError, Result};
use crate::journal::JournalData;
use temp::{SecurePassword, SecureTempDir};

const JOURNAL_JSON_NAME: &str = "journal.json";

/// Decrypt a `.timenc-journal` file and deserialize the contained `JournalData`.
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
    let output_dir = tmp.path().to_string_lossy().to_string();

    timenc_cli::decrypt(journal_path, &output_dir, password, keyfile)?;

    // timenc restores the original filename inside output_dir.
    // Our convention: the decrypted file is always "journal.json".
    // If timenc produces a different name (e.g., the stem of the .timenc file),
    // we scan for the first JSON file.
    let json_path = find_json_in_dir(tmp.path())?;
    let raw = std::fs::read(&json_path)?;

    let data = JournalData::from_json(&raw)?;

    // Secure-delete the plaintext JSON from the temp directory.
    if let Some(name) = json_path.file_name().and_then(|n| n.to_str()) {
        let _ = tmp.secure_delete(name);
    }

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

    // Write plaintext JSON to temp directory
    let json_bytes = data.to_json()?;
    let json_path = tmp.write_file(JOURNAL_JSON_NAME, &json_bytes)?;
    let json_path_str = json_path.to_string_lossy().to_string();

    // Encrypt directly to the target path
    timenc_cli::encrypt(&json_path_str, journal_path, password, keyfile)?;

    // Securely delete the plaintext copy
    let _ = tmp.secure_delete(JOURNAL_JSON_NAME);

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
fn find_json_in_dir(dir: &Path) -> Result<std::path::PathBuf> {
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
