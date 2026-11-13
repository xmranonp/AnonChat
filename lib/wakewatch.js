'use strict';
// Did the computer just wake from sleep? A timer that fires every few seconds notices when far more time than that has passed between two
// ticks: the process was frozen (sleep, hibernation, a suspended virtual machine). Works the same in the desktop app and the web mode,
// on every system, without help from the window. A short pause of a few seconds (a busy computer) is below the threshold and ignored.
// Every dependency is passed in, so it is testable without a clock or timers of its own.

function create({ onWake = () => {}, now = () => Date.now(), tickMs = 2000, thresholdMs = 20000, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let last = now(), timer = null;
  function tick() {
    const t = now(), gap = t - last;
    last = t;
    // A clock set backwards is not a sleep.
    if (gap - tickMs >= thresholdMs) { try { onWake({ gapMs: gap }); } catch {} return true; }
    return false;
  }
  return {
    tick,
    // Asked right before anything is sent: a wake is noticed at once, not up to one tick later (timers that were due during the sleep may
    // fire before the tick does). Only while running: without the timer, a long quiet spell is not a sleep.
    poll() { return timer ? tick() : false; },
    start() { if (timer) return; last = now(); timer = setTimer(tick, tickMs); if (timer && timer.unref) timer.unref(); },
    stop() { if (timer) { clearTimer(timer); timer = null; } },
  };
}

module.exports = { create };
