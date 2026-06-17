/**
 * @file models.js
 * @module Models
 * @description Factory functions and immutable state-transition helpers for core domain objects.
 *
 * Object hierarchy:
 *   Assay
 *   └── Trial (one per recording session)
 *       └── Run  (one per animal / genotype)
 *           └── values[] (one entry per stimulus)
 *
 * All factory functions return plain objects — no classes — so they
 * serialise cleanly to IndexedDB without any prototype information.
 *
 * State-transition helpers mutate the passed object in place and are
 * guarded against operating on already-transitioned objects.
 */

/* ==========================================================================
   Internal Helpers
   ========================================================================== */

/**
 * Generates a pseudo-random unique ID combining the current Unix timestamp
 * with a random five-digit suffix to prevent collisions within the same
 * millisecond (e.g. rapid back-to-back run creation in a loop).
 *
 * Format: "<timestamp>_<suffix>"  e.g. "1686731847000_42853"
 *
 * @returns {string} A unique string ID.
 */
function generateUniqueId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers without crypto.randomUUID
  const randomSuffix = Math.floor(Math.random() * 1_000_000_000);
  return `${Date.now()}_${randomSuffix}`;
}


/* ==========================================================================
   Model Factories
   ========================================================================== */

/**
 * Creates a new top-level Assay configuration object.
 * The assay captures the experimental parameters and holds all trials.
 *
 * @param {Object} setupValues - Validated parameters from the setup form.
 * @param {string}   setupValues.assayName  - Human-readable experiment identifier.
 * @param {number}   setupValues.isi        - Inter-stimulus interval in seconds.
 * @param {number}   setupValues.stimCount  - Total number of stimuli per run.
 * @param {number}   setupValues.binSize    - Number of stimuli grouped into each bin.
 * @param {number}   setupValues.temperature - Ambient temperature in °C.
 * @param {number}   setupValues.humidity   - Relative humidity as a percentage.
 * @param {string[]} setupValues.genotypes  - Ordered list of genotype labels.
 * @returns {Object} A freshly initialised assay instance.
 */
export function createAssay({ assayName, isi, stimCount, binSize, temperature, humidity, genotypes }) {
  return {
    assayId:        generateUniqueId(),
    assayName,
    createdAt:      Date.now(),
    lastModifiedAt: Date.now(),
    isi,
    stimCount,
    binSize,
    temperature,
    humidity,
    genotypes,
    trials: []           // populated progressively as trials are created
  };
}

/**
 * Creates a new Trial instance.
 * A trial is a single recording session that can contain multiple runs
 * (one per animal / genotype combination).
 *
 * @param {number} trialIndex - Sequential 1-based index within the parent assay.
 * @returns {Object} A freshly initialised trial instance.
 */
export function createTrial(trialIndex) {
  return {
    trialId:         generateUniqueId(),
    trialIndex,
    status:          "active",  // "active" | "completed" | "abandoned"
    abandonedReason: null,
    startedAt:       Date.now(),
    endedAt:         null,
    runs:            []         // populated as runs are started within this trial
  };
}

/**
 * Creates a new Run instance representing a single subject's test.
 * Each run records one boolean value per stimulus interval.
 *
 * @param {Object}        params                  - Run configuration.
 * @param {string}        params.genotype          - Genotype label for this animal.
 * @param {number|string} params.animalIndex       - 1-based sequential ID within this genotype+trial.
 * @param {number}        params.expectedStimCount - Target number of stimuli to record.
 * @returns {Object} A freshly initialised run instance.
 */
export function createRun({ genotype, animalIndex, expectedStimCount }) {
  return {
    runId:                     generateUniqueId(),
    genotype,
    animalIndex,
    expectedStimCount,
    values:                    [],    // filled during the run: 1 = responded, 0 = did not respond
    status:                    "active",  // "active" | "completed" | "stoppedEarly" | "abandoned"
    eligibleForAnalysis:       null,  // set to true/false on run completion
    ineligibleReason:          null,  // human-readable reason when eligibleForAnalysis is false
    partialBinWarning:         null,  // set if stimulus count is not an exact multiple of binSize
    touchIndexExcluded:        false,
    touchIndexExclusionReason: null,
    startedAt:                 Date.now(),
    endedAt:                   null
  };
}


/* ==========================================================================
   State Transition Helpers
   ========================================================================== */

/**
 * Marks a trial as successfully completed and records the end timestamp.
 * No-ops if the trial is not currently active (idempotent guard).
 *
 * @param {Object} trial - The trial object to mutate.
 */
export function completeTrial(trial) {
  if (trial.status !== "active") return;
  trial.status  = "completed";
  trial.endedAt = Date.now();
}

/**
 * Marks a trial as abandoned, records the reason, and logs the end time.
 * No-ops if the trial is not currently active (idempotent guard).
 *
 * @param {Object} trial  - The trial object to mutate.
 * @param {string} reason - Human-readable explanation of why the trial was abandoned.
 */
export function abandonTrial(trial, reason) {
  if (trial.status !== "active") return;
  trial.status          = "abandoned";
  trial.abandonedReason = reason;
  trial.endedAt         = Date.now();
}

/**
 * Marks a run as successfully completed and records the end timestamp.
 * No-ops if the run is not currently active (idempotent guard).
 *
 * @param {Object} run - The run object to mutate.
 */
export function completeRun(run) {
  if (run.status !== "active") return;
  run.status  = "completed";
  run.endedAt = Date.now();
}


/* ==========================================================================
   Query Helpers
   ========================================================================== */

/**
 * Retrieves the currently active trial from an assay.
 * There should only ever be one active trial at a time.
 *
 * @param {Object} assay - The assay object with a `trials` array.
 * @returns {Object|null} The active trial, or null if none exists.
 */
export function getActiveTrial(assay) {
  if (!assay || !assay.trials) return null;
  return assay.trials.find(trial => trial.status === "active") || null;
}