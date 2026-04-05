// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod encryption;
mod error;
mod journal;

use std::sync::Mutex;

use commands::JournalState;

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .manage(JournalState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            // TimENC helpers
            commands::get_timenc_info,
            commands::check_timenc_installed,
            commands::get_timenc_version,
            commands::get_timenc_path,
            commands::generate_keyfile,
            // Journal lifecycle
            commands::create_journal,
            commands::open_journal,
            commands::save_journal,
            commands::close_journal,
            commands::get_journal_data,
            // Entry management
            commands::new_entry,
            commands::upsert_entry,
            commands::delete_entry,
            commands::search_entries,
            commands::list_entries,
            // Utility
            commands::get_app_version,
            commands::write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TimENC Journal");
}
