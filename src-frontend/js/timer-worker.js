/**
 * @file timer-worker.js
 * @description Web Worker that acts as an isolated metronome heartbeat.
 *
 * Runs off the main thread to avoid UI jank and browser timer throttling.
 * Posts a "tick" message on every iteration, which the main thread uses to
 * drive the Web Audio scheduler and data recording loop.
 *
 * Architecture — MessageChannel self-post loop:
 *   Instead of setInterval (which is subject to browser clamping/throttling
 *   even inside a Worker), we use a MessageChannel whose port1.onmessage
 *   handler immediately re-posts to port2. MessageChannel callbacks are
 *   processed as microtask-adjacent tasks and run as fast as the Worker
 *   scheduler allows (typically < 1 ms jitter vs. ±5–20 ms for setInterval).
 *
 *   The scheduler() in main.js uses while-loop time guards so it is safe to
 *   be called far more frequently than once per ISI.
 *
 * Communication protocol:
 *   Incoming: "start" → begins the loop
 *             "stop"  → halts the loop
 *   Outgoing: "tick"  → emitted on every loop iteration
 */

/** @type {boolean} Whether the tick loop is currently running. */
let running = false;

/**
 * W-2 fix: generation counter to invalidate stale setTimeout callbacks.
 *
 * Problem: on a rapid stop→start sequence within the 8 ms setTimeout window,
 * a pending setTimeout from the old loop fires after the new loop has already
 * started, posting to port2 a second time and spawning two simultaneous loops.
 *
 * Fix: each loop iteration captures the current generation at the time the
 * setTimeout is scheduled. The callback only re-posts if the generation hasn't
 * changed (i.e. no stop/start occurred in the meantime).
 *
 * @type {number}
 */
let generation = 0;

/**
 * MessageChannel used for the self-post timing loop.
 * port1 is the receiver; posting to port2 queues the next iteration.
 */
const channel = new MessageChannel();

// Explicitly start port1 so it receives messages even if a future refactor
// switches from .onmessage assignment to .addEventListener (W-1 note).
channel.port1.start();

/**
 * Each iteration: emit a tick to the main thread, then schedule the next
 * iteration via an 8 ms setTimeout (~125 Hz ceiling).
 *
 * The setTimeout floor prevents the MessageChannel self-post loop from
 * spinning at thousands of iterations per second, which floods the main
 * thread with postMessage traffic on low-end devices. 8 ms is still 60×
 * faster than the shortest ISI used in practice (≥ 500 ms) so timing
 * accuracy is unaffected — scheduler() uses while-loop time guards and
 * fires on the AudioContext clock regardless of how often it is called.
 *
 * Exits cleanly when `running` is set to false by a "stop" message.
 */
channel.port1.onmessage = () => {
  if (!running) return;
  postMessage("tick");
  // Capture current generation so the callback can self-invalidate if a
  // stop→start pair occurs before this setTimeout fires (W-2 fix).
  const gen = generation;
  setTimeout(() => {
    if (gen === generation) channel.port2.postMessage(null);
  }, 8);  // ~125 Hz ceiling
};

self.onmessage = function (e) {
  if (e.data === "start") {
    if (running) return;  // Guard against duplicate starts
    running = true;
    generation++;                         // Invalidate any pending setTimeout from before
    channel.port2.postMessage(null);      // Kick off the loop

  } else if (e.data === "stop") {
    running = false;
    generation++;                         // Invalidate the pending setTimeout so the loop
                                          // truly stops rather than firing one last time
  }
};