/**
 * @file utils.js
 * @module AssayUtilities
 * @description Pure utility functions for input validation, data processing,
 * and data extraction. All functions are stateless and side-effect free.
 *
 * Sections:
 *   1. Validation & ID Generation
 *   2. Data Processing & Statistics
 *   3. Data Extraction & Aggregation
 */


/* ==========================================================================
   1. Validation & ID Generation
   ========================================================================== */

/**
 * Validates the input parameters collected from the assay setup form.
 * Returns a structured result rather than throwing, so the caller can
 * display all errors at once instead of one at a time.
 *
 * @param {Object}   values             - The raw assay configuration object.
 * @param {string}   values.assayName   - Name / ID of the experiment.
 * @param {string[]} values.genotypes   - Array of genotype labels.
 * @param {number}   values.isi         - Inter-stimulus interval in seconds (> 0).
 * @param {number}   values.stimCount   - Total number of stimuli per run (> 0).
 * @param {number}   values.binSize     - Stimuli grouped per analysis bin (> 0).
 * @param {number}   values.temperature - Room temperature in °C.
 * @param {number}   values.humidity    - Relative humidity, 0–100 %.
 * @returns {{ isValid: boolean, errors: string[], warnings: string[] }}
 *   isValid  — true only when the errors array is empty.
 *   errors   — human-readable description of each failed validation check.
 *   warnings — non-blocking advisories (e.g. very short ISI) that do not
 *              prevent submission but are surfaced to the user as toasts.
 */
export function validateInputs(values) {
  const errors   = [];
  const warnings = [];

  if (!values.assayName) {
    errors.push("Assay name is required.");
  }

  if (!values.genotypes || values.genotypes.length === 0) {
    errors.push("At least one genotype is required.");
  } else {
    // U-3 fix: reject blank/whitespace-only genotype labels
    if (values.genotypes.some(g => !g || !g.trim())) {
      errors.push("Genotype labels must not be empty.");
    }
    // U-2 fix: reject duplicate genotype labels — duplicates corrupt export column headers
    // and cause summary statistics to be computed from a merged pool of two genotypes.
    if (new Set(values.genotypes.map(g => g.trim())).size !== values.genotypes.length) {
      errors.push("Genotype labels must be unique.");
    }
  }

  if (values.isi <= 0) {
    errors.push("Inter-stimulus interval (ISI) must be greater than zero.");
  } else if (values.isi < 0.5) {
    // Non-blocking advisory — very short ISIs may be below reliable scheduling
    // resolution on slow or throttled devices, risking silent data inaccuracy.
    warnings.push(
      `ISI of ${values.isi}s is very short — timing accuracy may be reduced on this device. ` +
      `Consider using ≥0.5s for reliable results.`
    );
  }

  if (values.stimCount <= 0) {
    errors.push("Stimulus count must be greater than zero.");
  }

  if (values.binSize <= 0) {
    errors.push("Bin size must be greater than zero.");
  }

  // BUG-8 fix: if binSize > stimCount, binRunValues() produces an empty array
  // (all values are dropped as a trailing partial bin) causing completely blank
  // columns in the export with no user-facing explanation.
  if (values.binSize > 0 && values.stimCount > 0 && values.binSize > values.stimCount) {
    errors.push(`Bin size (${values.binSize}) cannot be larger than the total stimulus count (${values.stimCount}).`);
  }

  // U-1 fix: isNaN(null) returns false (Number(null) === 0), so temperature: null
  // would silently pass as 0 °C. Use an explicit null check first.
  if (values.temperature == null || isNaN(Number(values.temperature))) {
    errors.push("A valid temperature is required.");
  }

  // Same null guard as temperature above — isNaN(null) is false (Number(null) === 0)
  if (values.humidity == null || isNaN(Number(values.humidity)) || values.humidity < 0 || values.humidity > 100) {
    errors.push("Humidity must be a valid percentage between 0 and 100.");
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Generates a unique, human-readable experiment ID based on the local clock.
 * Intended as a sensible default that avoids blank name fields.
 *
 * Format: "touch_YYYY-MM-DD_HHMM"
 *
 * @returns {string} A timestamp-based ID string.
 */
export function generateAutoID() {
  const now    = new Date();
  const year   = now.getFullYear();
  const month  = String(now.getMonth() + 1).padStart(2, "0");
  const day    = String(now.getDate()).padStart(2, "0");
  const hours  = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");

  return `touch_${year}-${month}-${day}_${hours}${minutes}`;
}


/* ==========================================================================
   2. Data Processing & Statistics
   ========================================================================== */

/**
 * Groups a flat array of binary response values into fixed-size bins and
 * converts each bin into a percentage of positive responses (1s).
 *
 * Encoding convention:
 *   1 = animal responded to the stimulus (default / no-tap event)
 *   0 = animal did not respond (experimenter tapped to record non-response)
 * Therefore, a higher bin percentage means a more responsive animal.
 *
 * If the total number of values is not an exact multiple of binSize and
 * allowPartialBin is false (the default), trailing values that do not fill
 * a complete bin are silently dropped and a console warning is emitted.
 *
 * @param {number[]} values               - Raw stimulus values (0s and 1s).
 * @param {number}   binSize              - Number of values per bin.
 * @param {Object}   [options]            - Optional behaviour overrides.
 * @param {boolean}  [options.allowPartialBin=false] - Keep the last partial bin.
 * @param {boolean}  [options.warnOnDrop=true]       - Log a warning when values are dropped.
 * @returns {number[]} Percentage per bin (0–100), ordered chronologically.
 */
export function binRunValues(values, binSize, options = {}) {
  const { allowPartialBin = false, warnOnDrop = true } = options;

  // U-4 fix: guard against null/undefined values (e.g. from a partially-written DB record)
  if (!values || !Array.isArray(values)) return [];

  const totalValues = values.length;
  const remainder   = totalValues % binSize;

  // Determine how many values can be cleanly binned
  let usableCount = totalValues;
  if (remainder !== 0 && !allowPartialBin) {
    usableCount = totalValues - remainder;
    if (warnOnDrop) {
      console.warn(
        `[Data Truncated] Dropped ${remainder} trailing value(s) that do not ` +
        `form a complete bin of size ${binSize}.`
      );
    }
  }

  const usableValues     = values.slice(0, usableCount);
  const binnedPercentages = [];

  for (let i = 0; i < usableValues.length; i += binSize) {
    const bin        = usableValues.slice(i, i + binSize);
    const sum        = bin.reduce((acc, v) => acc + v, 0);
    // Use bin.length (not binSize) so partial bins are handled correctly
    const percentage = (sum / bin.length) * 100;
    binnedPercentages.push(percentage);
  }

  return binnedPercentages;
}

/**
 * Normalises an array of binned percentages against the first bin (baseline).
 * The result is the "Touch Index" — each bin expressed as a fraction of baseline.
 *
 * A Touch Index of 1.0 means the animal responded at the same rate as baseline.
 * Values < 1.0 indicate habituation; values > 1.0 indicate sensitisation.
 *
 * Returns null when normalisation is impossible (zero or missing baseline),
 * which causes the run to be excluded from Touch Index analysis.
 *
 * @param {number[]} binnedPercentages - Output of binRunValues().
 * @returns {number[]|null} Normalised ratios, or null if baseline is invalid.
 */
export function computeTouchIndexBins(binnedPercentages) {
  // U-5 fix: explicitly guard the empty-array case before reading index 0.
  // Previously this relied on binnedPercentages[0] === undefined being == null,
  // which is correct but fragile — a future strict-equality change would break it.
  if (!binnedPercentages || binnedPercentages.length === 0) return null;

  const baseline = binnedPercentages[0];

  // Prevent division by zero (baseline = 0 means no responses in the first bin)
  if (baseline === 0 || baseline == null) {
    return null;
  }

  return binnedPercentages.map(v => v / baseline);
}


/* ==========================================================================
   3. Data Extraction & Aggregation
   ========================================================================== */

/**
 * Flattens all runs from all trials in an assay into a single array,
 * enriching each run with its parent trial's index for downstream labelling.
 *
 * By default only runs from completed trials are included; pass
 * { includeAbandoned: true } to also include abandoned trials.
 *
 * @param {Object}  assay                        - The full assay object.
 * @param {Object}  [options]                    - Filter options.
 * @param {boolean} [options.includeAbandoned=false] - Include abandoned trials.
 * @returns {Object[]} Flat array of run objects, each with a `trialIndex` field.
 */
export function collectPooledRuns(assay, options = {}) {
  const { includeAbandoned = false } = options;

  return assay.trials
    .filter(trial => includeAbandoned || trial.status === "completed")
    .flatMap(trial =>
      trial.runs.map(run => ({
        ...run,
        trialIndex: trial.trialIndex
      }))
    );
}

/**
 * Extracts a tabular list of runs that were excluded from Touch Index
 * calculations (e.g. because their baseline bin was zero).
 * Used to populate the "Exclusions" sheet in the Excel export.
 *
 * Exclusions are computed fresh by re-running the TI derivation — they are
 * NOT read from `run.touchIndexExcluded` flags on the run object.
 * This guarantees that the exclusion list is always consistent regardless of
 * whether preview, export, or CSV functions have been called beforehand.
 *
 * @param {Object} assay - The full assay object (needs assay.binSize).
 * @returns {Array<[number, string, number, string]>}
 *   Each row: [trialIndex, genotype, animalIndex, exclusionReason]
 */
export function collectTouchIndexExclusions(assay) {
  // Only scan completed trials — abandoned or still-active trials must not
  // produce spurious exclusion rows in the export output.
  return assay.trials
    .filter(t => t.status === "completed")
    .flatMap(trial =>
      trial.runs
        // Only eligible runs can be TI-excluded. Ineligible runs (stopped early,
        // abandoned) have empty or partial values[] — their binned result is []
        // which causes computeTouchIndexBins to return null, producing spurious
        // exclusion rows in the export sheet.
        .filter(run => run.eligibleForAnalysis)
        .filter(run => {
          // A run is excluded if its Touch Index cannot be computed —
          // i.e. computeTouchIndexBins returns null (baseline bin = 0).
          const binned = binRunValues(run.values, assay.binSize);
          return computeTouchIndexBins(binned) === null;
        })
        .map(run => [
          trial.trialIndex,
          run.genotype,
          run.animalIndex,
          "Baseline bin = 0 (animal had no responses in the first bin)"
        ])
    );
}