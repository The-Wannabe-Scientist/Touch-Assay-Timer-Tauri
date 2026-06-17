/**
 * @file toast.js
 * @module Toast
 * @description Lightweight, accessible toast notification system.
 *
 * Usage:
 *   import { showToast } from "./toast.js";
 *   showToast("Run complete!", "success");
 *   showToast("Invalid input", "error", 5000);
 *
 * Types: "success" | "error" | "warning" | "info"
 * Duration: milliseconds (default 3500). Pass 0 for persistent toast.
 *
 * Keyboard behaviour:
 *   Escape  — dismisses the most-recently-added visible toast.
 *             Repeated presses clear the stack one by one.
 *   Enter / Space — dismisses a toast that currently has focus.
 */

/**
 * Inline SVG icon strings for each toast type.
 * Keyed by type name so showToast() can look them up in O(1).
 * @type {Object.<string, string>}
 */
const ICONS = {
  success: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12"/>
  </svg>`,
  error: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
  </svg>`,
  warning: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>`,
  info: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>`,
};

/** @type {HTMLElement|null} Lazily-created container element */
let container = null;

/** @type {boolean} Whether the module-level Escape listener is active */
let keyListenerActive = false;

/**
 * Returns (or creates) the fixed toast container at the bottom of the screen.
 * @returns {HTMLElement}
 */
function getContainer() {
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.setAttribute("role", "region");
    container.setAttribute("aria-label", "Notifications");
    container.setAttribute("aria-live", "polite");
    container.setAttribute("aria-atomic", "false");
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Module-level keydown handler.
 * Escape → dismiss the newest non-exiting toast.
 * Self-removes when no toasts remain so it never leaks.
 *
 * @param {KeyboardEvent} e
 */
function handleGlobalKeydown(e) {
  if (e.key !== "Escape") return;

  const root = getContainer();
  // Collect all toasts that are not already animating out
  const active = Array.from(root.querySelectorAll(".toast:not(.toast--exiting)"));
  if (active.length === 0) {
    // Nothing left — remove the listener
    document.removeEventListener("keydown", handleGlobalKeydown);
    keyListenerActive = false;
    return;
  }

  // Dismiss the last (newest) toast in the stack
  dismiss(active[active.length - 1]);
}

/**
 * Dismisses the newest visible toast, if any.
 * Returns true if a toast was dismissed, false if there were none.
 * Exported so external keydown handlers can call this before routing
 * their own key action (e.g. Space-bar tap) when a toast is on screen.
 *
 * @returns {boolean}
 */
export function dismissLatestToast() {
  const root   = getContainer();
  const active = Array.from(root.querySelectorAll(".toast:not(.toast--exiting)"));
  if (active.length === 0) return false;
  dismiss(active[active.length - 1]);
  return true;
}

/**
 * Ensures the module-level Escape listener is registered (once).
 */
function ensureKeyListener() {
  if (keyListenerActive) return;
  document.addEventListener("keydown", handleGlobalKeydown);
  keyListenerActive = true;
}

/**
 * Shows a toast notification.
 *
 * @param {string} message   - The notification text.
 * @param {"success"|"error"|"warning"|"info"} [type="info"] - Visual style.
 * @param {number} [duration=3500] - Auto-dismiss delay in ms. 0 = persistent.
 * @returns {HTMLElement} The toast element (so callers can dismiss it manually).
 */
export function showToast(message, type = "info", duration = 3500) {
  const root = getContainer();

  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.setAttribute("role", "alert");
  toast.setAttribute("aria-live", "assertive");
  // Make the toast focusable so keyboard users can tab to it
  toast.tabIndex = 0;

  // Inject only static, trusted HTML (icons + button skeleton); user-supplied `message`
  // is set via textContent below to prevent XSS from assay names or reason strings (Bug 1).
  toast.innerHTML = `
    <span class="toast__icon">${ICONS[type] ?? ICONS.info}</span>
    <span class="toast__message"></span>
    <button class="toast__close" type="button" aria-label="Dismiss notification">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
    ${duration > 0 ? `<div class="toast__progress" style="animation-duration:${duration}ms"></div>` : ""}
  `;
  // Set the user-supplied text safely — never via innerHTML
  toast.querySelector(".toast__message").textContent = message;

  // Dismiss on close button click
  toast.querySelector(".toast__close").addEventListener("click", () => dismiss(toast));

  // Enter / Space dismisses a focused toast
  toast.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault(); // prevent Space from scrolling the page
      dismiss(toast);
    }
  });

  // Ensure the module-level Escape handler is active
  ensureKeyListener();

  // Swipe-to-dismiss (touch)
  let touchStartX = 0;
  toast.addEventListener("touchstart", e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  toast.addEventListener("touchend", e => {
    // T-4 fix: changedTouches can be empty in rare multi-touch cancel scenarios;
    // accessing [0] would throw TypeError.
    if (!e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 60) dismiss(toast);
  }, { passive: true });

  root.appendChild(toast);

  // Force reflow so the animation triggers correctly after insertion
  toast.getBoundingClientRect();
  toast.classList.add("toast--visible");

  let timer = null;
  if (duration > 0) {
    timer = setTimeout(() => dismiss(toast), duration);
  }

  // Pause auto-dismiss while the user hovers over the toast.
  // Note: the timer variable is also held by the close-button and Escape handlers
  // via closure, but those paths call dismiss() which guards against double-dismiss
  // using the `toast--exiting` class check. The stale timer firing after an early
  // dismiss is therefore harmless — dismiss() becomes a no-op on the second call.
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
  toast.addEventListener("mouseleave", () => {
    if (duration > 0) timer = setTimeout(() => dismiss(toast), 1000);
  });

  return toast;
}

/**
 * Removes a toast from the DOM with an exit animation.
 * If it was the last toast, also cleans up the global key listener.
 * @param {HTMLElement} toast
 */
function dismiss(toast) {
  if (toast.classList.contains("toast--exiting")) return;
  toast.classList.add("toast--exiting");

  function cleanup() {
    toast.remove();
    // If the container is now empty, remove the global listener
    const root = container;
    if (root && root.querySelectorAll(".toast:not(.toast--exiting)").length === 0) {
      document.removeEventListener("keydown", handleGlobalKeydown);
      keyListenerActive = false;
    }
  }

  // Fallback timeout in case the CSS exit animation is missing or instant
  // (e.g. prefers-reduced-motion: reduce without a duration override)
  const fallback = setTimeout(cleanup, 500);
  toast.addEventListener("animationend", () => {
    clearTimeout(fallback);
    cleanup();
  }, { once: true });
}
