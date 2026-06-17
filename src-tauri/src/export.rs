// src/export.rs
// Native file-save command.
//
// Receives a filename suggestion and raw bytes from the JS frontend,
// shows the OS native Save dialog, and writes the file directly to disk.
// This replaces the PWA's <a download> data-URI blob approach, which was
// limited by in-memory buffer sizes and couldn't target network drives.

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Opens the OS native Save dialog and writes `data` bytes to the chosen path.
///
/// Called from JS via:
///   `invoke('save_file', { filename: 'assay.xlsx', data: Array.from(uint8array) })`
///
/// Returns the final save path on success, or an error string on failure/cancel.
#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    filename: String,
    data: Vec<u8>,
) -> Result<String, String> {
    // Determine extension for the dialog filter
    let extension = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let filter_name = match extension.as_str() {
        "xlsx" => "Excel Workbook",
        "csv"  => "CSV File",
        _      => "All Files",
    };

    // Show the native save dialog (blocks until user picks a path or cancels)
    let save_path = app
        .dialog()
        .file()
        .set_file_name(&filename)
        .add_filter(filter_name, &[&extension])
        .blocking_save_file();

    match save_path {
        Some(path) => {
            let path_str = path.to_string();
            std::fs::write(&path_str, &data)
                .map_err(|e| format!("Failed to write file: {e}"))?;
            Ok(path_str)
        }
        None => {
            // User cancelled the dialog — not an error, just a no-op signal
            Err("cancelled".to_string())
        }
    }
}
