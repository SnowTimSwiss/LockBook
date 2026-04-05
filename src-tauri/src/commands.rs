use std::sync::Mutex;
use tauri::State;

use crate::encryption::{self, timenc_cli};
use crate::error::{JournalError, Result};
use crate::journal::{entry::JournalEntry, JournalData, OpenJournal};

/// Global in-memory state: the currently open journal.
pub struct JournalState(pub Mutex<Option<OpenJournal>>);

// ─── TimENC ──────────────────────────────────────────────────────────────────

/// Returns info about the timenc installation for the UI warning banner.
#[tauri::command]
pub fn get_timenc_info() -> serde_json::Value {
    if let Some(path) = timenc_cli::timenc_path() {
        let version = timenc_cli::version().unwrap_or_else(|| "unknown".into());
        serde_json::json!({
            "found": true,
            "path": path.to_string_lossy().to_string(),
            "version": version,
            "message": format!("TimENC {} found", version),
            "searched_in": null
        })
    } else {
        serde_json::json!({
            "found": false,
            "path": null,
            "version": null,
            "message": "TimENC CLI not found on PATH or in known locations.",
            "searched_in": "PATH + registry + known paths"
        })
    }
}

/// Returns true if the `timenc` CLI is on PATH.
#[tauri::command]
pub fn check_timenc_installed() -> bool {
    timenc_cli::is_installed()
}

/// Returns the installed timenc version string, or None.
#[tauri::command]
pub fn get_timenc_version() -> Option<String> {
    timenc_cli::version()
}

/// Returns the resolved path to the timenc binary (for diagnostic display).
#[tauri::command]
pub fn get_timenc_path() -> Option<String> {
    timenc_cli::timenc_path().map(|p| p.to_string_lossy().to_string())
}

/// Generate a 32-byte random keyfile at `output_path`.
#[tauri::command]
pub fn generate_keyfile(output_path: String) -> Result<()> {
    timenc_cli::generate_keyfile(&output_path)
}

// ─── Journal lifecycle ───────────────────────────────────────────────────────

/// Create a new empty journal and keep it open in state.
#[tauri::command]
pub fn create_journal(
    path: String,
    password: String,
    keyfile: Option<String>,
    state: State<'_, JournalState>,
) -> Result<JournalData> {
    let data = encryption::create_journal(&path, &password, keyfile.as_deref())?;

    let mut guard = state.0.lock().unwrap();
    *guard = Some(OpenJournal {
        path: path.clone(),
        data: data.clone(),
    });

    Ok(data)
}

/// Decrypt and open an existing `.timenc-journal` file.
#[tauri::command]
pub fn open_journal(
    path: String,
    password: String,
    keyfile: Option<String>,
    state: State<'_, JournalState>,
) -> Result<JournalData> {
    let data = encryption::load_journal(&path, &password, keyfile.as_deref())?;

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
pub fn save_journal(
    path: String,
    password: String,
    keyfile: Option<String>,
    data: JournalData,
    state: State<'_, JournalState>,
) -> Result<()> {
    // Persist to disk via timenc
    encryption::save_journal(&path, &password, keyfile.as_deref(), &data)?;

    // Also update the in-memory state
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
