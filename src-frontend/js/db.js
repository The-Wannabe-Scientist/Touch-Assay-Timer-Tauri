/**
 * @file db.js
 * @module Database
 * @description Tauri IPC persistence layer for the Touch Assay Timer.
 *
 * All exported function signatures are IDENTICAL to the original db.js so
 * main.js requires zero changes — only the implementation beneath changes.
 *
 * Architecture:
 *   Each function calls the Rust SQLite backend via Tauri's invoke() IPC.
 *   The Rust layer stores assay/trial/run objects as JSON blobs in SQLite.
 *
 * Error handling:
 *   All functions are async. IPC errors are logged to console but do NOT
 *   propagate as rejections — they resolve silently so that a transient DB
 *   hiccup never crashes the WebView. Critical callers (form submit, etc.)
 *   can still add their own try/catch on top if they need to react to errors.
 */


/* ==========================================================================
   Tauri IPC Bridge
   ========================================================================== */

/**
 * Calls a Tauri Rust command. Returns the result, or throws on failure.
 * All public functions below wrap this with their own .catch() so errors
 * degrade gracefully rather than propagating as unhandled rejections.
 *
 * @param {string} cmd    - The Tauri command name (snake_case).
 * @param {Object} [args] - Arguments to pass to the Rust command.
 * @returns {Promise<*>}
 */
async function invoke(cmd, args = {}) {
  if (!window.__TAURI__?.core?.invoke) {
    throw new Error(
      `Tauri IPC unavailable — cannot call '${cmd}'. ` +
      `Ensure the app is running inside Tauri, not a plain browser.`
    );
  }
  return window.__TAURI__.core.invoke(cmd, args);
}

/**
 * Safe invoke — like invoke() but catches all errors, logs them, and
 * returns `fallback` instead. Use for fire-and-forget DB writes where
 * a failure should degrade gracefully without crashing the caller.
 *
 * @param {string} cmd
 * @param {Object} [args]
 * @param {*}      [fallback]
 * @returns {Promise<*>}
 */
async function invokeOrLog(cmd, args = {}, fallback = undefined) {
  try {
    return await invoke(cmd, args);
  } catch (err) {
    console.error(`[db] IPC error in '${cmd}':`, err);
    return fallback;
  }
}


/* ==========================================================================
   Availability
   ========================================================================== */

/**
 * SQLite is always available in Tauri. Returns true for API compatibility.
 * @returns {boolean}
 */
export function getIdbAvailable() {
  return true;
}

/**
 * No-op — SQLite is opened in main.rs at startup.
 * @returns {Promise<void>}
 */
export async function openDB() {
  // SQLite is already open — nothing to do
}


/* ==========================================================================
   Assay Operations
   ========================================================================== */

/**
 * Persists (creates or updates) an assay record.
 * @param {Object} assay
 * @returns {Promise<void>}
 */
export async function saveAssay(assay) {
  await invoke("save_assay", { assay });
}

/**
 * Fetches all assay records (shallow — no trials or runs).
 * @returns {Promise<Object[]>}
 */
export async function loadAllAssays() {
  return invokeOrLog("load_all_assays", {}, []);
}

/**
 * Fully re-hydrates an assay: record + all trials + each trial's runs.
 * @param {string} assayId
 * @returns {Promise<Object>}
 */
export async function hydrateAssay(assayId) {
  return invoke("hydrate_assay", { assayId });
}

/**
 * Permanently deletes an assay and all its associated trials and runs.
 * @param {string} assayId
 * @returns {Promise<void>}
 */
export async function deleteAssay(assayId) {
  await invokeOrLog("delete_assay", { assayId });
}


/* ==========================================================================
   Trial Operations
   ========================================================================== */

/**
 * Persists (creates or updates) a trial record.
 * @param {string} assayId
 * @param {Object} trial
 * @returns {Promise<void>}
 */
export async function saveTrial(assayId, trial) {
  await invoke("save_trial", { assayId, trial });
}

/**
 * Marks a trial as completed.
 * @param {string} _assayId - Unused (kept for API compatibility).
 * @param {string} trialId
 * @returns {Promise<void>}
 */
export async function markTrialCompleted(_assayId, trialId) {
  await invokeOrLog("mark_trial_completed", { trialId });
}

/**
 * Marks a trial as abandoned.
 * @param {string} _assayId - Unused (kept for API compatibility).
 * @param {string} trialId
 * @param {string} [reason]
 * @returns {Promise<void>}
 */
export async function markTrialAbandoned(_assayId, trialId, reason = "App closed or reloaded") {
  await invokeOrLog("mark_trial_abandoned", { trialId, reason });
}


/* ==========================================================================
   Run Operations
   ========================================================================== */

/**
 * Persists (creates or updates) a run record.
 * @param {string} _assayId - Unused (kept for API compatibility).
 * @param {string} trialId
 * @param {Object} run
 * @returns {Promise<void>}
 */
export async function saveRun(_assayId, trialId, run) {
  await invokeOrLog("save_run", { trialId, run });
}


/* ==========================================================================
   Startup Cleanup
   ========================================================================== */

/**
 * Marks any trials left in "active" state as abandoned.
 * @returns {Promise<void>}
 */
export async function abandonAllActiveTrialsInDB() {
  await invokeOrLog("abandon_active_trials");
}

/**
 * Scans all runs for any left in "active" state and marks them stoppedEarly.
 * @returns {Promise<void>}
 */
export async function markOrphanRunsStopped() {
  await invokeOrLog("mark_orphan_runs_stopped");
}
