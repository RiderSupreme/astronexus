// The night's work: three batteries, a beacon, and holding out until sunrise.
//
// The clock is the real sky's. It drifts through the evening while the
// batteries are collected, jumps on with each one taken, and once the beacon
// is lit runs the whole night through in a few minutes, so that the siege ends
// when the Sun actually clears the horizon behind the High Court.
import { THREE } from './lib/three.js';
import { jdFromLocal, localHours } from './astro.js';
import { standard, patch } from './materials.js';
import { ARMS } from './weapons.js';
import { STATE } from './zombies.js';
import { START } from './world.js';
import { makeRng, clamp, lerp, TAU, DEG, mod } from './util.js';

const SIEGE_SECONDS = 330;
const RELAY = 'KASAULI RELAY';
const hhmm = h => { h = mod(h, 24); return String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.floor((h % 1) * 60 + 1e-6)).padStart(2, '0'); };

const BEAM_VERT = /* glsl */`varying float vT; varying vec3 vN; varying vec3 vV;
void main() { vT = 0.5 - position.y; vec4 wp = modelMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`;
const BEAM_FRAG = /* glsl */`varying float vT; varying vec3 vN; varying vec3 vV; uniform float uI;
void main() { float edge = pow(abs(dot(normalize(vN), normalize(vV))), 2.4); float a = edge * (0.12 + 0.88 * pow(1.0 - vT, 2.6)) * smoothstep(0.0, 0.02, vT) * smoothstep(1.0, 0.75, vT) * uI; gl_FragColor = vec4(vec3(1.0, 0.86, 0.6) * a, 1.0); }`;

export class Mission {
  constructor(game) {
    this.game = game; this.rng = makeRng(2087);
    this.group = new THREE.Group(); this.group.name = 'mission'; game.scene.add(this.group);
    this.items = [];
    const M = (color, o = {}) => standard({ color, roughness: 0.6, metalness: 0.1, ...o }, 'item');
    this.mat = { cell: M(0xc77a12), dark: M(0x15171a, { metalness: 0.6, roughness: 0.5 }), olive: M(0x2c331f), band: M(0xd9b23a), white: M(0xcfcabd), green: M(0x2f8a4a), steel: M(0x24262a, { metalness: 0.9, roughness: 0.45 }), wood: M(0x4a2c17),
      lampOff: M(0x3a0d0a, { emissive: 0xff2a10, emissiveIntensity: 0.6 }), lampOn: M(0x0c3a16, { emissive: 0x38ff70, emissiveIntensity: 3 }) };
    // every pickup is one mesh: its colours ride on the vertices, and anything brighter than white glows
    this.itemMat = patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 }),
      { key: 'pickup', fragEmissive: 'totalEmissiveRadiance += vColor * step(1.2, max(vColor.r, max(vColor.g, vColor.b)));' });
    this.geos = {};
    // a faint column of light over anything worth picking up, so it can be found in long grass
    this.markMat = new THREE.MeshBasicMaterial({ color: 0xe8b93b, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.markGeo = new THREE.CylinderGeometry(0.02, 0.07, 1.5, 8, 1, true);
    this._buildBeacon();
    game.horde.onKill = (s, part) => this._onKill(s, part);
    this.reset();
  }

  // ---- things that can be picked up ----
  _model(type, kind) {
    const key = type + (kind || '');
    if (!this.geos[key]) {
      const parts = [], C = { cell: 0xc77a12, dark: 0x15171a, olive: 0x2c331f, band: 0xd9b23a, white: 0xcfcabd, green: 0x2f8a4a, steel: 0x24262a, wood: 0x4a2c17 }, col = new THREE.Color();
      const add = (c, g) => { const rgb = Array.isArray(c) ? c : col.set(C[c]).toArray(); parts.push([g.toNonIndexed(), rgb]); };
      const B = (c, w, h, d, x = 0, y = 0, z = 0) => add(c, new THREE.BoxGeometry(w, h, d).translate(x, y, z));
      if (type === 'cell') { B('cell', 0.42, 0.26, 0.24, 0, 0.13); B('dark', 0.05, 0.3, 0.26, -0.21, 0.14); B('dark', 0.05, 0.3, 0.26, 0.21, 0.14); B('dark', 0.3, 0.03, 0.03, 0, 0.3); B([0.15, 3.2, 0.5], 0.1, 0.03, 0.01, 0, 0.18, 0.125); }
      else if (type === 'ammo') { B('olive', 0.3, 0.17, 0.16, 0, 0.085); B('band', 0.31, 0.03, 0.165, 0, 0.11); B('dark', 0.1, 0.02, 0.03, 0, 0.18); }
      else if (type === 'med') { B('white', 0.3, 0.2, 0.12, 0, 0.1); B('green', 0.05, 0.14, 0.125, 0, 0.1); B('green', 0.14, 0.05, 0.125, 0, 0.1); }
      else if (type === 'grenade') { add('olive', new THREE.SphereGeometry(0.06, 10, 8).translate(0, 0.06, 0)); B('dark', 0.03, 0.04, 0.03, 0, 0.13); }
      else if (kind === 'rifle') { B('steel', 0.05, 0.07, 0.3, 0, 0.05, 0); B('wood', 0.045, 0.05, 0.26, 0, 0.055, -0.27); B('steel', 0.02, 0.02, 0.3, 0, 0.06, -0.52); B('wood', 0.04, 0.08, 0.28, 0, 0.04, 0.28); B('steel', 0.03, 0.14, 0.05, 0, -0.04, -0.03); }
      else { B('steel', 0.05, 0.065, 0.24, 0, 0.05, 0); B('steel', 0.024, 0.024, 0.55, 0, 0.065, -0.38); B('wood', 0.05, 0.05, 0.17, 0, 0.035, -0.27); B('wood', 0.04, 0.075, 0.3, 0, 0.035, 0.26); }
      const n = parts.reduce((a, [g]) => a + g.attributes.position.count, 0), pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), rgb = new Float32Array(n * 3);
      let o = 0;
      for (const [g, c] of parts) {
        pos.set(g.attributes.position.array, o * 3); nrm.set(g.attributes.normal.array, o * 3);
        for (let i = 0; i < g.attributes.position.count; i++) rgb.set(c, (o + i) * 3);
        o += g.attributes.position.count; g.dispose();
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3)); geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
      if (type === 'weapon') geo.rotateZ(Math.PI / 2 * 0.92);        // a gun left lying on its side
      this.geos[key] = geo;
    }
    const mesh = new THREE.Mesh(this.geos[key], this.itemMat); mesh.castShadow = true;
    return mesh;
  }
  place(type, x, z, { kind = null, amount = 0, y = null, use = false, label = '' } = {}) {
    const W = this.game.world;
    const it = { type, kind, amount, use, label, x, z, y: y ?? W.groundAt(x, z, W.heightAt(x, z) + 0.6, 0.6), taken: false, phase: this.rng.range(0, TAU) };
    const holder = new THREE.Group(); holder.position.set(x, it.y, z); holder.rotation.y = this.rng.range(0, TAU);
    holder.add(this._model(type, kind));
    const mark = new THREE.Mesh(this.markGeo, this.markMat); mark.position.y = 1.15; holder.add(mark);
    it.mesh = holder; this.group.add(holder); this.items.push(it);
    return it;
  }
  _take(it) {
    const G = this.game, W = G.weapons;
    let msg = '';
    if (it.type === 'ammo') { const n = W.addAmmo(it.kind, it.amount); if (!n) return false; msg = `+${n} ${ARMS[it.kind].name}`; if (!W.owned[it.kind]) msg += ' (no weapon yet)'; }
    else if (it.type === 'med') { if (G.player.health >= G.player.maxHealth) return false; G.player.heal(45); msg = '+45 HEALTH'; }
    else if (it.type === 'grenade') { if (W.grenadeCount >= 5) return false; W.grenadeCount++; msg = '+1 GRENADE'; }
    else if (it.type === 'weapon') { const fresh = W.give(it.kind); msg = fresh ? ARMS[it.kind].name : `+${ARMS[it.kind].mag * 2} ${ARMS[it.kind].name}`; }
    else if (it.type === 'cell') { this.cells++; msg = `BATTERY ${this.cells}/3`; this._cellTaken(it); }
    it.taken = true; it.mesh.visible = false;
    G.hud.feed(msg); G.audio?.play(it.type === 'cell' ? 'cell' : 'pickup');
    return true;
  }

  // ---- the beacon on the Open Hand ----
  _buildBeacon() {
    const G = this.game, L = G.world.landmarks, m = this.mat, low = G.gfx.qualityName === 'low';
    const g = new THREE.Group(); this.group.add(g);
    const B = (mat, w, h, d, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; g.add(o); return o; };
    const c = L.beacon;
    B(m.olive, 1.0, 1.25, 0.5, c.x, c.y + 0.625, c.z); B(m.dark, 0.9, 0.5, 0.05, c.x, c.y + 0.85, c.z + 0.26);
    this.lamps = [0, 1, 2].map(i => B(m.lampOff, 0.12, 0.08, 0.03, c.x - 0.26 + i * 0.26, c.y + 1.12, c.z + 0.265));
    B(m.dark, 0.06, 0.06, 5.2, c.x + 0.3, c.y + 0.1, c.z - 2.4);                           // conduit to the mast
    G.world.solids.addLate(G.world.solids.addBox(c.x - 0.5, c.y, c.z - 0.25, c.x + 0.5, c.y + 1.25, c.z + 0.25));
    this.console = { x: c.x, y: c.y, z: c.z + 0.9 };
    // the lamp at the top of the hand, and two beams turning about it
    const top = this.lampPos = new THREE.Vector3(L.openHand.x, 28.6, L.openHand.z);
    B(m.dark, 0.3, 1.4, 0.3, top.x, top.y - 0.9, top.z);
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), this.lampMat); bulb.position.copy(top); g.add(bulb);
    this.glow = new THREE.PointLight(0xffd9a0, 0, 130, 2); this.glow.position.copy(top); g.add(this.glow);
    this.turret = new THREE.Group(); this.turret.position.copy(top); g.add(this.turret);
    this.beams = []; this.beamMat = new THREE.ShaderMaterial({ vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, uniforms: { uI: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    const LEN = 190, ANG = 0.085, TILT = 0.2;
    for (const s of [1, -1]) {
      const arm = new THREE.Group(); arm.rotation.y = s > 0 ? 0 : Math.PI; this.turret.add(arm);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 28, 1, true), this.beamMat);
      cone.scale.set(Math.tan(ANG) * LEN, LEN, Math.tan(ANG) * LEN);
      // a cone has its point at +Y; lay it along the beam with the point at the lamp
      const dir = new THREE.Vector3(0, -Math.sin(TILT), -Math.cos(TILT));
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir); cone.position.copy(dir).multiplyScalar(LEN / 2);
      cone.frustumCulled = false; arm.add(cone);
      if (!low) {
        const spot = new THREE.SpotLight(0xffe2b0, 0, 280, ANG * 1.25, 0.7, 2);
        spot.target.position.copy(dir).multiplyScalar(50); arm.add(spot, spot.target);
        if (s > 0 && G.gfx.qualityName !== 'medium') { spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.camera.near = 6; spot.shadow.camera.far = 260; spot.shadow.bias = -0.0015; }
        this.beams.push(spot);
      }
    }
    this.lit = 0;
    this.beaconLights(false);
  }
  // The beacon's lamps are left out of the lighting altogether until they are lit: a dark lamp still costs every pixel its sums.
  beaconLights(on) { this.glow.visible = on; for (const b of this.beams) b.visible = on; }

  // ---- lifecycle ----
  reset() {
    const G = this.game, H = G.horde, rng = this.rng = makeRng(2087 + (this.runs = (this.runs || 0) + 1)), nav = G.nav, L = G.world.landmarks;
    for (const it of this.items) this.group.remove(it.mesh);
    this.items.length = 0;
    H.clear(); H.killed = 0; H.headshots = 0; H.awakeAll = false;
    this.phase = 'salvage'; this.cells = 0; this.t = 0; this.siegeT = 0; this.nightfall = false; this.spawnT = 3; this.debt = 0; this.holdT = 0; this.resupplyT = 70;
    this.said = {}; this.damageTaken = 0; this.lit = 0; this.dawnT = 0; this.lastHealth = 100;
    this.lampMat.color.setRGB(0, 0, 0); this.glow.intensity = 0; this.beamMat.uniforms.uI.value = 0; for (const b of this.beams) b.intensity = 0;
    this.beaconLights(false);
    for (const l of this.lamps) l.material = this.mat.lampOff;
    G.jd = jdFromLocal(2087, 9, 23, 17 + 25 / 60); G.clockRate = 5 / 3600;
    G.sky.cloudCover = 0.42; G.sky.haze = 0.35;
    // batteries, each with something useful beside it
    this.place('cell', 126, -18.5, { use: true, label: 'HIGH COURT' }); this.place('weapon', 124.2, -17.2, { kind: 'shotgun' }); this.place('ammo', 127.6, -17.4, { kind: 'shotgun', amount: 12 }); this.place('ammo', 123, -19.6, { kind: 'pistol', amount: 26 });
    this.place('cell', -14.6, -6.5, { use: true, label: 'TOWER', y: 1.05 }); this.place('weapon', -12.2, -6.15, { kind: 'rifle', y: 1.05 }); this.place('ammo', -16.6, -6.15, { kind: 'rifle', amount: 60, y: 1.05 });
    this.place('cell', L.forum.x, L.forum.z, { use: true, label: 'ASSEMBLY' }); this.place('med', L.forum.x + 1.6, L.forum.z - 1); this.place('ammo', L.forum.x - 1.2, L.forum.z + 1.4, { kind: 'rifle', amount: 60 }); this.place('ammo', L.forum.x + 0.4, L.forum.z + 2, { kind: 'shotgun', amount: 12 });
    // caches
    this.place('ammo', 2.5, 117, { kind: 'pistol', amount: 26 });
    this.place('grenade', 46, 7); this.place('grenade', 46.8, 8.2); this.place('med', 44.6, 9); this.place('ammo', 47.4, 6.2, { kind: 'pistol', amount: 26 });
    this.place('med', -84, 22); this.place('ammo', -85, -18, { kind: 'pistol', amount: 26 });
    this.cache = [];
    for (const [type, x, z, o] of [['ammo', 25.4, -68.2, { kind: 'rifle', amount: 120 }], ['ammo', 27, -68.2, { kind: 'rifle', amount: 60 }], ['ammo', 28.6, -68.2, { kind: 'shotgun', amount: 24 }], ['ammo', 32, -68.2, { kind: 'pistol', amount: 52 }], ['med', 33.6, -68.2, {}], ['med', 35, -68.2, {}], ['grenade', 30, -67.4, {}], ['grenade', 30.6, -68, {}]])
      this.cache.push(this.place(type, x, z, { ...o, y: -3.1 }));

    // the sleepers: standing wherever the last sunset left them
    const taken = [];
    const sleeper = (kind, x, z) => { if (H.spawn(kind, x, z, { dormant: true })) taken.push([x, z]); };
    for (let n = 0, tries = 0; n < 30 && tries < 900; tries++) {
      const c = nav.spawnCells[Math.floor(rng() * nav.spawnCells.length)], x = nav.cx(c), z = nav.cz(c);
      if (Math.hypot(x - START.x, z - START.z) < 30 || taken.some(p => Math.hypot(p[0] - x, p[1] - z) < 7)) continue;
      sleeper(rng() < 0.12 ? 'runner' : 'walker', x, z); n++;
    }
    const inside = (x0, z0, x1, z1, n, kinds) => { for (let i = 0, tries = 0; i < n && tries < 200; tries++) { const x = rng.range(x0, x1), z = rng.range(z0, z1); if (!nav.walkable(x, z) || taken.some(p => Math.hypot(p[0] - x, p[1] - z) < 2.5)) continue; sleeper(kinds[i % kinds.length], x, z); i++; } };
    inside(-148, -28, -98, 28, 9, ['walker', 'walker', 'walker', 'brute', 'walker', 'runner']);      // the forum
    inside(113, -23, 146, -15, 4, ['walker', 'walker', 'runner']);                                    // the court's portico
    inside(-21, -13, -7, 1, 3, ['walker']);                                                           // under the Tower of Shadows
    inside(14, -96, 46, -66, 4, ['walker', 'walker', 'brute']);                                       // the sunken court
    this._markers();
  }

  start() {
    const hud = this.game.hud;
    hud.say(RELAY, 'Scout, this is relay. You are inside the Capitol. Three batteries: High Court, Tower of Shadows, Assembly. Bring them to the Open Hand.', 8);
    hud.say(RELAY, 'The sleepers follow the sun. Keep quiet, keep clear of them, and be done before it sets.', 7);
  }

  _markers() {
    const m = [];
    if (this.phase === 'salvage') for (const it of this.items) if (it.type === 'cell' && !it.taken) m.push({ x: it.x, z: it.z, label: it.label });
    if (this.phase === 'carry') m.push({ x: this.console.x, z: this.console.z, label: 'OPEN HAND' });
    if (this.phase === 'siege') m.push({ x: this.console.x, z: this.console.z, label: 'BEACON', color: '#8ab6d1' });
    this.game.hud.markers = m;
  }
  _cellTaken(it) {
    const G = this.game, hud = G.hud;
    this.debt += 0.3;                               // eighteen minutes go by
    G.horde.alert(it.x, it.z, 42);
    if (this.cells === 1) hud.say(RELAY, 'One. Good. The shadows are getting long out there.');
    else if (this.cells === 2) hud.say(RELAY, 'Two. You will lose the light before the third.');
    else { hud.say(RELAY, 'That is all three. The Open Hand, north side, down in the court. Go.'); this.phase = 'carry'; }
    this._markers();
  }
  _onKill(s, part) {
    const r = this.rng(), W = this.game.weapons, p = this.game.player;
    const medChance = p.health < 45 ? 0.14 : 0.04;
    if (r < medChance) this.place('med', s.pos.x, s.pos.z);
    else if (r < medChance + 0.33) { const own = ['pistol', 'shotgun', 'rifle'].filter(k => W.owned[k]), k = own[Math.floor(this.rng() * own.length)]; this.place('ammo', s.pos.x, s.pos.z, { kind: k, amount: k === 'pistol' ? 17 : k === 'rifle' ? 30 : 8 }); }
    else if (r < medChance + 0.36) this.place('grenade', s.pos.x, s.pos.z);
    this.game.audio?.infected('die', s);
  }

  objectiveHTML() {
    return this.phase === 'salvage' ? `Find the batteries <b>${this.cells}/3</b>` : this.phase === 'carry' ? 'Take the batteries to the <b>Open Hand</b>'
      : this.phase === 'siege' ? 'Hold the beacon until <b>sunrise</b>' : this.phase === 'dawn' ? '<b>Sunrise</b>' : '';
  }
  clockNote() {
    const hud = this.game.hud;
    if (this.phase === 'siege' || this.phase === 'dawn') return 'Sunrise ' + hhmm(hud.sunrise);
    return this.nightfall ? 'Night' : 'Sunset ' + hhmm(hud.sunset);
  }

  _spawn(kind) {
    const G = this.game, p = G.player, c = G.nav.pickSpawn(this.rng, p.pos.x, p.pos.z, 24, this.phase === 'siege' ? 62 : 75, p.forward.x, p.forward.z);
    if (c < 0) return false;
    const x = G.nav.cx(c), z = G.nav.cz(c), s = G.horde.spawn(kind, x, z, { rise: true, yaw: Math.atan2(p.pos.x - x, p.pos.z - z) });
    if (s) { G.fx.dirt(x, s.pos.y, z); G.audio?.infected('rise', s); }
    return !!s;
  }

  update(dt) {
    const G = this.game, p = G.player, H = G.horde, hud = G.hud, sky = G.sky, sunAlt = sky.astro.sunAlt / DEG;
    this.t += dt;
    this.markMat.opacity = 0.11 / (0.4 + G.gfx.post.uExposure.value * 2.2);        // held to the same apparent brightness day and night
    if (p.health < this.lastHealth) this.damageTaken += this.lastHealth - p.health;
    this.lastHealth = p.health;
    // a little comes back if you can get clear of them
    if (p.alive && p.health < 35 && p.sinceHurt > 7) p.health = Math.min(35, p.health + dt * 2.5);
    // time bought with each battery is paid out over a few seconds, so the light is seen to move
    if (this.debt > 0) { const a = Math.min(this.debt, dt * 0.014); this.debt -= a; G.jd += a / 24; }

    // --- pickups
    let focus = null, fd = 2.3;
    for (const it of this.items) {
      if (it.taken) continue;
      const d = Math.hypot(it.x - p.pos.x, it.z - p.pos.z), dy = Math.abs(it.y - p.pos.y);
      it.mesh.visible = d < 110;                      // nothing this small is seen from further off
      if (!it.mesh.visible) continue;
      it.mesh.children[1].rotation.y += dt * 0.8;
      if (dy > 2.2) continue;
      if (it.use) { if (d < fd) { fd = d; focus = it; } }
      else if (d < 1.25 && p.alive) this._take(it);
    }
    const nearConsole = Math.hypot(this.console.x - p.pos.x, this.console.z - p.pos.z) < 2.4 && Math.abs(this.console.y - p.pos.y) < 1.5;
    if (focus) { hud.prompt('Take the battery'); if (G.input.pressed.interact) this._take(focus); this.holdT = 0; }
    else if (nearConsole && (this.phase === 'salvage' || this.phase === 'carry')) {
      if (this.cells < 3) { hud.prompt(`The beacon wants three batteries. You have ${this.cells}.`); this.holdT = 0; }
      else {
        this.holdT = G.input.held.interact ? this.holdT + dt / 2.2 : 0;
        hud.prompt('Hold to fit the batteries', this.holdT);
        if (this.holdT >= 1) this._light();
      }
    } else { hud.prompt(null); this.holdT = 0; }

    // --- nightfall
    if (!this.nightfall && sunAlt < -0.9) {
      this.nightfall = true; H.awakeAll = true;
      hud.banner('NIGHTFALL', 'They are all moving now'); hud.say(RELAY, 'Sun is down. They are moving. All of them.');
      G.audio?.play('nightfall');
      if (!G.weapons.torchOn) hud.feed(G.input.touch ? 'LAMP: TORCH' : 'F: TORCH');
    }

    // --- the director
    let awake = 0, brutes = 0;
    for (const s of H.list) if (s.active && (s.state === STATE.CHASE || s.state === STATE.ATTACK || s.state === STATE.RISE)) { awake++; if (s.kind === 'brute') brutes++; }
    this.awake = awake;
    let want = 0, gap = 3;
    if (this.phase === 'siege') {
      this.siegeT += dt; const f = clamp(this.siegeT / SIEGE_SECONDS, 0, 1);
      want = Math.round(lerp(8, 21, Math.pow(f, 0.8))); gap = lerp(1.6, 0.6, f);
      if (f > 0.5 && !this.said.half) { this.said.half = true; hud.say(RELAY, 'Halfway to sunrise. The big ones are coming in. Keep the court.'); }
      if (f > 0.86 && !this.said.grey) { this.said.grey = true; hud.say(RELAY, 'East is going grey. A few more minutes.'); }
      this.resupplyT -= dt;
      if (this.resupplyT <= 0) { this.resupplyT = 55; let any = false; for (const it of this.cache) if (it.taken) { it.taken = false; any = true; } if (any) { hud.feed('CACHE RESTOCKED'); G.audio?.play('pickup'); } }
      if (sunAlt > -0.85 && f > 0.5) this._dawn();
    } else if (this.nightfall && this.phase !== 'dawn' && this.phase !== 'done') { want = 5 + this.cells; gap = 3.2; }
    this.spawnT -= dt;
    if (want > awake && this.spawnT <= 0 && p.alive) {
      const f = this.phase === 'siege' ? this.siegeT / SIEGE_SECONDS : 0, r = this.rng();
      const kind = f > 0.28 && brutes < (f > 0.7 ? 3 : 2) && r < 0.07 + 0.08 * f ? 'brute' : r < 0.16 + 0.3 * f ? 'runner' : 'walker';
      this._spawn(kind); this.spawnT = gap * this.rng.range(0.6, 1.4);
    }

    // --- beacon
    if (this.lit > 0) {
      this.lit = Math.min(1, this.lit + dt * 0.5);
      this.turret.rotation.y += dt * 0.62;
      const flick = 0.92 + 0.08 * Math.sin(this.t * 31), k = this.lit * flick * (this.phase === 'dawn' || this.phase === 'done' ? Math.max(0.15, 1 - this.dawnT / 8) : 1);
      this.lampMat.color.setRGB(60 * k, 46 * k, 26 * k); this.glow.intensity = 320 * k; this.beamMat.uniforms.uI.value = 0.3 * k * (0.3 + 0.7 * sky.night) / Math.max(0.4, G.gfx.post.uExposure.value);
      for (const b of this.beams) b.intensity = 7000 * k;
    }
    // --- sunrise
    if (this.phase === 'dawn') { this.dawnT += dt; if (this.dawnT > 10) { this.phase = 'done'; G.win(); } }
  }

  _light() {
    const G = this.game, hud = G.hud;
    this.phase = 'siege'; this.siegeT = 0; this.lit = 0.01; this.holdT = 0; this.spawnT = 4;
    this.beaconLights(true);
    for (const l of this.lamps) l.material = this.mat.lampOn;
    // from now the night runs out in a fixed span of real time, ending when the Sun clears the horizon
    const rise = jdFromLocal(2087, 9, 23, 0) + (hud.sunrise + 0.02) / 24;
    G.clockRate = (rise - G.jd) * 24 / SIEGE_SECONDS;
    G.horde.awakeAll = true; this.nightfall = true;
    hud.banner('BEACON LIT', 'Hold until sunrise', 5);
    hud.say(RELAY, 'We have your light. The lift cannot fly the valley in the dark. Hold until sunrise.', 8);
    G.audio?.play('beacon');
    this._markers();
  }
  _dawn() {
    const G = this.game, H = G.horde;
    this.phase = 'dawn'; this.dawnT = 0; G.clockRate = 0.25 / 60;
    H.awakeAll = false;
    for (const s of H.list) if (s.active && (s.state === STATE.CHASE || s.state === STATE.ATTACK || s.state === STATE.RISE)) { s.state = STATE.DORMANT; s.move = 0; }
    for (const s of H.list) if (s.active && s.state === STATE.DORMANT) { s.pacified = true; s.wakeDelay = -1; }        // nothing wakes them now
    G.player.noise = 0;
    G.hud.banner('SUNRISE', 'They turn to the light', 7);
    G.hud.say(RELAY, 'Sunrise. Look at them stop. Lift is over the ridge, Scout. Well held.', 8);
    G.audio?.play('dawn');
    this._markers();
  }

  stats() {
    const G = this.game, W = G.weapons, H = G.horde;
    const acc = W.shots ? Math.round(W.hits / W.shots * 100) : 0, m = Math.floor(this.t / 60), s = Math.floor(this.t % 60);
    return { kills: H.killed, headshots: H.headshots, accuracy: acc, time: `${m}:${String(s).padStart(2, '0')}`, cells: this.cells, hurt: Math.round(this.damageTaken), clock: hhmm(localHours(G.jd)) };
  }
}
