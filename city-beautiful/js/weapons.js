// Weapons: three firearms, a rifle butt, grenades and a torch.
//
// The gun you see is drawn in its own scene over the world with the depth
// buffer cleared, so it can never poke through a wall. Shots are traced as
// rays against the collision world and the infected; everything else here is
// feel: sway, bob, recoil springs, reload choreography.
import { THREE } from './lib/three.js';
import { SURF, SOLID } from './physics.js';
import { clamp, damp, lerp, DEG, makeRng, TAU, smoothstep } from './util.js';

export const ARMS = {
  pistol: { name: '9 MM AUTO', mag: 13, reserve: 52, max: 130, dmg: 26, rpm: 400, auto: false, pellets: 1, spread: 0.45, spreadMove: 1.6, spreadAim: 0.1, kick: [1.5, 0.45], reload: 1.45, range: 110, zoom: 0.84, noise: 48, power: 0.8, hip: [0.15, -0.165, -0.4], aimZ: -0.3 },
  shotgun: { name: '12-BORE PUMP', mag: 6, reserve: 12, max: 48, dmg: 15, rpm: 66, auto: false, pellets: 9, spread: 3.3, spreadMove: 4.2, spreadAim: 2.5, kick: [5.2, 1.2], reload: 0.52, byShell: true, range: 42, zoom: 0.88, noise: 65, power: 1.6, hip: [0.17, -0.2, -0.46], aimZ: -0.3 },
  rifle: { name: '5.56 SERVICE RIFLE', mag: 30, reserve: 60, max: 240, dmg: 34, rpm: 640, auto: true, pellets: 1, spread: 0.3, spreadMove: 2.0, spreadAim: 0.05, kick: [0.85, 0.4], reload: 2.2, range: 190, zoom: 0.6, noise: 60, power: 1.1, hip: [0.17, -0.2, -0.44], aimZ: -0.22 },
};
export const SLOTS = ['pistol', 'shotgun', 'rifle'];

// ---- view models, assembled from boxes and tubes ----
function mats() {
  const M = (color, metalness, roughness) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
  return { steel: M(0x25272a, 0.9, 0.4), worn: M(0x44464a, 0.9, 0.48), wood: M(0x4a2c17, 0, 0.55), poly: M(0x141518, 0.1, 0.7), glove: M(0x1b1814, 0, 0.85), sleeve: M(0x38402a, 0, 0.95), brass: M(0xb08a3a, 1, 0.3), red: M(0x7a1510, 0, 0.6) };
}
function box(g, m, w, h, d, x, y, z, rx = 0, rz = 0) { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.rotation.set(rx, 0, rz); g.add(o); return o; }
function tubeZ(g, m, r, len, x, y, z, r2 = r, sides = 12) { const o = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, sides), m); o.rotation.x = Math.PI / 2; o.position.set(x, y, z); g.add(o); return o; }

// A gloved hand on the end of a sleeve. The group's origin is the palm; the forearm runs back along `toElbow`.
function hand(M, toElbow) {
  const g = new THREE.Group();
  box(g, M.glove, 0.085, 0.04, 0.1, 0, 0, 0);
  box(g, M.glove, 0.03, 0.075, 0.09, -0.045, -0.02, 0);          // fingers curled round
  box(g, M.glove, 0.03, 0.03, 0.07, 0.03, 0.03, -0.02);          // thumb
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, 0.42, 10), M.sleeve);
  const d = new THREE.Vector3(...toElbow).normalize();
  arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), d); arm.position.copy(d).multiplyScalar(0.24);
  g.add(arm);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.05, 10), M.glove); cuff.quaternion.copy(arm.quaternion); cuff.position.copy(d).multiplyScalar(0.06); g.add(cuff);
  return g;
}

function buildPistol(M) {
  const g = new THREE.Group(), p = {};
  box(g, M.steel, 0.026, 0.02, 0.15, 0, 0.012, -0.015);                               // frame
  p.slide = new THREE.Group(); g.add(p.slide);
  box(p.slide, M.steel, 0.028, 0.03, 0.19, 0, 0.037, -0.02);
  box(p.slide, M.worn, 0.029, 0.012, 0.035, 0, 0.04, 0.05);                           // serrations
  box(p.slide, M.steel, 0.004, 0.008, 0.006, 0, 0.056, -0.108);                       // front post
  box(p.slide, M.steel, 0.006, 0.008, 0.008, -0.008, 0.056, 0.07); box(p.slide, M.steel, 0.006, 0.008, 0.008, 0.008, 0.056, 0.07);   // rear notch
  tubeZ(g, M.worn, 0.0075, 0.02, 0, 0.037, -0.122);                                   // muzzle
  box(g, M.steel, 0.008, 0.028, 0.045, 0, -0.012, -0.03);                             // trigger guard
  box(g, M.wood, 0.03, 0.1, 0.048, 0, -0.05, 0.045, 0.24);                            // grip
  p.mag = box(g, M.steel, 0.02, 0.1, 0.034, 0, -0.055, 0.047, 0.24);
  p.muzzle = new THREE.Object3D(); p.muzzle.position.set(0, 0.037, -0.14); g.add(p.muzzle);
  p.eject = new THREE.Object3D(); p.eject.position.set(0.018, 0.045, 0.0); g.add(p.eject);
  p.right = hand(M, [0.25, -0.5, 0.75]); p.right.position.set(0.004, -0.055, 0.05); p.right.rotation.set(0.2, 0, -1.45); g.add(p.right);
  p.left = hand(M, [-0.55, -0.45, 0.65]); p.left.position.set(-0.03, -0.085, 0.045); p.left.rotation.set(0.2, 0, 1.2); g.add(p.left);
  p.leftHome = p.left.position.clone();
  p.sight = 0.06;
  return { g, p };
}
function buildRifle(M) {
  const g = new THREE.Group(), p = {};
  box(g, M.steel, 0.044, 0.062, 0.24, 0, 0.0, 0.0);                                   // receiver
  box(g, M.steel, 0.03, 0.02, 0.16, 0, 0.04, 0.0);                                    // top cover
  tubeZ(g, M.steel, 0.009, 0.4, 0, 0.012, -0.32);                                     // barrel
  tubeZ(g, M.steel, 0.006, 0.26, 0, 0.034, -0.25);                                    // gas tube
  box(g, M.wood, 0.042, 0.05, 0.24, 0, 0.012, -0.24);                                 // handguard
  tubeZ(g, M.worn, 0.013, 0.05, 0, 0.012, -0.54);                                     // flash hider
  box(g, M.steel, 0.008, 0.05, 0.012, 0, 0.05, -0.42); box(g, M.steel, 0.004, 0.016, 0.004, 0, 0.082, -0.42);      // front sight tower and post
  box(g, M.steel, 0.022, 0.03, 0.03, 0, 0.066, 0.06);                                 // rear sight block
  box(g, M.steel, 0.006, 0.014, 0.01, -0.01, 0.086, 0.06); box(g, M.steel, 0.006, 0.014, 0.01, 0.01, 0.086, 0.06);
  box(g, M.wood, 0.036, 0.075, 0.27, 0, -0.022, 0.25, -0.1);                          // stock
  box(g, M.poly, 0.03, 0.09, 0.04, 0, -0.07, 0.085, 0.3);                             // pistol grip
  p.mag = box(g, M.steel, 0.026, 0.14, 0.055, 0, -0.095, -0.03, -0.18);
  p.bolt = box(g, M.worn, 0.012, 0.014, 0.05, 0.026, 0.02, 0.02);
  p.muzzle = new THREE.Object3D(); p.muzzle.position.set(0, 0.012, -0.58); g.add(p.muzzle);
  p.eject = new THREE.Object3D(); p.eject.position.set(0.03, 0.03, 0.01); g.add(p.eject);
  p.right = hand(M, [0.3, -0.55, 0.7]); p.right.position.set(0.004, -0.075, 0.09); p.right.rotation.set(0.3, 0, -1.45); g.add(p.right);
  p.left = hand(M, [-0.5, -0.5, 0.65]); p.left.position.set(-0.004, -0.03, -0.24); p.left.rotation.set(0, 0, 3.0); g.add(p.left);
  p.leftHome = p.left.position.clone();
  p.sight = 0.088;
  return { g, p };
}
function buildShotgun(M) {
  const g = new THREE.Group(), p = {};
  box(g, M.steel, 0.044, 0.06, 0.22, 0, 0, 0);
  tubeZ(g, M.steel, 0.0115, 0.56, 0, 0.016, -0.39);                                   // barrel
  tubeZ(g, M.steel, 0.011, 0.34, 0, -0.012, -0.28);                                   // magazine tube
  p.pump = new THREE.Group(); g.add(p.pump);
  tubeZ(p.pump, M.wood, 0.026, 0.17, 0, -0.012, -0.27, 0.026, 10);
  box(g, M.wood, 0.038, 0.07, 0.3, 0, -0.03, 0.26, -0.13);                            // stock
  box(g, M.wood, 0.034, 0.05, 0.08, 0, -0.035, 0.1, 0.45);
  tubeZ(g, M.brass, 0.003, 0.006, 0, 0.031, -0.66);                                   // bead
  box(g, M.red, 0.02, 0.012, 0.05, 0.023, 0.005, 0.0);                                // a shell showing at the port
  p.muzzle = new THREE.Object3D(); p.muzzle.position.set(0, 0.016, -0.68); g.add(p.muzzle);
  p.eject = new THREE.Object3D(); p.eject.position.set(0.03, 0.01, 0.0); g.add(p.eject);
  p.right = hand(M, [0.3, -0.55, 0.7]); p.right.position.set(0.004, -0.06, 0.1); p.right.rotation.set(0.35, 0, -1.45); g.add(p.right);
  p.left = hand(M, [-0.5, -0.5, 0.65]); p.left.position.set(-0.004, -0.045, -0.27); p.left.rotation.set(0, 0, 3.0); p.pump.add(p.left);
  p.leftHome = p.left.position.clone();
  p.sight = 0.034;
  return { g, p };
}

const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();

export class Weapons {
  constructor(game) {
    this.game = game;
    const cam = game.camera;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(54, cam.aspect, 0.01, 12);
    this.rig = new THREE.Group(); this.scene.add(this.rig);
    this.M = mats();
    this.models = { pistol: buildPistol(this.M), shotgun: buildShotgun(this.M), rifle: buildRifle(this.M) };
    this.root = new THREE.Group(); this.rig.add(this.root);
    for (const k of SLOTS) { this.models[k].g.visible = false; this.root.add(this.models[k].g); }
    // the gun is lit by copies of the world's lights
    this.sun = new THREE.DirectionalLight(0xffffff, 1); this.fill = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    this.flashLight = new THREE.PointLight(0xffc070, 0, 3, 2);
    this.scene.add(this.sun, this.sun.target, this.fill); this.rig.add(this.flashLight);
    // muzzle flash: a few crossed additive cards
    const fm = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, map: flashTexture(), toneMapped: false });
    this.flash = new THREE.Group();
    for (let i = 0; i < 3; i++) { const q = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), fm); q.rotation.z = i * Math.PI / 3; if (i === 2) { q.rotation.set(0, Math.PI / 2, 0); q.scale.set(1.6, 0.7, 1); } this.flash.add(q); }
    this.flash.visible = false; this.rig.add(this.flash); this.flashMat = fm;
    // torch
    this.torch = new THREE.SpotLight(0xfff0d8, 0, 60, 0.4, 0.55, 1.3);
    this.torch.castShadow = game.gfx.qualityName !== 'low'; this.torch.shadow.mapSize.set(1024, 1024); this.torch.shadow.camera.near = 0.4; this.torch.shadow.camera.far = 60; this.torch.shadow.bias = -0.002;
    game.scene.add(this.torch, this.torch.target);
    this.torchOn = false; this.torchPower = 0;
    // grenades in flight
    this.grenades = []; this.grenadeGeo = new THREE.SphereGeometry(0.055, 10, 8); this.grenadeMat = new THREE.MeshStandardMaterial({ color: 0x2c3320, roughness: 0.6, metalness: 0.3 });
    this.rng = makeRng(31337);
    this.reset();
    game.overlayScene = this.scene; game.overlayCamera = this.camera;
  }

  reset() {
    this.owned = { pistol: true, shotgun: false, rifle: false };
    this.ammo = {}; for (const k of SLOTS) this.ammo[k] = { mag: ARMS[k].mag, reserve: ARMS[k].reserve };
    this.grenadeCount = 2;
    this.current = 'pistol'; this.pending = null;
    this.cool = 0; this.reloadT = -1; this.shellsToLoad = 0; this.pumpT = -1; this.meleeT = -1; this.switchT = 0; this.lower = 1;
    this.ads = 0; this.kickZ = 0; this.kickR = 0; this.bloom = 0; this.swayX = 0; this.swayY = 0; this.flashT = 0; this.landDip = 0;
    this.spreadNow = 1; this.shots = 0; this.hits = 0;
    this.events = [];                 // 'hit', 'kill', 'head', 'empty' for the HUD and audio
    for (const g of this.grenades) this.game.scene.remove(g.mesh); this.grenades.length = 0;
    this._show();
  }
  _show() { for (const k of SLOTS) this.models[k].g.visible = k === this.current; }
  get def() { return ARMS[this.current]; }
  get clip() { return this.ammo[this.current]; }
  get busy() { return this.reloadT >= 0 || this.switchT > 0 || this.meleeT >= 0; }

  give(id) { if (!this.owned[id]) { this.owned[id] = true; this.switchTo(id); return true; } this.addAmmo(id, ARMS[id].mag * 2); return false; }
  addAmmo(id, n) { const a = this.ammo[id]; const before = a.reserve; a.reserve = Math.min(ARMS[id].max, a.reserve + n); return a.reserve - before; }
  switchTo(id) { if (id === this.current || !this.owned[id] || this.pending) return; this.pending = id; this.switchT = 0.44; this.reloadT = -1; this.game.audio?.play('switch'); }
  reload() {
    const D = this.def, a = this.clip;
    if (this.reloadT >= 0 || a.mag >= D.mag || a.reserve <= 0 || this.switchT > 0) return;
    this.reloadT = 0; this.shellsToLoad = D.byShell ? Math.min(D.mag - a.mag, a.reserve) : 0;
    this.game.audio?.play(D.byShell ? 'shell' : 'magout');
  }

  // ---- firing ----
  _fire(player) {
    const G = this.game, D = this.def, a = this.clip, cam = G.camera, rng = this.rng;
    a.mag--; this.cool = 60 / D.rpm; this.shots++;
    if (D.byShell) { this.reloadT = -1; this.pumpT = 0; }
    // cone of fire: steadier down the sights, wider on the move, opening with each shot
    const moving = Math.hypot(player.vel.x, player.vel.z) / 4.4;
    const spread = (lerp(D.spread, D.spreadAim, this.ads) + D.spreadMove * moving * (1 - 0.6 * this.ads) + this.bloom + (player.onGround ? 0 : 2.5)) * DEG;
    const o = cam.position;
    cam.getWorldDirection(_d);
    const right = _v.set(1, 0, 0).applyQuaternion(cam.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    this.models[this.current].p.muzzle.getWorldPosition(this._muzzle || (this._muzzle = new THREE.Vector3()));
    const mz = this._muzzle;
    let any = false;
    for (let i = 0; i < D.pellets; i++) {
      const ang = rng.range(0, TAU), rad = Math.tan(spread) * Math.sqrt(rng()) * (D.pellets > 1 ? 1 : 0.85);
      const dx = _d.x + (right.x * Math.cos(ang) + up.x * Math.sin(ang)) * rad, dy = _d.y + (right.y * Math.cos(ang) + up.y * Math.sin(ang)) * rad, dz = _d.z + (right.z * Math.cos(ang) + up.z * Math.sin(ang)) * rad;
      const l = Math.hypot(dx, dy, dz), ux = dx / l, uy = dy / l, uz = dz / l;
      const wh = G.world.raycast(o.x, o.y, o.z, ux, uy, uz, D.range);
      const wt = wh ? wh.t : D.range;
      const zh = G.horde ? G.horde.raycast(o.x, o.y, o.z, ux, uy, uz, wt) : null;
      let ex, ey, ez;
      if (zh) {
        const fall = D.pellets > 1 ? clamp(1.25 - zh.t / D.range, 0.35, 1) : 1;
        const tx = zh.target; ex = zh.px; ey = zh.py; ez = zh.pz;
        const killed = G.horde.damage(tx, D.dmg * fall, zh.part, ux, uz, D.pellets > 1 ? 0.6 : 1);
        G.fx?.blood(ex, ey, ez, ux, uy, uz, killed && zh.part === 'head');
        this.events.push(killed ? (zh.part === 'head' ? 'head' : 'kill') : 'hit'); any = true;
        G.audio?.at('flesh', ex, ey, ez);
      } else if (wh) {
        ex = o.x + ux * wt; ey = o.y + uy * wt; ez = o.z + uz * wt;
        G.fx?.impact(ex, ey, ez, wh.nx, wh.ny, wh.nz, wh.surf);
        if (i === 0) G.audio?.at(wh.surf === SURF.metal ? 'ricochet' : wh.surf === SURF.water ? 'splash' : 'thud', ex, ey, ez);
      } else { ex = o.x + ux * D.range; ey = o.y + uy * D.range; ez = o.z + uz * D.range; }
      if (i % 3 === 0) G.fx?.tracer(mz.x + ux * 0.6, mz.y + uy * 0.6, mz.z + uz * 0.6, ex, ey, ez);
    }
    if (any) this.hits++;
    // recoil into the camera, and into the model
    const k = 1 - 0.3 * this.ads - (player.crouching ? 0.15 : 0);
    player.kickVel += D.kick[0] * DEG * 13 * k; player.kickYaw += rng.range(-1, 1) * D.kick[1] * DEG * k;
    player.trauma = Math.min(1, player.trauma + 0.05 * D.power);
    this.kickZ += 0.045 * D.power; this.kickR += 0.07 * D.power; this.bloom = Math.min(3, this.bloom + (D.auto ? 0.35 : 0.6));
    this.flashT = 0.045; this.flash.rotation.z = rng.range(0, TAU); this.flash.scale.setScalar(rng.range(0.8, 1.25) * D.power);
    G.fx?.muzzle(mz.x, mz.y, mz.z, _d.x, _d.y, _d.z, D.power);
    if (!D.byShell) this._eject();
    player.noise = 1;
    G.horde?.alert(player.pos.x, player.pos.z, D.noise);
    G.audio?.shot(this.current);
  }
  _eject() {
    const p = this.models[this.current].p, cam = this.game.camera, e = p.eject.getWorldPosition(_v), r = this.rng;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const pl = this.game.player;
    this.game.fx?.casing(e.x, e.y, e.z, right.x * r.range(1.6, 2.6) + up.x * 1.5 + pl.vel.x, right.y * 2 + r.range(1.4, 2.4), right.z * r.range(1.6, 2.6) + up.z * 1.5 + pl.vel.z);
  }

  _melee(player) {
    const G = this.game, H = G.horde; if (!H) return;
    const fx = player.forward.x, fz = player.forward.z, fl = Math.hypot(fx, fz) || 1;
    let n = 0;
    for (const s of H.list) {
      if (!s.active || n >= 2) continue;
      const dx = s.pos.x - player.pos.x, dz = s.pos.z - player.pos.z, d = Math.hypot(dx, dz);
      if (d > 2.2 || Math.abs(s.pos.y - player.pos.y) > 1.6 || (dx * fx + dz * fz) / (d * fl || 1) < 0.45) continue;
      const killed = H.damage(s, 60, 'torso', dx / (d || 1), dz / (d || 1), 3.2);
      G.fx?.blood(s.pos.x, s.pos.y + 1.3, s.pos.z, fx, 0.2, fz, false);
      this.events.push(killed ? 'kill' : 'hit'); n++;
    }
    G.audio?.play(n ? 'meleehit' : 'swing');
    player.trauma = Math.min(1, player.trauma + (n ? 0.25 : 0.05));
  }

  throwGrenade(player) {
    if (this.grenadeCount <= 0 || this.busy) return;
    this.grenadeCount--;
    const cam = this.game.camera; cam.getWorldDirection(_d);
    const mesh = new THREE.Mesh(this.grenadeGeo, this.grenadeMat); mesh.castShadow = true;
    mesh.position.copy(cam.position).addScaledVector(_d, 0.5); mesh.position.y -= 0.15;
    this.game.scene.add(mesh);
    this.grenades.push({ mesh, vx: _d.x * 15 + player.vel.x, vy: _d.y * 15 + 4.2, vz: _d.z * 15 + player.vel.z, fuse: 2.4 });
    this.meleeT = 0.25; this.game.audio?.play('swing');
  }
  _grenades(dt, player) {
    const G = this.game, W = G.world;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i], p = g.mesh.position;
      g.fuse -= dt; g.vy -= 19 * dt;
      const sp = Math.hypot(g.vx, g.vy, g.vz), step = sp * dt;
      if (sp > 0.05) {
        const h = W.raycast(p.x, p.y, p.z, g.vx / sp, g.vy / sp, g.vz / sp, step + 0.06, SOLID.SHOT);
        if (h) {
          p.set(p.x + g.vx / sp * Math.max(0, h.t - 0.06), p.y + g.vy / sp * Math.max(0, h.t - 0.06), p.z + g.vz / sp * Math.max(0, h.t - 0.06));
          const dot = g.vx * h.nx + g.vy * h.ny + g.vz * h.nz;
          g.vx = (g.vx - 2 * dot * h.nx) * 0.42; g.vy = (g.vy - 2 * dot * h.ny) * 0.38; g.vz = (g.vz - 2 * dot * h.nz) * 0.42;
          if (Math.abs(dot) > 2) G.audio?.at('clink', p.x, p.y, p.z);
        } else { p.x += g.vx * dt; p.y += g.vy * dt; p.z += g.vz * dt; }
      }
      const floor = W.heightAt(p.x, p.z) + 0.055; if (p.y < floor) { p.y = floor; g.vy = Math.abs(g.vy) * 0.3; g.vx *= 0.7; g.vz *= 0.7; }
      g.mesh.rotation.x += dt * sp * 2;
      if (g.fuse <= 0) {
        G.scene.remove(g.mesh); this.grenades.splice(i, 1);
        G.fx?.explosion(p.x, p.y, p.z); G.audio?.at('boom', p.x, p.y, p.z);
        const kills = G.horde ? G.horde.blast(p.x, p.y, p.z, 7.5, 430) : 0;
        for (let k = 0; k < kills; k++) this.events.push('kill');
        G.horde?.alert(p.x, p.z, 95);
        const d = p.distanceTo(player.eyePos);
        if (d < 7 && !W.solids.occluded(p.x, p.y + 0.3, p.z, (player.eyePos.x - p.x) / d, (player.eyePos.y - p.y - 0.3) / d, (player.eyePos.z - p.z) / d, d - 0.3, SOLID.SHOT)) player.hurt(75 * (1 - d / 7) ** 1.2, p.x, p.z);
        player.trauma = Math.min(1, player.trauma + clamp(1.4 - d / 22, 0, 1));
      }
    }
  }

  // ---- per frame ----
  update(dt, player, input, active) {
    const G = this.game, D = this.def, a = this.clip, P = this.models[this.current].p;
    this.cool = Math.max(0, this.cool - dt);
    this.bloom = Math.max(0, this.bloom - dt * 4.5);
    if (active && player.alive) {
      if (input.pressed.slot1) this.switchTo('pistol'); if (input.pressed.slot2) this.switchTo('shotgun'); if (input.pressed.slot3) this.switchTo('rifle');
      if (input.wheel || input.pressed.swap) { const own = SLOTS.filter(k => this.owned[k]); const i = own.indexOf(this.pending || this.current); this.switchTo(own[(i + (input.wheel < 0 ? own.length - 1 : 1)) % own.length]); }
      if (input.pressed.reload) this.reload();
      if (input.pressed.light) { this.torchOn = !this.torchOn; G.audio?.play('click'); }
      if (input.pressed.grenade) this.throwGrenade(player);
      if (input.pressed.melee && this.meleeT < 0 && this.switchT <= 0) { this.meleeT = 0; this.reloadT = -1; this._meleeDone = false; }
      player.aiming = !!input.held.aim && !player.sprinting && this.reloadT < 0 && this.switchT <= 0 && this.meleeT < 0;
      player.aimZoom = D.zoom;
      const wantFire = D.auto ? input.held.fire : input.pressed.fire;
      if (wantFire && this.cool <= 0 && this.switchT <= 0 && this.meleeT < 0 && this.pumpT < 0 && !player.sprinting && (this.reloadT < 0 || (D.byShell && a.mag > 0))) {
        if (a.mag > 0) this._fire(player);
        else { this.cool = 0.25; this.events.push('empty'); G.audio?.play('dry'); this.reload(); }
      }
    } else player.aiming = false;

    // switching: down, swap, up
    if (this.switchT > 0) {
      const before = this.switchT; this.switchT -= dt;
      if (before > 0.22 && this.switchT <= 0.22 && this.pending) { this.current = this.pending; this.pending = null; this._show(); }
      if (this.switchT <= 0) this.switchT = 0;
    }
    // reloading
    if (this.reloadT >= 0) {
      const R = this.def, c = this.clip;
      this.reloadT += dt / R.reload;
      if (R.byShell) {
        if (this.reloadT >= 1) {
          c.mag++; c.reserve--; this.shellsToLoad--;
          if (this.shellsToLoad > 0 && c.reserve > 0) { this.reloadT = 0; G.audio?.play('shell'); } else { this.reloadT = -1; this.pumpT = 0; }
        }
      } else {
        if (!this._magIn && this.reloadT > 0.62) { this._magIn = true; G.audio?.play('magin'); }
        if (this.reloadT >= 1) { const n = Math.min(R.mag - c.mag, c.reserve); c.mag += n; c.reserve -= n; this.reloadT = -1; this._magIn = false; G.audio?.play('slide'); }
      }
    } else this._magIn = false;
    if (this.pumpT >= 0) { const b = this.pumpT; this.pumpT += dt / 0.42; if (b < 0.3 && this.pumpT >= 0.3) { G.audio?.play('pump'); this._eject(); } if (this.pumpT >= 1) this.pumpT = -1; }
    if (this.meleeT >= 0) { this.meleeT += dt / 0.5; if (!this._meleeDone && this.meleeT > 0.32) { this._meleeDone = true; if (this.grenades.length === 0 || this.meleeT < 0.9) this._melee(player); } if (this.meleeT >= 1) this.meleeT = -1; }
    this._grenades(dt, player);

    // ---- pose the model ----
    const cam = G.camera;
    this.rig.position.copy(cam.position); this.rig.quaternion.copy(cam.quaternion);
    this.camera.position.copy(cam.position); this.camera.quaternion.copy(cam.quaternion);
    if (this.camera.aspect !== cam.aspect) { this.camera.aspect = cam.aspect; this.camera.updateProjectionMatrix(); }
    this.ads = damp(this.ads, player.aiming ? 1 : 0, 16, dt);
    const sw = this.switchT > 0 ? Math.sin(Math.PI * (1 - this.switchT / 0.44)) : 0;
    this.lower = damp(this.lower, (player.sprinting ? 0.75 : 0) + (player.alive ? 0 : 1), 10, dt);
    this.swayX = damp(this.swayX, clamp(-input.lookX * 0.0009, -0.03, 0.03), 9, dt); this.swayY = damp(this.swayY, clamp(input.lookY * 0.0009, -0.03, 0.03), 9, dt);
    this.kickZ = damp(this.kickZ, 0, 14, dt); this.kickR = damp(this.kickR, 0, 12, dt);
    const hip = D.hip, e = this.ads, bob = player.bobAmt * (1 - 0.85 * e), t = G.time;
    let x = lerp(hip[0], 0, e) + this.swayX + Math.cos(player.bob) * 0.006 * bob;
    let y = lerp(hip[1], -P.sight, e) + this.swayY + Math.sin(player.bob * 2) * 0.006 * bob + Math.sin(t * 1.4) * 0.0015 - this.lower * 0.13 - sw * 0.28 - clamp(player.vel.y * 0.004, -0.03, 0.03);
    let z = lerp(hip[2], D.aimZ, e) + this.kickZ;
    let rx = this.kickR * (1 - 0.5 * e) - this.lower * 0.5 - sw * 0.9 + this.swayY * 1.5, ry = this.swayX * 2.2 + this.lower * 0.5, rz = this.swayX * -1.5 + Math.cos(player.bob) * 0.012 * bob;
    // reload choreography
    P.left.position.copy(P.leftHome);
    if (P.mag) P.mag.position.y = P.magHome ?? (P.magHome = P.mag.position.y);
    if (this.reloadT >= 0) {
      const r = this.reloadT;
      if (D.byShell) { const k = Math.sin(Math.PI * r); rz += -0.5; rx += 0.25; y -= 0.03; P.left.position.z += 0.3 * k; P.left.position.y -= 0.06 * k; P.left.position.x += 0.05 * k; }
      else {
        const tilt = smoothstep(0, 0.18, r) * (1 - smoothstep(0.82, 1, r));
        rz += 0.55 * tilt; rx += 0.3 * tilt; y -= 0.025 * tilt; x -= 0.02 * tilt;
        const out = smoothstep(0.12, 0.3, r) * (1 - smoothstep(0.48, 0.66, r));
        if (P.mag) P.mag.position.y = P.magHome - 0.3 * out;
        const reach = smoothstep(0.1, 0.3, r) * (1 - smoothstep(0.66, 0.84, r));
        P.left.position.y -= 0.16 * reach; P.left.position.z += 0.1 * reach;
      }
    }
    if (P.pump) P.pump.position.z = this.pumpT >= 0 ? 0.1 * Math.sin(Math.PI * this.pumpT) : 0;
    if (P.slide) P.slide.position.z = this.cool > 60 / D.rpm - 0.05 ? 0.035 : (a.mag === 0 && this.reloadT < 0 ? 0.03 : 0);
    if (P.bolt) P.bolt.position.z = 0.02 + (this.cool > 60 / D.rpm - 0.04 ? 0.04 : 0);
    if (this.meleeT >= 0) { const m = Math.sin(Math.PI * Math.min(1, this.meleeT * 1.3)); x -= 0.16 * m; z -= 0.24 * m; ry += 1.0 * m; rz += 0.5 * m; rx += 0.25 * m; }
    this.root.position.set(x, y, z); this.root.rotation.set(rx, ry, rz);

    // flash
    this.flashT -= dt;
    if (this.flashT > 0) { this.root.updateMatrixWorld(true); P.muzzle.getWorldPosition(_v); this.flash.position.copy(this.rig.worldToLocal(_v)); this.flash.visible = true; this.flashLight.position.copy(this.flash.position); this.flashLight.intensity = 3 * D.power; }
    else { this.flash.visible = false; this.flashLight.intensity = 0; }

    // light the model the way the spot the player stands on is lit
    const sky = G.sky, o = cam.position, L = sky.lightDir;
    if ((G.frames + 1) % 6 === 0) {
      this._sunTarget = G.world.solids.occluded(o.x, o.y, o.z, L.x, L.y, L.z, 90, SOLID.AO) ? 0 : 1;
      let open = 0; for (const d of [[0, 1, 0], [0.6, 0.8, 0], [-0.6, 0.8, 0], [0, 0.8, 0.6], [0, 0.8, -0.6]]) if (!G.world.solids.occluded(o.x, o.y, o.z, d[0], d[1], d[2], 30, SOLID.AO)) open++;
      this._openTarget = 0.3 + 0.7 * open / 5;
    }
    this.sunlit = damp(this.sunlit ?? 1, this._sunTarget ?? 1, 6, dt); this.open = damp(this.open ?? 1, this._openTarget ?? 1, 4, dt);
    this.sun.color.copy(sky.lightE).multiplyScalar(this.sunlit); this.sun.position.copy(o).addScaledVector(L, 10); this.sun.target.position.copy(o);
    this.fill.color.copy(sky.fill.color).multiplyScalar(this.open); this.fill.groundColor.copy(sky.fill.groundColor).multiplyScalar(this.open);
    this.scene.environment = G.scene.environment;
    for (const m of Object.values(this.M)) m.envMapIntensity = this.open;
    G.openSky = this.open;

    // torch
    this.torchPower = damp(this.torchPower, this.torchOn && player.alive ? 1 : 0, 14, dt);
    this.torch.intensity = this.torchPower * 240;
    cam.getWorldDirection(_d);
    this.torch.position.copy(o).addScaledVector(_d, 0.1); this.torch.position.y -= 0.12;
    this.torch.target.position.copy(o).addScaledVector(_d, 12);
    this.torch.target.updateMatrixWorld();

    this.spreadNow = lerp(D.spread, D.spreadAim, this.ads) + D.spreadMove * (Math.hypot(player.vel.x, player.vel.z) / 4.4) * (1 - 0.6 * this.ads) + this.bloom;
  }
}

// A soft star for the muzzle flash, drawn once.
function flashTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 2, 64, 64, 62); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,220,150,0.8)'); g.addColorStop(1, 'rgba(255,120,20,0)');
  x.fillStyle = g; x.beginPath();
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2, r = i % 2 ? 22 : 62; x.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); }
  x.closePath(); x.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
