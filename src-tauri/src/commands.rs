use std::sync::Mutex;
use tauri::State;

use crate::encryption;
use crate::error::{JournalError, Result};
use crate::journal::{entry::JournalEntry, JournalData, OpenJournal};

/// Global in-memory state: the currently open journal.
pub struct JournalState(pub Mutex<Option<OpenJournal>>);

// ─── TimENC ──────────────────────────────────────────────────────────────────

/// Human-readable label for the bundled, in-process TimENC implementation.
const TIMENC_BUNDLED: &str = "bundled (in-process)";

/// Returns info about the TimENC implementation for the UI banner.
///
/// TimENC is now compiled into Lockbook, so it is always available — no external
/// binary or PATH lookup is involved.
#[tauri::command]
pub async fn get_timenc_info() -> serde_json::Value {
    serde_json::json!({
        "found": true,
        "path": TIMENC_BUNDLED,
        "version": TIMENC_BUNDLED,
        "message": "TimENC is bundled with Lockbook.",
        "searched_in": null
    })
}

/// TimENC is bundled, so this is always true.
#[tauri::command]
pub async fn check_timenc_installed() -> bool {
    true
}

/// Returns the bundled TimENC label.
#[tauri::command]
pub async fn get_timenc_version() -> Option<String> {
    Some(TIMENC_BUNDLED.to_string())
}

/// TimENC is in-process; there is no external binary path.
#[tauri::command]
pub async fn get_timenc_path() -> Option<String> {
    Some(TIMENC_BUNDLED.to_string())
}

/// Generate a 32-byte random keyfile at `output_path`.
#[tauri::command]
pub async fn generate_keyfile(output_path: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        timenc::generate_keyfile(std::path::Path::new(&output_path))
            .map(|_| ())
            .map_err(|e| JournalError::EncryptionFailed(e.to_string()))
    })
    .await
    .unwrap_or_else(|err| Err(JournalError::EncryptionFailed(err.to_string())))
}

// ─── Journal lifecycle ───────────────────────────────────────────────────────

/// Create a new empty journal and keep it open in state.
#[tauri::command]
pub async fn create_journal(
    path: String,
    password: String,
    keyfile: Option<String>,
    state: State<'_, JournalState>,
) -> Result<JournalData> {
    let data_path = path.clone();
    let data = tauri::async_runtime::spawn_blocking(move || {
        encryption::create_journal(&data_path, &password, keyfile.as_deref())
    })
    .await
    .unwrap_or_else(|err| Err(JournalError::EncryptionFailed(err.to_string())))?;

    let mut guard = state.0.lock().unwrap();
    *guard = Some(OpenJournal {
        path: path.clone(),
        data: data.clone(),
    });

    Ok(data)
}

/// Decrypt and open an existing `.lbook` or legacy `.timenc-journal` file.
#[tauri::command]
pub async fn open_journal(
    path: String,
    password: String,
    keyfile: Option<String>,
    state: State<'_, JournalState>,
) -> Result<JournalData> {
    let data_path = path.clone();
    let data = tauri::async_runtime::spawn_blocking(move || {
        encryption::load_journal(&data_path, &password, keyfile.as_deref())
    })
    .await
    .unwrap_or_else(|err| Err(JournalError::DecryptionFailed(err.to_string())))?;

    let mut guard = state.0.lock().unwrap();
    *guard = Some(OpenJournal {
        path: path.clone(),
        data: data.clone(),
    });

    Ok(data)
}

/// Encrypt and persist the current in-memory journal data to disk.
/// This version accepts path, data directly (for client-side save).
#[tauri::command]
pub async fn save_journal(
    path: String,
    password: String,
    keyfile: Option<String>,
    data: JournalData,
    state: State<'_, JournalState>,
) -> Result<()> {
    // Persist to disk via timenc
    let data_path = path.clone();
    let data_for_disk = data.clone();
    tauri::async_runtime::spawn_blocking(move || {
        encryption::save_journal(&data_path, &password, keyfile.as_deref(), &data_for_disk)
    })
    .await
    .unwrap_or_else(|err| Err(JournalError::EncryptionFailed(err.to_string())))?;

    // Also update the in-memory state
    let mut guard = state.0.lock().unwrap();
    *guard = Some(OpenJournal {
        path: path.clone(),
        data: data.clone(),
    });

    Ok(())
}

/// Verify the current password, then re-encrypt the journal with a new password.
#[tauri::command]
pub async fn change_journal_password(
    path: String,
    current_password: String,
    new_password: String,
    keyfile: Option<String>,
    data: JournalData,
    state: State<'_, JournalState>,
) -> Result<()> {
    let verify_path = path.clone();
    let verify_keyfile = keyfile.clone();
    tauri::async_runtime::spawn_blocking(move || {
        encryption::load_journal(&verify_path, &current_password, verify_keyfile.as_deref())
    })
    .await
    .unwrap_or_else(|err| Err(JournalError::DecryptionFailed(err.to_string())))?;

    let data_path = path.clone();
    let data_for_disk = data.clone();
    tauri::async_runtime::spawn_blocking(move || {
        encryption::save_journal(
            &data_path,
            &new_password,
            keyfile.as_deref(),
            &data_for_disk,
        )
    })
    .await
    .unwrap_or_else(|err| Err(JournalError::EncryptionFailed(err.to_string())))?;

    let mut guard = state.0.lock().unwrap();
    *guard = Some(OpenJournal {
        path: path.clone(),
        data: data.clone(),
    });

    Ok(())
}

/// Close the currently open journal (wipes in-memory data).
#[tauri::command]
pub fn close_journal(state: State<'_, JournalState>) -> Result<()> {
    let mut guard = state.0.lock().unwrap();
    *guard = None;
    Ok(())
}

/// Return the data of the currently open journal without re-decrypting from disk.
#[tauri::command]
pub fn get_journal_data(state: State<'_, JournalState>) -> Result<JournalData> {
    let guard = state.0.lock().unwrap();
    let journal = guard.as_ref().ok_or(JournalError::NoJournalOpen)?;
    Ok(journal.data.clone())
}

// ─── Entry management ────────────────────────────────────────────────────────

/// Add a new blank entry with the given title; return it so the UI can focus it.
#[tauri::command]
pub fn new_entry(title: String, state: State<'_, JournalState>) -> Result<JournalEntry> {
    let mut guard = state.0.lock().unwrap();
    let journal = guard.as_mut().ok_or(JournalError::NoJournalOpen)?;

    let entry = JournalEntry::new(title);
    journal.data.upsert_entry(entry.clone());
    Ok(entry)
}

/// Insert or update an entry (matched by `entry.id`).
#[tauri::command]
pub fn upsert_entry(entry: JournalEntry, state: State<'_, JournalState>) -> Result<()> {
    let mut guard = state.0.lock().unwrap();
    let journal = guard.as_mut().ok_or(JournalError::NoJournalOpen)?;
    journal.data.upsert_entry(entry);
    Ok(())
}

/// Delete an entry by id.
#[tauri::command]
pub fn delete_entry(entry_id: String, state: State<'_, JournalState>) -> Result<()> {
    let mut guard = state.0.lock().unwrap();
    let journal = guard.as_mut().ok_or(JournalError::NoJournalOpen)?;
    journal.data.remove_entry(&entry_id)
}

/// Full-text search across all entries; returns matching entries sorted newest first.
#[tauri::command]
pub fn search_entries(query: String, state: State<'_, JournalState>) -> Result<Vec<JournalEntry>> {
    let guard = state.0.lock().unwrap();
    let journal = guard.as_ref().ok_or(JournalError::NoJournalOpen)?;
    Ok(journal.data.search(&query))
}

/// Return all entries sorted newest first.
#[tauri::command]
pub fn list_entries(state: State<'_, JournalState>) -> Result<Vec<JournalEntry>> {
    let guard = state.0.lock().unwrap();
    let journal = guard.as_ref().ok_or(JournalError::NoJournalOpen)?;
    Ok(journal.data.sorted_entries())
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/// Returns the application version from Cargo.toml.
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Write a UTF-8 text file to disk (used for Markdown export).
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<()> {
    std::fs::write(&path, content.as_bytes()).map_err(JournalError::Io)
}
