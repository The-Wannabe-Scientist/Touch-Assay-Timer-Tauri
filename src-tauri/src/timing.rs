// src/timing.rs
// High-precision monotonic timestamp command.
//
// Returns milliseconds elapsed since the application started, using the OS
// monotonic clock (std::time::Instant). This clock:
//   - Never goes backwards (unlike system wall-clock which can be adjusted by NTP)
//   - Is not subject to browser timer throttling
//   - Has nanosecond internal resolution (returned as f64 ms for JS compatibility)
//
// The JS frontend uses this for the startup gap-detection check in the scheduler.
// Audio scheduling continues to use the AudioContext clock (which is already
// hardware-accurate for sound timing).

use crate::AppState;
use tauri::State;

/// Returns milliseconds elapsed since app start as a high-precision f64.
/// The value is monotonically increasing and cannot drift or be throttled.
///
/// Called from JS via: `invoke('get_monotonic_ms')`
#[tauri::command]
pub fn get_monotonic_ms(state: State<'_, AppState>) -> f64 {
    let elapsed = state.start_instant.elapsed();
    // Convert to milliseconds with sub-millisecond precision
    elapsed.as_secs_f64() * 1000.0
}
