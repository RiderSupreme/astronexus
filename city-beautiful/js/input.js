// Input: keyboard and mouse with pointer lock, or twin thumbs on a touch screen.
//
// Everything is reduced to the same small set of actions, so the rest of the
// game never asks which device is in use. Held actions are read from `held`,
// one-shot actions from `pressed` (true only for the frame they happened).
import { clamp } from './util.js';

const KEYMAP = {
  KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyC: 'crouch', ControlLeft: 'crouch',
  KeyR: 'reload', KeyE: 'interact', KeyF: 'light', KeyV: 'melee', KeyG: 'grenade', KeyQ: 'swap',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Tab: 'objectives', KeyM: 'mute', KeyP: 'pause', Escape: 'pause',
};

export class Input {
  constructor(canvas, touchRoot) {
    this.canvas = canvas;
    this.held = Object.create(null);
    this.pressed = Object.create(null);
    this.lookX = 0; this.lookY = 0;          // accumulated look this frame, in "mouse pixels"
    this.moveX = 0; this.moveZ = 0;          // analogue move, -1..1 (strafe, forward)
    this.wheel = 0;
    this.locked = false;
    this.lockFailed = false;                 // pointer lock refused: fall back to plain mouse movement
    this.touch = false;
    this.enabled = false;                    // false while a menu is up
    this.onLockChange = null;

    addEventListener('keydown', e => {
      const a = KEYMAP[e.code];
      if (!a) return;
      if (this.enabled || a === 'pause') { if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault(); }
      if (!e.repeat) { this.pressed[a] = true; this.held[a] = true; }
    });
    addEventListener('keyup', e => { const a = KEYMAP[e.code]; if (a) this.held[a] = false; });
    addEventListener('blur', () => { for (const k in this.held) this.held[k] = false; });

    canvas.addEventListener('mousedown', e => {
      if (!this.enabled) return;
      if (e.button === 0) { this.held.fire = true; this.pressed.fire = true; }
      if (e.button === 2) { this.held.aim = true; this.pressed.aim = true; }
      if (!this.locked && !this.lockFailed && !this.touch) this.lock();
    });
    addEventListener('mouseup', e => { if (e.button === 0) this.held.fire = false; if (e.button === 2) this.held.aim = false; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    addEventListener('mousemove', e => {
      if (!this.enabled || this.touch) return;
      if (this.locked || this.lockFailed) { this.lookX += e.movementX || 0; this.lookY += e.movementY || 0; }
    });
    canvas.addEventListener('wheel', e => { if (this.enabled) { this.wheel += Math.sign(e.deltaY); e.preventDefault(); } }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => { this.lockFailed = true; });

    if (touchRoot) this._initTouch(touchRoot);
  }

  // Ask the browser to capture the mouse. Must be called from a click.
  lock() {
    if (this.touch) return;
    try {
      const p = this.canvas.requestPointerLock && this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => { this.lockFailed = true; });
      else if (!this.canvas.requestPointerLock) this.lockFailed = true;
    } catch { this.lockFailed = true; }
  }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  // Movement as a 2D vector: keyboard gives unit steps, the touch stick gives its own values.
  readMove() {
    const kx = (this.held.right ? 1 : 0) - (this.held.left ? 1 : 0), kz = (this.held.forward ? 1 : 0) - (this.held.back ? 1 : 0);
    let x = kx + this.moveX, z = kz + this.moveZ;
    const l = Math.hypot(x, z);
    if (l > 1) { x /= l; z /= l; }
    return [x, z];
  }

  endFrame() {
    for (const k in this.pressed) this.pressed[k] = false;
    this.lookX = 0; this.lookY = 0; this.wheel = 0;
  }

  // ---- touch: left thumb moves, right thumb looks, buttons do the rest ----
  _initTouch(root) {
    this.touchRoot = root;
    const stick = root.querySelector('[data-stick]'), knob = stick && stick.querySelector('i');
    let moveId = null, lookId = null, mox = 0, moy = 0, lx = 0, ly = 0;
    const R = 56;
    const start = e => {
      if (!this.touch) { this.touch = true; root.hidden = false; document.documentElement.classList.add('touch'); }
      if (!this.enabled) return;
      for (const t of e.changedTouches) {
        const btn = t.target.closest && t.target.closest('[data-act]');
        if (btn) {
          const a = btn.dataset.act; this.pressed[a] = true; this.held[a] = true; btn.classList.add('on');
          btn._tid = t.identifier;
          if (a === 'fire' && lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }     // the trigger thumb still aims
          continue;
        }
        if (t.clientX < innerWidth * 0.42 && moveId === null) {
          moveId = t.identifier; mox = t.clientX; moy = t.clientY;
          if (stick) { stick.style.left = mox + 'px'; stick.style.top = moy + 'px'; stick.classList.add('on'); }
        } else if (lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
      }
      e.preventDefault();
    };
    const move = e => {
      for (const t of e.changedTouches) {
        if (t.identifier === moveId) {
          const dx = clamp((t.clientX - mox) / R, -1, 1), dy = clamp((t.clientY - moy) / R, -1, 1);
          this.moveX = dx; this.moveZ = -dy;
          this.held.sprint = Math.hypot(dx, dy) > 0.92 && dy < -0.6;          // push the stick right forward to run
          if (knob) knob.style.transform = `translate(${dx * R * 0.6}px, ${dy * R * 0.6}px)`;
        } else if (t.identifier === lookId) {
          this.lookX += (t.clientX - lx) * 2.2; this.lookY += (t.clientY - ly) * 2.2; lx = t.clientX; ly = t.clientY;
        }
      }
      e.preventDefault();
    };
    const end = e => {
      for (const t of e.changedTouches) {
        if (t.identifier === moveId) { moveId = null; this.moveX = this.moveZ = 0; this.held.sprint = false; if (stick) stick.classList.remove('on'); if (knob) knob.style.transform = ''; }
        if (t.identifier === lookId) lookId = null;
        for (const btn of root.querySelectorAll('[data-act].on')) if (btn._tid === t.identifier) { this.held[btn.dataset.act] = false; btn.classList.remove('on'); }
      }
    };
    const opts = { passive: false };
    for (const el of [this.canvas, root]) {
      el.addEventListener('touchstart', start, opts); el.addEventListener('touchmove', move, opts);
      el.addEventListener('touchend', end, opts); el.addEventListener('touchcancel', end, opts);
    }
  }
}
