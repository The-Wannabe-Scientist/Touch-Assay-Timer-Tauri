/**
 * @file export.js
 * @module Export
 * @description Formats nested assay data into 2D arrays for Excel export and
 * HTML preview, plus a zero-dependency CSV fallback.
 *
 * Each "2D array" is an array of rows, where each row is an array of cell values.
 * These are passed to SheetJS (XLSX) for Excel, rendered to <table> HTML for
 * the preview modal, or serialised to comma-separated text for CSV.
 *
 * Sheet layout for every trial/pooled section:
 *   1. Raw stimulus values    (one column per run, one row per stimulus)
 *                              — includes Partial Bin Warning (#4) and Ineligible Reason (#5)
 *   2. Binned percentages     (% response per bin) + mean / SEM / N summary (#2)
 *   3. Touch Index (binned)   (normalised against bin 1 baseline)
 *   4. Touch Index (analysed) (mean / SEM / N across animals per genotype) (#2)
 *
 * All three master export functions (Excel, CSV, HTML preview) share a single
 * data-building pass via buildAllSections() (#12).  For pooled configs a shared
 * run-binning cache avoids redundant computation (#11).
 *
 * Depends on SheetJS (XLSX) being loaded globally for Excel export.
 * The CSV fallback has no external dependencies.
 */

import {
  binRunValues,
  computeTouchIndexBins,
  collectPooledRuns,
  collectTouchIndexExclusions
} from "./utils.js";


/* ==========================================================================
   Constants
   ========================================================================== */

/**
 * Human-readable labels for run status values.
 * Used in the "Run Status" header row of every raw data table.
 * @type {Object.<string, string>}
 */
export const RUN_STATUS_LABELS = {
  completed:    "Completed",
  stoppedEarly: "Stopped Early",
  abandoned:    "Abandoned"
};


/* ==========================================================================
   XSS Guard
   ========================================================================== */

/**
 * Escapes HTML special characters in a string before inserting it into innerHTML.
 * Prevents XSS when user-supplied values (assay names, genotype labels, etc.)
 * are rendered into the preview modal.
 *
 * @param {string} str - Raw string to escape.
 * @returns {string} Safely escaped HTML string.
 */
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
}


/* ==========================================================================
   Internal Helpers
   ========================================================================== */

/**
 * Groups a flat list of run objects by genotype and sorts them for consistent
 * column ordering across all exported tables.
 *
 * For pooled (cross-trial) views, runs are sorted by trial index first, then
 * animal index, and each run is assigned a `globalAnimalIndex` for labelling.
 *
 * For per-trial views, runs are sorted by animal index only.
 *
 * @param {Object[]} runs      - Flat array of run objects.
 * @param {string[]} genotypes - Ordered list of genotype labels (defines column order).
 * @param {boolean}  isPooled  - Whether this is a pooled cross-trial view.
 * @returns {Object.<string, Object[]>} Map of genotype → sorted run array.
 */
function groupAndSortRuns(runs, genotypes, isPooled = false) {
  // Initialise empty arrays for every declared genotype
  const runsByGenotype = {};
  genotypes.forEach(g => { runsByGenotype[g] = []; });

  // Assign each run to its genotype bucket
  runs.forEach(run => {
    if (runsByGenotype[run.genotype]) runsByGenotype[run.genotype].push(run);
  });

  // Sort and (for pooled views) assign a sequential global animal index
  genotypes.forEach(g => {
    if (isPooled) {
      runsByGenotype[g].sort((a, b) =>
        a.trialIndex - b.trialIndex || a.animalIndex - b.animalIndex
      );
      runsByGenotype[g].forEach((run, i) => { run.globalAnimalIndex = i + 1; });
    } else {
      runsByGenotype[g].sort((a, b) => a.animalIndex - b.animalIndex);
    }
  });

  return runsByGenotype;
}

/**
 * Calculates the arithmetic mean and Standard Error of the Mean (SEM)
 * for an array of numbers.
 *
 * Returns empty strings when the input is empty or undefined, so that
 * spreadsheet cells show blank rather than NaN.
 *
 * @param {number[]} values - Numeric values (e.g. binned percentages for one genotype).
 * @returns {{ mean: number|string, sem: number|string }}
 */
function calculateStats(values) {
  if (!values || values.length === 0) return { mean: "", sem: "" };

  const n    = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;

  // Bug 10: SEM is undefined for a single observation — return blank so the
  // exported cell shows nothing rather than 0 (which implies zero spread).
  if (n === 1) return { mean, sem: "" };

  // EX-1 fix: use sample variance (Bessel's correction, divide by n-1) instead of
  // population variance (divide by n). Population variance systematically underestimates
  // SEM for small n, which is the typical case in biological experiments.
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  const sem      = Math.sqrt(variance) / Math.sqrt(n);

  return { mean, sem };
}

/**
 * Pre-computes binned percentages and Touch Index arrays for a flat list of
 * runs, storing results in a Map keyed by run object.
 *
 * Used by buildAllSections() to share a single binning pass across all pooled
 * sub-tables for the same config, avoiding redundant computation (#11).
 *
 * @param {Object[]} runs    - Flat array of run objects.
 * @param {number}   binSize - Number of stimuli per bin.
 * @returns {Map<Object, { binned: number[], ti: number[]|null }>}
 */
function buildRunCache(runs, binSize) {
  const cache = new Map();
  runs.forEach(run => {
    const binned = binRunValues(run.values, binSize);
    cache.set(run, { binned, ti: computeTouchIndexBins(binned) });
  });
  return cache;
}


/* ==========================================================================
   Layout & Formatting Helpers
   ========================================================================== */

/**
 * Applies column widths and text-wrap cell styles to a SheetJS worksheet.
 * The first column (labels) gets extra width; all others get equal narrower width.
 *
 * @param {Object}  sheet - A SheetJS worksheet object (mutated in place).
 * @param {any[][]} data  - The 2D array that was used to create the sheet.
 */
export function applySheetLayout(sheet, data) {
  // Bug 5: data may be empty (e.g. a trial with no runs). Guard before
  // accessing data[0] to avoid "Cannot read properties of undefined (reading 'map')".
  if (!data || data.length === 0) return;

  // Set column widths
  sheet["!cols"] = data[0].map((_, colIndex) => (
    colIndex === 0 ? { wch: 22 } : { wch: 10 }
  ));

  // Enable word-wrap on every cell
  Object.keys(sheet).forEach(addr => {
    if (addr[0] === "!") return;  // Skip SheetJS metadata keys
    const cell = sheet[addr];
    cell.s = cell.s || {};
    cell.s.alignment = { wrapText: true };
  });
}

/**
 * Builds the assay-level metadata 2D array (shown on the first Excel sheet
 * and at the top of the HTML preview).
 *
 * Includes both createdAt and lastModifiedAt (#6).
 *
 * @param {Object} assay - The assay configuration object.
 * @returns {any[][]} Two-column table: [parameter, value].
 */
export function buildMetadata2D(assay) {
  return [
    ["Parameter",                    "Value"],
    ["Experiment ID",                assay.assayName],
    ["Date Created",                 new Date(assay.createdAt).toLocaleString()],
    ["Last Modified",                assay.lastModifiedAt ? new Date(assay.lastModifiedAt).toLocaleString() : "N/A"],
    ["Genotypes",                    assay.genotypes.join(", ")],
    ["Temperature",                  assay.temperature !== undefined ? `${assay.temperature} °C` : "N/A"],
    ["Humidity",                     assay.humidity    !== undefined ? `${assay.humidity} % RH`  : "N/A"],
    ["Inter-stimulus Interval (s)",  assay.isi],
    ["Number of Stimulations",       assay.stimCount],
    ["Bin Size",                     assay.binSize]
  ];
}

/**
 * Renders a 2D data array as an HTML table for the preview modal.
 * The first row and any row whose first cell is "Bin" or "Genotype" are
 * rendered as <th> header cells.
 *
 * @param {string}  title  - Section heading displayed above the table.
 * @param {any[][]} data2D - The 2D array to render.
 * @returns {string} HTML string for this section. Empty string if data is empty.
 */
export function buildHtmlTableFrom2D(title, data2D) {
  if (!data2D || data2D.length === 0) return "";

  // Escape the title to prevent XSS when it contains user-supplied text
  const safeTitle = title
    ? title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : "";

  let html = `<div class="preview-section"><h3>${safeTitle}</h3>` +
             `<div class="preview-table-wrapper"><table><tbody>`;

  data2D.forEach((row, rowIndex) => {
    // Render empty rows as spacer rows
    if (!row || row.length === 0) {
      html += `<tr><td colspan="100%" style="height:1.5rem;border:none;"></td></tr>`;
      return;
    }

    html += "<tr>";
    row.forEach(cell => {
      const content      = (cell === null || cell === undefined || cell === "") ? "" : cell;
      const displayValue = typeof content === "number"
        ? (Number.isInteger(content) ? content : content.toFixed(2))
        : escapeHTML(content);  // Escape user-supplied strings to prevent XSS

      // Header cells: first row, or rows that start with "Bin" / "Genotype"
      const isHeaderRow = rowIndex === 0 || row[0] === "Bin" || row[0] === "Genotype";
      html += isHeaderRow
        ? `<th>${displayValue}</th>`
        : `<td>${displayValue}</td>`;
    });
    html += "</tr>";
  });

  html += "</tbody></table></div></div>";
  return html;
}

/**
 * Combines the three "analysed" sub-tables (percent binned, TI binned,
 * TI summary) into a single contiguous 2D array for one Excel sheet.
 * Tables are separated by two blank rows for readability.
 *
 * @param {{ percentAnalysed2D: any[][], tiBinned2D: any[][], tiAnalysed2D: any[][] }} tables
 * @returns {any[][]} Combined 2D array.
 */
export function buildTouchAnalysedSheet2D({ percentAnalysed2D, tiBinned2D, tiAnalysed2D }) {
  const out = [];

  function append(table) {
    if (!table || table.length === 0) return;
    if (out.length > 0) out.push([], []);  // Two blank separator rows
    table.forEach(row => out.push(row));
  }

  append(percentAnalysed2D);
  append(tiBinned2D);
  append(tiAnalysed2D);

  return out;
}


/* ==========================================================================
   Trial-Level 2D Builders
   ========================================================================== */

/**
 * Builds the raw stimulus-by-stimulus table for a single trial.
 * Each column is one run; each row is one stimulus interval.
 *
 * Values: 1 = animal responded, 0 = did not respond (tap recorded).
 * Runs that did not complete the full protocol show empty cells for
 * stimulus indices beyond their recorded values.
 *
 * Now includes Partial Bin Warning (#4) and Ineligible Reason (#5) header rows
 * so QC information is preserved in every raw export.
 *
 * @param {Object} trial - A single trial object with a `runs` array.
 * @param {Object} assay - The parent assay (provides stimCount and genotypes).
 * @returns {any[][]} 2D array: [genotypeRow, animalRow, statusRow, partialBinRow, ineligibleRow, ...stimulusRows]
 */
export function buildTrialRaw2D(trial, assay) {
  const { stimCount, genotypes } = assay;
  const runsByGenotype = groupAndSortRuns(trial.runs, genotypes, false);

  // Build the five header rows
  const headerGenotype   = ["Genotype"];
  const headerAnimal     = ["Animal"];
  const headerStatus     = ["Run Status"];
  const headerPartialBin = ["Partial Bin Warning"];  // #4
  const headerIneligible = ["Ineligible Reason"];    // #5

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      headerGenotype.push(g);
      headerAnimal.push(`Animal ${run.animalIndex}`);
      headerStatus.push(RUN_STATUS_LABELS[run.status] ?? run.status);
      headerPartialBin.push(run.partialBinWarning ?? "");
      headerIneligible.push(run.ineligibleReason  ?? "");
    });
    // Blank spacer column between genotypes (not after the last one)
    if (gi < genotypes.length - 1) {
      headerGenotype.push(""); headerAnimal.push(""); headerStatus.push("");
      headerPartialBin.push(""); headerIneligible.push("");
    }
  });

  // Build one row per stimulus
  const rows = [];
  for (let i = 0; i < stimCount; i++) {
    const row = [`Stimulus ${i + 1}`];
    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        // Show blank if this run ended before reaching this stimulus
        // EX-7 fix: guard against null/undefined values array (e.g. partial DB write)
        const vals = run.values ?? [];
        row.push(i < vals.length ? vals[i] : "");
      });
      if (gi < genotypes.length - 1) row.push("");
    });
    rows.push(row);
  }

  return [headerGenotype, headerAnimal, headerStatus, headerPartialBin, headerIneligible, ...rows];
}

/**
 * Builds the binned percentage table for a single trial, with a summary
 * section showing mean ± SEM ± N per genotype per bin (#2).
 *
 * @param {Object} trial - A single trial object with a `runs` array.
 * @param {Object} assay - The parent assay (provides genotypes and binSize).
 * @returns {any[][]} 2D array with raw bins then mean/SEM/N summary rows.
 */
export function buildTrialBinned2D(trial, assay) {
  const { genotypes, binSize } = assay;
  const runsByGenotype = groupAndSortRuns(trial.runs, genotypes, false);

  // Header rows
  const headerGenotype = ["Genotype"];
  const headerAnimal   = ["Animal"];
  const headerStatus   = ["Run Status"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      headerGenotype.push(g);
      headerAnimal.push(`Animal ${run.animalIndex}`);
      headerStatus.push(RUN_STATUS_LABELS[run.status] ?? run.status);
    });
    if (gi < genotypes.length - 1) {
      headerGenotype.push(""); headerAnimal.push(""); headerStatus.push("");
    }
  });

  // Pre-compute binned values for every run
  const binnedByRun = new Map();
  let maxBinCount   = 0;
  trial.runs.forEach(run => {
    const bins = binRunValues(run.values, binSize);
    binnedByRun.set(run, bins);
    maxBinCount = Math.max(maxBinCount, bins.length);
  });

  // Build one raw row and one summary row per bin
  const rawRows     = [];
  const summaryRows = [];
  const summaryHeader = ["Bin"];
  genotypes.forEach(g => summaryHeader.push(`${g}_Mean`, `${g}_SEM`, `${g}_N`));  // #2

  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start    = binIndex * binSize + 1;
    const end      = start + binSize - 1;
    const binLabel = `Bin ${binIndex + 1} (${start}–${end})`;

    // Raw values row
    const rawRow = [binLabel];
    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        const bins = binnedByRun.get(run);
        // EX-9 fix: guard bins being undefined; consistent with optional chain in summary row
        rawRow.push(bins && binIndex < bins.length ? bins[binIndex] : "");
      });
      if (gi < genotypes.length - 1) rawRow.push("");
    });
    rawRows.push(rawRow);

    // Summary (mean ± SEM ± N) row
    const sumRow = [binLabel];
    genotypes.forEach(g => {
      const values = runsByGenotype[g]
        .filter(run => run.eligibleForAnalysis)  // Bug 3: exclude ineligible runs from summary stats
        .map(run => binnedByRun.get(run)?.[binIndex])  // optional chain: run may not be in map
        .filter(v => v !== undefined);
      const { mean, sem } = calculateStats(values);
      sumRow.push(mean, sem, values.length);  // #2
    });
    summaryRows.push(sumRow);
  }

  return [
    headerGenotype, headerAnimal, headerStatus,
    ...rawRows,
    ["", "", ""], ["", "", ""], ["", "", ""],  // Three blank separator rows
    summaryHeader,
    ...summaryRows
  ];
}

/**
 * Builds the Touch Index (binned, raw per-run values) table for a single trial.
 * Runs whose first bin is zero are excluded from TI analysis and flagged.
 *
 * @param {Object} trial - A single trial object with a `runs` array.
 * @param {Object} assay - The parent assay (provides genotypes and binSize).
 * @returns {any[][]} 2D array: [genotypeRow, animalRow, ...binRows]
 */
export function buildTrialTouchIndexBinned2D(trial, assay) {
  const { genotypes, binSize } = assay;
  const runsByGenotype = groupAndSortRuns(trial.runs, genotypes, false);

  const headerGenotype = ["Genotype"];
  const headerAnimal   = ["Animal"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      headerGenotype.push(g);
      headerAnimal.push(`Animal ${run.animalIndex}`);
    });
    if (gi < genotypes.length - 1) {
      headerGenotype.push(""); headerAnimal.push("");
    }
  });

  // Compute Touch Index for each run; exclude those with a zero baseline
  const binnedByRun = new Map();
  let maxBinCount   = 0;

  trial.runs.filter(run => run.eligibleForAnalysis).forEach(run => {
    const binned = binRunValues(run.values, binSize);
    const ti     = computeTouchIndexBins(binned);
    // Runs with a null TI (zero baseline) are excluded from the map;
    // collectTouchIndexExclusions() detects them dynamically without needing
    // these flags to be written here.
    if (ti) {
      binnedByRun.set(run, ti);
      maxBinCount = Math.max(maxBinCount, ti.length);
    }
  });

  const rows = [];
  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start = binIndex * binSize + 1;
    const end   = start + binSize - 1;
    const row   = [`Bin ${binIndex + 1} (${start}–${end})`];

    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        const bins = binnedByRun.get(run);
        row.push(bins && binIndex < bins.length ? bins[binIndex] : "");
      });
      if (gi < genotypes.length - 1) row.push("");
    });
    rows.push(row);
  }

  return [headerGenotype, headerAnimal, ...rows];
}

/**
 * Builds the Touch Index summary (mean ± SEM ± N per genotype per bin) for a single trial (#2).
 *
 * @param {Object} trial - A single trial object with a `runs` array.
 * @param {Object} assay - The parent assay (provides genotypes and binSize).
 * @returns {any[][]} 2D array: [header, ...summaryRows]
 */
export function buildTrialTouchIndexAnalysed2D(trial, assay) {
  const { genotypes, binSize } = assay;

  // Group Touch Index arrays by genotype (only non-excluded runs)
  const runsByGenotype = {};
  genotypes.forEach(g => (runsByGenotype[g] = []));

  trial.runs.filter(run => run.eligibleForAnalysis).forEach(run => {
    const binned = binRunValues(run.values, binSize);
    const ti     = computeTouchIndexBins(binned);
    // Excluded runs (null TI) are silently omitted; collectTouchIndexExclusions handles them.
    if (ti && runsByGenotype[run.genotype]) {
      runsByGenotype[run.genotype].push(ti);
    }
  });

  const maxBinCount = Math.max(
    ...Object.values(runsByGenotype).flat().map(r => r.length),
    0
  );

  const header = ["Bin"];
  genotypes.forEach(g => header.push(`${g}_Mean`, `${g}_SEM`, `${g}_N`));  // #2

  const rows = [];
  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start = binIndex * binSize + 1;
    const end   = start + binSize - 1;
    const row   = [`Bin ${binIndex + 1} (${start}–${end})`];

    genotypes.forEach(g => {
      // Filter out undefined entries (from runs with fewer bins)
      const values        = runsByGenotype[g].map(r => r[binIndex]).filter(v => v != null);
      const { mean, sem } = calculateStats(values);
      row.push(mean, sem, values.length);  // #2
    });
    rows.push(row);
  }

  return [header, ...rows];
}


/* ==========================================================================
   Pooled (Cross-Trial) 2D Builders
   ========================================================================== */

/**
 * Builds the raw stimulus-by-stimulus table across all selected trials (pooled).
 * Identical structure to buildTrialRaw2D but spans multiple trials, adding
 * Trial and Trial Animal header rows.
 *
 * Now includes Partial Bin Warning (#4) and Ineligible Reason (#5) header rows.
 * Accepts pre-collected runs via optional _runs parameter to avoid re-querying
 * when called from buildAllSections (#11).
 *
 * @param {Object}   assay    - The full assay object.
 * @param {Object}   [options]- Filter options passed to collectPooledRuns.
 * @param {Object[]} [_runs]  - Pre-collected runs (optional, avoids re-querying).
 * @returns {any[][]} 2D array with seven header rows then stimulus rows.
 */
export function buildPooledRaw2D(assay, options = {}, _runs = null) {
  const { stimCount, genotypes } = assay;
  const runs           = _runs || collectPooledRuns(assay, options);
  const runsByGenotype = groupAndSortRuns(runs, genotypes, true);

  // Seven header rows for pooled view
  const hGenotype    = ["Genotype"];
  const hAnimal      = ["Animal"];
  const hTrial       = ["Trial"];
  const hTrialAnimal = ["Trial Animal"];
  const hStatus      = ["Run Status"];
  const hPartialBin  = ["Partial Bin Warning"];  // #4
  const hIneligible  = ["Ineligible Reason"];    // #5

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      hGenotype.push(g);
      hAnimal.push(`Animal ${run.globalAnimalIndex}`);
      hTrial.push(`Trial ${run.trialIndex}`);
      hTrialAnimal.push(`Animal ${run.animalIndex}`);
      hStatus.push(RUN_STATUS_LABELS[run.status] ?? run.status);
      hPartialBin.push(run.partialBinWarning ?? "");
      hIneligible.push(run.ineligibleReason  ?? "");
    });
    if (gi < genotypes.length - 1) {
      [hGenotype, hAnimal, hTrial, hTrialAnimal, hStatus, hPartialBin, hIneligible]
        .forEach(h => h.push(""));
    }
  });

  const rows = [];
  for (let i = 0; i < stimCount; i++) {
    const row = [`Stimulus ${i + 1}`];
    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        // EX-7 fix: guard against null/undefined values array (e.g. partial DB write)
        const vals = run.values ?? [];
        row.push(i < vals.length ? vals[i] : "");
      });
      if (gi < genotypes.length - 1) row.push("");
    });
    rows.push(row);
  }

  return [hGenotype, hAnimal, hTrial, hTrialAnimal, hStatus, hPartialBin, hIneligible, ...rows];
}

/**
 * Builds the pooled binned percentage table with mean ± SEM ± N summary rows (#2).
 *
 * Accepts pre-collected runs and a pre-built binning cache to avoid redundant
 * computation when called from buildAllSections (#11).
 *
 * @param {Object}   assay    - The full assay object.
 * @param {Object}   [options]- Filter options.
 * @param {Object[]} [_runs]  - Pre-collected runs (optional).
 * @param {Map}      [_cache] - Pre-built run cache from buildRunCache (optional).
 * @returns {any[][]} 2D array with header rows, raw bin rows, and summary rows.
 */
export function buildPooledBinned2D(assay, options = {}, _runs = null, _cache = null) {
  const { genotypes, binSize } = assay;
  const runs           = _runs || collectPooledRuns(assay, options);
  const runsByGenotype = groupAndSortRuns(runs, genotypes, true);

  const hGenotype    = ["Genotype"];
  const hAnimal      = ["Animal"];
  const hTrial       = ["Trial"];
  const hTrialAnimal = ["Trial Animal"];
  const hStatus      = ["Run Status"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      hGenotype.push(g);
      hAnimal.push(`Animal ${run.globalAnimalIndex}`);
      hTrial.push(`Trial ${run.trialIndex}`);
      hTrialAnimal.push(`Animal ${run.animalIndex}`);
      hStatus.push(RUN_STATUS_LABELS[run.status] ?? run.status);
    });
    if (gi < genotypes.length - 1) {
      [hGenotype, hAnimal, hTrial, hTrialAnimal, hStatus].forEach(h => h.push(""));
    }
  });

  // Use provided cache or build one locally
  const binnedByRun = new Map();
  let maxBinCount   = 0;

  if (_cache) {
    _cache.forEach(({ binned }, run) => {
      binnedByRun.set(run, binned);
      maxBinCount = Math.max(maxBinCount, binned.length);
    });
  } else {
    runs.forEach(run => {
      const bins = binRunValues(run.values, binSize);
      binnedByRun.set(run, bins);
      maxBinCount = Math.max(maxBinCount, bins.length);
    });
  }

  const rawRows     = [];
  const summaryRows = [];
  const summaryHeader = ["Bin"];
  genotypes.forEach(g => summaryHeader.push(`${g}_Mean`, `${g}_SEM`, `${g}_N`));  // #2

  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start    = binIndex * binSize + 1;
    const end      = start + binSize - 1;
    const binLabel = `Bin ${binIndex + 1} (${start}–${end})`;

    // Raw row
    const rawRow = [binLabel];
    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        const bins = binnedByRun.get(run);
        rawRow.push(bins && binIndex < bins.length ? bins[binIndex] : "");
      });
      if (gi < genotypes.length - 1) rawRow.push("");
    });
    rawRows.push(rawRow);

    // Summary row
    const sumRow = [binLabel];
    genotypes.forEach(g => {
      const values = runsByGenotype[g]
        .filter(run => run.eligibleForAnalysis)  // Bug 3: exclude ineligible runs from summary stats
        .map(run => binnedByRun.get(run)?.[binIndex])
        .filter(v => v !== undefined);
      const { mean, sem } = calculateStats(values);
      sumRow.push(mean, sem, values.length);  // #2
    });
    summaryRows.push(sumRow);
  }

  return [
    hGenotype, hAnimal, hTrial, hTrialAnimal, hStatus,
    ...rawRows,
    ["", ""], ["", ""], ["", ""],   // Blank separator rows
    summaryHeader,
    ...summaryRows
  ];
}

/**
 * Builds the pooled Touch Index (raw per-run) table across all selected trials.
 *
 * Accepts pre-collected runs and a pre-built cache to avoid redundant
 * computation when called from buildAllSections (#11).
 *
 * @param {Object}   assay    - The full assay object.
 * @param {Object}   [options]- Filter options passed to collectPooledRuns.
 * @param {Object[]} [_runs]  - Pre-collected runs (optional).
 * @param {Map}      [_cache] - Pre-built run cache (optional).
 * @returns {any[][]} 2D array: [genotypeRow, animalRow, ...binRows]
 */
export function buildPooledTouchIndexBinned2D(assay, options = {}, _runs = null, _cache = null) {
  const { genotypes, binSize } = assay;
  const runs           = _runs || collectPooledRuns(assay, options);
  const runsByGenotype = groupAndSortRuns(runs, genotypes, true);

  const headerGenotype = ["Genotype"];
  const headerAnimal   = ["Animal"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      headerGenotype.push(g);
      headerAnimal.push(`Animal ${run.globalAnimalIndex}`);
    });
    if (gi < genotypes.length - 1) {
      headerGenotype.push(""); headerAnimal.push("");
    }
  });

  // Use provided cache or compute locally
  const tiBinnedByRun = new Map();
  let maxBinCount     = 0;

  if (_cache) {
    _cache.forEach(({ ti }, run) => {
      if (ti && run.eligibleForAnalysis) {  // Bug 3: exclude ineligible runs from TI analysis
        tiBinnedByRun.set(run, ti);
        maxBinCount = Math.max(maxBinCount, ti.length);
      }
    });
  } else {
    runs.filter(run => run.eligibleForAnalysis).forEach(run => {
      const binned = binRunValues(run.values, binSize);
      const ti     = computeTouchIndexBins(binned);
      // Runs with a null TI (zero baseline) are excluded from the map.
      if (ti) {
        tiBinnedByRun.set(run, ti);
        maxBinCount = Math.max(maxBinCount, ti.length);
      }
    });
  }

  const rows = [];
  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start = binIndex * binSize + 1;
    const end   = start + binSize - 1;
    const row   = [`Bin ${binIndex + 1} (${start}–${end})`];

    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        const bins = tiBinnedByRun.get(run);
        row.push(bins && binIndex < bins.length ? bins[binIndex] : "");
      });
      if (gi < genotypes.length - 1) row.push("");
    });
    rows.push(row);
  }

  return [headerGenotype, headerAnimal, ...rows];
}

/**
 * Builds the pooled Touch Index summary (mean ± SEM ± N per genotype per bin) (#2).
 *
 * Accepts pre-collected runs and a pre-built cache to avoid redundant
 * computation when called from buildAllSections (#11).
 *
 * @param {Object}   assay    - The full assay object.
 * @param {Object}   [options]- Filter options passed to collectPooledRuns.
 * @param {Object[]} [_runs]  - Pre-collected runs (optional).
 * @param {Map}      [_cache] - Pre-built run cache (optional).
 * @returns {any[][]} 2D array: [header, ...summaryRows]
 */
export function buildPooledTouchIndexAnalysed2D(assay, options = {}, _runs = null, _cache = null) {
  const { genotypes, binSize } = assay;
  const runs = _runs || collectPooledRuns(assay, options);

  // Group TI arrays by genotype (only non-excluded runs contribute)
  const tiByGenotype = {};
  genotypes.forEach(g => (tiByGenotype[g] = []));

  if (_cache) {
    runs.filter(run => run.eligibleForAnalysis).forEach(run => {
      const entry = _cache.get(run);
      if (entry?.ti && tiByGenotype[run.genotype]) {
        tiByGenotype[run.genotype].push(entry.ti);
      }
    });
  } else {
    runs.filter(run => run.eligibleForAnalysis).forEach(run => {
      const binned = binRunValues(run.values, binSize);
      const ti     = computeTouchIndexBins(binned);
      // Excluded runs (null TI) are silently omitted.
      if (ti && tiByGenotype[run.genotype]) {
        tiByGenotype[run.genotype].push(ti);
      }
    });
  }

  const maxBinCount = Math.max(
    ...Object.values(tiByGenotype).flat().map(r => r.length),
    0
  );

  const header = ["Bin"];
  genotypes.forEach(g => header.push(`${g}_Mean`, `${g}_SEM`, `${g}_N`));  // #2

  const rows = [];
  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start = binIndex * binSize + 1;
    const end   = start + binSize - 1;
    const row   = [`Bin ${binIndex + 1} (${start}–${end})`];

    genotypes.forEach(g => {
      const values        = tiByGenotype[g].map(r => r[binIndex]).filter(v => v != null);
      const { mean, sem } = calculateStats(values);
      row.push(mean, sem, values.length);  // #2
    });
    rows.push(row);
  }

  return [header, ...rows];
}


/* ==========================================================================
   Master Section Builder (#12)
   ========================================================================== */

/**
 * Builds a flat, ordered array of export sections for every selected dataset.
 * Always produces: Assay Metadata first, then trial/pooled sections in config
 * order, then Touch Index Exclusions (if any excluded runs exist).
 *
 * This is the single source of truth consumed by performExcelExport,
 * performCSVExport, and generatePreviewHTML, eliminating ~100 lines of
 * duplicated looping logic (#12).
 *
 * For pooled configs, collectPooledRuns is called once per config and a shared
 * binning cache is passed to all three pooled sub-table builders, avoiding
 * redundant binRunValues calls (#11).
 *
 * @param {Object}   assay         - The full assay object.
 * @param {Object[]} exportConfigs - Array of dataset selection configs from getExportConfigs().
 * @returns {Array<{ name: string, excelSheetName: string, data2D: any[][] }>}
 */
export function buildAllSections(assay, exportConfigs) {
  const sections = [];

  // ── Metadata (always first) ──────────────────────────────────────────────
  sections.push({
    name:           "Assay Metadata",
    excelSheetName: "Assay_Metadata",
    data2D:         buildMetadata2D(assay)
  });

  exportConfigs.forEach(config => {

    // ── Per-trial sections ─────────────────────────────────────────────────
    if (config.type === "trial") {
      const trial = assay.trials.find(t => String(t.trialId) === String(config.trialId));
      if (!trial) return;

      sections.push({
        name:           `Trial ${trial.trialIndex} - Raw`,
        excelSheetName: `Trial_${trial.trialIndex}_Raw`,
        data2D:         buildTrialRaw2D(trial, assay)
      });
      sections.push({
        name:           `Trial ${trial.trialIndex} - Analysed`,
        excelSheetName: `Trial_${trial.trialIndex}_Analysed`,
        data2D:         buildTouchAnalysedSheet2D({
          percentAnalysed2D: buildTrialBinned2D(trial, assay),
          tiBinned2D:        buildTrialTouchIndexBinned2D(trial, assay),
          tiAnalysed2D:      buildTrialTouchIndexAnalysed2D(trial, assay)
        })
      });
    }

    // ── Pooled (cross-trial) sections ──────────────────────────────────────
    if (config.type === "pooled") {
      const suffix   = config.includeAbandoned ? "All Trials"  : "Completed Trials";
      const xlSuffix = config.includeAbandoned ? "AllTrials"   : "CompletedTrials";
      const poolOpt  = { includeAbandoned: config.includeAbandoned };

      // Collect runs once and build a shared binning cache for this config (#11)
      const runs  = collectPooledRuns(assay, poolOpt);
      const cache = buildRunCache(runs, assay.binSize);

      sections.push({
        name:           `Pooled (${suffix}) - Raw`,
        excelSheetName: `Pooled_${xlSuffix}_Raw`,
        data2D:         buildPooledRaw2D(assay, poolOpt, runs)
      });
      sections.push({
        name:           `Pooled (${suffix}) - Analysed`,
        excelSheetName: `Pooled_${xlSuffix}_Analysed`,
        data2D:         buildTouchAnalysedSheet2D({
          percentAnalysed2D: buildPooledBinned2D(assay, poolOpt, runs, cache),
          tiBinned2D:        buildPooledTouchIndexBinned2D(assay, poolOpt, runs, cache),
          tiAnalysed2D:      buildPooledTouchIndexAnalysed2D(assay, poolOpt, runs, cache)
        })
      });
    }
  });

  // ── Touch Index exclusions (appended only if any runs were excluded) ──────
  const tiExclusions = collectTouchIndexExclusions(assay);
  if (tiExclusions.length > 0) {
    sections.push({
      name:           "Touch Index Exclusions",
      excelSheetName: "TouchIndex_Exclusions",
      data2D:         [["Trial", "Genotype", "Animal", "Reason"], ...tiExclusions]
    });
  }

  return sections;
}


/* ==========================================================================
   Master Export Functions
   ========================================================================== */

/**
 * Orchestrates the creation of a multi-sheet Excel workbook and saves it
 * via the OS native Save dialog (Tauri) or a browser download (fallback).
 *
 * All sections are built via buildAllSections() (#12), which also applies
 * the shared run-binning cache for pooled configs (#11).
 *
 * Requires SheetJS (XLSX) to be loaded globally. If XLSX is unavailable,
 * the caller should use performCSVExport() instead.
 *
 * @param {Object}   currentAssay  - The full assay object.
 * @param {Object[]} exportConfigs - Array of dataset selection configs from getExportConfigs().
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function performExcelExport(currentAssay, exportConfigs) {
  // EX-5 fix: guard against XLSX being undefined (CDN failure, CSP block, etc.)
  if (typeof XLSX === "undefined") {
    return { success: false, error: "SheetJS library not loaded. Please check your internet connection and reload." };
  }
  try {
    const wb       = XLSX.utils.book_new();
    const sections = buildAllSections(currentAssay, exportConfigs);

    sections.forEach(({ excelSheetName, data2D }) => {
      const sheet = XLSX.utils.aoa_to_sheet(data2D);

      if (excelSheetName === "Assay_Metadata") {
        sheet["!cols"] = [{ wch: 25 }, { wch: 40 }];
      } else {
        applySheetLayout(sheet, data2D);
      }

      XLSX.utils.book_append_sheet(wb, sheet, excelSheetName);
    });

    const filename = `${currentAssay.assayName || "Assay"}_Export.xlsx`;

    if (window.__TAURI__?.core?.invoke) {
      // Tauri: write buffer to disk via native Save dialog
      const buffer  = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const result  = await window.__TAURI__.core.invoke("save_file", {
        filename,
        data: Array.from(new Uint8Array(buffer))
      });
      if (result === "cancelled") return { success: false, error: "cancelled" };
    } else {
      // Fallback: browser blob download (dev mode outside Tauri)
      XLSX.writeFile(wb, filename);
    }

    return { success: true };

  } catch (err) {
    console.error("Excel export failed:", err);
    return { success: false, error: err.message };
  }
}


/* ==========================================================================
   CSV Fallback Export (No External Dependencies)
   ========================================================================== */

/**
 * Converts a single 2D row into a valid CSV line.
 * Cells containing commas, newlines, or quotes are wrapped in double-quotes,
 * and any existing double-quotes within those cells are escaped as "".
 *
 * @param {any[]} row - Array of cell values.
 * @returns {string} A properly escaped CSV line (no trailing newline).
 */
function arrayToCSVRow(row) {
  return row.map(cell => {
    const val = (cell === null || cell === undefined) ? "" : String(cell);
    if (val.includes(",") || val.includes("\n") || val.includes('"')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  }).join(",");
}

/**
 * Exports assay data as a UTF-8 CSV file.
 * Uses the Tauri native Save dialog when available, falls back to browser
 * blob download when running outside Tauri (e.g. in dev mode).
 *
 * All sections are built via buildAllSections() (#12).
 *
 * Each dataset section is preceded by a "=== Section Name ===" heading line
 * and separated by a blank line, making the file human-readable in a text
 * editor as well as importable into spreadsheet applications.
 *
 * @param {Object}   currentAssay  - The full assay object.
 * @param {Object[]} exportConfigs - Array of dataset selection configs.
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function performCSVExport(currentAssay, exportConfigs) {
  try {
    const sections = buildAllSections(currentAssay, exportConfigs);

    let csv = "";
    sections.forEach((section, i) => {
      if (i > 0) csv += "\n";
      csv += `=== ${section.name} ===\n`;
      section.data2D.forEach(row => {
        csv += (row && row.length > 0) ? arrayToCSVRow(row) + "\n" : "\n";
      });
    });

    const filename = `${currentAssay.assayName || "Assay"}_Export.csv`;

    if (window.__TAURI__?.core?.invoke) {
      // Tauri: write directly to disk via native Save dialog
      const encoder = new TextEncoder();
      const bytes   = encoder.encode(csv);
      const result  = await window.__TAURI__.core.invoke("save_file", {
        filename,
        data: Array.from(bytes)
      });
      if (result === "cancelled") return { success: false, error: "cancelled" };
    } else {
      // Fallback: browser blob download (dev mode outside Tauri)
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    return { success: true };

  } catch (err) {
    console.error("CSV export failed:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Generates the full HTML content for the data preview modal.
 * All sections are built via buildAllSections() (#12).
 *
 * @param {Object}   currentAssay  - The full assay object.
 * @param {Object[]} exportConfigs - Array of dataset selection configs.
 * @returns {string} Complete HTML string ready to inject into the modal container.
 */
export function generatePreviewHTML(currentAssay, exportConfigs) {
  const sections = buildAllSections(currentAssay, exportConfigs);
  return sections
    .map(({ name, data2D }) => buildHtmlTableFrom2D(name, data2D))
    .join("");
}