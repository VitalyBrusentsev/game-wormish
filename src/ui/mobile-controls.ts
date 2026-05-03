import { WeaponType } from "../definitions";
import { drawWeaponSprite } from "../weapons/weapon-sprites";

export type MobileAimMode = "idle" | "aim" | "charge";

export type MobileControlsState = {
  visible: boolean;
  weapon: WeaponType;
  canSelectWeapon: boolean;
  weaponPickerOpen: boolean;
  mode: MobileAimMode;
  showAimButton: boolean;
  aimButtonX: number;
  aimButtonY: number;
  showJumpButton: boolean;
  topUiOffsetPx: number;
};

export type MobileControlsCallbacks = {
  onToggleWeaponPicker: () => void;
  onSelectWeapon: (weapon: WeaponType) => void;
  onAimButton: () => void;
  onCancel: () => void;
  onPrimary: () => void;
  onJump: () => void;
};

const WEAPON_ORDER: readonly WeaponType[] = [
  WeaponType.Bazooka,
  WeaponType.HandGrenade,
  WeaponType.Rifle,
  WeaponType.Uzi,
];

function bindPress(button: HTMLButtonElement, onPress: () => void) {
  let skipClickOnce = false;
  button.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    skipClickOnce = true;
    if (event.pointerType !== "mouse") {
      event.preventDefault();
    }
    onPress();
  });
  button.addEventListener("click", (event) => {
    if (skipClickOnce) {
      skipClickOnce = false;
      event.preventDefault();
      return;
    }
    onPress();
  });
}

function isChargeWeapon(weapon: WeaponType): boolean {
  return weapon === WeaponType.Bazooka || weapon === WeaponType.HandGrenade;
}

function weaponShortName(weapon: WeaponType): string {
  switch (weapon) {
    case WeaponType.HandGrenade:
      return "Grenade";
    case WeaponType.Bazooka:
      return "Bazooka";
    case WeaponType.Rifle:
      return "Rifle";
    case WeaponType.Uzi:
      return "Uzi";
  }
}

function weaponDescription(weapon: WeaponType): string {
  switch (weapon) {
    case WeaponType.HandGrenade:
      return "Large blast\nTimed explosive";
    case WeaponType.Bazooka:
      return "High damage\nExplosive weapon";
    case WeaponType.Rifle:
      return "Direct shot\nHigh precision";
    case WeaponType.Uzi:
      return "Burst fire\nClose pressure";
  }
}

export class MobileControlsOverlay {
  private readonly callbacks: MobileControlsCallbacks;
  private readonly root: HTMLDivElement;
  private readonly weaponDock: HTMLDivElement;
  private readonly weaponButton: HTMLButtonElement;
  private readonly weaponCopy: HTMLDivElement;
  private readonly weaponLabel: HTMLSpanElement;
  private readonly weaponDescription: HTMLSpanElement;
  private readonly weaponIcon: HTMLCanvasElement;
  private readonly weaponMenu: HTMLDivElement;
  private readonly weaponButtons = new Map<WeaponType, HTMLButtonElement>();
  private readonly aimButton: HTMLButtonElement;
  private readonly actionDock: HTMLDivElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly primaryButton: HTMLButtonElement;
  private readonly jumpButton: HTMLButtonElement;
  private mounted = false;

  constructor(callbacks: MobileControlsCallbacks) {
    this.callbacks = callbacks;

    this.root = document.createElement("div");
    this.root.className = "mobile-controls-layer";

    this.weaponDock = document.createElement("div");
    this.weaponDock.className = "mobile-weapon-dock";

    this.weaponButton = document.createElement("button");
    this.weaponButton.type = "button";
    this.weaponButton.className = "mobile-weapon-button";
    bindPress(this.weaponButton, () => this.callbacks.onToggleWeaponPicker());

    this.weaponIcon = document.createElement("canvas");
    this.weaponIcon.className = "mobile-weapon-icon";
    this.weaponIcon.width = 62;
    this.weaponIcon.height = 40;

    this.weaponLabel = document.createElement("span");
    this.weaponLabel.className = "mobile-weapon-label";

    this.weaponDescription = document.createElement("span");
    this.weaponDescription.className = "mobile-weapon-description";

    this.weaponCopy = document.createElement("div");
    this.weaponCopy.className = "mobile-weapon-copy";
    this.weaponCopy.append(this.weaponLabel, this.weaponDescription);
    this.weaponButton.append(this.weaponIcon, this.weaponCopy);

    this.weaponMenu = document.createElement("div");
    this.weaponMenu.className = "mobile-weapon-menu";

    for (const weapon of WEAPON_ORDER) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mobile-weapon-item";
      button.textContent = weaponShortName(weapon);
      bindPress(button, () => this.callbacks.onSelectWeapon(weapon));
      this.weaponButtons.set(weapon, button);
      this.weaponMenu.appendChild(button);
    }

    this.weaponDock.append(this.weaponButton, this.weaponMenu);

    this.aimButton = document.createElement("button");
    this.aimButton.type = "button";
    this.aimButton.className = "mobile-aim-button";
    this.aimButton.textContent = "Aim";
    bindPress(this.aimButton, () => this.callbacks.onAimButton());

    this.actionDock = document.createElement("div");
    this.actionDock.className = "mobile-action-dock";

    this.cancelButton = document.createElement("button");
    this.cancelButton.type = "button";
    this.cancelButton.className = "mobile-action-button mobile-action-button--secondary";
    this.cancelButton.textContent = "Cancel";
    bindPress(this.cancelButton, () => this.callbacks.onCancel());

    this.primaryButton = document.createElement("button");
    this.primaryButton.type = "button";
    this.primaryButton.className = "mobile-action-button mobile-action-button--primary";
    this.primaryButton.textContent = "Fire";
    bindPress(this.primaryButton, () => this.callbacks.onPrimary());

    this.actionDock.append(this.cancelButton, this.primaryButton);

    this.jumpButton = document.createElement("button");
    this.jumpButton.type = "button";
    this.jumpButton.className = "mobile-jump-button";
    this.jumpButton.textContent = "Jump";
    bindPress(this.jumpButton, () => this.callbacks.onJump());

    this.root.append(this.weaponDock, this.aimButton, this.actionDock, this.jumpButton);
  }

  mount() {
    if (this.mounted) return;
    document.body.appendChild(this.root);
    this.mounted = true;
  }

  dispose() {
    if (!this.mounted) return;
    if (this.root.parentElement) {
      this.root.parentElement.removeChild(this.root);
    }
    this.mounted = false;
  }

  setState(state: MobileControlsState) {
    if (!this.mounted) return;

    this.root.style.setProperty(
      "--mobile-top-ui-offset-px",
      `${Math.max(0, Math.round(state.topUiOffsetPx))}px`
    );
    this.root.classList.toggle("mobile-controls-layer--visible", state.visible);
    this.weaponDock.classList.toggle("mobile-weapon-dock--hidden", !state.visible);
    this.weaponButton.disabled = !state.canSelectWeapon;
    this.weaponMenu.classList.toggle("mobile-weapon-menu--open", state.weaponPickerOpen);
    this.weaponLabel.textContent = weaponShortName(state.weapon);
    this.weaponDescription.textContent = weaponDescription(state.weapon);
    this.drawWeaponIcon(state.weapon);
    for (const [weapon, button] of this.weaponButtons) {
      button.classList.toggle("mobile-weapon-item--active", weapon === state.weapon);
      button.disabled = !state.canSelectWeapon;
    }

    const showAimButton = state.visible && state.showAimButton && state.mode === "idle";
    this.aimButton.classList.toggle("mobile-aim-button--visible", showAimButton);
    if (showAimButton) {
      this.aimButton.style.left = `${Math.round(state.aimButtonX)}px`;
      this.aimButton.style.top = `${Math.round(state.aimButtonY)}px`;
    }

    const showActions = state.visible && (state.mode === "aim" || state.mode === "charge");
    this.actionDock.classList.toggle("mobile-action-dock--visible", showActions);
    const primaryLabel =
      state.mode === "charge"
        ? "Fire"
        : isChargeWeapon(state.weapon)
          ? "Charge"
          : "Fire";
    this.primaryButton.textContent = primaryLabel;

    this.jumpButton.classList.toggle(
      "mobile-jump-button--visible",
      state.visible && state.showJumpButton
    );
  }

  private drawWeaponIcon(weapon: WeaponType) {
    const ctx = this.weaponIcon.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, this.weaponIcon.width, this.weaponIcon.height);

    if (weapon === WeaponType.HandGrenade) {
      const cx = this.weaponIcon.width * 0.42;
      const cy = this.weaponIcon.height * 0.62;
      const r = 11.5;
      const now = performance.now() * 0.001;

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (let i = 0; i < 4; i += 1) {
        const drift = (now * 0.34 + i * 0.23) % 1;
        const smokeX = cx + 6 + Math.sin(now * 1.8 + i * 1.4) * (2.2 + i * 0.35);
        const smokeY = cy - r - 9 - drift * 18;
        const smokeR = 1.9 + drift * 3.2;
        ctx.globalAlpha = (1 - drift) * 0.34;
        ctx.fillStyle = "rgba(222,232,238,0.9)";
        ctx.beginPath();
        ctx.arc(smokeX, smokeY, smokeR, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(198,218,224,0.72)";
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(cx + 1, cy - r - 3);
      ctx.quadraticCurveTo(cx + 8, cy - r - 12, cx + 15, cy - r - 10);
      ctx.stroke();

      ctx.strokeStyle = "rgba(255,170,82,0.86)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(cx + 12, cy - r - 10);
      ctx.lineTo(cx + 16, cy - r - 10);
      ctx.stroke();

      const body = ctx.createRadialGradient(cx - 4, cy - 5, 2, cx, cy, r + 3);
      body.addColorStop(0, "#5c6970");
      body.addColorStop(0.45, "#2c363b");
      body.addColorStop(1, "#11181d");
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(8,12,15,0.92)";
      ctx.lineWidth = 2.2;
      ctx.stroke();

      ctx.strokeStyle = "rgba(190,211,218,0.38)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 1.4, Math.PI * 1.05, Math.PI * 1.9);
      ctx.stroke();

      ctx.fillStyle = "#65737a";
      ctx.fillRect(cx - 3.2, cy - r - 7, 6.4, 7.5);
      ctx.strokeStyle = "rgba(9,13,16,0.68)";
      ctx.lineWidth = 1.4;
      ctx.strokeRect(cx - 3.2, cy - r - 7, 6.4, 7.5);

      ctx.globalAlpha = 0.86;
      ctx.fillStyle = "rgba(245,255,255,0.78)";
      ctx.beginPath();
      ctx.ellipse(cx - 4.2, cy - 4.6, 2.4, 3.7, 0.72, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      return;
    }

    const ok = drawWeaponSprite({
      ctx,
      weapon,
      rotationPoint: { x: this.weaponIcon.width * 0.4, y: this.weaponIcon.height * 0.52 },
      aimAngle: -0.22,
    });
    if (!ok) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(weaponShortName(weapon), this.weaponIcon.width * 0.5, this.weaponIcon.height * 0.5);
    }
  }
}
