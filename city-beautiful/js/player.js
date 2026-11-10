// The player: a body that walks, runs, crouches and jumps through the collision
// world, and the camera riding on its shoulders.
import { THREE } from './lib/three.js';
import { BOUNDS } from './world.js';
import { SURF } from './physics.js';
import { clamp, damp, lerp, DEG } from './util.js';

const RADIUS = 0.34, HEIGHT = 1.78, EYE = 1.64, CROUCH_HEIGHT = 1.15, CROUCH_EYE = 1.0;
const GRAVITY = 19, JUMP = 6.2, STEP_UP = 0.5;

export class Player {
  constructor(world, camera) {
    this.world = world; this.camera = camera;
    this.pos = new THREE.Vector3();          // feet
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.onGround = true; this.crouching = false; this.sprinting = false; this.aiming = false;
    this.health = 100; this.maxHealth = 100; this.stamina = 1; this.alive = true;
    this.height = HEIGHT; this.eye = EYE; this.viewY = 0;
    this.bob = 0; this.bobAmt = 0; this.stepDist = 0; this.coyote = 0; this.sinceHurt = 99; this.sinceSprint = 99;
    this.kickPitch = 0; this.kickYaw = 0; this.kickVel = 0;     // recoil, added by the weapon, recovered here
    this.trauma = 0;                                            // screen shake, 0..1
    this.hurtDir = new THREE.Vector3(); this.hurtFlash = 0;
    this.inWater = 0; this.surface = SURF.concrete;
    this.fov = 72; this.fovNow = 72; this.sens = 1; this.invertY = false;
    this.events = [];                                           // 'step', 'jump', 'land', 'hurt', 'splash' for audio and effects
    this.forward = new THREE.Vector3(0, 0, -1); this.eyePos = new THREE.Vector3();
    this._p2 = { x: 0, z: 0 };
    this.noise = 0;                                             // how loud the player is being, 0..1, decays
    this.speedScale = 1;
  }

  spawn(x, z, yaw = 0) {
    this.pos.set(x, this.world.groundAt(x, z, this.world.heightAt(x, z) + 0.2, STEP_UP), z);
    this.vel.set(0, 0, 0); this.yaw = yaw; this.pitch = 0; this.viewY = this.pos.y;
    this.health = this.maxHealth; this.stamina = 1; this.alive = true; this.onGround = true; this.trauma = 0; this.hurtFlash = 0;
  }

  hurt(amount, fromX, fromZ) {
    if (!this.alive) return;
    this.health -= amount; this.sinceHurt = 0; this.hurtFlash = Math.min(1, this.hurtFlash + 0.35 + amount / 60);
    this.trauma = Math.min(1, this.trauma + 0.3 + amount / 80);
    this.hurtDir.set(fromX - this.pos.x, 0, fromZ - this.pos.z).normalize();
    this.events.push('hurt');
    if (this.health <= 0) { this.health = 0; this.alive = false; this.events.push('die'); }
  }
  heal(amount) { this.health = Math.min(this.maxHealth, this.health + amount); }

  update(dt, input, active = true) {
    const W = this.world;
    this.sinceHurt += dt; this.sinceSprint += dt;
    // --- look
    if (active && this.alive) {
      const k = 0.0021 * this.sens * (this.aiming ? 0.62 : 1) * (this.fovNow / 72);
      this.yaw -= input.lookX * k;
      this.pitch = clamp(this.pitch - input.lookY * k * (this.invertY ? -1 : 1), -88 * DEG, 88 * DEG);
    }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // --- intent
    let mx = 0, mz = 0, wantJump = false, wantCrouch = false, wantSprint = false;
    if (active && this.alive) { [mx, mz] = input.readMove(); wantJump = !!input.pressed.jump; wantCrouch = !!input.held.crouch; wantSprint = !!input.held.sprint; }
    // crouch: can only stand again with head room
    if (wantCrouch) this.crouching = true;
    else if (this.crouching && W.solids.ceilingAt(this.pos.x, this.pos.z, this.pos.y + CROUCH_HEIGHT - 0.1, this.pos.y + HEIGHT + 0.05) === Infinity) this.crouching = false;
    this.height = damp(this.height, this.crouching ? CROUCH_HEIGHT : HEIGHT, 14, dt);
    this.eye = damp(this.eye, this.crouching ? CROUCH_EYE : EYE, 12, dt);
    this.sprinting = wantSprint && mz > 0.5 && !this.crouching && !this.aiming && this.stamina > 0.02 && this.onGround;
    if (this.sprinting) { this.stamina = Math.max(0, this.stamina - dt * 0.15); this.sinceSprint = 0; }
    else if (this.sinceSprint > 0.9) this.stamina = Math.min(1, this.stamina + dt * 0.24);
    this.inWater = W.waterDepth(this.pos.x, this.pos.z) > 0.2 && this.pos.y < 0 ? 1 : 0;
    let speed = this.crouching ? 2.2 : this.sprinting ? 6.8 : 4.4;
    if (this.aiming) speed *= 0.62;
    if (this.inWater) speed *= 0.62;
    speed *= this.speedScale;
    const tx = (cy * mx - sy * mz) * speed, tz = (-sy * mx - cy * mz) * speed;
    const accel = (this.onGround ? 58 : 9) * dt;
    const dvx = tx - this.vel.x, dvz = tz - this.vel.z, dl = Math.hypot(dvx, dvz);
    if (dl > accel) { this.vel.x += dvx / dl * accel; this.vel.z += dvz / dl * accel; } else { this.vel.x = tx; this.vel.z = tz; }
    // --- jump
    this.coyote = this.onGround ? 0.12 : this.coyote - dt;
    if (wantJump && this.coyote > 0 && !this.crouching) { this.vel.y = JUMP; this.onGround = false; this.coyote = 0; this.events.push('jump'); this.noise = Math.max(this.noise, 0.4); }

    // --- move, in sub-steps so a slow frame cannot push the body through a thin wall
    const steps = Math.max(1, Math.ceil(dt / 0.02)), h = dt / steps, p2 = this._p2;
    for (let s = 0; s < steps; s++) {
      p2.x = this.pos.x + this.vel.x * h; p2.z = this.pos.z + this.vel.z * h;
      W.solids.collide(p2, RADIUS, this.pos.y + STEP_UP, this.pos.y + this.height);
      p2.x = clamp(p2.x, BOUNDS.x0 + RADIUS, BOUNDS.x1 - RADIUS); p2.z = clamp(p2.z, BOUNDS.z0 + RADIUS, BOUNDS.z1 - RADIUS);
      // what was asked for and what the walls allowed differ: lose the blocked part of the velocity
      const ax = (p2.x - this.pos.x) / h, az = (p2.z - this.pos.z) / h;
      if (Math.abs(ax - this.vel.x) > 0.5 || Math.abs(az - this.vel.z) > 0.5) { this.vel.x = ax; this.vel.z = az; }
      this.pos.x = p2.x; this.pos.z = p2.z;
      const ground = W.groundAt(this.pos.x, this.pos.z, this.pos.y, this.onGround ? STEP_UP : 0.2);
      if (this.onGround) {
        if (ground >= this.pos.y - 0.6) this.pos.y = ground;
        else this.onGround = false;
      }
      if (!this.onGround) {
        this.vel.y -= GRAVITY * h; this.pos.y += this.vel.y * h;
        if (this.vel.y > 0) {
          const c = W.solids.ceilingAt(this.pos.x, this.pos.z, this.pos.y + 0.8, this.pos.y + this.height + 0.08);
          if (c !== Infinity) { this.pos.y = Math.min(this.pos.y, c - this.height - 0.08); this.vel.y = 0; }
        }
        if (this.pos.y <= ground && this.vel.y <= 0) {
          const impact = -this.vel.y;
          this.pos.y = ground; this.vel.y = 0; this.onGround = true;
          this.events.push('land'); this.bobAmt = Math.min(1.5, impact * 0.12); this.noise = Math.max(this.noise, clamp(impact / 12, 0.2, 0.8));
          if (impact > 11.5) this.hurt((impact - 11.5) * 7, this.pos.x, this.pos.z + 1);
        }
      } else this.vel.y = 0;
    }

    // --- footsteps and how much noise all this makes
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hs > 0.6) {
      this.stepDist += hs * dt; this.bob += hs * dt * (this.crouching ? 2.6 : 1.75);
      const stride = this.sprinting ? 2.5 : this.crouching ? 1.5 : 2.0;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        this.surface = this.inWater ? SURF.water : (W.heightAt(this.pos.x, this.pos.z) < this.pos.y - 0.05 ? SURF.concrete : (W.growAt(this.pos.x, this.pos.z) > 0.45 ? SURF.dirt : SURF.concrete));
        this.events.push('step');
      }
      this.noise = Math.max(this.noise, this.crouching ? 0.08 : this.sprinting ? 0.5 : 0.22);
    }
    this.noise = Math.max(0, this.noise - dt * 0.6);
    this.bobAmt = damp(this.bobAmt, this.onGround ? clamp(hs / 4.4, 0, 1.4) : 0, 8, dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.3);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 1.1);
    // --- recoil settles back like a damped spring
    this.kickVel += (-this.kickPitch * 90 - this.kickVel * 15) * dt; this.kickPitch += this.kickVel * dt;
    this.kickYaw = damp(this.kickYaw, 0, 9, dt);

    this._camera(dt, mx);
  }

  _camera(dt, strafe) {
    const cam = this.camera;
    // ride up steps smoothly instead of snapping
    this.viewY = Math.abs(this.viewY - this.pos.y) > 0.9 ? this.pos.y : damp(this.viewY, this.pos.y, 16, dt);
    const b = this.bobAmt, by = Math.sin(this.bob * 2) * 0.034 * b, bx = Math.cos(this.bob) * 0.022 * b;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    cam.position.set(this.pos.x + cy * bx, this.viewY + this.eye + by - (this.alive ? 0 : 1.1 * (1 - Math.exp(-this.sinceHurt * 3))), this.pos.z - sy * bx);
    const t = this.trauma * this.trauma;
    const shP = (Math.sin(this.bob * 37.1 + performance.now() * 0.047) * 0.5 + Math.sin(performance.now() * 0.091) * 0.5) * t * 0.035;
    const shY = Math.sin(performance.now() * 0.063 + 1.7) * t * 0.035, shR = Math.sin(performance.now() * 0.077 + 4.1) * t * 0.05;
    cam.rotation.set(this.pitch + this.kickPitch + shP, this.yaw + this.kickYaw + shY, -strafe * 0.012 * b + shR + (this.alive ? 0 : 0.5 * (1 - Math.exp(-this.sinceHurt * 3))), 'YXZ');
    const want = this.fov * (this.aiming ? this.aimZoom || 0.78 : this.sprinting ? 1.07 : 1);
    this.fovNow = damp(this.fovNow, want, 12, dt);
    if (Math.abs(cam.fov - this.fovNow) > 0.01) { cam.fov = this.fovNow; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    cam.getWorldDirection(this.forward);
    this.eyePos.copy(cam.position);
  }
}
