// src/wake_lock.rs
// Prevent the display from sleeping during an active experiment.
//
// macOS: Spawns `caffeinate -d` as a child process, which holds a display-sleep
//        prevention assertion for as long as the child lives. Killing the child
//        releases the assertion — no IOKit FFI or CoreFoundation types needed.
//
// Windows: Calls SetThreadExecutionState via the windows crate.
//
// Other: No-op — experiment works fine, screen may sleep on idle hardware.

use std::sync::Mutex;

// ---------------------------------------------------------------------------
// Shared state — child process handle (macOS) or unit (other platforms)
// ---------------------------------------------------------------------------

static WAKE_LOCK: Mutex<Option<WakeLockHandle>> = Mutex::new(None);

struct WakeLockHandle {
    #[cfg(target_os = "macos")]
    child: std::process::Child,
    #[cfg(not(target_os = "macos"))]
    _phantom: (),
}

// Safety: Child contains a raw pid_t which is safe to send across threads.
unsafe impl Send for WakeLockHandle {}

// ---------------------------------------------------------------------------
// macOS — caffeinate -d
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn platform_acquire() -> Option<WakeLockHandle> {
    // `caffeinate -d` prevents the display from sleeping.
    // The assertion lives until the child process is killed.
    match std::process::Command::new("caffeinate")
        .arg("-d")
        .spawn()
    {
        Ok(child) => Some(WakeLockHandle { child }),
        Err(e) => {
            eprintln!("[wake_lock] caffeinate spawn failed: {e}");
            None
        }
    }
}

#[cfg(target_os = "macos")]
fn platform_release(mut handle: WakeLockHandle) {
    let _ = handle.child.kill();
    let _ = handle.child.wait(); // reap the zombie
}

// ---------------------------------------------------------------------------
// Windows — SetThreadExecutionState
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn platform_acquire() -> Option<WakeLockHandle> {
    use std::os::windows::process::CommandExt;
    // ES_CONTINUOUS | ES_DISPLAY_REQUIRED prevents display sleep.
    // winapi values: ES_CONTINUOUS = 0x80000000, ES_DISPLAY_REQUIRED = 0x00000002
    unsafe {
        extern "system" {
            fn SetThreadExecutionState(esflags: u32) -> u32;
        }
        SetThreadExecutionState(0x80000000u32 | 0x00000002u32);
    }
    Some(WakeLockHandle { _phantom: () })
}

#[cfg(target_os = "windows")]
fn platform_release(_handle: WakeLockHandle) {
    unsafe {
        extern "system" {
            fn SetThreadExecutionState(esflags: u32) -> u32;
        }
        // ES_CONTINUOUS alone clears the display-required flag
        SetThreadExecutionState(0x80000000u32);
    }
}

// ---------------------------------------------------------------------------
// Fallback — no-op
// ---------------------------------------------------------------------------

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_acquire() -> Option<WakeLockHandle> {
    Some(WakeLockHandle { _phantom: () })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_release(_handle: WakeLockHandle) {}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Acquires a display-sleep prevention wake lock. Idempotent.
/// Called from JS via: `invoke('request_wake_lock')`
#[tauri::command]
pub fn request_wake_lock() -> Result<(), String> {
    let mut guard = WAKE_LOCK.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = platform_acquire();
    }
    Ok(())
}

/// Releases the active display-sleep prevention wake lock. Idempotent.
/// Called from JS via: `invoke('release_wake_lock')`
#[tauri::command]
pub fn release_wake_lock() -> Result<(), String> {
    let mut guard = WAKE_LOCK.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = guard.take() {
        platform_release(handle);
    }
    Ok(())
}
