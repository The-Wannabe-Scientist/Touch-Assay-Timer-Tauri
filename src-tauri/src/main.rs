// src/main.rs
// Prevents an extra console window from appearing on Windows in release mode.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod database;
pub mod export;
pub mod timing;
pub mod wake_lock;

use std::sync::Mutex;
use tauri::Manager;

/// Shared application state — holds the SQLite connection and monotonic start time.
pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub start_instant: std::time::Instant,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // ── Open (or create) the SQLite database in the app data directory ──
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data directory");

            std::fs::create_dir_all(&app_dir)
                .expect("Failed to create app data directory");

            let db_path = app_dir.join("touch_assay.db");
            let conn = rusqlite::Connection::open(&db_path)
                .expect("Failed to open SQLite database");

            // Enable WAL mode for crash-safety and better concurrent read performance
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
                .expect("Failed to set WAL mode");

            // Initialise the schema (idempotent — safe to run on every startup)
            database::initialise_schema(&conn)
                .expect("Failed to initialise database schema");

            app.manage(AppState {
                db: Mutex::new(conn),
                start_instant: std::time::Instant::now(),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Timing
            timing::get_monotonic_ms,
            // Database — assays
            database::save_assay,
            database::load_all_assays,
            database::hydrate_assay,
            database::delete_assay,
            // Database — trials
            database::save_trial,
            database::mark_trial_completed,
            database::mark_trial_abandoned,
            // Database — runs
            database::save_run,
            database::abandon_active_trials,
            database::mark_orphan_runs_stopped,
            // Export
            export::save_file,
            // Wake lock
            wake_lock::request_wake_lock,
            wake_lock::release_wake_lock,
        ])
        .run(tauri::generate_context!())
        .expect("Error while running Touch Assay Timer");
}
