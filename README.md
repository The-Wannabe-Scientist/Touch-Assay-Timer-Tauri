# Touch Assay Timer

> **Precision stimulus–response timing for *C. elegans* touch assay experiments.**

A cross-platform desktop application (macOS & Windows) for recording and analysing mechanosensory touch assays in *Caenorhabditis elegans*. Built with [Tauri](https://tauri.app) (Rust + WebView), it delivers sub-millisecond timing accuracy, crash-safe SQLite persistence, and native OS integration — without a browser, a server, or an internet connection.

---

## Features

- **High-precision timing** — monotonic Rust clock (`std::time::Instant`) eliminates browser timer throttling and tab-suspension jitter
- **Crash-safe storage** — SQLite with WAL mode; data survives power loss mid-trial
- **Metronome-driven protocol** — audio beeps and visual bar lock stimulus delivery to the configured ISI
- **Multi-genotype support** — tag each animal run by genotype; the app tracks counts and animal indices automatically
- **Warmup countdown** — configurable pre-run countdown with audio cues to prepare the experimenter
- **Touch Index analysis** — per-genotype, per-bin response percentages computed at export time
- **Native file export** — Excel (`.xlsx` via SheetJS) and CSV via a native Save As dialog; files land exactly where you choose
- **Saved assays** — all sessions stored locally; resume or export any past assay at any time
- **Screen wake lock** — prevents display sleep during experiments (`caffeinate` on macOS, `SetThreadExecutionState` on Windows)
- **Dark / light mode** — follows OS preference; toggle in Settings
- **No network required** — fully offline after first launch

---

## Platform Support

| Platform | Status |
|---|---|
| macOS (Apple Silicon & Intel) | ✅ Supported |
| Windows 10 / 11 | ✅ Supported (build on Windows) |
| Linux | ⚠️ Compiles, untested |

---

## Getting Started

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| Rust | ≥ 1.77 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Xcode CLT (macOS) | Latest | `xcode-select --install` |

### Run in development

```bash
git clone <repo-url>
cd Touch-Assay-Timer-Tauri
npm install
npm run tauri:dev
```

The app window opens automatically. Frontend changes hot-reload instantly; Rust changes recompile in ~5 seconds.

### Build a production installer

```bash
npm run tauri:build
```

Output:
- **macOS** → `src-tauri/target/release/bundle/dmg/Touch Assay Timer_1.0.0_x64.dmg`
- **Windows** → `src-tauri/target/release/bundle/msi/Touch Assay Timer_1.0.0_x64_en-US.msi`

> **macOS Gatekeeper:** For internal lab use, right-click → Open to bypass the unsigned app warning. For wider distribution, sign with an Apple Developer certificate ($99/yr).

---

## Project Structure

```
Touch-Assay-Timer-Tauri/
├── src-frontend/          # Web UI (HTML + CSS + JS)
│   ├── index.html
│   ├── styles.css
│   └── js/
│       ├── main.js        # State machine & UI logic
│       ├── db.js          # Tauri IPC layer (replaces IndexedDB)
│       ├── export.js      # Excel/CSV generation + native save
│       ├── models.js      # Assay/Trial/Run data models
│       ├── audio.js       # AudioContext beeps & TTS cues
│       ├── timer-worker.js # Web Worker metronome heartbeat
│       ├── toast.js       # In-app notification system
│       └── utils.js       # Shared helpers
│
├── src-tauri/             # Rust backend
│   ├── src/
│   │   ├── main.rs        # App bootstrap, SQLite init, command registry
│   │   ├── database.rs    # SQLite persistence (assays, trials, runs)
│   │   ├── export.rs      # Native Save dialog
│   │   ├── timing.rs      # Monotonic clock IPC
│   │   └── wake_lock.rs   # Display sleep prevention
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/
│       └── default.json
│
├── vite.config.js
└── package.json
```

---

## Data Storage

Data is stored in SQLite at:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/com.touchassay.timer/touch_assay.db` |
| Windows | `%APPDATA%\com.touchassay.timer\touch_assay.db` |

The schema stores assay, trial, and run objects as indexed JSON blobs. WAL mode ensures atomic writes — a crash mid-trial leaves all previous data intact.

---

## Experimental Protocol

1. **Setup** — enter assay name, genotypes, ISI (inter-stimulus interval), stimulus count, and optional temperature/humidity metadata
2. **Configured** — select a genotype from the dropdown; tap the button twice to start (double-tap confirmation prevents accidental starts)
3. **Warmup** — configurable countdown (default 3 s) with audio cues; experimenter positions the worm
4. **Running** — audio metronome fires at the ISI; experimenter taps the button for each positive response; the protocol ends automatically after the configured stimulus count
5. **Between runs** — the app returns to Configured/Poised state; select next genotype or animal
6. **Export** — when the trial is complete, export to Excel (multi-sheet) or CSV via a native Save dialog

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Tap (record response) — active only during a run |

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | HTML5 + Vanilla CSS + ES Modules |
| Build / dev server | Vite 6 |
| Desktop shell | Tauri 2 (Rust + WKWebView / WebView2) |
| Persistence | SQLite via `rusqlite` (bundled) |
| Export | SheetJS (`xlsx`) for Excel; built-in CSV |
| Audio | Web Audio API + Web Speech API |
| Scheduling | Web Worker heartbeat + `requestAnimationFrame` |
| Wake lock | `caffeinate` (macOS) / `SetThreadExecutionState` (Windows) |

---

## Contributing

Pull requests welcome. Please run `cargo check` and `npm run build` before submitting.

---

## License

MIT — see [LICENSE](LICENSE) for details.
