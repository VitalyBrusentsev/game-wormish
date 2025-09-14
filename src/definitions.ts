export type TeamId = "Red" | "Blue";

export enum WeaponType {
  Bazooka = "Bazooka",
  HandGrenade = "Hand Grenade",
  Rifle = "Rifle",
}

export const COLORS = {
  bgSkyTop: "#78a6ff",
  bgSkyBottom: "#d7ecff",
  water: "#3a68b1",
  sand: "#9c7a57",
  dirt: "#6b4b2a",
  dirtDark: "#4a331e",
  grass: "#4caf50",
  grassHighlight: "#7adf79",
  red: "#ff4d4d",
  blue: "#4da3ff",
  white: "#ffffff",
  text: "#222",
  shadow: "rgba(0,0,0,0.3)",
  hudBg: "rgba(0,0,0,0.35)",
  hudPanel: "rgba(0,0,0,0.5)",
  hudPanelBorder: "rgba(255,255,255,0.1)",
  healthRed: "#ff5555",
  healthGreen: "#5aff7a",
  power: "#ffcc00",
};

export const WORLD = {
  gravity: 900, // px/s^2
  windMax: 180, // px/s^2
  walkSpeed: 120, // px/s
  jumpSpeed: 300, // px/s
  wormRadius: 12, // px
  projectileRadius: 6,
  terrainMarginTop: 140,
  minGround: 0.5, // fraction of height for min ground level
  maxGround: 0.8, // fraction of height for max ground level
};

export const GAMEPLAY = {
  turnTimeMs: 30000,
  postShotDelayMs: 1200,
  teamSize: 3,
  // Bazooka reduced distance by ~50% by halving launch speed
  bazooka: {
    minPower: 450,   // was 900
    maxPower: 1150,  // was 2300
    explosionRadius: 42,
    damage: 75,
    trail: true,
  },
  // Hand Grenade: flies ~1.5x shorter distance than bazooka
  // Distance ~ v^2, so speed factor ~ sqrt(1/1.5) ≈ 0.82 of bazooka speeds.
  handGrenade: {
    minPower: 370,
    maxPower: 940,
    fuseMs: 3000,
    restitution: 0.35,
    explosionRadius: 52,
    damage: 90,
  },
  // Rifle: straight-line shot (no gravity), small ground dent, heavy direct damage
  rifle: {
    speed: 1600,               // px/s
    explosionRadius: 14,       // ~3x smaller than bazooka's radius (42/3=14)
    directDamage: 75,          // 75% of total health
    aimRadius: 200,            // aiming crosshair limited to this radius
    projectileRadius: 3,       // small bullet
    maxLifetime: 1.6,          // seconds before despawn
  },
};



export type PredictedPoint = { x: number; y: number; alpha: number };

export type WormSnapshot = {
  x: number;
  y: number;
  health: number;
  team: TeamId;
  alive: boolean;
};

export type HudState = {
  currentTeam: TeamId;
  weapon: WeaponType;
  turnTimeLeftMs: number;
  wind: number;
  charging: boolean;
  charge01: number;
  redTeamHealth: number;
  blueTeamHealth: number;
  message: string | null;
  predicted: PredictedPoint[];
};

export const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));


export const randRange = (min: number, max: number) =>
  Math.random() * (max - min) + min;


export const distance = (x1: number, y1: number, x2: number, y2: number) =>
  Math.hypot(x2 - x1, y2 - y1);






export const nowMs = () => performance.now();