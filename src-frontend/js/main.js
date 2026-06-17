/**
 * @file main.js
 * @module MainController
 * @description Orchestrates the Touch Assay Timer application.
 *
 * Responsibilities:
 *   - Initialises all modules on DOMContentLoaded.
 *   - Owns the global application state machine (STATES / setState).
 *   - Drives the three-layer scheduling pipeline:
 *       Layer 1: Web Worker heartbeat → scheduler() → Web Audio hardware ticks
 *       Layer 2: UI display + optional speech, triggered at stimulus onset
 *       Layer 3: Data recording at stimulus close, batch-saved to IndexedDB
 *   - Manages run lifecycle: start → warmup → record → complete/stop.
 *   - Handles crash guards (visibilitychange, beforeunload).
 *   - Wires all DOM event listeners.
 *
 * Application State Machine:
 *
 *   SETUP ──submit──→ CONFIGURED ──tap──→ POISED ──tap──→ RUNNING
 *                         ↑                  ↑                 │
 *                         └──backToAssay─────┘←──stopRun/done──┘
 *                                            │
 *                                    finishTrial
 *                                            │
 *                                          EXPORT
 *
 * Scheduling pipeline (fires ~125×/sec via timer-worker.js):
 *
 *   Worker "tick" → scheduler() {
 *     Step 0: Gap check — auto-stop if timing gap > 2×ISI (backgrounding detected)
 *     Step 1: Speech/UI layer  — update counter, trigger voice cue at stimulus open
 *     Step 2: Data layer       — record 0/1 at stimulus close, batch-save to IDB
 *     Step 3: Audio layer      — pre-schedule hardware beep slightly in advance
 *   }
 */


import { validateInputs, generateAutoID, binRunValues } from "./utils.js";
import {
  createAssay, createTrial, createRun,
  getActiveTrial, completeRun
}                                                      from "./models.js";
import {
  saveAssay, loadAllAssays, hydrateAssay, deleteAssay,
  saveTrial, markTrialCompleted, markTrialAbandoned,
  saveRun, abandonAllActiveTrialsInDB, markOrphanRunsStopped, getIdbAvailable
}                                                      from "./db.js";
import {
  isAudioReady, setVoiceMode, loadVoices, speak, stopSpeech,
  warmUpAudio, playWarmupTone, scheduleWebAudioTick,
  triggerImmediateSpeech, getAudioTime, playCompletionTone,
  setTickPitch, getTickPitch, primeSpeechEngine, setBinSpeak,
  playTick
}                                                      from "./audio.js";
import {
  performExcelExport, performCSVExport, generatePreviewHTML
}                                                      from "./export.js";
import { showToast, dismissLatestToast }                from "./toast.js";


/* ==========================================================================
   Global Application State
   ========================================================================== */

/**
 * All valid application states.
 * The body class is set to `state-<value>` so CSS can show/hide sections.
 * @enum {string}
 */
const STATES = {
  SETUP:      "setup",
  CONFIGURED: "configured",
  POISED:     "poised",
  RUNNING:    "running",
  EXPORT:     "export"
};

/** @type {string} The current application state (one of STATES). */
let currentState = STATES.SETUP;

/** @type {Object|null} The currently active assay, fully hydrated from DB. */
let currentAssay = null;

/**
 * Double-tap confirmation guard.
 * The first tap sets pendingStart = true and shows a confirmation prompt.
 * The second tap within 2 seconds proceeds to start the run.
 * @type {boolean}
 */
let pendingStart = false;

/** @type {number|null} setTimeout handle for the pendingStart reset timer. */
let startTimeout = null;


/* ==========================================================================
   Timing & Scheduling State
   ========================================================================== */

/**
 * Tracks how many stimulus intervals have been closed (data recorded).
 * This is the authoritative "how many stimuli done" counter.
 * @type {number}
 */
let currentStimulusIndex = 0;

/**
 * Tracks how many stimulus windows have been opened for speech/UI updates.
 * Advances one step ahead of currentStimulusIndex.
 * @type {number}
 */
let nextSpeechIndex = 0;

/**
 * Tracks how many hardware audio ticks have been pre-scheduled.
 * Advances further ahead (by scheduleAheadTime) than speech/data.
 * @type {number}
 */
let nextAudioStimulusIndex = 0;

/**
 * Array of AudioContext timestamps for every tap recorded in the current run.
 * Consumed via tapReadIndex — no per-interval array reallocation needed.
 * @type {number[]}
 */
let tapTimestamps = [];

/**
 * Read pointer into tapTimestamps[].
 * All entries at indices < tapReadIndex have already been consumed by a
 * closed stimulus window and will not be checked again. This replaces
 * the previous `.some()` + `.filter()` pattern, avoiding closure and
 * array allocation on every ISI tick.
 * @type {number}
 */
let tapReadIndex = 0;

/**
 * Cached reference to the currently active run object.
 * Set once at the start of a run (startCueLoop) and cleared when the run ends.
 * Eliminates the `.find()` scan inside scheduler() which otherwise runs ~125×/sec.
 * @type {Object|null}
 */
let activeRun = null;

/**
 * Cached ISI (inter-stimulus interval) for the current run, in seconds.
 * Copied from currentAssay.isi at the start of each run so the hot path
 * in scheduler() never needs to dereference the assay object.
 * @type {number}
 */
let runISI = 0;

/**
 * Cached stimulus count for the current run.
 * Copied from currentAssay.stimCount at the start of each run.
 * @type {number}
 */
let runStimCount = 0;

/**
 * Cached bin size for the current run.
 * Copied from currentAssay.binSize at the start of each run and forwarded
 * to audio.js via setBinSpeak() so "bins" voice mode speaks on the correct
 * stimulus boundaries without dereferencing the assay object in the hot path.
 * @type {number}
 */
let runBinSize = 10;

/** @type {number} AudioContext time when the next speech/UI update should fire. */
let nextSpeechTime = 0.0;

/** @type {number} AudioContext time when the next data recording window closes. */
let nextDataIntervalTime = 0.0;

/** @type {number} AudioContext time when the next hardware tick should be scheduled. */
let nextAudioScheduleTime = 0.0;

/**
 * How far ahead (in seconds) the audio scheduler pre-books hardware ticks.
 * 200ms gives enough headroom for budget Android devices where main-thread
 * pauses of 100–150ms are common (background GC, compositing, etc.).
 * Still well below any ISI used in practice (≥ 500ms) so ticks won't
 * sound early.
 * @type {number}
 */
const SCHEDULE_AHEAD_TIME = 0.20;

/**
 * AudioContext timestamp of the last scheduler() invocation.
 * Used to detect timing gaps caused by backgrounding / throttling.
 * @type {number}
 */
let lastSchedulerTime = 0;

/**
 * How many milliseconds before the stimulus opens to fire the TTS command,
 * to compensate for browser speech-engine cold-path latency (typically 50–120 ms).
 * Loaded from localStorage so users can tune it per-device in Settings.
 * @type {number}
 */
// M6 fix: wrap top-level localStorage reads in try/catch — accessing localStorage
// before DOMContentLoaded in restricted/Private-Browsing contexts can throw SecurityError.
let speechLeadMs = 80;  // 80 ms default
try {
  const _stored = parseInt(localStorage.getItem("touchAssaySpeechLeadMs"), 10);
  // Clamp to [0, 490] ms: values ≥ 500 ms would push nextSpeechTime before
  // AudioContext t0, causing the first cue to fire immediately on start.
  if (!isNaN(_stored) && _stored >= 0) speechLeadMs = Math.min(_stored, 490);
} catch { /* Private browsing or sandboxed iframe — use default */ }

/**
 * How many stimuli were recorded at the time of the last IDB batch save.
 * Used to decide when to flush: save when (currentIndex - lastSave) >= BATCH_SIZE.
 * @type {number}
 */
let lastBatchSaveIndex = 0;

/**
 * Number of stimuli between periodic IDB saves during a run.
 * Reduces write frequency from every tick to every N stimuli (~90% fewer writes).
 * @type {number}
 */
const BATCH_SAVE_INTERVAL = 10;

/** @type {number|null} requestAnimationFrame handle for the visual metronome bar. */
let visualAnimationFrame = null;

/** @type {number|null} Timestamp (Date.now()) of the last processed tap. */
let lastTapTime = 0;

/**
 * Minimum milliseconds between accepted taps (hardware debounce).
 * Prevents a single physical press from registering as two taps on slow devices.
 * @type {number}
 */
const TAP_COOLDOWN_MS = 80;

// runStartTime removed — was set but never read; startup time is not needed by any consumer.


/* ==========================================================================
   Hardware & Settings State
   ========================================================================== */

/** @type {WakeLockSentinel|null} Active screen Wake Lock, or null if not held. */
let wakeLock = null;

/**
 * Tracks whether a Wake Lock is currently desired.
 * Using a separate boolean (instead of checking `wakeLock !== null`) ensures the
 * visibilitychange re-acquire logic works correctly even after releaseWakeLock()
 * synchronously nulls `wakeLock` before `.release()` resolves.
 * @type {boolean}
 */
let wantsWakeLock = false;

/**
 * Whether the countdown warmup is enabled before each run.
 * Persisted in localStorage so the setting survives page refreshes.
 * @type {boolean}
 */
// L1 fix: wrap in try/catch (same reason as speechLeadMs above).
let isWarmupEnabled = true;
try { isWarmupEnabled = localStorage.getItem("touchAssayWarmupEnabled") !== "false"; } catch { /* use default */ }

/**
 * Duration of the warmup countdown in seconds.
 * @type {number}
 */
let warmupDuration = 3;
try { warmupDuration = Math.min(60, Math.max(1, parseInt(localStorage.getItem("touchAssayWarmupDuration"), 10) || 3)); } catch { /* use default */ }

/**
 * True while the warmup countdown is actively ticking.
 * Prevents re-entry if the tap button is pressed twice during warmup.
 * @type {boolean}
 */
let isWarmingUp = false;

/**
 * The Web Worker instance that drives the scheduling heartbeat.
 * Isolated off the main thread so browser timer throttling doesn't affect timing.
 */
const timerWorker = new Worker(new URL("./timer-worker.js", import.meta.url), { type: "classic" });


/* ==========================================================================
   DOMContentLoaded — Main Entry Point
   ========================================================================== */

document.addEventListener("DOMContentLoaded", async () => {

  /* -----------------------------------------------------------------------
     DOM Element Cache (UI)
     Centralised here so element lookups happen once at init, not on every event.
  ----------------------------------------------------------------------- */
  const UI = {
    Inputs: {
      assayName:       document.getElementById("assayName"),
      genotypes:       document.getElementById("genotypes"),
      isi:             document.getElementById("ISI"),
      stimCount:       document.getElementById("stimCount"),
      binSize:         document.getElementById("binSize"),
      temperature:     document.getElementById("temperature"),
      humidity:        document.getElementById("humidity"),
      genotypeSelect:  document.getElementById("genotypeSelect"),
      selectAllAssays:  document.getElementById("selectAllAssays"),
      exportSelectAll:  document.getElementById("exportSelectAll"),
    },
    Screens: {
      setup:       document.getElementById("setupScreen"),
      assay:       document.getElementById("assayScreen"),
      export:      document.getElementById("exportScreen"),
      settings:    document.getElementById("settingsScreen"),
      guidelines:  document.getElementById("guidelinesScreen"),
      savedAssays: document.getElementById("savedAssaysScreen"),
    },
    Buttons: {
      tap:                  document.getElementById("tapButton"),
      stopRun:              document.getElementById("stopRun"),
      finishTrial:          document.getElementById("finishTrial"),
      backToAssay:          document.getElementById("backToAssay"),
      newAssay:             document.getElementById("newAssay"),
      progress:             document.getElementById("toggleProgress"),
      exportExcel:          document.getElementById("exportExcel"),
      exportCSV:            document.getElementById("exportCSV"),
      previewExcel:         document.getElementById("previewExcel"),
      exportFromPreview:    document.getElementById("exportFromPreview"),
      openSettings:         document.getElementById("openSettings"),
      closeSettings:        document.getElementById("closeSettings"),
      openGuidelines:       document.getElementById("openGuidelines"),
      closeGuidelines:      document.getElementById("closeGuidelines"),
      openSavedAssays:      document.getElementById("openSavedAssays"),
      closeSavedAssays:     document.getElementById("closeSavedAssays"),
      overflowMenu:         document.getElementById("overflowMenuButton"),

      deleteSelectedAssays: document.getElementById("deleteSelectedAssays"),
      headerHome:           document.getElementById("headerHomeBtn"),
    },
    Displays: {
      liveProgress:     document.getElementById("liveProgress"),
      currentStim:      document.getElementById("currentStimDisplay"),
      totalStim:        document.getElementById("totalStimDisplay"),
      warmup:           document.getElementById("warmupDisplay"),
      binWarning:       document.getElementById("binWarning"),
      savedAssaysList:  document.getElementById("savedAssaysList"),
      previewModal:     document.getElementById("previewModal"),
      previewContainer: document.getElementById("previewContainer"),
      closePreview:     document.getElementById("closePreview"),
      overflowMenu:     document.getElementById("overflowMenu"),
      // Cached once to avoid repeated getElementById calls inside the hot scheduler loop
      metronomeBar:     document.getElementById("visualMetronomeBar"),
    },
    Forms: {
      setup: document.getElementById("setupForm"),
    },
    Settings: {
      warmupToggle:             document.getElementById("warmupToggle"),
      warmupDurationInput:      document.getElementById("warmupDuration"),
      warmupDurationContainer:  document.getElementById("warmupDurationContainer"),
      tickPitch:                document.getElementById("tickPitch"),
      tickPitchDisplay:         document.getElementById("tickPitchDisplay"),
      speechLead:               document.getElementById("speechLead"),
      speechLeadDisplay:        document.getElementById("speechLeadDisplay"),
    }
  };


  /* -----------------------------------------------------------------------
     Initialisation Sequence
  ----------------------------------------------------------------------- */

  formatRequiredLabels();                    // Add * to required form fields
  UI.Inputs.assayName.value = generateAutoID(); // Pre-fill with timestamp-based ID
  restoreSetupDraft();                       // #1: Restore any unsaved form draft
  initializeSettings();                      // Restore saved preferences from localStorage
  setState(STATES.SETUP);                    // Render the initial state

  // Clean up orphan sessions from previous crashes, then check IDB availability.
  // Merged into one Promise.allSettled so the two cleanup functions are not called
  // twice (previously a fire-and-forget pair ran alongside this block, causing
  // parallel IDB transactions that could silently abort each other).
  Promise.allSettled([
    abandonAllActiveTrialsInDB(),
    markOrphanRunsStopped()
  ]).then(() => {
    if (!getIdbAvailable()) {
      const banner = document.getElementById("idbWarningBanner");
      if (banner) banner.removeAttribute("hidden");
      showToast(
        "Storage unavailable — data will not be saved. Check browser settings.",
        "error",
        0  // persistent
      );
    }
  });


  /* -----------------------------------------------------------------------
     State Machine
  ----------------------------------------------------------------------- */

  /**
   * Transitions the application to a new state.
   *
   * Sets body.className to "state-<nextState>" so CSS rules can show or hide
   * the correct sections without manual display toggling in JS.
   *
   * Each case also configures button availability for that state to prevent
   * invalid actions (e.g. tapping Stop when no run is active).
   *
   * @param {string} nextState - Target state constant from STATES.
   */
  function setState(nextState) {
    currentState           = nextState;
    document.body.className = `state-${currentState}`;

    switch (currentState) {
      case STATES.SETUP:
        UI.Buttons.tap.disabled            = true;
        UI.Buttons.stopRun.disabled        = true;
        UI.Buttons.finishTrial.disabled    = true;
        UI.Inputs.genotypeSelect.innerHTML = "";
        UI.Buttons.tap.textContent         = "Select Genotype to Start";
        break;

      case STATES.CONFIGURED:
        UI.Inputs.genotypeSelect.disabled = false;
        UI.Buttons.tap.disabled           = false;
        UI.Buttons.progress.disabled      = false;
        UI.Buttons.stopRun.disabled       = true;
        UI.Buttons.finishTrial.disabled   = true;
        UI.Buttons.tap.textContent        = "Select Genotype to Start";
        break;

      case STATES.POISED:
        UI.Inputs.genotypeSelect.disabled = false;
        UI.Buttons.tap.disabled           = false;
        UI.Buttons.finishTrial.disabled   = false;
        UI.Buttons.progress.disabled      = false;
        UI.Buttons.stopRun.disabled       = true;
        UI.Buttons.tap.textContent        = "Select Genotype to Start";
        break;

      case STATES.RUNNING:
        UI.Inputs.genotypeSelect.disabled = true;
        UI.Buttons.finishTrial.disabled   = true;
        UI.Buttons.progress.disabled      = true;
        UI.Buttons.tap.disabled           = false;
        UI.Buttons.stopRun.disabled       = false;
        // The "do not leave" beforeunload dialog is handled by the event listener
        // registered below — no additional setup is needed here.
        break;

      case STATES.EXPORT:
        // All controls remain as-is; export screen CSS handles visibility
        break;
    }
  }


  /* -----------------------------------------------------------------------
     Overlay Screen Management
  ----------------------------------------------------------------------- */

  /**
   * Shows an overlay screen (settings, guidelines, saved assays) while
   * adding the 'state-overlay' body class for CSS-driven dimming.
   *
   * @param {HTMLElement} screenElement - The section element to show.
   */
  function showScreen(screenElement) {
    UI.Displays.overflowMenu.hidden = true;
    document.body.classList.add("state-overlay");

    // Collapse all overlay screens first to avoid stacking
    UI.Screens.settings.hidden    = true;
    UI.Screens.guidelines.hidden  = true;
    UI.Screens.savedAssays.hidden = true;

    screenElement.hidden = false;
  }

  /**
   * Hides an overlay screen and removes the dimming class.
   *
   * @param {HTMLElement} screenElement - The section element to hide.
   */
  function hideScreenAndRestore(screenElement) {
    screenElement.hidden = true;
    document.body.classList.remove("state-overlay");
  }


  /* -----------------------------------------------------------------------
     Hardware Integration
  ----------------------------------------------------------------------- */

  /**
   * Requests a screen Wake Lock to prevent the device from sleeping during
   * an active run. Uses Tauri's native OS wake lock (IOKit on macOS,
   * SetThreadExecutionState on Windows) instead of the browser WakeLock API.
   */
  async function requestWakeLock() {
    wantsWakeLock = true;
    try {
      if (window.__TAURI__?.core?.invoke) {
        await window.__TAURI__.core.invoke("request_wake_lock");
      } else if ("wakeLock" in navigator) {
        // Fallback for dev-mode browser testing outside Tauri
        wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (err) {
      console.warn("Wake Lock request failed:", err);
    }
  }

  /**
   * Releases the active Wake Lock (called on run complete or stop).
   * Safe to call when no lock is held.
   */
  function releaseWakeLock() {
    wantsWakeLock = false;
    if (window.__TAURI__?.core?.invoke) {
      window.__TAURI__.core.invoke("release_wake_lock").catch(() => {});
    } else if (wakeLock) {
      // Fallback for dev-mode browser testing outside Tauri
      const lock = wakeLock;
      wakeLock = null;
      lock.release().catch(() => {});
    }
  }


  /* -----------------------------------------------------------------------
     Run Lifecycle — Start
  ----------------------------------------------------------------------- */

  /**
   * Creates a new run record within the current trial and starts the metronome.
   *
   * Flow:
   *   1. Creates a run object and appends it to the active trial in memory.
   *   2. Persists the initial run record to IDB.
   *   3. Requests Wake Lock and transitions to RUNNING state.
   *   4. Initialises scheduling timestamps and starts the Worker heartbeat.
   */
  async function startRun() {
    if (!currentAssay) return;

    const activeTrial = getActiveTrial(currentAssay);
    if (!activeTrial) return;

    const selectedGenotype = UI.Inputs.genotypeSelect.value;

    // H2 fix: guard against an empty genotype — createRun with genotype:"" would
    // silently persist an un-labelled run and corrupt exports.
    if (!selectedGenotype) {
      showToast("Please select a genotype before starting.", "info", 3000);
      return;
    }

    // Count only eligible runs for this genotype to determine the next animal index,
    // consistent with the tap-button and genotype-dropdown counters
    const animalIndex = activeTrial.runs.filter(
      run => run.genotype === selectedGenotype && run.status === "completed" && run.eligibleForAnalysis
    ).length + 1;

    const run = createRun({
      genotype:          selectedGenotype,
      animalIndex,
      expectedStimCount: currentAssay.stimCount
    });

    activeTrial.runs.push(run);
    await saveRun(currentAssay.assayId, activeTrial.trialId, run);

    // Transition UI
    setState(STATES.RUNNING);
    UI.Buttons.tap.textContent       = "Tap";
    UI.Displays.totalStim.textContent = currentAssay.stimCount;
    UI.Displays.currentStim.textContent = "1";

    requestWakeLock();
    startCueLoop();
  }

  /**
   * Seeds the scheduling timestamps using the AudioContext clock and starts
   * the Web Worker metronome heartbeat.
   *
   * The 0.5s offset gives the audio context time to warm up before the first
   * tick fires, preventing the first beep from being clipped or delayed.
   *
   * Also captures the active run reference and stable assay parameters into
   * module-level cache variables so scheduler() never dereferences currentAssay
   * or scans the runs array during its hot path.
   */
  function startCueLoop() {
    // Capture the active run reference once — scheduler() will use this directly
    const activeTrial = getActiveTrial(currentAssay);
    activeRun         = activeTrial?.runs.find(r => r.status === "active") ?? null;

    // Cache stable run parameters to avoid repeated property lookups in scheduler()
    runISI        = currentAssay.isi;
    runStimCount  = currentAssay.stimCount;
    runBinSize    = currentAssay.binSize || 10;

    // Forward bin size to audio module for "bins" voice mode
    setBinSpeak(runBinSize);

    // Reset all scheduling counters
    currentStimulusIndex    = 0;
    nextSpeechIndex         = 0;
    nextAudioStimulusIndex  = 0;
    tapTimestamps           = [];
    tapReadIndex            = 0;
    lastSchedulerTime       = 0;
    lastBatchSaveIndex      = 0;

    const t0 = getAudioTime();
    const startTime = t0 + 0.5;  // 500ms warm-up delay

    nextAudioScheduleTime  = startTime;
    // Fire the TTS command slightly before the stimulus opens to compensate
    // for browser speech-engine latency (speechLeadMs, default 80 ms).
    nextSpeechTime         = startTime - (speechLeadMs / 1000);
    nextDataIntervalTime   = startTime + runISI;  // First window closes after one ISI

    timerWorker.postMessage("start");

    // Cancel any stale animation frame before starting a fresh one
    // (guards against rapid stop→start sequences stacking rAF callbacks)
    if (visualAnimationFrame !== null) {
      cancelAnimationFrame(visualAnimationFrame);
    }
    visualAnimationFrame = requestAnimationFrame(renderVisualMetronome);
  }


  /* -----------------------------------------------------------------------
     Scheduling Pipeline (Core)
  ----------------------------------------------------------------------- */

  /**
   * The main scheduler function — called on every Worker "tick" (~125×/sec).
   *
   * Runs three sequential layers:
   *
   *   Step 0: TIMING INTEGRITY CHECK
   *     Detects if the gap since the last tick is suspiciously large
   *     (indicates backgrounding or browser throttling). If so, stops the
   *     run and marks it ineligible to prevent recording garbage data.
   *
   *   Step 1: SPEECH / UI SYNC
   *     Fires at the opening of each stimulus window.
   *     Updates the stimulus counter and triggers optional voice cues.
   *
   *   Step 2: DATA RECORDING
   *     Fires at the closing of each stimulus window.
   *     Checks whether a tap occurred during that interval and records 0 or 1.
   *     Batch-saves to IDB every BATCH_SAVE_INTERVAL stimuli.
   *     Triggers run completion when all stimuli are recorded.
   *
   *   Step 3: AUDIO PRE-SCHEDULING
   *     Schedules hardware beeps slightly ahead of time using the AudioContext
   *     clock to guarantee timing accuracy independent of JS thread load.
   */
  function scheduler() {
    // Use cached run reference — avoids a linear .find() scan (~125×/sec)
    const run = activeRun;

    // Safety: if there's no active run, halt the loop
    if (!run) {
      stopCueLoop();
      return;
    }

    const currentTime = getAudioTime();

    // ── Step 0: Timing gap detection ───────────────────────────────────────
    // Note: lastSchedulerTime is set *after* this check so that on the very
    // first tick (lastSchedulerTime === 0) the guard is intentionally skipped.
    // On a recovered return from background, the first tick post-resume will
    // correctly fire the gap guard and abort the run before any data is lost.
    if (lastSchedulerTime > 0) {
      const gap           = currentTime - lastSchedulerTime;
      const maxAllowedGap = Math.max(runISI * 2, 1.0);

      if (gap > maxAllowedGap) {
        console.error(
          `Timing gap: ${gap.toFixed(3)}s exceeds max ${maxAllowedGap.toFixed(3)}s — ` +
          `auto-stopping run (device was backgrounded or throttled)`
        );
        stopRunEarly("Timing interrupted — device was backgrounded or throttled");
        return;
      }
    }
    lastSchedulerTime = currentTime;

    // ── Step 1: Speech & UI sync (fires at stimulus open) ──────────────────
    // Optimisation: when the scheduler misses several ticks (e.g. a brief JS
    // pause), the while-loop would catch up by firing triggerImmediateSpeech()
    // for every missed beat. Each call does cancel() + speak(), so only the
    // last utterance survives — the intermediate ones are pure churn (~5-10ms
    // each). Instead, we advance through all missed beats, update the UI to
    // the latest, and fire speech exactly once for the most recent stimulus.
    {
      let speechFired = false;
      while (currentTime >= nextSpeechTime && nextSpeechIndex < runStimCount) {
        const displayIndex = nextSpeechIndex + 1;  // 1-based for display

        // Always update the counter — it must reflect the latest stimulus
        UI.Displays.currentStim.textContent = displayIndex;

        // Only fire speech on the last iteration of this catch-up loop.
        // Peek ahead: if the *next* beat is also due, skip speech for this one.
        const nextBeatAlsoDue = (currentTime >= nextSpeechTime + runISI)
                             && (nextSpeechIndex + 1 < runStimCount);
        if (!nextBeatAlsoDue) {
          triggerImmediateSpeech(displayIndex, runISI);
          speechFired = true;
        }

        nextSpeechTime += runISI;
        nextSpeechIndex++;
      }
      // If we skipped all speech calls (shouldn't happen, but defensive),
      // the counter is still up-to-date from the last iteration above.
      void speechFired;  // Suppress unused-variable linters
    }

    // ── Step 2: Data recording (fires at stimulus close) ───────────────────
    while (currentTime >= nextDataIntervalTime && currentStimulusIndex < runStimCount) {
      const intervalStart = nextDataIntervalTime - runISI;
      const intervalEnd   = nextDataIntervalTime;

      // Check if the experimenter tapped within this stimulus window.
      // Uses an index pointer (tapReadIndex) to scan only unconsumed entries,
      // avoiding the previous .some() + .filter() pattern that allocated a new
      // array and closures on every ISI tick.
      let tapOccurred = false;
      while (tapReadIndex < tapTimestamps.length) {
        const t = tapTimestamps[tapReadIndex];
        if (t >= intervalEnd) break;            // belongs to a future window
        if (t >= intervalStart) tapOccurred = true;  // inside this window
        tapReadIndex++;                         // consume (past or matched)
      }

      // Encoding:
      //   1 = animal responded (default — experimenter did NOT tap)
      //   0 = animal did not respond (experimenter tapped to record non-response)
      run.values.push(tapOccurred ? 0 : 1);

      // Reset visual "bucket fulfilled" indicators for the next interval
      UI.Buttons.tap.classList.remove("bucket-fulfilled");
      if (UI.Displays.metronomeBar) UI.Displays.metronomeBar.classList.remove("fulfilled");

      currentStimulusIndex++;
      nextDataIntervalTime += runISI;

      // Batch save: flush to IDB periodically to reduce transaction overhead.
      // Index updated *after* increment so the count reflects stimuli fully recorded.
      if (currentStimulusIndex - lastBatchSaveIndex >= BATCH_SAVE_INTERVAL) {
        // C3 fix: guard against trial being null — getActiveTrial() can return null
        // if the trial was completed or abandoned via another code path.
        const trial = getActiveTrial(currentAssay);
        if (trial) {
          saveRun(currentAssay.assayId, trial.trialId, run).catch(err =>
            console.error("Batch save failed:", err)
          );
          lastBatchSaveIndex = currentStimulusIndex;
        }
      }

      // Check if all stimuli for this run are recorded
      if (run.values.length === run.expectedStimCount) {
        // Capture the run reference BEFORE stopCueLoop() sets activeRun = null,
        // so completeRunNormally() receives it directly without a fragile .find() re-scan.
        const completedRun = run;
        stopCueLoop();
        completeRunNormally(completedRun);
        return;  // Exit scheduler immediately — run is over
      }
    }

    // ── Step 3: Audio pre-scheduling (fires slightly ahead of time) ────────
    while (
      nextAudioScheduleTime < currentTime + SCHEDULE_AHEAD_TIME &&
      nextAudioStimulusIndex < runStimCount
    ) {
      scheduleWebAudioTick(nextAudioStimulusIndex + 1, runISI, nextAudioScheduleTime);
      nextAudioScheduleTime += runISI;
      nextAudioStimulusIndex++;
    }
  }


  /* -----------------------------------------------------------------------
     Run Lifecycle — Stop / Complete
  ----------------------------------------------------------------------- */

  /**
   * Halts the Worker heartbeat and cancels the visual animation frame.
   * Also clears the cached activeRun reference so scheduler() cannot fire
   * against a stale run object if a tick arrives after stop.
   * Does not modify any data — call before any run-ending function.
   */
  function stopCueLoop() {
    timerWorker.postMessage("stop");
    activeRun = null;  // Defensive: prevent scheduler() processing stale run
    if (visualAnimationFrame !== null) {
      cancelAnimationFrame(visualAnimationFrame);
      visualAnimationFrame = null;
    }
    // Bug 21 fix: trim consumed tapTimestamps entries to prevent unbounded
    // array growth during long runs. Reset the read index to match.
    tapTimestamps.length = 0;
    tapReadIndex = 0;
  }

  /**
   * Called when a run completes naturally (all stimuli recorded).
   *
   * Marks the run as completed, evaluates eligibility for analysis,
   * saves the final state to IDB, plays the completion chime, and
   * returns the UI to POISED state so the next run can begin.
   */
  async function completeRunNormally(run) {
    const activeTrial = getActiveTrial(currentAssay);
    // run is passed directly from the scheduler — no .find() needed.
    // (activeRun is already null at this point because stopCueLoop() was called first.)
    if (!run) return;

    // BUG-7 fix: guard against null activeTrial. This can happen in an extreme
    // race where the trial was already completed via another path before the
    // scheduler fired completeRunNormally. Without this guard, line 830
    // (`saveRun(currentAssay.assayId, activeTrial.trialId, run)`) would throw
    // TypeError and the final IDB save would never happen.
    if (!activeTrial) {
      console.error("completeRunNormally: no active trial found — run data may not be saved to IDB.");
      playCompletionTone();
      updateProgressTable();
      refreshGenotypeDropdownCounts();
      releaseWakeLock();
      applyProgressVisibilityPreference();
      setState(STATES.POISED);
      showToast("Run complete — all stimulations recorded.", "success");
      return;
    }

    completeRun(run);

    // A run is eligible for analysis only if it recorded the full expected stimulus count
    run.eligibleForAnalysis = (run.values.length === run.expectedStimCount);

    if (!run.eligibleForAnalysis) {
      run.ineligibleReason = "Incomplete stimulus count";
    } else {
      // Pre-compute and cache binned percentages on the run object
      run.binnedPercentages = binRunValues(run.values, currentAssay.binSize);
    }

    // Warn if the stimulus count is not an exact multiple of binSize —
    // trailing values will be silently dropped during analysis
    const remainder = run.values.length % currentAssay.binSize;
    if (remainder !== 0) {
      // M4 fix: reworded to remove ambiguous double-negative ("do not fill")
      run.partialBinWarning =
        `Last ${remainder} value(s) dropped — not enough to fill a complete bin of size ${currentAssay.binSize}`;
    }

    // Final save: ensures all values are in IDB regardless of batch timing
    await saveRun(currentAssay.assayId, activeTrial.trialId, run);

    // Update last-modified timestamp so metadata exports reflect the latest activity
    currentAssay.lastModifiedAt = Date.now();
    saveAssay(currentAssay).catch(err => console.error("Failed to update assay metadata:", err));

    // Completion feedback
    playCompletionTone();
    try {
      if (navigator.vibrate) navigator.vibrate([100, 50, 200]);  // Ascending haptic pattern
    } catch (e) { /* Haptics not supported — silently ignore */ }

    // Update the UI and return to POISED state for the next run.
    // applyProgressVisibilityPreference() below sets both .hidden and the button
    // label correctly — no need to pre-set them here (that would override the pref).
    updateProgressTable();
    refreshGenotypeDropdownCounts();
    releaseWakeLock();
    // Respect the user's saved visibility preference for the progress table
    // (set via the "Hide/Show Progress" toggle in the assay screen).
    applyProgressVisibilityPreference();
    setState(STATES.POISED);
    showToast("Run complete — all stimulations recorded.", "success");
  }

  /**
   * Aborts an in-progress run and marks it as ineligible for analysis.
   * Called by: the Stop Run button, the timing gap detector, and crash guards.
   *
   * @param {string} [reason="Run stopped early by user"] - Explanation for the stop.
   */
  function stopRunEarly(reason = "Run stopped early by user") {
    isWarmingUp = false;
    // BUG-3 fix: if warmup hid the tap button, restore it now so the UI
    // doesn't get stuck in an invisible-button state after an external stop.
    if (UI.Buttons.tap.hidden) UI.Buttons.tap.hidden = false;
    if (!UI.Displays.warmup.hidden) UI.Displays.warmup.hidden = true;

    // Snapshot activeRun BEFORE stopCueLoop() nulls it. This prevents a double-stop
    // race where a final Worker tick arrives after stopCueLoop() clears activeRun,
    // causing a second call that would tag and re-save an already-tagged run.
    const snapshotRun = activeRun;
    stopCueLoop();
    stopSpeech();

    // Bug 5: guard against currentAssay being null (e.g. corrupted state or a
    // spurious call after resetToSetup). Without this, saveRun(currentAssay.assayId, ...)
    // below would throw TypeError: Cannot read properties of null.
    if (!currentAssay) return;

    const activeTrial = getActiveTrial(currentAssay);
    const run         = snapshotRun || activeTrial?.runs.find(r => r.status === "active");
    if (!run) return;

    // Tag the run with ineligibility information
    run.status               = "stoppedEarly";
    run.endedAt              = Date.now();
    run.eligibleForAnalysis  = false;
    run.ineligibleReason     = reason;

    // C4 fix: activeTrial can be null if the trial was already completed/abandoned
    // by another code path (e.g. crash recovery). Without this guard, .trialId
    // throws TypeError and the run's data is silently lost.
    if (!activeTrial) {
      console.error("stopRunEarly: no active trial — run may not be saved to IDB");
    } else {
      saveRun(currentAssay.assayId, activeTrial.trialId, run).catch(err =>
        console.error("Failed to save stopped run:", err)
      );
    }

    // Update last-modified timestamp so metadata exports reflect the latest activity
    currentAssay.lastModifiedAt = Date.now();
    saveAssay(currentAssay).catch(err => console.error("Failed to update assay metadata:", err));

    // Update UI and return to POISED state.
    // applyProgressVisibilityPreference() handles both .hidden and the label.
    updateProgressTable();
    refreshGenotypeDropdownCounts();
    releaseWakeLock();
    // Respect the user's saved visibility preference for the progress table.
    applyProgressVisibilityPreference();
    setState(STATES.POISED);
    showToast(
      reason === "Run stopped early by user"
        ? "Run stopped \u2014 marked ineligible for analysis."
        : `Run interrupted: ${reason}`,
      "warning",
      5000
    );
  }


  /* -----------------------------------------------------------------------
     Tap Action Handler
  ----------------------------------------------------------------------- */

  /**
   * Central handler for all tap/keypress inputs.
   *
   * Routes differently depending on current state:
   *   CONFIGURED / POISED: double-tap confirmation → start warmup → start run
   *   RUNNING:             record a tap timestamp for the current stimulus window
   *
   * Also handles:
   *   - Hardware debounce (TAP_COOLDOWN_MS)
   *   - Audio context warm-up on first interaction
   *   - Visual and haptic feedback on every tap
   */
  async function executeTapAction() {
    // Block taps on the export screen entirely
    if (currentState === STATES.EXPORT) return;

    // ── Hardware debounce ─────────────────────────────────────────────────
    const now = Date.now();
    if (now - lastTapTime < TAP_COOLDOWN_MS) return;
    lastTapTime = now;

    const isStartingNewRun = (currentState === STATES.CONFIGURED || currentState === STATES.POISED);

    // ── Pre-flight checks (only when starting a new run) ──────────────────
    if (isStartingNewRun) {
      const selectedGenotype = UI.Inputs.genotypeSelect.value;

      if (!selectedGenotype) {
        showToast("Please select a genotype before starting.", "info", 3000);
        return;
      }

      if (!pendingStart) {
        // First tap: show confirmation prompt and set a 2-second reset timer
        pendingStart = true;

        // C1 fix: activeTrial can be null if the trial was abandoned/completed by
        // another code path. Use optional chaining consistent with the timeout branch.
        const activeTrial = getActiveTrial(currentAssay);
        const nextIndex   = (activeTrial?.runs.filter(
          r => r.genotype === selectedGenotype && r.status === "completed" && r.eligibleForAnalysis
        ).length ?? 0) + 1;

        UI.Buttons.tap.textContent = `Tap again to start ${selectedGenotype} (Animal ${nextIndex})`;

        clearTimeout(startTimeout);
        startTimeout = setTimeout(() => {
          pendingStart = false;
          if (currentState === STATES.CONFIGURED || currentState === STATES.POISED) {
            // Bug 10 fix: re-read genotype from the DOM inside the timeout to avoid
            // using a stale closure-captured value if the user changed the dropdown.
            const freshGenotype = UI.Inputs.genotypeSelect.value;
            // Recompute freshly — do not use the closure-captured nextIndex which was
            // calculated at first-tap time and may be stale if a run completed in between.
            const activeTrial = getActiveTrial(currentAssay);
            const freshIndex = (activeTrial?.runs.filter(
              r => r.genotype === freshGenotype &&
                   r.status === "completed" &&
                   r.eligibleForAnalysis
            ).length ?? 0) + 1;
            UI.Buttons.tap.textContent = `Start ${freshGenotype} (Animal ${freshIndex})`;
          }
        }, 2000);

        return;  // Wait for the second tap
      }

      // Second tap: proceed to start
      pendingStart = false;
      clearTimeout(startTimeout);
    }

    // ── Audio warm-up (first interaction) ────────────────────────────────────
    if (!isAudioReady()) {
      // Bug 3: warmUpAudio() now re-throws on failure. Catch here so we can
      // show a user-facing error and abort instead of continuing with a
      // suspended AudioContext where getAudioTime() returns 0.
      try {
        await warmUpAudio();
      } catch {
        showToast(
          "Audio could not start — check your browser's autoplay/audio settings and try again.",
          "error",
          7000
        );
        return;
      }
      // Bug 7 (audio): speak("") with an empty string can break iOS speechSynthesis.
      // primeSpeechEngine() uses a silent space utterance (" ") for the same purpose
      // and is already used during warmup for exactly this reason.
      primeSpeechEngine();
    }

    // ── Visual & haptic feedback ──────────────────────────────────────────
    UI.Buttons.tap.classList.add("tapped");
    setTimeout(() => UI.Buttons.tap.classList.remove("tapped"), 100);

    try {
      if (navigator.vibrate) navigator.vibrate(50);
    } catch (err) {
      console.warn("Haptics not supported/allowed:", err);
    }

    // ── Route the action ──────────────────────────────────────────────────
    if (currentState === STATES.RUNNING) {
      // Record the tap's AudioContext timestamp for the data recording layer
      tapTimestamps.push(getAudioTime());

      // Visual indicator: "bucket fulfilled" shows the tap was registered
      UI.Buttons.tap.classList.add("bucket-fulfilled");
      // Use cached reference — avoids getElementById on every tap during a run
      if (UI.Displays.metronomeBar) UI.Displays.metronomeBar.classList.add("fulfilled");

    } else if (isStartingNewRun) {
      // Start the warmup countdown (which then calls startRun)
      await runWarmup();
    }
  }


  /* -----------------------------------------------------------------------
     Warmup Countdown
  ----------------------------------------------------------------------- */

  /**
   * Plays an optional countdown (warmupDuration seconds) before starting a run.
   * Shows a large number countdown in the UI and plays a beep each second.
   *
   * If warmup is disabled in Settings, calls startRun() immediately.
   * The isWarmingUp flag prevents re-entry if the user taps during the countdown.
   *
   * The countdown checks each iteration whether it should still be running,
   * so it can be cancelled cleanly if the state changes unexpectedly.
   */
  async function runWarmup() {
    if (isWarmingUp) return;

    if (!isWarmupEnabled) {
      primeSpeechEngine();  // Warm the TTS engine even when skipping the countdown
      // Bug 2: wrap startRun() so IDB/audio failures are surfaced rather than swallowed.
      try {
        await startRun();
      } catch (err) {
        console.error("Failed to start run:", err);
        showToast("Failed to start run — storage error. Please try again.", "error");
      }
      return;
    }

    isWarmingUp                    = true;
    UI.Displays.warmup.hidden      = false;
    UI.Buttons.tap.hidden          = true;

    // Prime the TTS engine with a silent utterance so the synthesis pipeline
    // is warm before the first real voiced cue fires during the run.
    primeSpeechEngine();

    for (let i = warmupDuration; i > 0; i--) {
      // Cancel if the state has changed externally (e.g. stop was clicked)
      if (!isWarmingUp || (currentState !== STATES.CONFIGURED && currentState !== STATES.POISED)) {
        isWarmingUp               = false;
        UI.Displays.warmup.hidden = true;
        UI.Buttons.tap.hidden     = false;
        // Restore the tap button label so it doesn't show the stale "Tap again…" text.
        const sel = UI.Inputs.genotypeSelect.value;
        if (sel && (currentState === STATES.CONFIGURED || currentState === STATES.POISED)) {
          const at = getActiveTrial(currentAssay);
          const n  = (at?.runs.filter(r => r.genotype === sel && r.status === "completed" && r.eligibleForAnalysis).length ?? 0) + 1;
          UI.Buttons.tap.textContent = `Start ${sel} (Animal ${n})`;
        }
        return;
      }

      UI.Displays.warmup.textContent = i;
      playWarmupTone(1200);  // High beep each countdown second

      await new Promise(r => setTimeout(r, 1000));

      // #7: Re-check after the await — warmup may have been cancelled while suspended
      if (!isWarmingUp) {
        UI.Displays.warmup.hidden = true;
        UI.Buttons.tap.hidden     = false;
        // Restore the tap button label after a mid-countdown cancel.
        const sel = UI.Inputs.genotypeSelect.value;
        if (sel) {
          const at = getActiveTrial(currentAssay);
          const n  = (at?.runs.filter(r => r.genotype === sel && r.status === "completed" && r.eligibleForAnalysis).length ?? 0) + 1;
          UI.Buttons.tap.textContent = `Start ${sel} (Animal ${n})`;
        }
        return;
      }
    }

    isWarmingUp               = false;
    UI.Displays.warmup.hidden = true;
    UI.Buttons.tap.hidden     = false;

    // Bug 2: wrap startRun() so IDB/audio failures are surfaced rather than swallowed.
    try {
      await startRun();
    } catch (err) {
      console.error("Failed to start run:", err);
      showToast("Failed to start run — storage error. Please try again.", "error");
    }
  }


  /* -----------------------------------------------------------------------
     Visual Metronome Renderer
  ----------------------------------------------------------------------- */

  /**
   * Draws the visual progress bar that sweeps left-to-right across each
   * stimulus interval, synced to the AudioContext clock.
   *
   * Uses requestAnimationFrame to run at display refresh rate.
   * The bar position is calculated purely from the AudioContext time,
   * so it stays perfectly in sync with audio regardless of frame rate.
   */
  function renderVisualMetronome() {
    if (currentState !== STATES.RUNNING || !currentAssay) {
      // Clear the stale handle so stopCueLoop()'s cancelAnimationFrame guard stays
      // consistent — otherwise a handle created by a re-queued rAF after stopCueLoop
      // would never be stored and could run indefinitely.
      visualAnimationFrame = null;
      return;
    }

    // Snapshot nextDataIntervalTime once to avoid a race with scheduler(), which can
    // increment it between consecutive rAF callbacks and cause the bar to flash to 100%
    // or reset to 0% mid-interval before the next frame corrects it.
    const intervalEnd   = nextDataIntervalTime;
    const currentTime   = getAudioTime();
    const intervalStart = intervalEnd - runISI;  // Use cached ISI

    // Progress: 0.0 at interval start → 1.0 at interval end
    let progress = (currentTime - intervalStart) / runISI;  // Use cached ISI
    progress     = Math.max(0, Math.min(1, progress));  // Clamp to [0, 1]

    // Use cached DOM reference from UI — avoids getElementById on every frame
    if (UI.Displays.metronomeBar) UI.Displays.metronomeBar.style.width = `${progress * 100}%`;

    // Schedule the next frame
    visualAnimationFrame = requestAnimationFrame(renderVisualMetronome);
  }


  /* -----------------------------------------------------------------------
     UI Renderers & Data Helpers
  ----------------------------------------------------------------------- */

  /**
   * Adds a red asterisk (*) next to the label of every required form field.
   * Runs once at startup so CSS doesn't need to carry this concern.
   */
  function formatRequiredLabels() {
    document.querySelectorAll("input[required], select[required]").forEach(input => {
      const label = input.id
        ? document.querySelector(`label[for="${input.id}"]`)
        : input.closest("label");

      if (!label || label.querySelector(".required-asterisk")) return;

      const textNode = Array.from(label.childNodes).find(
        node => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== ""
      );

      if (textNode) {
        const wrapper = document.createElement("span");
        wrapper.innerHTML = `${textNode.nodeValue.trim()} <span class="required-asterisk">*</span>`;
        label.replaceChild(wrapper, textNode);
      }
    });
  }

  /**
   * Restores user preferences from localStorage and applies them to the UI.
   * Called once during initialisation.
   */
  function initializeSettings() {
    // Warmup settings
    UI.Settings.warmupToggle.checked              = isWarmupEnabled;
    UI.Settings.warmupDurationInput.value         = warmupDuration;
    UI.Settings.warmupDurationContainer.style.display = isWarmupEnabled ? "flex" : "none";

    // Theme
    // Mirror the inline script's OS-preference fallback: if no theme has ever been saved,
    // use prefers-color-scheme rather than hardcoding "light". Without this,
    // initializeSettings() would overwrite the dark theme the inline script just applied
    // (via the same OS-preference check) back to "light" on first load.
    const savedTheme = localStorage.getItem("touchAssayTheme") ||
      (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", savedTheme);
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) metaThemeColor.setAttribute('content', savedTheme === 'dark' ? '#0f172a' : '#f1f5f9');
    document.querySelectorAll('input[name="themeMode"]').forEach(input => {
      if (input.value === savedTheme) input.checked = true;
    });

    // Voice mode
    const savedVoiceMode = localStorage.getItem("touchAssayVoiceMode") || "tick";
    setVoiceMode(savedVoiceMode);
    document.querySelectorAll('input[name="voiceMode"]').forEach(input => {
      if (input.value === savedVoiceMode) input.checked = true;
    });

    // #15: Tick pitch
    const savedPitch = parseInt(localStorage.getItem("touchAssayTickPitch"), 10);
    const initPitch  = isNaN(savedPitch) ? 900 : savedPitch;
    setTickPitch(initPitch);
    if (UI.Settings.tickPitch) {
      UI.Settings.tickPitch.value = initPitch;
      if (UI.Settings.tickPitchDisplay)
        UI.Settings.tickPitchDisplay.textContent = initPitch + " Hz";
    }

    // Speech lead time (ms) — compensates for TTS engine latency
    if (UI.Settings.speechLead) {
      UI.Settings.speechLead.value = speechLeadMs;
      if (UI.Settings.speechLeadDisplay)
        UI.Settings.speechLeadDisplay.textContent = speechLeadMs + " ms";
    }

    // #21: Restore progress-table visibility preference
    const progressPref = localStorage.getItem("touchAssayProgressVisible");
    // We don't apply it here at startup because there's no data yet;
    // it gets applied in completeRunNormally() / stopRunEarly() when
    // the table is first shown (or kept hidden) according to preference.
  }

  /**
   * Applies the user's saved progress-table visibility preference.
   * Called after each run ends so the table respects the user's toggle setting.
   */
  function applyProgressVisibilityPreference() {
    const pref      = localStorage.getItem("touchAssayProgressVisible");
    const container = document.getElementById("assayProgress");
    if (!container) return;
    // Default: show the table ("true" or no stored pref = visible)
    const shouldShow = pref !== "false";
    container.hidden               = !shouldShow;
    UI.Buttons.progress.textContent = shouldShow ? "Hide Progress" : "Show Progress";
  }

  /**
   * Calculates and displays a warning when the stimulus count is not an
   * exact multiple of the bin size (some trailing stimuli will be dropped).
   * Called whenever either input field changes.
   */
  function updateBinWarning() {
    const stimCount = Number(UI.Inputs.stimCount.value);
    const binSize   = Number(UI.Inputs.binSize.value);

    if (!stimCount || !binSize || stimCount % binSize === 0) {
      UI.Displays.binWarning.hidden = true;
      return;
    }

    const usable = stimCount - (stimCount % binSize);
    UI.Displays.binWarning.textContent =
      `Total stimulations (${stimCount}) are not an exact multiple of bin size (${binSize}). ` +
      `Binned analysis will include the first ${usable} stimulations.`;
    UI.Displays.binWarning.hidden = false;
  }

  /**
   * Rebuilds the genotype selection dropdown with current run counts.
   * The count shows how many runs have been completed (non-active) for each genotype
   * in the current trial, giving the experimenter live feedback.
   *
   * Restores the previously selected value after rebuilding.
   *
   * @param {string[]} genotypes - Ordered list of genotype labels.
   */
  function populateGenotypeSelect(genotypes) {
    const trial          = currentAssay ? getActiveTrial(currentAssay) : null;
    const previousValue  = UI.Inputs.genotypeSelect.value;

    UI.Inputs.genotypeSelect.innerHTML =
      `<option value="" disabled selected>Select Genotype</option>`;

    genotypes.forEach(g => {
      const option  = document.createElement("option");
      option.value  = g;

      // Count only eligible (completed + eligible for analysis) runs for this genotype
      const count   = trial
        ? trial.runs.filter(r => r.genotype === g && r.status === "completed" && r.eligibleForAnalysis).length
        : 0;

      option.textContent = count > 0 ? `${g} (${count} eligible)` : g;
      UI.Inputs.genotypeSelect.appendChild(option);
    });

    // Restore the selection if the previously selected genotype still exists
    const options = Array.from(UI.Inputs.genotypeSelect.options);
    if (previousValue && options.some(o => o.value === previousValue)) {
      UI.Inputs.genotypeSelect.value = previousValue;
    }
  }

  /**
   * Re-populates the genotype dropdown to reflect updated run counts
   * without changing the current selection. Called after each run ends.
   */
  function refreshGenotypeDropdownCounts() {
    if (!currentAssay) return;
    populateGenotypeSelect(currentAssay.genotypes);
  }

  /**
   * Rebuilds the in-assay progress summary table showing total, eligible,
   * and ineligible run counts per genotype for the current trial.
   */
  function updateProgressTable() {
    const container = document.getElementById("assayProgress");
    if (!container) return;  // Bug 8: guard against missing element
    container.innerHTML = "";

    if (!currentAssay || !getActiveTrial(currentAssay)) return;

    const trial   = getActiveTrial(currentAssay);
    const summary = {};

    // Initialise counters for every declared genotype
    currentAssay.genotypes.forEach(g => {
      summary[g] = { total: 0, eligible: 0, ineligible: 0 };
    });

    // Tally runs into the appropriate bucket (skip active/in-progress runs)
    trial.runs.forEach(r => {
      if (!summary[r.genotype]) return;
      if (r.status === "active") return;  // Don't count in-progress runs
      summary[r.genotype].total++;
      if (r.status === "completed" && r.eligibleForAnalysis) {
        summary[r.genotype].eligible++;
      } else {
        summary[r.genotype].ineligible++;
      }
    });

    let html = `<table><thead><tr>` +
               `<th>Genotype</th><th>Total Runs</th><th>Eligible</th><th>Ineligible</th>` +
               `</tr></thead><tbody>`;

    currentAssay.genotypes.forEach(g => {
      html += `<tr>` +
              `<td>${g}</td>` +
              `<td>${summary[g].total}</td>` +
              `<td>${summary[g].eligible}</td>` +
              `<td>${summary[g].ineligible}</td>` +
              `</tr>`;
    });

    html += `</tbody></table>`;
    container.innerHTML = html;
  }

  /**
   * Populates the export dataset list with checkboxes for each trial and
   * the two pooled (completed-only vs all-trials) options.
   * Completed trials are pre-checked; abandoned/active are unchecked.
   * Shows a per-genotype run breakdown alongside the totals (#7).
   * Syncs the Select All checkbox and refreshes button state after building (#8, #9).
   *
   * @param {Object} assay - The full assay object.
   */
  function populateExportDatasetList(assay) {
    const container = document.getElementById("exportDatasetList");
    container.innerHTML = "";

    if (!assay || !assay.trials) return;

    // Bug 9: accumulate into a string and assign once — avoids O(n²) DOM
    // re-parsing that happens when innerHTML += is called inside a loop
    // (each append reads the entire current DOM, re-serialises it, and
    // re-parses the concatenated result).
    let html = "";

    assay.trials.forEach(trial => {
      const isCompleted = trial.status === "completed";
      const isAbandoned = trial.status === "abandoned";
      const total       = trial.runs.length;
      const eligible    = trial.runs.filter(r => r.eligibleForAnalysis).length;

      // #7: per-genotype run count breakdown
      const genotypeSummary = assay.genotypes
        .map(g => {
          const n = trial.runs.filter(r => r.genotype === g).length;
          return n > 0 ? `${escapeHTML(g)}: ${n}` : null;
        })
        .filter(Boolean)
        .join(", ");

      html +=
        `<label>` +
        `<input type="checkbox" data-dataset-type="trial" data-trial-id="${trial.trialId}"` +
        ` aria-label="Trial ${Number(trial.trialIndex)}, ${eligible} eligible of ${total} total${isAbandoned ? ', abandoned' : ''}"` +
        ` ${isCompleted ? "checked" : ""}>` +
        ` Trial ${Number(trial.trialIndex)}` +
        ` — ${eligible} eligible (${total} total)` +
        (genotypeSummary ? ` &middot; ${genotypeSummary}` : "") +
        (isAbandoned ? " <em>(abandoned)</em>" : "") +
        `</label>`;
    });

    html +=
      `<label><input type="checkbox" data-dataset-type="pooled" ` +
      `data-include-abandoned="false" checked> Pooled (completed trials only)</label>`;

    html +=
      `<label><input type="checkbox" data-dataset-type="pooled" ` +
      `data-include-abandoned="true"> Pooled (include abandoned)</label>`;

    // Single assignment — all trial rows are parsed in one pass
    container.innerHTML = html;

    // Sync select-all state and button enabled state after rebuilding the list
    syncExportSelectAll();
    refreshExportButtonState();
  }

  /**
   * Enables or disables the Export and Preview buttons based on whether at
   * least one dataset checkbox is currently checked (#8).
   */
  function refreshExportButtonState() {
    const anyChecked =
      document.querySelectorAll("#exportDatasetList input[type='checkbox']:checked").length > 0;
    UI.Buttons.exportExcel.disabled  = !anyChecked;
    UI.Buttons.previewExcel.disabled = !anyChecked;
    if (UI.Buttons.exportCSV) UI.Buttons.exportCSV.disabled = !anyChecked;
  }

  /**
   * Updates the "Select all datasets" master checkbox to reflect the current
   * checked / indeterminate state of all dataset checkboxes (#9).
   */
  function syncExportSelectAll() {
    const all      = document.querySelectorAll("#exportDatasetList input[type='checkbox']");
    const checked  = Array.from(all).filter(cb => cb.checked);
    const selAll   = UI.Inputs.exportSelectAll;
    if (!selAll) return;
    selAll.checked       = checked.length === all.length && all.length > 0;
    selAll.indeterminate = checked.length > 0 && checked.length < all.length;
  }

  /**
   * Escapes HTML special characters to prevent XSS when rendering
   * user-supplied strings (e.g. assay names) into innerHTML.
   *
   * @param {string} str - Raw user input string.
   * @returns {string} Safely escaped HTML string.
   */
  function escapeHTML(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g,  "&lt;")
      .replace(/>/g,  "&gt;")
      .replace(/"/g,  "&quot;")
      .replace(/'/g,  "&#39;");
  }

  /**
   * Builds and renders the trial summary card on the export screen.
   * Shows eligible run counts and mean overall response rate per genotype
   * for the most recently completed trial.
   *
   * @param {Object} assay - The fully hydrated assay (after hydrateAssay()).
   */
  function renderTrialSummaryCard(assay) {
    // Trial summary removed — keep card permanently hidden.
    const card = document.getElementById("trialSummaryCard");
    if (card) card.hidden = true;
  }

  /**
   * Fetches all saved assays from IndexedDB and renders them as a list
   * in the Saved Assays overlay. Each entry shows the assay name, date,
   * and action buttons (Start New Trial, Export, Delete).
   */
  async function populateSavedAssaysList() {
    const assays = await loadAllAssays();
    UI.Displays.savedAssaysList.innerHTML = "";

    if (assays.length === 0) {
      // #31: Styled empty state with icon instead of plain text
      UI.Displays.savedAssaysList.innerHTML = `
        <div class="saved-assays-empty">
          <svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
          </svg>
          <p><strong>No saved assays yet</strong>Complete an assay setup to get started. Your experiments will appear here.</p>
        </div>`;
      return;
    }

    // Sort newest first
    let html = "";
    assays.sort((a, b) => b.createdAt - a.createdAt).forEach(assay => {
      const genotypesStr = assay.genotypes && assay.genotypes.length ? ` (${assay.genotypes.map(escapeHTML).join(", ")})` : "";
      html += `
        <div class="saved-assay-row">
          <div class="assay-row-header">
            <input type="checkbox" class="assay-select-checkbox" data-assay-id="${assay.assayId}">
            <div class="assay-info">
              ${escapeHTML(assay.assayName) || "Untitled"}${genotypesStr} — ${assay.createdAt ? new Date(assay.createdAt).toLocaleString() : "Unknown date"}
            </div>
          </div>
          <div class="assay-actions">
            <button class="secondary" data-action="start"  data-assay-id="${assay.assayId}">Start New Trial</button>
            <button class="secondary" data-action="export" data-assay-id="${assay.assayId}">Export</button>
            <button class="danger"    data-action="delete" data-assay-id="${assay.assayId}"
              data-assay-name="${escapeHTML(assay.assayName)}">Delete</button>
          </div>
        </div>
      `;
    });

    UI.Displays.savedAssaysList.innerHTML = html;
    UI.Buttons.deleteSelectedAssays.disabled = true;
    UI.Inputs.selectAllAssays.checked        = false;
  }

  /**
   * Reads the export dataset checkboxes and returns the selected configurations.
   *
   * @returns {Array<{ type: string, trialId?: string, includeAbandoned?: boolean }>}
   */
  function getExportConfigs() {
    const checked = Array.from(
      document.querySelectorAll("#exportDatasetList input[type='checkbox']:checked")
    );
    return checked.map(input => ({
      type:             input.dataset.datasetType,
      trialId:          input.dataset.trialId,
      includeAbandoned: input.dataset.includeAbandoned === "true"
    }));
  }


  /* -----------------------------------------------------------------------
     Crash Guards (Visibility & Unload)
  ----------------------------------------------------------------------- */

  /**
   * Fires when the app is sent to the background (visibilityState = "hidden").
   * Emergency-flushes the current run data to IDB before the browser suspends us.
   *
   * The scheduler's timing gap check will stop the run when the app resumes
   * (because the gap will exceed 2×ISI), so we only need to save here, not stop.
   *
   * Also re-requests the Wake Lock when the app returns to the foreground,
   * because Wake Locks are released automatically when the page is hidden.
   */
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "hidden" && currentState === STATES.RUNNING && currentAssay) {
      // Emergency flush: persist whatever is recorded so far before the browser suspends us.
      // Do NOT call stopRunEarly() here — the scheduler's gap check (Step 0) will stop the
      // run cleanly when the app resumes once the gap exceeds 2×ISI. Calling stopRunEarly()
      // here AND letting the gap check fire on resume creates a double-stop race where two
      // concurrent IDB writes target the same run record.
      const activeTrial = getActiveTrial(currentAssay);
      const run = activeRun || activeTrial?.runs.find(r => r.status === "active");
      if (run && activeTrial) {
        saveRun(currentAssay.assayId, activeTrial.trialId, run).catch(() => {});
      }
    }

    // Wake Locks are released when hidden; re-acquire when visible, but only
    // if a run is still active — there is no point holding the lock otherwise.
    // Bug 4: also check activeRun !== null. On slow devices the timing-gap auto-stop
    // in scheduler() fires on the first tick after resume, which means currentState
    // is still RUNNING when this handler fires. Without the activeRun guard, we
    // re-acquire a lock that will be released again moments later.
    if (wantsWakeLock && document.visibilityState === "visible" && currentState === STATES.RUNNING && activeRun !== null) {
      await requestWakeLock();
    }
  });

  /**
   * Fires synchronously when the user closes or refreshes the tab.
   * Marks the active run as stoppedEarly and attempts a final IDB save.
   *
   * Note: beforeunload handlers are best-effort on mobile — the save may
   * not complete before the page is torn down. The abandonAllActiveTrialsInDB()
   * cleanup on next launch catches any that slip through.
   */
  window.addEventListener("beforeunload", e => {
    if (currentState !== STATES.RUNNING || !currentAssay) return;

    // #5: Show the browser's native "Leave site?" dialog when a run is active.
    // Setting returnValue triggers the confirmation on all modern browsers.
    e.preventDefault();
    e.returnValue = "";  // Required for Chrome/Edge (legacy spec)

    // BUG-1 fix: snapshot the current run values to sessionStorage synchronously
    // before the page is torn down. On mobile browsers (iOS Safari, Chrome Android)
    // the async IDB write inside stopRunEarly() is not guaranteed to commit before
    // the page is unloaded. sessionStorage writes are synchronous and survive a
    // same-origin reload, giving abandonAllActiveTrialsInDB() on next launch a
    // fallback to tag the run as stopped even if the IDB write was dropped.
    try {
      const activeTrial = getActiveTrial(currentAssay);
      const runToSave   = activeRun || activeTrial?.runs.find(r => r.status === "active");
      if (runToSave && activeTrial) {
        sessionStorage.setItem("touchAssayCrashGuard", JSON.stringify({
          assayId:  currentAssay.assayId,
          trialId:  activeTrial.trialId,
          runId:    runToSave.runId,
          values:   runToSave.values,
          savedAt:  Date.now()
        }));
      }
    } catch { /* sessionStorage may be unavailable in some private-browse modes */ }

    // Bug 11 fix: beforeunload should NOT call stopRunEarly() because the user
    // may click "Stay" on the Leave dialog. stopRunEarly() has irreversible side
    // effects (marks the run stoppedEarly, stops the Worker), so it should only
    // fire on actual page unload. The `unload` event below handles this.
    // NOTE: `unload` is unreliable in modern browsers (especially mobile), but
    // the sessionStorage crash-guard snapshot above provides a safety net.
  });

  // Bug 11 fix: move stopRunEarly() to the `unload` event so it only fires
  // when the user actually leaves, not when they click "Stay" on the dialog.
  window.addEventListener("unload", () => {
    if (currentState !== STATES.RUNNING || !currentAssay) return;
    stopRunEarly("App closing \u2014 run stopped for data safety");
  });


  /* -----------------------------------------------------------------------
     Web Worker Communication
  ----------------------------------------------------------------------- */

  /**
   * Receives heartbeat ticks from the timer-worker.
   * Only calls scheduler() when the app is actively in RUNNING state
   * to prevent spurious processing during other states.
   */
  timerWorker.onmessage = function (e) {
    // Also guard on activeRun: stopCueLoop() nulls activeRun synchronously, but
    // a tick message already queued in the event loop can still arrive before
    // completeRunNormally() calls setState(POISED). Checking activeRun here means
    // those late ticks exit immediately without re-entering scheduler().
    if (e.data === "tick" && currentState === STATES.RUNNING && currentAssay && activeRun) {
      scheduler();
    }
  };


  /* -----------------------------------------------------------------------
     Navigation Helpers (shared between newAssay and headerHome)
  ----------------------------------------------------------------------- */

  /**
   * Zeroes all scheduling and timing counters so a fresh run cannot be
   * corrupted by values left over from a previous session.
   *
   * Also resets the warmup guard — navigating away mid-countdown would
   * otherwise leave `isWarmingUp = true`, blocking the next run from starting.
   */
  function resetTimingState() {
    isWarmingUp            = false;
    currentStimulusIndex   = 0;
    // Bug 4: also reset the two speech/audio index counters so a fresh session after
    // resetToSetup() cannot inherit stale values from a previous run.
    nextSpeechIndex        = 0;
    nextAudioStimulusIndex = 0;
    tapTimestamps          = [];
    tapReadIndex           = 0;
    lastSchedulerTime      = 0;
    lastBatchSaveIndex     = 0;
    nextAudioScheduleTime  = 0.0;
    nextSpeechTime         = 0.0;
    nextDataIntervalTime   = 0.0;
  }

  /**
   * Tears down the active assay and returns the app to the Setup screen.
   *
   * Resets the form, clears the progress table, and zeroes all
   * timing/scheduling counters. Called by both the "New Assay" button
   * and the header logo/home button.
   */
  function resetToSetup() {
    currentAssay = null;
    UI.Forms.setup.reset();
    UI.Inputs.assayName.value     = generateAutoID();
    UI.Displays.binWarning.hidden = true;

    // Bug 4: form.reset() clears the hidden #genotypes input value but does NOT
    // clear the chip DOM elements — chips from the previous assay would remain
    // visually, while the hidden input is empty, causing a confusing validation
    // error on next submit. Clear the chip list explicitly.
    const chipList = document.getElementById("chipList");
    if (chipList) chipList.innerHTML = "";

    // Clear progress table from the previous assay
    const progressContainer = document.getElementById("assayProgress");
    // Bug 16 fix: guard against null — element may not exist in all DOM states.
    if (progressContainer) {
      progressContainer.innerHTML = "";
      progressContainer.hidden    = true;
    }
    UI.Buttons.progress.textContent = "Show Progress";

    resetTimingState();
    setState(STATES.SETUP);
  }


  /* -----------------------------------------------------------------------
     Event Bindings
  ----------------------------------------------------------------------- */

  /**
   * Saves all current setup-form field values as a JSON draft in localStorage.
   * Called on every input event (debounced) so partial entries survive a
   * tab close or navigation away.
   *
   * Uses a 400ms debounce so rapid keystrokes only trigger one write per burst.
   */
  let _draftSaveTimer = null;
  function scheduleDraftSave() {
    clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(() => {
      try {
        const draft = {
          assayName:   UI.Inputs.assayName?.value?.trim() || "",
          genotypes:   UI.Inputs.genotypes?.value || "",
          isi:         UI.Inputs.isi?.value        || "",
          stimCount:   UI.Inputs.stimCount?.value  || "",
          binSize:     UI.Inputs.binSize?.value    || "",
          temperature: UI.Inputs.temperature?.value || "",
          humidity:    UI.Inputs.humidity?.value   || ""
        };
        localStorage.setItem("touchAssaySetupDraft", JSON.stringify(draft));
      } catch { /* storage not available */ }
    }, 400);  // 400ms debounce
  }

  /**
   * Restores a saved setup draft into the form fields and genotype chips.
   * Only runs if there is a non-empty draft in localStorage.
   */
  function restoreSetupDraft() {
    let draft;
    try {
      const raw = localStorage.getItem("touchAssaySetupDraft");
      if (!raw) return;
      draft = JSON.parse(raw);
    } catch { return; }

    if (draft.assayName)                          UI.Inputs.assayName.value   = draft.assayName;
    if (draft.isi)                                 UI.Inputs.isi.value          = draft.isi;
    if (draft.stimCount)                           UI.Inputs.stimCount.value    = draft.stimCount;
    if (draft.binSize)                             UI.Inputs.binSize.value      = draft.binSize;
    // Use != null (not truthiness) so that valid values of 0 (e.g. 0 °C, 0% RH) are restored.
    if (draft.temperature != null && draft.temperature !== "") UI.Inputs.temperature.value  = draft.temperature;
    if (draft.humidity    != null && draft.humidity    !== "") UI.Inputs.humidity.value     = draft.humidity;

    // Restore genotype chips via the hidden input + chip script
    // Trigger the same addChip logic by setting the hidden input value
    // and populating chips through the existing chip-input infrastructure.
    if (draft.genotypes) {
      UI.Inputs.genotypes.value = draft.genotypes;
      const chipList = document.getElementById("chipList");
      if (chipList) {
        // Clear any existing chips first
        chipList.innerHTML = "";
        const genArr = draft.genotypes.split(",").map(g => g.trim()).filter(Boolean);
        genArr.forEach(val => {
          // Manually create chips matching the inline chip script's format
          const chip = document.createElement("span");
          chip.className    = "chip";
          chip.dataset.value = val;
          const label       = document.createElement("span");
          label.className   = "chip-label";
          label.textContent = val;
          const removeBtn   = document.createElement("button");
          removeBtn.type    = "button";
          removeBtn.className = "chip-remove";
          removeBtn.setAttribute("aria-label", "Remove " + val);
          removeBtn.textContent = "✕";
          removeBtn.addEventListener("click", () => {
            chip.remove();
            // Mirror syncHidden() from the inline chip-input script in index.html.
            // That function is private to its IIFE scope so we replicate the logic here.
            // If syncHidden() changes in the inline script, update this block to match.
            UI.Inputs.genotypes.value = Array.from(
              document.querySelectorAll("#chipList .chip")
            ).map(c => c.dataset.value).join(",");
            scheduleDraftSave();  // Bug 6: persist the updated genotype list after chip removal
          });
          chip.appendChild(label);
          chip.appendChild(removeBtn);
          chipList.appendChild(chip);
        });
      }
    }

    // Trigger bin warning recalculation after restoring values
    updateBinWarning();
  }

  /** Clears the setup draft from localStorage. Called after a successful Begin. (#1) */
  function clearSetupDraft() {
    try { localStorage.removeItem("touchAssaySetupDraft"); } catch { /* noop */ }
  }



  // ── Draft auto-save: wire all setup form fields (#1) ────────────────────
  // Any change to a setup field is debounced and written to localStorage so
  // the form survives accidental navigation or a page refresh.
  [
    UI.Inputs.assayName,
    UI.Inputs.isi,
    UI.Inputs.stimCount,
    UI.Inputs.binSize,
    UI.Inputs.temperature,
    UI.Inputs.humidity,
  ].forEach(el => {
    if (el) el.addEventListener("input", scheduleDraftSave);
  });

  // Also save when the hidden genotypes field changes (updated by chip script)
  if (UI.Inputs.genotypes) {
    UI.Inputs.genotypes.addEventListener("change", scheduleDraftSave);
  }

  UI.Forms.setup.addEventListener("submit", async function (event) {
    event.preventDefault();

    const setupValues = {
      assayName:   UI.Inputs.assayName.value.trim(),
      genotypes:   UI.Inputs.genotypes.value.split(",").map(g => g.trim()).filter(g => g !== ""),
      isi:         Number(UI.Inputs.isi.value),
      stimCount:   Number(UI.Inputs.stimCount.value),
      binSize:     Number(UI.Inputs.binSize.value),
      temperature: UI.Inputs.temperature.value === "" ? null : Number(UI.Inputs.temperature.value),
      humidity:    UI.Inputs.humidity.value    === "" ? null : Number(UI.Inputs.humidity.value)
    };

    const validation = validateInputs(setupValues);
    if (!validation.isValid) {
      showToast(
        "Please fix: " + validation.errors.join(" • "),
        "error",
        6000
      );
      return;
    }

    // #2: Show non-blocking advisory for very short ISI
    if (validation.warnings && validation.warnings.length > 0) {
      validation.warnings.forEach(w => showToast(w, "warning", 7000));
    }

    // Create and persist the assay and its first trial
    try {
      currentAssay = createAssay(setupValues);
      await saveAssay(currentAssay);

      const firstTrial = createTrial(1);
      currentAssay.trials.push(firstTrial);
      await saveTrial(currentAssay.assayId, firstTrial);
    } catch (err) {
      console.error("Failed to save assay to database:", err);
      showToast(
        "Failed to save assay — please try again. (" + (err?.message || err) + ")",
        "error",
        8000
      );
      currentAssay = null;
      return;
    }

    // #1: Clear the draft now that the assay has been saved
    clearSetupDraft();

    populateGenotypeSelect(setupValues.genotypes);
    setState(STATES.CONFIGURED);
  });

  // ── Bin warning live update ─────────────────────────────────────────────
  UI.Inputs.stimCount.addEventListener("input", updateBinWarning);
  UI.Inputs.binSize.addEventListener("input",   updateBinWarning);

  // ── Tap button (pointerdown avoids 300ms mobile ghost-click delay) ──────
  UI.Buttons.tap.addEventListener("pointerdown", e => {
    e.preventDefault();  // Prevents ghost click / double-fire on touch devices
    executeTapAction();
  });

  // Fallback for older Android WebViews that don't implement Pointer Events
  // reliably. The hardware debounce (TAP_COOLDOWN_MS = 80ms) prevents double-
  // firing when both pointerdown and touchstart fire on the same interaction.
  UI.Buttons.tap.addEventListener("touchstart", e => {
    e.preventDefault();  // Suppress the following 300ms-delayed click
    executeTapAction();
  }, { passive: false });

  // ── Space bar shortcut ──────────────────────────────────────────────────
  document.addEventListener("keydown", event => {
    // Prevent Space from scrolling the page while on the trial screen,
    // even during key-repeat (held key). Do this before the repeat-guard
    // so that a held Space never triggers a browser scroll.
    const _onAssayForScroll = currentState === STATES.CONFIGURED
                           || currentState === STATES.POISED
                           || currentState === STATES.RUNNING;
    if (_onAssayForScroll && event.key === " ") {
      event.preventDefault();
    }

    // Ignore held-down keys (auto-repeat) for tap actions
    if (event.repeat) return;

    // Bug 13 fix: allow Escape to cancel a warmup countdown in progress.
    // Setting isWarmingUp = false causes the runWarmup() loop to exit on its
    // next iteration, restoring the tap button and cleaning up the display.
    if (event.key === "Escape" && isWarmingUp) {
      isWarmingUp = false;
      // L2 fix: restore UI immediately so user sees instant feedback instead of
      // waiting up to 1 s for the runWarmup() loop's next setTimeout to fire.
      UI.Displays.warmup.hidden = true;
      UI.Buttons.tap.hidden     = false;
      return;
    }

    // Bug 15 fix: Escape key closes preview modal, overlay screens, and overflow menu.
    if (event.key === "Escape") {
      // 1. Close preview modal if open
      if (!UI.Displays.previewModal.hidden) {
        UI.Displays.previewModal.hidden = true;
        return;
      }
      // 2. Close any open overlay screen (settings, guidelines, saved assays)
      if (!UI.Screens.settings.hidden) {
        hideScreenAndRestore(UI.Screens.settings);
        return;
      }
      if (!UI.Screens.guidelines.hidden) {
        hideScreenAndRestore(UI.Screens.guidelines);
        return;
      }
      if (!UI.Screens.savedAssays.hidden) {
        hideScreenAndRestore(UI.Screens.savedAssays);
        return;
      }
      // 3. Close overflow menu if open
      if (!UI.Displays.overflowMenu.hidden) {
        UI.Displays.overflowMenu.hidden = true;
        return;
      }
      return;
    }

    const onAssayScreen = currentState === STATES.CONFIGURED
                       || currentState === STATES.POISED
                       || currentState === STATES.RUNNING;

    if (onAssayScreen) {
      // On the assay screen, Space and Enter must NEVER activate any focused
      // element — including the genotype <select>, buttons, etc.
      // Block the browser default BEFORE any early-return so the <select>
      // dropdown cannot be opened and no button can be activated.
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
      }

      // Non-activation keys (Tab, arrow keys, etc.) pass through unaffected.
      if (event.key !== " " && event.key !== "Enter") return;

      // Bug 11: Enter is silently swallowed — no tap, no button activation.
      // (The previous code used `if (event.key !== " ") return` which was
      // unreachable dead code: the guard above already ensures key is " " or
      // "Enter", so the only case that would pass this check is "Enter".)
      if (event.key === "Enter") return;

      // RUNNING: tap unconditionally takes priority over everything
      if (currentState === STATES.RUNNING) {
        if (!UI.Buttons.tap.disabled) executeTapAction();
        return;
      }

      // If a toast has keyboard focus, let the toast's own keydown handler
      // dismiss it (already wired in toast.js) — don't also trigger a tap
      if (document.activeElement?.classList.contains("toast")) return;

      // Outside a run: Space dismisses the newest visible toast first
      if (dismissLatestToast()) return;

      if (!UI.Buttons.tap.disabled) executeTapAction();
      return;
    }

    // ── Non-assay screens ─────────────────────────────────────────────────
    // Allow normal keyboard input in form fields (text inputs, selects, etc.)
    if (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "SELECT") return;

    // Space only: dismiss toast or trigger tap
    if (event.key === " ") {
      event.preventDefault();
      if (document.activeElement?.classList.contains("toast")) return;
      if (dismissLatestToast()) return;
      if (!UI.Buttons.tap.disabled) executeTapAction();
    }
  });

  // ── Stop run button ─────────────────────────────────────────────────────
  UI.Buttons.stopRun.addEventListener("click", () => stopRunEarly());

  // ── Finish trial button ─────────────────────────────────────────────────
  UI.Buttons.finishTrial.addEventListener("click", async () => {
    if (!confirm("Finish this trial? You will not be able to add more runs to this trial.")) return;

    const activeTrial = getActiveTrial(currentAssay);

    // Bug 3: guard against null (can occur if the trial was already completed via another
    // path, e.g. a rapid double-click or a race with the crash-guard cleanup).
    if (!activeTrial) {
      showToast("No active trial to finish.", "warning", 4000);
      return;
    }

    if (activeTrial.runs.length === 0) {
      await markTrialAbandoned(currentAssay.assayId, activeTrial.trialId, "No runs recorded");
    } else {
      await markTrialCompleted(currentAssay.assayId, activeTrial.trialId);
    }

    // Hydrate FIRST so the export list reflects the updated trial status
    currentAssay = await hydrateAssay(currentAssay.assayId);
    // #14: Render summary card for the just-completed trial
    renderTrialSummaryCard(currentAssay);
    populateExportDatasetList(currentAssay);
    setState(STATES.EXPORT);
  });

  // ── Show/hide progress table ────────────────────────────────────────────
  UI.Buttons.progress.addEventListener("click", () => {
    const progressContainer            = document.getElementById("assayProgress");
    progressContainer.hidden           = !progressContainer.hidden;
    UI.Buttons.progress.textContent    = progressContainer.hidden ? "Show Progress" : "Hide Progress";
    // #21: Persist the user's visibility preference
    // Bug 3 fix: wrap in try/catch for Private Browsing / QuotaExceededError.
    try { localStorage.setItem("touchAssayProgressVisible", String(!progressContainer.hidden)); } catch { /* storage unavailable */ }
  });

  // ── Genotype selection change — update tap button label ─────────────────
  UI.Inputs.genotypeSelect.addEventListener("change", e => {
    if (currentState === STATES.CONFIGURED || currentState === STATES.POISED) {
      const selected    = e.target.value;
      // C2 fix: activeTrial can be null; use optional chaining to prevent crash.
      const activeTrial = getActiveTrial(currentAssay);
      const nextIndex   = (activeTrial?.runs.filter(
        r => r.genotype === selected && r.status === "completed" && r.eligibleForAnalysis
      ).length ?? 0) + 1;

      UI.Buttons.tap.textContent = `Start ${selected} (Animal ${nextIndex})`;

      // Reset the double-tap guard when the genotype changes
      pendingStart = false;
      clearTimeout(startTimeout);
    }
  });

  // ── Start new trial (from export screen) ───────────────────────────────
  UI.Buttons.backToAssay.addEventListener("click", async () => {
    // H3 fix: guard against currentAssay being null — rapid navigation or state
    // corruption could leave it null, causing .assayId to throw TypeError.
    if (!currentAssay) return;
    try {
      // Re-hydrate from IDB so trialIndex is always correct, even if the user has
      // looped through export → backToAssay multiple times, and to pick up any
      // run records written since the last hydrateAssay() call.
      currentAssay = await hydrateAssay(currentAssay.assayId);
      const trial = createTrial(currentAssay.trials.length + 1);
      currentAssay.trials.push(trial);
      await saveTrial(currentAssay.assayId, trial);  // await: run start must not race DB write
      populateGenotypeSelect(currentAssay.genotypes);
      updateProgressTable();
      // POISED (not CONFIGURED): this assay already exists; Finish Trial must be
      // immediately available in case the experimenter only needs one run.
      setState(STATES.POISED);
    } catch (err) {
      console.error("backToAssay error:", err);
      showToast("Failed to start new trial. (" + (err?.message || err) + ")", "error", 8000);
    }
  });

  // ── New assay ───────────────────────────────────────────────────────────
  UI.Buttons.newAssay.addEventListener("click", () => {
    // Warn if there is completed trial data that has not yet been exported,
    // so the experimenter does not lose track of results saved in IndexedDB.
    if (currentAssay) {
      const completedTrials = (currentAssay.trials || []).filter(t => t.status === "completed");
      if (completedTrials.length > 0) {
        if (!confirm(
          "You have unsaved data. Export your results before starting a new assay, " +
          "or they may be difficult to find later.\n\nStart a new assay anyway?"
        )) return;
      }
    }

    resetToSetup();
  });

  // ── Header home (logo / title) → back to setup ─────────────────────────
  UI.Buttons.headerHome.addEventListener("click", () => {
    // Do not navigate away while a run is actively recording data
    if (currentState === STATES.RUNNING) return;
    resetToSetup();
  });

  // ── Overlay navigation ──────────────────────────────────────────────────
  UI.Buttons.openSettings.addEventListener("click",   () => showScreen(UI.Screens.settings));
  UI.Buttons.closeSettings.addEventListener("click",  () => hideScreenAndRestore(UI.Screens.settings));
  UI.Buttons.openGuidelines.addEventListener("click", () => showScreen(UI.Screens.guidelines));
  UI.Buttons.closeGuidelines.addEventListener("click",() => hideScreenAndRestore(UI.Screens.guidelines));

  UI.Buttons.openSavedAssays.addEventListener("click", () => {
    showScreen(UI.Screens.savedAssays);
    // M3 fix: propagate async errors — previously the returned Promise was
    // discarded so IDB failures produced a silent empty list with no user feedback.
    populateSavedAssaysList().catch(err => {
      console.error("Failed to load saved assays:", err);
      showToast("Could not load saved assays. Please try again.", "error", 4000);
    });
  });
  UI.Buttons.closeSavedAssays.addEventListener("click", () =>
    hideScreenAndRestore(UI.Screens.savedAssays)
  );

  // ── Overflow menu toggle ────────────────────────────────────────────────
  UI.Buttons.overflowMenu.addEventListener("click", e => {
    e.stopPropagation();  // Prevent the document click handler from immediately closing it
    UI.Displays.overflowMenu.hidden = !UI.Displays.overflowMenu.hidden;
  });

  // Close the overflow menu when clicking anywhere outside it
  document.addEventListener("click", e => {
    if (!UI.Displays.overflowMenu.hidden && !UI.Displays.overflowMenu.contains(e.target)) {
      UI.Displays.overflowMenu.hidden = true;
    }
  });

  // ── Saved assays list — event delegation ───────────────────────────────
  UI.Displays.savedAssaysList.addEventListener("click", async e => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const action  = btn.dataset.action;
    const assayId = btn.dataset.assayId;

    if (action === "start") {
      try {
        currentAssay = await hydrateAssay(assayId);
        populateGenotypeSelect(currentAssay.genotypes);

        // Abandon any previously active trial (shouldn't exist, but guard anyway)
        const active = getActiveTrial(currentAssay);
        if (active) {
          await markTrialAbandoned(currentAssay.assayId, active.trialId, "Started new trial from saved assays");
          // Bug 5 fix: update the in-memory trial object to match what was
          // just written to IDB. Without this, getActiveTrial() would still
          // find this trial (status is "active" in memory), causing the new
          // trial created below to be shadowed.
          active.status          = "abandoned";
          active.abandonedReason = "Started new trial from saved assays";
          active.endedAt         = Date.now();
        }

        const newTrial = createTrial(currentAssay.trials.length + 1);
        currentAssay.trials.push(newTrial);
        await saveTrial(currentAssay.assayId, newTrial);

        // Clear progress table from any previously loaded assay
        const progressContainer = document.getElementById("assayProgress");
        progressContainer.innerHTML = "";
        progressContainer.hidden    = true;
        UI.Buttons.progress.textContent = "Show Progress";

        hideScreenAndRestore(UI.Screens.savedAssays);
        setState(STATES.POISED);
      } catch (err) {
        console.error("savedAssaysList start error:", err);
        showToast("Failed to load assay. (" + (err?.message || err) + ")", "error", 8000);
      }

    } else if (action === "export") {
      currentAssay = await hydrateAssay(assayId);
      // Bug 12 fix: render the trial summary card so the export screen shows
      // trial details, matching the pattern used in the complete-trial path (~L2085).
      renderTrialSummaryCard(currentAssay);
      hideScreenAndRestore(UI.Screens.savedAssays);
      populateExportDatasetList(currentAssay);
      setState(STATES.EXPORT);

    } else if (action === "delete") {
      const name = btn.dataset.assayName || "this assay";
      if (confirm(`Delete ${name}?`)) {
        try {
          await deleteAssay(assayId);
          await populateSavedAssaysList();
          showToast(`"${name}" deleted.`, "success", 3000);
        } catch (err) {
          console.error("Delete failed:", err);
          showToast(`Failed to delete "${name}". Please try again.`, "error");
        }
      }
    }  // end action routing
  });

  // ── Saved assays bulk selection ─────────────────────────────────────────
  UI.Displays.savedAssaysList.addEventListener("change", e => {
    if (!e.target.classList.contains("assay-select-checkbox")) return;

    const all     = document.querySelectorAll(".assay-select-checkbox");
    const checked = document.querySelectorAll(".assay-select-checkbox:checked");

    UI.Buttons.deleteSelectedAssays.disabled = checked.length === 0;
    UI.Inputs.selectAllAssays.checked        = checked.length === all.length && all.length > 0;
  });

  UI.Inputs.selectAllAssays.addEventListener("change", e => {
    const isChecked = e.target.checked;
    document.querySelectorAll(".assay-select-checkbox").forEach(cb => {
      cb.checked = isChecked;
    });
    const all = document.querySelectorAll(".assay-select-checkbox");
    UI.Buttons.deleteSelectedAssays.disabled = !isChecked || all.length === 0;
  });

  UI.Buttons.deleteSelectedAssays.addEventListener("click", async () => {
    const checked = document.querySelectorAll(".assay-select-checkbox:checked");
    if (checked.length === 0) return;

    if (!confirm(`Are you sure you want to permanently delete ${checked.length} selected assays?`)) return;

    UI.Buttons.deleteSelectedAssays.textContent = "Deleting...";
    UI.Buttons.deleteSelectedAssays.disabled    = true;

    const idsToDelete = Array.from(checked).map(cb => cb.dataset.assayId);
    let failCount = 0;

    // Delete sequentially — parallel deletes on the same cached IDB connection
    // can interleave their write transactions and cause silent aborts.
    // Bug 3: use try/finally so the button label is always restored, even if
    // populateSavedAssaysList() throws after a partial deletion failure.
    try {
      for (const id of idsToDelete) {
        try {
          await deleteAssay(id);
        } catch (err) {
          console.error(`Failed to delete assay ${id}:`, err);
          failCount++;
        }
      }

      if (failCount > 0) {
        alert(`${failCount} assay(s) could not be deleted. The rest were removed.`);
      }
    } finally {
      // Always restore the button — even if populateSavedAssaysList() throws.
      UI.Buttons.deleteSelectedAssays.textContent = "Delete Selected";
    }

    await populateSavedAssaysList();
  });

  // ── Settings ────────────────────────────────────────────────────────────
  UI.Settings.warmupToggle.addEventListener("change", e => {
    isWarmupEnabled = e.target.checked;
    // Bug 3 fix: wrap in try/catch for Private Browsing / QuotaExceededError.
    try { localStorage.setItem("touchAssayWarmupEnabled", isWarmupEnabled); } catch { /* storage unavailable */ }
    UI.Settings.warmupDurationContainer.style.display = isWarmupEnabled ? "flex" : "none";
  });

  // Clamp and persist on both "input" (live typing / spinner) and "change" (blur)
  // so the displayed value always matches the JS variable and never shows 0.
  function applyWarmupDuration(e) {
    const parsed = parseInt(e.target.value, 10);
    if (isNaN(parsed)) return;  // Don't update while field is empty
    warmupDuration = Math.min(60, Math.max(1, parsed));
    UI.Settings.warmupDurationInput.value = warmupDuration;  // Reflect clamped value back
    // Bug 3 fix: wrap in try/catch for Private Browsing / QuotaExceededError.
    try { localStorage.setItem("touchAssayWarmupDuration", warmupDuration); } catch { /* storage unavailable */ }
  }
  UI.Settings.warmupDurationInput.addEventListener("input",  applyWarmupDuration);
  UI.Settings.warmupDurationInput.addEventListener("change", applyWarmupDuration);

  document.querySelectorAll('input[name="themeMode"]').forEach(input => {
    input.addEventListener("change", e => {
      if (!e.target.checked) return;
      const theme = e.target.value;
      document.documentElement.setAttribute("data-theme", theme);
      // Keep the Android status bar / browser chrome color in sync
      document.querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", theme === "dark" ? "#0f172a" : "#f1f5f9");
      // Bug 3 fix: wrap in try/catch for Private Browsing / QuotaExceededError.
      try { localStorage.setItem("touchAssayTheme", theme); } catch { /* storage unavailable */ }
    });
  });

  document.querySelectorAll('input[name="voiceMode"]').forEach(input => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      stopSpeech();
      setVoiceMode(input.value);
      // Bug 3 fix: wrap in try/catch for Private Browsing / QuotaExceededError.
      try { localStorage.setItem("touchAssayVoiceMode", input.value); } catch { /* storage unavailable */ }
    });
  });

  // ── Settings: audio controls (#15) ──────────────────────────────────────

  /**
   * Plays a preview tick to help the user audition the current setting.
   * Ensures the AudioContext is warmed up before playing.
   * A debounce timer ID is returned so callers can cancel pending previews.
   * @param {number|undefined} timerId - Previous debounce timer to cancel.
   * @param {number}           delay   - Debounce delay in ms.
   * @returns {number} New debounce timer ID.
   */
  function _previewTick(timerId, delay = 0) {
    clearTimeout(timerId);
    return setTimeout(() => {
      warmUpAudio()
        .then(() => playTick(null))
        .catch(() => { /* AudioContext blocked — silently skip preview */ });
    }, delay);
  }

  /**
   * Triggers the .pop CSS animation on a badge element to give tactile
   * feedback whenever its value changes while the user drags a slider.
   * @param {HTMLElement|null} el - The badge element to animate.
   */
  function _popBadge(el) {
    if (!el) return;
    el.classList.remove("pop");
    // Force reflow so removing then re-adding the class restarts the animation
    void el.offsetWidth;
    el.classList.add("pop");
  }

  /**
   * Debounce timer ID for the pitch-preview tick.
   * @type {number|undefined}
   */
  let _pitchPreviewTimer;

  if (UI.Settings.tickPitch) {
    UI.Settings.tickPitch.addEventListener("input", e => {
      const hz = parseInt(e.target.value, 10);
      setTickPitch(hz);
      // Bug 3 fix: wrap in try/catch for Private Browsing / QuotaExceededError.
      try { localStorage.setItem("touchAssayTickPitch", hz); } catch { /* storage unavailable */ }
      if (UI.Settings.tickPitchDisplay) {
        UI.Settings.tickPitchDisplay.textContent = hz + " Hz";
        _popBadge(UI.Settings.tickPitchDisplay);
      }
      // Debounce the preview tick so rapid slider drags only fire once the
      // user briefly pauses, preventing a rapid-fire buzz of overlapping tones.
      _pitchPreviewTimer = _previewTick(_pitchPreviewTimer, 120);
    });
  }

  // ── Settings: speech lead time ─────────────────────────────────────────
  if (UI.Settings.speechLead) {
    UI.Settings.speechLead.addEventListener("input", e => {
      // Apply the same [0, 490] clamp used at startup — values ≥ 500 ms would
      // push nextSpeechTime before AudioContext t0, misfiring the first speech cue.
      // H5 fix: parseInt of a non-numeric string returns NaN; Math.min/max with NaN
      // propagates NaN, which would set speechLeadMs = NaN and silence all speech.
      const parsed = parseInt(e.target.value, 10);
      if (isNaN(parsed)) return;  // ignore invalid input, keep previous value
      speechLeadMs = Math.max(0, Math.min(490, parsed));
      // Bug 3 fix: wrap in try/catch for Private Browsing / QuotaExceededError.
      try { localStorage.setItem("touchAssaySpeechLeadMs", speechLeadMs); } catch { /* storage unavailable */ }
      if (UI.Settings.speechLeadDisplay) {
        UI.Settings.speechLeadDisplay.textContent = speechLeadMs + " ms";
        _popBadge(UI.Settings.speechLeadDisplay);
      }
      // BUG-10 fix: speechLeadMs seeds nextSpeechTime only at startCueLoop() time,
      // so changing it mid-run has no effect on the current run. Inform the user
      // so they're not confused by the apparent lack of immediate response.
      if (currentState === STATES.RUNNING) {
        showToast("Speech lead will apply from the next run.", "info", 3000);
      }
    });
  }


  // ── Export ──────────────────────────────────────────────────────────────
  /**
   * Wraps an export action with a loading spinner state on the button.
   * Yields to the browser paint cycle before running the (potentially slow)
   * synchronous export to ensure the spinner appears before blocking.
   * (#30)
   */
  async function runWithSpinner(btn, label, fn) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.classList.add("btn-loading");
    try {
      await new Promise(r => setTimeout(r, 0));  // yield one frame
      await fn();
    } finally {
      btn.textContent = original;
      btn.classList.remove("btn-loading");
    }
  }

  UI.Buttons.exportExcel.addEventListener("click", () => {
    if (!currentAssay) return;

    const configs = getExportConfigs();
    if (configs.length === 0) {
      alert("Please select a dataset.");
      return;
    }

    // If SheetJS isn't loaded (offline / CDN failure), fall back to CSV silently
    if (typeof XLSX === "undefined") {
      runWithSpinner(UI.Buttons.exportExcel, "Exporting…", () => {
        const result = performCSVExport(currentAssay, configs);
        if (!result.success) alert("Export failed: " + result.error);
      });
      return;
    }

    runWithSpinner(UI.Buttons.exportExcel, "Exporting…", () => {
      const result = performExcelExport(currentAssay, configs);
      if (!result.success) {
        if (confirm(`Excel export failed: ${result.error}\n\nWould you like to export as CSV instead?`)) {
          performCSVExport(currentAssay, configs);
        }
      }
    });
  });

  // #13: Dedicated CSV export button
  if (UI.Buttons.exportCSV) {
    UI.Buttons.exportCSV.addEventListener("click", () => {
      if (!currentAssay) return;
      const configs = getExportConfigs();
      if (configs.length === 0) {
        alert("Please select a dataset.");
        return;
      }
      runWithSpinner(UI.Buttons.exportCSV, "Exporting…", () => {
        const result = performCSVExport(currentAssay, configs);
        if (!result.success) alert("CSV export failed: " + result.error);
      });
    });
  }

  UI.Buttons.previewExcel.addEventListener("click", () => {
    if (!currentAssay) return;

    const configs = getExportConfigs();
    if (configs.length === 0) {
      alert("Please select a dataset to preview.");
      return;
    }

    runWithSpinner(UI.Buttons.previewExcel, "Loading…", () => {
      UI.Displays.previewContainer.innerHTML = generatePreviewHTML(currentAssay, configs);
      UI.Displays.previewModal.hidden        = false;
    });
  });

  // Close preview modal via button or backdrop click
  UI.Displays.closePreview.addEventListener("click", () => {
    UI.Displays.previewModal.hidden = true;
  });

  UI.Displays.previewModal.addEventListener("click", e => {
    if (e.target === UI.Displays.previewModal) {
      UI.Displays.previewModal.hidden = true;
    }
  });

  UI.Buttons.exportFromPreview.addEventListener("click", () => {
    UI.Buttons.exportExcel.click();       // Delegate to the main export handler
    UI.Displays.previewModal.hidden = true;
  });

  // ── Export dataset list — checkbox delegation (#8, #9) ──────────────────
  // Refresh button state and keep the select-all checkbox in sync whenever
  // any individual dataset checkbox changes.
  document.getElementById("exportDatasetList").addEventListener("change", () => {
    refreshExportButtonState();
    syncExportSelectAll();
  });

  // Select-all master toggle: check/uncheck all dataset checkboxes (#9)
  if (UI.Inputs.exportSelectAll) {
    UI.Inputs.exportSelectAll.addEventListener("change", e => {
      document.querySelectorAll("#exportDatasetList input[type='checkbox']")
        .forEach(cb => { cb.checked = e.target.checked; });
      refreshExportButtonState();
    });
  }

  // ── SheetJS availability detection (#10) ────────────────────────────────
  // The SheetJS script loads with `defer`, so we check after the window has
  // fully loaded.  If it failed to load (e.g. offline), update button labels
  // to "Export to CSV" so users are not surprised by the fallback format.
  function updateExportButtonLabels() {
    const isExcel = typeof XLSX !== "undefined";
    if (!isExcel) {
      const csvLabel = "Export to CSV";
      const csvTitle = "SheetJS could not be loaded — data will export as CSV";
      [UI.Buttons.exportExcel, UI.Buttons.exportFromPreview].forEach(btn => {
        if (btn) { btn.textContent = csvLabel; btn.title = csvTitle; }
      });
    }
  }

  // Check once SheetJS has loaded (or failed) and again at window load as fallback
  const xlsxScript = document.querySelector("script[src*=\"xlsx\"]");
  if (xlsxScript) {
    xlsxScript.addEventListener("load",  updateExportButtonLabels);
    xlsxScript.addEventListener("error", updateExportButtonLabels);
  }
  window.addEventListener("load", updateExportButtonLabels);



});  // end DOMContentLoaded