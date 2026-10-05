// Cancel windows of the player's combat actions (pure, tested in scripts/controls.test.mjs). The times come from the
// clips' meta (anim/library.js): attack `hit` [start, end] and `combo`; dodge `cancel` and `chain`.
//   canAct(kind, s) → may `kind` ('dodge' | 'block' | 'light' | 'heavy') start now?
//   s = { stagger, hitT, blocking, attack: { t, hit, combo } | null, dodge: { t, cancel, chain } | null }
//       hitT = seconds into a hit reaction (-1 when none)
// The rules:
//   · a broken guard (stagger) allows nothing; a hit reaction holds the player a moment (dodge/block 0.12 s, attacks 0.22 s)
//   · dodge: never during an attack's strike (its hit window); a feint in the wind-up or a cancel of the recovery is fine;
//     a second dodge chains from the first one's `chain`
//   · block: cancels an attack once its hit window is over, a dodge once it has travelled (`cancel`)
//   · attacks: not while blocking; out of a dodge from its `cancel`; out of an attack from its `combo` (a light chain)
export const HIT_STUN = { dodge: 0.12, block: 0.12, light: 0.22, heavy: 0.22 };

export function canAct(kind, s) {
  if (s.stagger > 0) return false;
  if (s.hitT >= 0 && s.hitT < HIT_STUN[kind]) return false;
  const at = s.attack, dg = s.dodge;
  const struck = !!(at && at.hit && at.t > at.hit[1]);
  if (kind === 'dodge') {
    if (dg) return dg.t >= (dg.chain ?? Infinity);
    return !at || !at.hit || at.t < at.hit[0] || struck;
  }
  if (dg && dg.t < (dg.cancel ?? Infinity)) return false;
  if (kind === 'block') return !at || struck;
  if (s.blocking) return false;
  return !at || (at.combo > 0 && at.t >= at.combo);
}
