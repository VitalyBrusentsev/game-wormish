import { WeaponType } from "./definitions";

export type Phase = "aim" | "projectile" | "post" | "gameover";

export class GameState {
  phase: Phase = "aim";
  weapon: WeaponType = WeaponType.Bazooka;
  turnStartMs: number = 0;
  charging: boolean = false;
  chargeStartMs: number = 0;

  startTurn(nowMs: number, defaultWeapon: WeaponType = WeaponType.Bazooka) {
    this.phase = "aim";
    this.weapon = defaultWeapon;
    this.turnStartMs = nowMs;
    this.charging = false;
    this.chargeStartMs = 0;
  }

  setWeapon(weapon: WeaponType) {
    this.weapon = weapon;
  }

  beginCharge(nowMs: number) {
    this.charging = true;
    this.chargeStartMs = nowMs;
  }

  endCharge(nowMs: number): number {
    const power = this.getCharge01(nowMs);
    this.charging = false;
    return power;
  }

  cancelCharge() {
    this.charging = false;
  }

  getCharge01(nowMs: number): number {
    const elapsed = Math.max(0, nowMs - this.chargeStartMs);
    const speed = 1 / 1400; // 1/ms
    const t = elapsed * speed;
    const frac = t % 2;
    return frac < 1 ? frac : 2 - frac;
  }

  timeLeftMs(nowMs: number, turnTimeMs: number): number {
    return Math.max(0, turnTimeMs - (nowMs - this.turnStartMs));
  }

  pauseFor(pausedMs: number) {
    if (pausedMs <= 0) return;
    this.turnStartMs += pausedMs;
    if (this.chargeStartMs) {
      this.chargeStartMs += pausedMs;
    }
  }

  shotFired() {
    if (this.phase === "aim") this.phase = "projectile";
  }

  expireAimPhase() {
    if (this.phase === "aim") this.phase = "post";
  }

  endProjectilePhase() {
    if (this.phase === "projectile") this.phase = "post";
  }
}