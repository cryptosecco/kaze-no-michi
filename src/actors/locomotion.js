// Player locomotion rules, free of the scene so they can be tested on their own (scripts/controls.test.mjs).
//   SPEED / topSpeed(state)   top speed (m/s) for the sword's state and the gait asked for
//   slopeFactor(grade)        uphill slower, downhill a touch faster
//   SprintControl             sprint intent from Shift (hold / toggle), the pad's L3 click and its held dodge button

// Sheathed: walk · run · sprint. Sword drawn: guard (blocking) · strafe (the short gliding footwork, sideways or back
// while facing the framed foe) · drawnRun (moving freely, or straight at the foe) · combatSprint (repositioning or
// escaping mid-fight; out of combat a sprint sheathes the blade instead).
export const SPEED = { walk: 1.6, run: 4.0, sprint: 6.4, guard: 2.1, strafe: 2.3, drawnRun: 3.8, combatSprint: 5.0 };

// strafe: 0..1 (or a boolean), how much of the drawn movement is footwork around the foe rather than a run at him
export function topSpeed({ drawn = false, sprint = false, walk = false, guard = false, strafe = 0 } = {}) {
  if (guard) return SPEED.guard;
  if (sprint) return drawn ? SPEED.combatSprint : SPEED.sprint;
  if (walk) return SPEED.walk;
  if (!drawn) return SPEED.run;
  const k = Math.min(1, Math.max(0, +strafe));
  return SPEED.drawnRun + (SPEED.strafe - SPEED.drawnRun) * k;
}

// grade = rise / run along the motion: up to 20 % slower uphill (stairs included), up to 5 % faster downhill
export function slopeFactor(grade) {
  return grade > 0 ? 1 - Math.min(0.2, grade * 0.5) : 1 + Math.min(0.05, -grade * 0.12);
}

// Sprint intent, input by input:
//   keyboard Shift    mode 'hold' (sprint while held, default) or 'toggle' (a press starts it; the next press, or the
//                     movement keys going idle, ends it) — game.settings.sprintMode
//   pad L3 click      toggles it, until the stick comes back to neutral
//   pad dodge button  tap = dodge, hold = sprint (the samurai-game habit). In combat the press dodges at once and
//                     holding on sprints out of the dodge; out of combat the press starts the sprint and a tap dodges
//                     on release (no latency where a dodge matters).
// Presses are edges from the input layer, so a button still down from a menu (B = back) is not a new press.
// update(dt, input) → { sprint, dodge }: dodge = the pad's dodge button asks for a dodge this frame.
export class SprintControl {
  constructor({ tap = 0.2, grace = 0.2 } = {}) {
    this.mode = 'hold';
    this.tap = tap; // longest press of the pad's dodge button that still counts as a tap
    this.grace = grace; // the movement input may pass through neutral this long (a reversal) before a toggle ends
    this.keyOn = false;
    this.padOn = false;
    this.held = -1; // seconds the pad's dodge button has been down since its press (-1 = up)
    this.heldDodged = false; // that press already dodged (it went down in combat)
    this.still = 0; // seconds without movement input
  }

  update(dt, { key = false, keyPressed = false, padClick = false, padDodge = false, padDodgePressed = false, moving = false, combat = false } = {}) {
    let dodge = false;
    this.still = moving ? 0 : this.still + dt;
    // a toggle press arms the sprint for `grace` seconds, so it can come just before the movement does
    if (keyPressed && this.mode === 'toggle') (this.keyOn = !this.keyOn), (this.still = 0);
    if (padClick) (this.padOn = !this.padOn), (this.still = 0);
    if (this.mode !== 'toggle') this.keyOn = key;
    else if (this.still > this.grace) this.keyOn = false;
    if (this.still > this.grace) this.padOn = false;
    if (padDodgePressed) {
      this.held = 0;
      this.heldDodged = combat;
      dodge = combat;
    } else if (padDodge && this.held >= 0) this.held += dt;
    else if (!padDodge && this.held >= 0) {
      dodge = !this.heldDodged && this.held < this.tap;
      this.held = -1;
    }
    const sprint = moving && (this.keyOn || this.padOn || this.held >= 0);
    return { sprint, dodge };
  }

  reset() {
    this.keyOn = this.padOn = false;
    this.held = -1;
    this.still = 0;
  }
}
