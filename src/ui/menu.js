import { strokeSVG } from './brush.js';
import { t, JP } from './i18n.js';

// Menu navigation shared by every screen. A stack of handlers; the top one receives
// 'up' | 'down' | 'left' | 'right' | 'select' | 'back' from keyboard, gamepad (d-pad, left stick, A/B)
// and mouse (hover + click are handled by the components themselves).

const KEYMAP = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Enter: 'select',
  NumpadEnter: 'select',
  Space: 'select',
  Escape: 'back',
  Backspace: 'back',
};

export class Nav {
  constructor(game, emitSound) {
    this.game = game;
    this.stack = [];
    this.emitSound = emitSound;
    this._pad = { held: {}, next: {}, start: false };
    window.addEventListener('keydown', (e) => this._onKey(e), true);
  }

  push(h) {
    this.stack = this.stack.filter((x) => x !== h);
    this.stack.push(h);
    return h;
  }

  pop(h) {
    this.stack = this.stack.filter((x) => x !== h);
  }

  top() {
    return this.stack[this.stack.length - 1] || null;
  }

  _onKey(e) {
    // let the audio engine unlock inside this user gesture, even if the key is swallowed below
    if (!e.repeat) this.game.emit('ui:gesture');
    const h = this.top();
    if (!h) return;
    const a = KEYMAP[e.code];
    if (!a) {
      if (h.onAnyKey && h.onAnyKey(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (h.onAnyKey && h.onAnyKey(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat && (a === 'select' || a === 'back')) return;
    h.nav(a, e);
  }

  // Gamepad polling (called every rendered frame, even while the simulation is paused). Returns true on the frame Start (the
  // pad's pause button) goes down while no screen has the pad: that press, and only that one, may open the pause. A screen
  // reads Start as `back`, which is what closes the pause, so the press that closed it must not open it again; and a Start
  // that is already down when the last screen goes away is not a press.
  poll(input, nowMs) {
    if (!input.pad.connected) return false;
    const h = this.top();
    const b = input.padButtons;
    const st = !(h && h.ownsSticks); // photo mode flies the camera with the sticks
    const dirs = {
      up: b.has(12) || (st && input.pad.ly < -0.55),
      down: b.has(13) || (st && input.pad.ly > 0.55),
      left: b.has(14) || (st && input.pad.lx < -0.55),
      right: b.has(15) || (st && input.pad.lx > 0.55),
      select: b.has(0),
      back: b.has(1) || b.has(9),
    };
    const start = b.has(9);
    const startDown = start && !this._pad.start;
    this._pad.start = start;
    if (!h) {
      // Nothing listens, but what is held now is not a fresh press for the handler that appears next: a Start still down
      // would read as `back` and close the pause it has just opened, a stick held would move the focus and repeat. Nothing
      // is due until it is let go and pushed again (so no repeat time is kept either, a stale one would fire at once)
      this._pad.held = dirs;
      this._pad.next = {};
      return startDown;
    }
    for (const k in dirs) {
      const on = dirs[k];
      const was = this._pad.held[k];
      const due = this._pad.next[k]; // when a press that a screen has seen repeats; none for a direction held since before
      if (on && !was) {
        if (h.onAnyKey && h.onAnyKey({ code: 'Pad' + k })) {
          /* consumed */
        } else h.nav(k, null);
        this._pad.next[k] = nowMs + 420;
      } else if (on && was && (k === 'up' || k === 'down' || k === 'left' || k === 'right') && due !== undefined && nowMs > due) {
        h.nav(k, null);
        this._pad.next[k] = nowMs + 120;
      }
      this._pad.held[k] = on;
    }
    return false;
  }
}

// Vertical menu of labelled actions with a painted brush mark on the selected entry.
export class Menu {
  constructor({ items, onSelect, onBack, sound, cls = '', seed = 11 }) {
    this.items = items;
    this.onSelect = onSelect;
    this.onBack = onBack;
    this.sound = sound || (() => {});
    this.index = Math.max(0, items.findIndex((i) => !i.disabled && !i.hidden));
    this.el = document.createElement('ul');
    this.el.className = `kz-menu ${cls}`;
    this.el.setAttribute('role', 'menu');
    this.seed = seed;
    this.render();
  }

  visible() {
    return this.items.map((it, i) => ({ it, i })).filter(({ it }) => !it.hidden);
  }

  render() {
    this.el.innerHTML = '';
    this.items.forEach((it, i) => {
      if (it.hidden) return;
      const li = document.createElement('li');
      li.className = 'kz-item';
      li.setAttribute('role', 'menuitem');
      li.dataset.i = i;
      li.innerHTML =
        `<span class="kz-mark">${strokeSVG({ w: 64, h: 11, seed: this.seed + i * 7, tail: 0.5, dry: 4 }, { cls: 'kz-mark-svg' })}</span>` +
        `<span class="kz-label">${t(it.key)}</span>` +
        (JP[it.key] ? `<span class="kz-jp" lang="ja">${JP[it.key]}</span>` : '');
      li.addEventListener('pointerenter', () => this.focus(i, true));
      li.addEventListener('click', (e) => {
        e.stopPropagation();
        this.focus(i, false);
        this.select();
      });
      this.el.appendChild(li);
    });
    this.focus(this.index, false, true);
  }

  focus(i, sound = true, force = false) {
    if (!this.items[i] || this.items[i].disabled || this.items[i].hidden) return;
    if (i === this.index && !force) return;
    this.index = i;
    for (const li of this.el.children) li.classList.toggle('on', Number(li.dataset.i) === i);
    if (sound) this.sound('move');
  }

  move(d) {
    const vis = this.visible().filter(({ it }) => !it.disabled);
    if (!vis.length) return;
    let k = vis.findIndex(({ i }) => i === this.index);
    k = (k + d + vis.length) % vis.length;
    this.focus(vis[k].i);
  }

  select() {
    const it = this.items[this.index];
    if (!it || it.disabled) return;
    this.sound('select');
    this.onSelect && this.onSelect(it);
  }

  nav(a) {
    if (a === 'up') this.move(-1);
    else if (a === 'down') this.move(1);
    else if (a === 'select') this.select();
    else if (a === 'back' && this.onBack) {
      this.sound('back');
      this.onBack();
    }
  }
}

// Rows of settings: 'header' | 'choice' | 'slider' | 'toggle' | 'action'.
//   { type:'choice', key, options:[{value,labelKey}], get, set }
//   { type:'slider', key, min, max, step, get, set, format }
//   { type:'toggle', key, get, set }      { type:'action', key, run }
export class OptionList {
  constructor({ rows, onBack, sound, cls = '' }) {
    this.rows = rows;
    this.onBack = onBack;
    this.sound = sound || (() => {});
    this.index = rows.findIndex((r) => r.type !== 'header' && r.type !== 'note');
    this.el = document.createElement('div');
    this.el.className = `kz-options ${cls}`;
    this.render();
  }

  render() {
    this.el.innerHTML = '';
    this.rows.forEach((r, i) => {
      const row = document.createElement('div');
      row.dataset.i = i;
      if (r.type === 'header') {
        row.className = 'kz-opt-h';
        row.textContent = t(r.key);
      } else if (r.type === 'note') {
        row.className = 'kz-opt-note';
        row.textContent = t(r.key);
      } else {
        row.className = `kz-opt kz-opt-${r.type}`;
        row.innerHTML = `<span class="kz-opt-label">${t(r.key)}</span><span class="kz-opt-val"></span>`;
        row.addEventListener('pointerenter', () => this.focus(i));
        row.addEventListener('click', (e) => this._click(i, e));
        if (r.type === 'slider') this._bindDrag(row, i);
      }
      this.el.appendChild(row);
    });
    this.refresh();
    this.focus(this.index, false, true);
  }

  refresh() {
    for (const row of this.el.children) {
      const r = this.rows[row.dataset.i];
      const val = row.querySelector('.kz-opt-val');
      if (!val) continue;
      if (r.type === 'choice') {
        const cur = r.get();
        const o = r.options.find((x) => x.value === cur) || r.options[0];
        val.innerHTML = `<i class="kz-arrow">‹</i><b>${o.labelKey ? t(o.labelKey) : o.label}</b><i class="kz-arrow">›</i>`;
      } else if (r.type === 'toggle') {
        const on = !!r.get();
        val.innerHTML = `<span class="kz-toggle ${on ? 'on' : ''}"><i></i></span><b>${t(on ? 'on' : 'off')}</b>`;
      } else if (r.type === 'slider') {
        const v = r.get();
        const f = (v - r.min) / (r.max - r.min);
        val.innerHTML =
          `<span class="kz-track"><span class="kz-fill" style="width:${(f * 100).toFixed(1)}%"></span>` +
          `<span class="kz-knob" style="left:${(f * 100).toFixed(1)}%"></span></span><b>${r.format ? r.format(v) : v}</b>`;
      } else if (r.type === 'action') {
        val.innerHTML = r.hint ? `<b>${r.hint()}</b>` : '';
      }
    }
  }

  focus(i, sound = true, force = false) {
    const r = this.rows[i];
    if (!r || r.type === 'header' || r.type === 'note') return;
    if (i === this.index && !force) return;
    this.index = i;
    for (const row of this.el.children) row.classList.toggle('on', Number(row.dataset.i) === i);
    if (sound) this.sound('move');
  }

  move(d) {
    let i = this.index;
    for (let k = 0; k < this.rows.length; k++) {
      i = (i + d + this.rows.length) % this.rows.length;
      const r = this.rows[i];
      if (r.type !== 'header' && r.type !== 'note') break;
    }
    this.focus(i);
  }

  change(d) {
    const r = this.rows[this.index];
    if (!r) return;
    if (r.type === 'choice') {
      const k = r.options.findIndex((o) => o.value === r.get());
      const n = r.options[(k + d + r.options.length) % r.options.length];
      r.set(n.value);
    } else if (r.type === 'toggle') r.set(!r.get());
    else if (r.type === 'slider') {
      const v = Math.min(r.max, Math.max(r.min, r.get() + d * r.step));
      r.set(Math.round(v / r.step) * r.step);
    } else return;
    this.sound('tick');
    this.refresh();
  }

  _click(i, e) {
    this.focus(i, false);
    const r = this.rows[i];
    if (r.type === 'action') {
      this.sound('select');
      r.run();
      return;
    }
    if (r.type === 'choice') {
      const rect = e.currentTarget.querySelector('.kz-opt-val').getBoundingClientRect();
      this.change(e.clientX < rect.left + rect.width / 2 ? -1 : 1);
    } else if (r.type === 'toggle') this.change(1);
  }

  _bindDrag(row, i) {
    const setFrom = (e) => {
      const track = row.querySelector('.kz-track');
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const r = this.rows[i];
      let f = (e.clientX - rect.left) / rect.width;
      f = Math.min(1, Math.max(0, f));
      const v = Math.round((r.min + f * (r.max - r.min)) / r.step) * r.step;
      if (v !== r.get()) {
        r.set(v);
        this.refresh();
      }
    };
    row.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.kz-track')) return;
      e.preventDefault();
      this.focus(i, false);
      row.setPointerCapture(e.pointerId);
      setFrom(e);
      const mv = (ev) => setFrom(ev);
      const up = () => {
        row.removeEventListener('pointermove', mv);
        row.removeEventListener('pointerup', up);
        this.sound('tick');
      };
      row.addEventListener('pointermove', mv);
      row.addEventListener('pointerup', up);
    });
  }

  nav(a) {
    if (a === 'up') this.move(-1);
    else if (a === 'down') this.move(1);
    else if (a === 'left') this.change(-1);
    else if (a === 'right') this.change(1);
    else if (a === 'select') {
      const r = this.rows[this.index];
      if (r && r.type === 'action') {
        this.sound('select');
        r.run();
      } else this.change(1);
    } else if (a === 'back' && this.onBack) {
      this.sound('back');
      this.onBack();
    }
  }
}
