// src/database.rs
// SQLite persistence layer — replaces IndexedDB from the PWA.
//
// Schema strategy: JSON blob columns
//   Assay/trial/run objects are stored as JSON strings, with indexed scalar
//   columns for fields needed in queries (assay_id, trial_id, status).
//   This avoids a full relational schema and keeps the JS models unchanged —
//   objects serialize to JSON, Rust stores the blob, JS deserializes on read.
//
// WAL mode is set at startup in main.rs for crash-safety.
//
// All command functions mirror the IndexedDB API signatures from db.js so the
// frontend can call them identically via `invoke()`.

use crate::AppState;
use rusqlite::params;
use serde_json::Value;
use tauri::State;

// ═══════════════════════════════════════════════════════════════════════════
// Schema Initialisation
// ═══════════════════════════════════════════════════════════════════════════

/// Creates all tables and indexes on first launch. Safe to call on every
/// startup — `CREATE TABLE IF NOT EXISTS` is idempotent.
pub fn initialise_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS assays (
            assay_id  TEXT PRIMARY KEY,
            data      TEXT NOT NULL         -- full assay object as JSON
        );

        CREATE TABLE IF NOT EXISTS trials (
            trial_id  TEXT PRIMARY KEY,
            assay_id  TEXT NOT NULL,        -- indexed for parent lookup
            status    TEXT NOT NULL,        -- 'active' | 'completed' | 'abandoned'
            data      TEXT NOT NULL         -- full trial object as JSON (no runs array)
        );
        CREATE INDEX IF NOT EXISTS idx_trials_assay_id ON trials (assay_id);
        CREATE INDEX IF NOT EXISTS idx_trials_status   ON trials (status);

        CREATE TABLE IF NOT EXISTS runs (
            run_id    TEXT PRIMARY KEY,
            trial_id  TEXT NOT NULL,        -- indexed for parent lookup
            status    TEXT NOT NULL,        -- 'active' | 'completed' | 'stoppedEarly' | 'abandoned'
            data      TEXT NOT NULL         -- full run object as JSON
        );
        CREATE INDEX IF NOT EXISTS idx_runs_trial_id ON runs (trial_id);
        CREATE INDEX IF NOT EXISTS idx_runs_status   ON runs (status);
    ")
}


// ═══════════════════════════════════════════════════════════════════════════
// Assay Commands
// ═══════════════════════════════════════════════════════════════════════════

/// Persists (creates or updates) an assay record.
/// Mirrors: saveAssay(assay) in db.js
#[tauri::command]
pub fn save_assay(
    state: State<'_, AppState>,
    assay: Value,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let assay_id = assay["assayId"]
        .as_str()
        .ok_or("save_assay: missing assayId")?;
    let data = serde_json::to_string(&assay).map_err(|e| e.to_string())?;

    db.execute(
        "INSERT INTO assays (assay_id, data) VALUES (?1, ?2)
         ON CONFLICT(assay_id) DO UPDATE SET data = excluded.data",
        params![assay_id, data],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Fetches all assay records (shallow — no trials or runs).
/// Mirrors: loadAllAssays() in db.js
#[tauri::command]
pub fn load_all_assays(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let mut stmt = db
        .prepare("SELECT data FROM assays")
        .map_err(|e| e.to_string())?;

    let assays: Result<Vec<Value>, _> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|r| {
            r.map_err(|e| e.to_string())
                .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        })
        .collect();

    assays
}

/// Fully re-hydrates an assay: top-level record + all trials + each trial's runs.
/// Mirrors: hydrateAssay(assayId) in db.js
#[tauri::command]
pub fn hydrate_assay(
    state: State<'_, AppState>,
    assay_id: String,
) -> Result<Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Load assay
    let assay_data: String = db
        .query_row(
            "SELECT data FROM assays WHERE assay_id = ?1",
            params![assay_id],
            |row| row.get(0),
        )
        .map_err(|_| format!("Assay not found: {assay_id}"))?;

    let mut assay: Value = serde_json::from_str(&assay_data).map_err(|e| e.to_string())?;

    // Load trials for this assay
    let mut trial_stmt = db
        .prepare("SELECT data FROM trials WHERE assay_id = ?1 ORDER BY rowid")
        .map_err(|e| e.to_string())?;

    let trial_datas: Vec<String> = trial_stmt
        .query_map(params![assay_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e: rusqlite::Error| e.to_string())?;

    let mut trials: Vec<Value> = trial_datas
        .iter()
        .map(|s| serde_json::from_str(s).map_err(|e: serde_json::Error| e.to_string()))
        .collect::<Result<_, _>>()?;

    // Load runs for each trial
    let mut run_stmt = db
        .prepare("SELECT data FROM runs WHERE trial_id = ?1 ORDER BY rowid")
        .map_err(|e| e.to_string())?;

    for trial in trials.iter_mut() {
        let trial_id = trial["trialId"]
            .as_str()
            .ok_or("hydrate_assay: trial missing trialId")?
            .to_string();

        let run_datas: Vec<String> = run_stmt
            .query_map(params![trial_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e: rusqlite::Error| e.to_string())?;

        let runs: Vec<Value> = run_datas
            .iter()
            .map(|s| serde_json::from_str(s).map_err(|e: serde_json::Error| e.to_string()))
            .collect::<Result<_, _>>()?;

        trial["runs"] = Value::Array(runs);
    }

    assay["trials"] = Value::Array(trials);
    Ok(assay)
}

/// Permanently deletes an assay and all its associated trials and runs.
/// Mirrors: deleteAssay(assayId) in db.js
#[tauri::command]
pub fn delete_assay(
    state: State<'_, AppState>,
    assay_id: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Collect all trial IDs for this assay
    let mut trial_stmt = db
        .prepare("SELECT trial_id FROM trials WHERE assay_id = ?1")
        .map_err(|e| e.to_string())?;

    let trial_ids: Vec<String> = trial_stmt
        .query_map(params![assay_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e: rusqlite::Error| e.to_string())?;

    // Delete runs → trials → assay (children first for referential cleanliness)
    for trial_id in &trial_ids {
        db.execute("DELETE FROM runs WHERE trial_id = ?1", params![trial_id])
            .map_err(|e| e.to_string())?;
    }

    db.execute("DELETE FROM trials WHERE assay_id = ?1", params![assay_id])
        .map_err(|e| e.to_string())?;

    db.execute("DELETE FROM assays WHERE assay_id = ?1", params![assay_id])
        .map_err(|e| e.to_string())?;

    Ok(())
}


// ═══════════════════════════════════════════════════════════════════════════
// Trial Commands
// ═══════════════════════════════════════════════════════════════════════════

/// Persists (creates or updates) a trial record.
/// Mirrors: saveTrial(assayId, trial) in db.js
#[tauri::command]
pub fn save_trial(
    state: State<'_, AppState>,
    assay_id: String,
    trial: Value,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let trial_id = trial["trialId"]
        .as_str()
        .ok_or("save_trial: missing trialId")?;
    let status = trial["status"]
        .as_str()
        .unwrap_or("active");

    // Strip the in-memory `runs` array before persisting — runs live in their own table
    let mut trial_data = trial.clone();
    if let Some(obj) = trial_data.as_object_mut() {
        obj.remove("runs");
    }
    let data = serde_json::to_string(&trial_data).map_err(|e| e.to_string())?;

    db.execute(
        "INSERT INTO trials (trial_id, assay_id, status, data) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(trial_id) DO UPDATE SET assay_id = excluded.assay_id,
                                             status   = excluded.status,
                                             data     = excluded.data",
        params![trial_id, assay_id, status, data],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Marks a trial as completed.
/// Mirrors: markTrialCompleted(_assayId, trialId) in db.js
#[tauri::command]
pub fn mark_trial_completed(
    state: State<'_, AppState>,
    trial_id: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    update_trial_status(&db, &trial_id, "completed", None)
}

/// Marks a trial as abandoned with a reason.
/// Mirrors: markTrialAbandoned(_assayId, trialId, reason) in db.js
#[tauri::command]
pub fn mark_trial_abandoned(
    state: State<'_, AppState>,
    trial_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let reason_str = reason.unwrap_or_else(|| "App closed or reloaded".to_string());
    update_trial_status(&db, &trial_id, "abandoned", Some(&reason_str))
}

/// Internal helper: read-modify-write a trial's status atomically.
fn update_trial_status(
    db: &rusqlite::Connection,
    trial_id: &str,
    new_status: &str,
    abandoned_reason: Option<&str>,
) -> Result<(), String> {
    let data_str: String = db
        .query_row(
            "SELECT data FROM trials WHERE trial_id = ?1",
            params![trial_id],
            |row| row.get(0),
        )
        .map_err(|_| format!("Trial not found: {trial_id}"))?;

    let mut trial: Value = serde_json::from_str(&data_str).map_err(|e| e.to_string())?;

    trial["status"] = Value::String(new_status.to_string());
    trial["endedAt"] = Value::Number(
        chrono::Utc::now().timestamp_millis().into(),
    );
    if let Some(reason) = abandoned_reason {
        trial["abandonedReason"] = Value::String(reason.to_string());
    }

    let updated = serde_json::to_string(&trial).map_err(|e| e.to_string())?;

    db.execute(
        "UPDATE trials SET status = ?1, data = ?2 WHERE trial_id = ?3",
        params![new_status, updated, trial_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}


// ═══════════════════════════════════════════════════════════════════════════
// Run Commands
// ═══════════════════════════════════════════════════════════════════════════

/// Persists (creates or updates) a run record.
/// Mirrors: saveRun(_assayId, trialId, run) in db.js
#[tauri::command]
pub fn save_run(
    state: State<'_, AppState>,
    trial_id: String,
    run: Value,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let run_id = run["runId"]
        .as_str()
        .ok_or("save_run: missing runId")?;
    let status = run["status"].as_str().unwrap_or("active");
    let data = serde_json::to_string(&run).map_err(|e| e.to_string())?;

    db.execute(
        "INSERT INTO runs (run_id, trial_id, status, data) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(run_id) DO UPDATE SET trial_id = excluded.trial_id,
                                           status   = excluded.status,
                                           data     = excluded.data",
        params![run_id, trial_id, status, data],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}


// ═══════════════════════════════════════════════════════════════════════════
// Startup Cleanup Commands
// ═══════════════════════════════════════════════════════════════════════════

/// On app restart, marks any trials left in "active" state as abandoned.
/// Mirrors: abandonAllActiveTrialsInDB() in db.js
#[tauri::command]
pub fn abandon_active_trials(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Fetch all active trial IDs and their data
    let mut stmt = db
        .prepare("SELECT trial_id, data FROM trials WHERE status = 'active'")
        .map_err(|e| e.to_string())?;

    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e: rusqlite::Error| e.to_string())?;

    let now_ms = chrono::Utc::now().timestamp_millis();
    let abandon_reason = "App closed unexpectedly";

    for (trial_id, data_str) in rows {
        let mut trial: Value = serde_json::from_str(&data_str).map_err(|e| e.to_string())?;
        trial["status"] = Value::String("abandoned".to_string());
        trial["abandonedReason"] = Value::String(abandon_reason.to_string());
        trial["endedAt"] = Value::Number(now_ms.into());
        let updated = serde_json::to_string(&trial).map_err(|e| e.to_string())?;

        db.execute(
            "UPDATE trials SET status = 'abandoned', data = ?1 WHERE trial_id = ?2",
            params![updated, trial_id],
        )
        .map_err(|e| e.to_string())?;

        // Also abandon any active runs within this trial
        abandon_runs_for_trial_internal(&db, &trial_id, now_ms)?;
    }

    Ok(())
}

/// Scans ALL runs for any left in "active" state and marks them stoppedEarly.
/// Mirrors: markOrphanRunsStopped() in db.js
#[tauri::command]
pub fn mark_orphan_runs_stopped(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let mut stmt = db
        .prepare("SELECT run_id, data FROM runs WHERE status = 'active'")
        .map_err(|e| e.to_string())?;

    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e: rusqlite::Error| e.to_string())?;

    let now_ms = chrono::Utc::now().timestamp_millis();

    for (run_id, data_str) in rows {
        let mut run: Value = serde_json::from_str(&data_str).map_err(|e| e.to_string())?;
        run["status"] = Value::String("stoppedEarly".to_string());
        run["endedAt"] = Value::Number(now_ms.into());
        run["eligibleForAnalysis"] = Value::Bool(false);
        run["ineligibleReason"] = Value::String("App restarted unexpectedly".to_string());
        let updated = serde_json::to_string(&run).map_err(|e| e.to_string())?;

        db.execute(
            "UPDATE runs SET status = 'stoppedEarly', data = ?1 WHERE run_id = ?2",
            params![updated, run_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Internal helper used by abandon_active_trials to also abandon child runs.
fn abandon_runs_for_trial_internal(
    db: &rusqlite::Connection,
    trial_id: &str,
    now_ms: i64,
) -> Result<(), String> {
    let mut stmt = db
        .prepare("SELECT run_id, data FROM runs WHERE trial_id = ?1 AND status = 'active'")
        .map_err(|e| e.to_string())?;

    let rows: Vec<(String, String)> = stmt
        .query_map(params![trial_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e: rusqlite::Error| e.to_string())?;

    for (run_id, data_str) in rows {
        let mut run: Value = serde_json::from_str(&data_str).map_err(|e| e.to_string())?;
        run["status"] = Value::String("abandoned".to_string());
        run["endedAt"] = Value::Number(now_ms.into());
        run["eligibleForAnalysis"] = Value::Bool(false);
        run["ineligibleReason"] = Value::String("App closed unexpectedly".to_string());
        let updated = serde_json::to_string(&run).map_err(|e| e.to_string())?;

        db.execute(
            "UPDATE runs SET status = 'abandoned', data = ?1 WHERE run_id = ?2",
            params![updated, run_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}
