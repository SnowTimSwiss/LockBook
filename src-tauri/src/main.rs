// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod encryption;
mod error;
mod journal;

use std::sync::Mutex;

use commands::JournalState;

/// Works around WebKitGTK crashing right after the window maps on some Linux
/// setups (most notably the proprietary NVIDIA driver under Wayland, e.g. on
/// CachyOS/Arch). There the DMA-BUF renderer fails with
/// "Error 71 (Protocol error) dispatching to Wayland display" and takes the
/// whole app down. Falling back to the non-DMA-BUF renderer is harmless for a
/// text editor. Must run before GTK/WebKit is initialised. A value the user
/// already set (e.g. `WEBKIT_DISABLE_DMABUF_RENDERER=0`) always wins.
#[cfg(target_os = "linux")]
fn apply_webkit_workarounds() {
    // Checked in several places because the Flatpak sandbox does not expose all
    // of them (`/dev/nvidiactl` is shared via `--device=dri`).
    let nvidia = [
        "/proc/driver/nvidia/version",
        "/sys/module/nvidia",
        "/dev/nvidiactl",
    ]
    .iter()
    .any(|p| std::path::Path::new(p).exists());

    if nvidia && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

/// The titlebar is drawn by GTK3 itself (GNOME/Mutter offers no server-side
/// decorations on Wayland), and GTK3 shows minimize/maximize/close by default
/// instead of the user's choice. Copy GNOME's `button-layout` (e.g.
/// "appmenu:minimize,close") so Lockbook matches the other apps. Must run after
/// GTK is initialised, i.e. from the Tauri `setup` hook.
#[cfg(target_os = "linux")]
fn apply_gnome_button_layout() {
    use gtk::gio::{self, prelude::*};
    use gtk::prelude::*;

    const SCHEMA: &str = "org.gnome.desktop.wm.preferences";
    let has_schema = gio::SettingsSchemaSource::default()
        .and_then(|source| source.lookup(SCHEMA, true))
        .is_some();
    if !has_schema {
        return;
    }
    let layout = gio::Settings::new(SCHEMA).string("button-layout");
    if let Some(settings) = gtk::Settings::default() {
        settings.set_gtk_decoration_layout(Some(layout.as_str()));
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    apply_webkit_workarounds();

    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(JournalState(Mutex::new(None)))
        .setup(|_app| {
            #[cfg(target_os = "linux")]
            apply_gnome_button_layout();
            Ok(())
        })
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
            commands::change_journal_password,
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
            // Attachments
            commands::read_attachment_file,
            commands::read_clipboard_image,
            commands::write_temp_attachment,
            commands::write_binary_file,
            commands::get_attachment_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TimENC Journal");
}
