import { strokeSVG, inkText } from './brush.js';
import { t } from './i18n.js';
import { Menu } from './menu.js';

// Full-screen and centred cards painted in ink:
//   quest title card ('quest:update' with a new id, 'quest:start', 'quest:complete' {id,title,titleJp}),
//   queued so "tale complete" is never overwritten by the next tale's card
//   toast ('toast' {text}, 'blessing')             standoff overlay ('standoff:start' / 'standoff:end')
//   death card ('player:death'; the actors module respawns the player itself → hidden on 'respawn')
//   ending card ('ending' {title, text}) with a return-to-title menu        credits (title menu)

// Brush titles for the quest chain (ids from src/actors/quest/Quests.js); events may override with titleJp.
const QUEST_JP = { shrine: '風の導き', camp: '銀杏の谷', cliff: '崖の夕陽' };

export class Cards {
  constructor(ui) {
    this.ui = ui;
    const game = (this.game = ui.game);
    this.root = document.createElement('div');
    this.root.className = 'kz-layer kz-cards show';

    this.quest = div('kz-card');
    this.quest.innerHTML = `<div class="kz-eyebrow"></div><div class="kz-card-jp kz-inkwrap"></div><div class="kz-card-title"></div>${strokeSVG(
      { w: 260, h: 10, seed: 64, tail: 0.55, dry: 6 },
      { cls: 'kz-card-rule' }
    )}`;
    this.toastEl = div('kz-toast');
    this.root.append(this.quest, this.toastEl);

    this.standoff = layer('kz-standoff');
    this.standoff.innerHTML = `<div class="kz-so-wash kz-shade"></div><div class="kz-so-kanji kz-inkwrap">${inkText('対峙')}</div><div class="kz-so-hint"></div>`;

    this.death = layer('kz-fullcard kz-death');
    this.death.innerHTML = `<div><div class="kz-big kz-inkwrap">${inkText('散')}</div><div class="kz-line"></div><div class="kz-subline"></div></div>`;

    this.ending = layer('kz-fullcard kz-ending');
    this.ending.innerHTML = `<div><div class="kz-big kz-inkwrap">${inkText('終')}</div><div class="kz-line"></div><div class="kz-subline"></div><div class="kz-end-menu"></div></div>`;

    this.credits = layer('kz-credits');
    this.credits.innerHTML = `<div class="kz-cred"></div>`;

    this.layers = [this.root, this.standoff, this.death, this.ending, this.credits];
    this._queue = [];
    this._cardBusy = false;
    this._toastTimer = 0;
    this._lastQuest = null;

    const jp = (d) => d.titleJp || QUEST_JP[d.id] || '';
    game.on('quest:update', (e) => {
      const d = e.detail || {};
      if (d.id && d.id !== this._lastQuest && d.title) this.questCard(t('newQuest'), d.title, jp(d));
      if (d.id) this._lastQuest = d.id;
    });
    game.on('quest:start', (e) => {
      const d = e.detail || {};
      if (d.id === this._lastQuest) return;
      this._lastQuest = d.id || this._lastQuest;
      if (d.title) this.questCard(t('newQuest'), d.title, jp(d));
    });
    game.on('quest:complete', (e) => {
      const d = e.detail || {};
      this.questCard(t('questDone'), d.title || '', jp(d), true);
    });
    game.on('toast', (e) => this.toast((e.detail && e.detail.text) || ''));
    game.on('blessing', () => this.toast(t('blessing')));
    game.on('standoff:start', () => this.showStandoff(true));
    game.on('standoff:end', () => this.showStandoff(false));
    game.on('player:death', () => this.showDeath());
    game.on('respawn', () => this.hideDeath());
    game.on('player:respawn', () => this.hideDeath());
    game.on('ending', (e) => this.showEnding(e.detail || {}));
    game.on('state', (e) => {
      if (e.detail && e.detail.state === 'title') this.reset();
    });
  }

  // Cards queue up: a completed tale finishes its moment before the next tale is announced.
  questCard(eyebrow, title, jp, priority = false) {
    const card = { eyebrow, title, jp };
    if (priority) this._queue.unshift(card);
    else this._queue.push(card);
    if (!this._cardBusy) this._nextCard();
  }

  _nextCard() {
    const c = this._queue.shift();
    if (!c) {
      this._cardBusy = false;
      return;
    }
    this._cardBusy = true;
    const q = this.quest;
    q.querySelector('.kz-eyebrow').textContent = c.eyebrow;
    const jpEl = q.querySelector('.kz-card-jp');
    jpEl.innerHTML = c.jp ? inkText(c.jp) : '';
    jpEl.style.display = c.jp ? '' : 'none';
    q.querySelector('.kz-card-title').textContent = c.title;
    q.classList.remove('show');
    void q.offsetWidth;
    q.classList.add('show');
    this._cardTimer = setTimeout(() => {
      q.classList.remove('show');
      this._cardTimer = setTimeout(() => this._nextCard(), 1300);
    }, 4600);
  }

  reset() {
    clearTimeout(this._cardTimer);
    this._queue = [];
    this._cardBusy = false;
    this._lastQuest = null;
    this.quest.classList.remove('show');
    this.standoff.classList.remove('show');
    this.hideDeath();
  }

  toast(text) {
    if (!text) return;
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 2600);
  }

  showStandoff(on) {
    this.standoff.querySelector('.kz-so-hint').textContent = t('standoffHint');
    this.standoff.classList.toggle('show', on);
  }

  showDeath() {
    this.death.querySelector('.kz-line').textContent = t('deathLine');
    this.death.querySelector('.kz-subline').textContent = t('deathSub');
    this.death.classList.add('show');
    this.ui.hud.hide();
  }

  hideDeath() {
    if (!this.death.classList.contains('show')) return;
    this.death.classList.remove('show');
    if (this.game.state === 'play') this.ui.hud.show();
  }

  showEnding({ title, text } = {}) {
    this.ending.querySelector('.kz-line').textContent = text || t('endingLine');
    this.ending.querySelector('.kz-subline').textContent = title || t('endingThanks');
    const wrap = this.ending.querySelector('.kz-end-menu');
    const menu = new Menu({
      items: [{ id: 'title', key: 'quitTitle' }],
      seed: 91,
      sound: this.ui.sound,
      onSelect: () => {
        this.ui.nav.pop(menu);
        this.ending.classList.remove('show', 'kz-interactive');
        this.ui.quitToTitle();
      },
    });
    wrap.innerHTML = '';
    wrap.appendChild(menu.el);
    this.ending.classList.add('show', 'kz-interactive');
    this.ui.hud.hide();
    setTimeout(() => this.ui.nav.push(menu), 2400);
  }

  showCredits(onClose) {
    const box = this.credits.querySelector('.kz-cred');
    box.innerHTML =
      `<h2>${t('creditsTitle')}</h2>` +
      t('creditsLines')
        .map(([a, b]) => `<p><small>${a}</small><span>${b}</span></p>`)
        .join('') +
      `<p style="margin-top:36px"><span style="font-size:15px;font-style:normal;letter-spacing:.3em;text-transform:uppercase;opacity:.6">⏎ ${t('back')}</span></p>`;
    this.credits.classList.add('show', 'kz-interactive');
    const close = () => {
      this.ui.nav.pop(h);
      this.credits.classList.remove('show', 'kz-interactive');
      this.credits.removeEventListener('click', close);
      onClose && onClose();
    };
    const h = {
      onAnyKey: () => {
        this.ui.sound('back');
        close();
        return true;
      },
      nav: () => h.onAnyKey(),
    };
    this.credits.addEventListener('click', close);
    this.ui.nav.push(h);
  }
}

function div(cls) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function layer(cls) {
  const d = document.createElement('div');
  d.className = `kz-layer ${cls}`;
  return d;
}
