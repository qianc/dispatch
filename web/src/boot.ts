/**
 * The app runs: tell public/boot-watchdog.js, and take away its "Dispatch did not start" overlay if
 * a slow load put it up already (DISP-246).
 */
export function markStarted() {
  (window as unknown as { __dispatchStarted: boolean }).__dispatchStarted = true;
  document.getElementById('boot-fail')?.remove();
}
