// Input buffer: a press made shortly before its action becomes legal is kept for `window` seconds and fires as soon
// as the action is legal (an attack pressed during a dodge strikes the moment the dodge can be cancelled). Times are
// game seconds, so slow motion and hit-stop stretch the window together with the action it waits on.
//   buf.press(name, now)       remember a press (a newer press of the same action replaces the older one)
//   buf.has(name, now)         a press of `name` younger than the window is waiting
//   buf.take(name, now)        has() + forget it
//   buf.newest(names, now)     the most recent live press among `names`, or null
//   buf.clear(name?)           forget one action, or all of them

export class ActionBuffer {
  constructor(window = 0.2) {
    this.window = window;
    this.presses = new Map(); // name → game time of the press
  }

  press(name, now) {
    this.presses.set(name, now);
  }

  has(name, now) {
    const t = this.presses.get(name);
    if (t === undefined) return false;
    if (now - t > this.window) {
      this.presses.delete(name);
      return false;
    }
    return true;
  }

  take(name, now) {
    const ok = this.has(name, now);
    this.presses.delete(name);
    return ok;
  }

  newest(names, now) {
    let best = null, bt = -Infinity;
    for (const n of names) {
      if (!this.has(n, now)) continue;
      const t = this.presses.get(n);
      if (t > bt) (bt = t), (best = n);
    }
    return best;
  }

  clear(name) {
    if (name === undefined) this.presses.clear();
    else this.presses.delete(name);
  }
}
