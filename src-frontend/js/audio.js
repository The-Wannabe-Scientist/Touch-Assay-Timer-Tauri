/**
 * @file audio.js
 * @module AudioController
 * @description Manages all audio output for the assay timer.
 *
 * Responsibilities:
 *   - Web Audio API: precise hardware-scheduled metronome ticks and tones.
 *   - Web Speech API: optional voice countdown per stimulus.
 *   - Completion feedback: ascending two-tone chime at run end.
 *
 * Architecture note — the scheduler uses a two-layer approach:
 *   Layer 1 (hardware): scheduleWebAudioTick() pre-schedules beeps slightly
 *     in the future using the AudioContext clock, achieving sub-millisecond
 *     timing accuracy regardless of the JS thread being busy.
 *   Layer 2 (voice/UI): triggerImmediateSpeech() fires at the exact moment
 *     the stimulus window opens so speech aligns with the visual display.
 */


/* ==========================================================================
   Module-level State
   ========================================================================== */

// ── Web Audio state ──────────────────────────────────────────────────────────

/** @type {AudioContext|null} Shared audio context — created once on first use. */
let audioCtx = null;

/** @type {GainNode|null} Master gain node — all oscillators route through this. */
let masterGain = null;

/** @type {SpeechSynthesisVoice|null} The selected TTS voice, or null if unavailable. */
let selectedVoice = null;
/** @type {number} Frequency in Hz for the metronome tick tone. */
let tickPitch = 900;

/**
 * Controls which audio cues are emitted per stimulus.
 * "tick"  — play a short beep every stimulus.
 * "count" — speak the stimulus number aloud every stimulus.
 * "tens"  — speak only on multiples of 10; tick otherwise.
 * "bins"  — tick every stimulus; speak only at each bin-size boundary.
 * @type {"tick"|"count"|"tens"|"bins"}
 */
let voiceMode = "tick";

/**
 * Bin size used by "bins" voice mode — speaks once every N stimuli.
 * Updated at the start of each run via setBinSpeak() so it always
 * reflects the active assay's bin size.
 * @type {number}
 */
let binSpeakSize = 10;

/** @type {{ rate: number, pitch: number, lang: string }} TTS configuration. */
let speechConfig = { rate: 1.0, pitch: 1.0, lang: "en" };

/** @type {boolean} True once the AudioContext has been resumed after a user gesture. */
let isReady = false;

// ── Speech state ─────────────────────────────────────────────────────────────


/* ==========================================================================
   Public Getters & Setters
   ========================================================================== */

/** @returns {boolean} Whether the audio context is running and ready for scheduling. */
export const isAudioReady = () => isReady;

/**
 * Changes the active voice/cue mode.
 * @param {"tick"|"count"|"tens"|"bins"} mode - The desired cue mode.
 */
export function setVoiceMode(mode) {
  voiceMode = mode;
}

/**
 * Sets the bin-boundary interval used by "bins" voice mode.
 * Call this at the start of each run with the active assay's binSize so
 * spoken cues land exactly on bin boundaries regardless of the assay config.
 * @param {number} n - Number of stimuli per bin (must be >= 1).
 */
export function setBinSpeak(n) {
  binSpeakSize = Math.max(1, n);
}

/**
 * Sets the tick tone frequency.
 * Clamped to [100, 4000] Hz to stay within useful audible range.
 * @param {number} hz - Desired frequency in Hz.
 */
export function setTickPitch(hz) {
  tickPitch = Math.max(100, Math.min(4000, hz));
}

/** @returns {number} The current tick frequency in Hz. */
export function getTickPitch() { return tickPitch; }

/**
 * Merges new speech settings and refreshes the selected voice.
 * @param {{ rate?: number, pitch?: number, lang?: string }} config - Partial config to merge.
 */
export function configureSpeech(config) {
  speechConfig = { ...speechConfig, ...config };
  loadVoices();
}


/* ==========================================================================
   Voice Initialisation
   ========================================================================== */

/**
 * Selects the best available TTS voice for the configured language.
 * Prefers Google voices for higher quality; falls back to any matching
 * language, then to the first available voice on the system.
 *
 * Called on init and again when the browser's voice list changes
 * (which can happen asynchronously on some browsers).
 */
export function loadVoices() {
  const voices = speechSynthesis.getVoices();
  if (voices.length === 0) return;  // List not ready yet; will retry via onvoiceschanged

  selectedVoice =
    voices.find(v => v.lang.startsWith(speechConfig.lang) && v.name.includes("Google")) ||
    voices.find(v => v.lang.startsWith(speechConfig.lang)) ||
    voices[0] ||
    null;
}

// M5 fix: speechSynthesis is not available in all browser environments
// (some WebViews, embedded browsers). Accessing it at module load time without
// a guard crashes the entire module, taking down the whole application.
if (typeof speechSynthesis !== "undefined") {
  // Browsers load voices asynchronously; listen for when the list is populated
  speechSynthesis.onvoiceschanged = loadVoices;
  // Synchronously attempt to load if the list is already available (common on desktop)
  if (speechSynthesis.getVoices().length > 0) loadVoices();
}


/* ==========================================================================
   Web Audio Context
   ========================================================================== */

/**
 * Lazily creates and returns the shared AudioContext.
 * Must be called from a user gesture context on first use (or after warmUpAudio).
 *
 * @returns {AudioContext} The shared audio context.
 */
function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Route all oscillators through a single master gain node.
    // Note: Volume control is not needed in this app because device hardware volume
    // buttons provide sufficient control for users. Default gain is 1.0 (full volume).
    masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
  }
  // H4 fix: enforce the invariant that audioCtx non-null ⇒ masterGain non-null.
  // If masterGain was somehow lost (e.g. context recycled by a future refactor),
  // re-create it so tone functions don't crash on gain.connect(masterGain).
  if (!masterGain) {
    masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
  }
  return audioCtx;
}

/**
 * Resumes the AudioContext after a user gesture.
 * Browsers suspend the context by default until user interaction.
 * Should be called on the first tap/keypress.
 *
 * @returns {Promise<void>} Resolves when the context is running.
 */
export function warmUpAudio() {
  if (isReady) return Promise.resolve();  // Already running — no-op
  const ctx = getAudioContext();
  return ctx.resume()
    .then(() => { isReady = true; })
    .catch(err => {
      // Log the cause but re-throw so callers can surface a user-facing error.
      // Swallowing here would let execution continue with a suspended context,
      // causing getAudioTime() to return 0 and all scheduled ticks to misfire.
      console.warn("Audio context resume blocked by browser policy.", err);
      throw err;
    });
}

/**
 * Monotonic high-water mark for AudioContext time.
 * Some browser implementations can briefly return a stale or regressed
 * currentTime after suspend → resume. This variable ensures getAudioTime()
 * never returns a value smaller than a previously returned one.
 * @type {number}
 */
let lastMonotonicTime = 0;

/**
 * Returns the current hardware clock time from the AudioContext.
 * This is used as the reference for all scheduled audio events and
 * for recording tap timestamps in sync with audio.
 *
 * Includes a monotonic guard: if AudioContext.currentTime briefly regresses
 * (e.g. after a suspend → resume cycle on some WebKit builds), the last
 * known-good value is returned instead. This prevents the scheduler's gap
 * detector from firing a false positive and aborting the run.
 *
 * @returns {number} Current AudioContext time in seconds (monotonically non-decreasing).
 */
export function getAudioTime() {
  const t = getAudioContext().currentTime;
  if (t > lastMonotonicTime) lastMonotonicTime = t;
  return lastMonotonicTime;
}

// When the app returns to the foreground after backgrounding, the
// AudioContext may have been suspended. Resume it automatically.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(err =>
      console.warn("Could not resume audio context on visibility restore.", err)
    );
  }
});


/* ==========================================================================
   Speech Synthesis
   ========================================================================== */

/**
 * Speaks the given text immediately, cancelling any in-flight utterance first.
 *
 * Cancelling before speaking is intentional: if the scheduler fires before
 * the previous utterance has finished (e.g. short ISI), the old speech would
 * queue and drift out of sync with the visual display. Cancelling forces
 * immediate delivery of the new cue.
 *
 * @param {string} text - The text to speak.
 */
export function speak(text) {
  if (typeof speechSynthesis === "undefined") return;
  // Lazy-init guard: on Chrome, voiceschanged fires asynchronously after page load.
  // If speak() is called before the event fires, selectedVoice is still null.
  // Attempt to populate it now — this succeeds once the browser's voice list is ready.
  if (!selectedVoice) loadVoices();

  speechSynthesis.cancel();  // Flush any queued utterances to prevent lag drift

  // Safari (and some Chromium builds) silently drop a speak() call issued in
  // the same task as cancel(). Deferring via queueMicrotask ensures the cancel
  // completes before the new utterance is enqueued, while avoiding the 1–16 ms
  // latency penalty of setTimeout(fn, 0) which is subject to browser clamping.
  // Microtasks run at the end of the current task — effectively ~0 ms delay —
  // and are more than offset by the SPEECH_LEAD_TIME advance in main.js.
  queueMicrotask(() => {
    const utterance = new SpeechSynthesisUtterance(text);
    if (selectedVoice)         utterance.voice = selectedVoice;
    utterance.rate  = speechConfig.rate;
    utterance.pitch = speechConfig.pitch;
    speechSynthesis.speak(utterance);
  });
}

/**
 * Primes the TTS engine with a silent, zero-volume utterance so the browser
 * initialises its synthesis pipeline before the first real cue fires.
 *
 * The very first speechSynthesis.speak() call incurs a cold-start penalty of
 * 50–300 ms on most platforms (Chrome Android, iOS Safari, etc.). Calling
 * primeSpeechEngine() during the warmup countdown absorbs this latency so
 * all run-time utterances benefit from a warm engine.
 *
 * Call this once at the start of the warmup countdown (or immediately before
 * startCueLoop() when warmup is disabled).
 */
export function primeSpeechEngine() {
  if (typeof speechSynthesis === "undefined") return;
  if (!selectedVoice) loadVoices();
  const u = new SpeechSynthesisUtterance(" ");  // Single space — inaudible
  if (selectedVoice) u.voice = selectedVoice;
  u.volume = 0;  // Silent
  speechSynthesis.speak(u);
}

/**
 * Stops any speech that is currently being spoken or queued.
 */
export function stopSpeech() {
  if (typeof speechSynthesis === "undefined") return;
  speechSynthesis.cancel();
}


/* ==========================================================================
   Tone Generators
   ========================================================================== */

/**
 * Schedules a short, sharp metronome tick at a precise hardware time.
 *
 * Uses a sine oscillator with a fast exponential decay (attack-less) to
 * produce a clean click-like sound. The oscillator node is self-disposing
 * once stopped.
 *
 * @param {number|null} exactTime - AudioContext time to play the tick.
 *   If null, plays immediately at ctx.currentTime.
 */
export function playTick(exactTime = null) {
  const ctx  = getAudioContext();
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  const time = exactTime !== null ? exactTime : ctx.currentTime;

  osc.type            = "sine";
  osc.frequency.value = tickPitch;  // Configurable via setTickPitch()

  gain.gain.setValueAtTime(0.25, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);  // 50ms decay

  osc.connect(gain);
  gain.connect(masterGain);

  osc.start(time);
  osc.stop(time + 0.05);  // Node auto-disconnects after stopping
  // L3 fix: disconnect the GainNode after the oscillator ends so it is released
  // from the audio graph and eligible for GC on long-running sessions.
  osc.onended = () => gain.disconnect();
}

/**
 * Schedules a warmup countdown tone at a precise hardware time.
 * Uses a higher amplitude and longer sustain than the regular tick to
 * be clearly distinguishable during the pre-run countdown.
 *
 * @param {number}      frequency - Tone frequency in Hz.
 * @param {number|null} exactTime - AudioContext time to play the tone.
 */
export function playWarmupTone(frequency, exactTime = null) {
  const ctx  = getAudioContext();
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  const time = exactTime !== null ? exactTime : ctx.currentTime;

  osc.type            = "sine";
  osc.frequency.value = frequency;

  gain.gain.setValueAtTime(0.2, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);  // 300ms sustain

  osc.connect(gain);
  gain.connect(masterGain);

  osc.start(time);
  osc.stop(time + 0.3);
  // L3 fix: release GainNode from audio graph after oscillator stops
  osc.onended = () => gain.disconnect();
}

/**
 * Plays a two-tone ascending chime to signal that a run has completed.
 *
 * The two notes are staggered by 150ms to create an ascending "ding-dong"
 * effect that is easily distinguishable from both the metronome tick and
 * the warmup beep, even in a noisy lab environment.
 */
export function playCompletionTone() {
  const ctx  = getAudioContext();
  const time = ctx.currentTime;

  // Schedule both notes relative to the current time
  [800, 1200].forEach((freq, i) => {
    const osc     = ctx.createOscillator();
    const gain    = ctx.createGain();
    const startAt = time + i * 0.15;  // 0ms and 150ms offsets

    osc.type            = "sine";
    osc.frequency.value = freq;

    gain.gain.setValueAtTime(0.3, startAt);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.3);

    osc.connect(gain);
    gain.connect(masterGain);

    osc.start(startAt);
    osc.stop(startAt + 0.3);
    // L3 fix: release GainNode from audio graph after oscillator stops
    osc.onended = () => gain.disconnect();
  });
}


/* ==========================================================================
   Decoupled Metronome Controllers
   ========================================================================== */

/**
 * Layer 1 — Hardware Audio Scheduler.
 *
 * Called slightly ahead of the actual stimulus time (lookahead scheduling).
 * Schedules the beep precisely on the AudioContext hardware clock, which is
 * immune to main-thread jank and timer throttling.
 *
 * In "count" mode with a fast ISI (< 1s) the tick is always played because
 * speech would not have time to complete before the next stimulus.
 *
 * @param {number} stimulusIndex - 1-based stimulus number being scheduled.
 * @param {number} assayIsi      - ISI of the active assay in seconds.
 * @param {number} exactTime     - AudioContext timestamp to schedule the beep.
 */
export function scheduleWebAudioTick(stimulusIndex, assayIsi, exactTime) {
  // Fast ISI override: always tick even in count mode (speech can't keep up)
  if (voiceMode === "count" && assayIsi < 1) {
    playTick(exactTime);
    return;
  }

  switch (voiceMode) {
    case "tick":
      // Tick on every stimulus
      playTick(exactTime);
      break;

    case "count":
      // No hardware tick in count mode — speech fires in triggerImmediateSpeech.
      // (Fast-ISI override above already plays a tick when speech can't keep up.)
      break;

    case "tens":
      // Tick on all stimuli that are NOT multiples of 10
      // (multiples will have speech instead, scheduled in triggerImmediateSpeech)
      if (stimulusIndex % 10 !== 0) playTick(exactTime);
      break;

    case "bins":
      // Always tick every stimulus — speech fires separately at bin boundaries
      playTick(exactTime);
      break;
  }
}

/**
 * Layer 2 — Immediate Speech / Voice Trigger.
 *
 * Called at the exact moment a new stimulus window opens (not pre-scheduled).
 * Speech is triggered synchronously with the UI update so both the visual
 * counter and the spoken number appear at the same instant.
 *
 * @param {number} stimulusIndex - 1-based stimulus number to announce.
 * @param {number} assayIsi      - ISI of the active assay in seconds.
 */
export function triggerImmediateSpeech(stimulusIndex, assayIsi) {
  // Fast ISI: speech can't complete before the next tick — skip all voice modes
  if (assayIsi < 1) return;

  switch (voiceMode) {
    case "count":
      // Speak the stimulus number on every interval
      speak(String(stimulusIndex));
      break;

    case "tens":
      if (stimulusIndex % 10 === 0) {
        // Speak on multiples of 10
        speak(String(stimulusIndex));
      } else if (speechSynthesis.speaking || speechSynthesis.pending) {
        // Flush any overrunning speech from the previous multiple-of-10.
        // Without this, a spoken "10" or "20" can still be playing when the
        // next tick fires on short ISIs (≈ 1 s), causing audible overlap.
        // Guarded behind speaking/pending check to avoid no-op cancel() churn
        // which can cause the speech engine to needlessly re-initialise on
        // some platforms.
        speechSynthesis.cancel();
      }
      break;

    case "bins":
      // Speak the stimulus number only when it lands exactly on a bin boundary
      // (i.e. is a multiple of binSpeakSize). All other stimuli just get the
      // hardware tick scheduled by scheduleWebAudioTick — no speech needed.
      if (stimulusIndex % binSpeakSize === 0) {
        speak(String(stimulusIndex));
      } else if (speechSynthesis.speaking || speechSynthesis.pending) {
        // Flush any overrun from the previous bin-boundary utterance so it
        // doesn't bleed into the following tick interval.
        // Guarded to avoid needless cancel() calls on every non-boundary tick.
        speechSynthesis.cancel();
      }
      break;

    // "tick" mode: no speech — tick only, handled in scheduleWebAudioTick
  }
}