import { describe, expect, it, vi } from "vitest";
import { WeaponType } from "../definitions";
import {
  MOBILE_AIM_GESTURE_ZONE_RADIUS_PX,
  MobileGameplayController,
  type MobileGameplayContext,
} from "../mobile/mobile-gameplay-controller";

const createContext = (
  overrides: Partial<MobileGameplayContext> = {}
): MobileGameplayContext => {
  const activeWorm = overrides.activeWorm ?? {
    x: 100,
    y: 200,
    radius: 14,
    facing: 1,
    alive: true,
  };

  return {
    isMobileProfile: true,
    overlaysBlocking: false,
    initialMenuDismissed: true,
    isActiveTeamLocallyControlled: true,
    isLocalTurnActive: true,
    networkReady: true,
    phase: "aim",
    charging: false,
    weapon: WeaponType.Bazooka,
    activeWorm,
    terrainLeft: 0,
    terrainRight: 500,
    topUiOffsetPx: 0,
    getAimInfo: () => ({ targetX: activeWorm.x + 80, targetY: activeWorm.y - 40, angle: 0 }),
    worldToScreen: (x, y) => ({ x, y }),
    setWeapon: vi.fn(),
    setAimTarget: vi.fn(),
    startCharge: vi.fn(() => true),
    cancelCharge: vi.fn(),
    fireCurrentWeapon: vi.fn(() => true),
    recordMovementStep: vi.fn((direction: -1 | 1, durationMs: number) => {
      activeWorm.x += direction * (durationMs / 10);
      return true;
    }),
    captureMovementGhostSprite: vi.fn(() => null),
    ...overrides,
  };
};

describe("MobileGameplayController", () => {
  it("gates controls on mobile profile, overlays, local turn, phase, and network readiness", () => {
    const controller = new MobileGameplayController();
    const ready = createContext();

    expect(controller.canUsePanning(ready)).toBe(true);
    expect(controller.canUseWeaponSelector(ready)).toBe(true);
    expect(controller.canUseControls(ready)).toBe(true);

    expect(controller.canUseControls(createContext({ isMobileProfile: false }))).toBe(false);
    expect(controller.canUseControls(createContext({ overlaysBlocking: true }))).toBe(false);
    expect(controller.canUseControls(createContext({ isLocalTurnActive: false }))).toBe(false);
    expect(controller.canUseControls(createContext({ phase: "projectile" }))).toBe(false);
    expect(controller.canUseControls(createContext({ networkReady: false }))).toBe(false);
  });

  it("moves from tap to aim and sends a default aim target", () => {
    const controller = new MobileGameplayController();
    const context = createContext();

    controller.handleTap(context, 102, 198);
    let state = controller.sync(context);
    expect(state.showAimButton).toBe(true);

    controller.handleAimButton(context);
    state = controller.sync(context);

    expect(state.mode).toBe("aim");
    expect(state.showAimButton).toBe(false);
    expect(context.setAimTarget).toHaveBeenCalledTimes(1);
    const target = (context.setAimTarget as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(target?.[0]).toBeGreaterThan(context.activeWorm.x);
    expect(target?.[1]).toBeLessThan(context.activeWorm.y);
  });

  it("handles charge, cancel, and fire transitions", () => {
    const controller = new MobileGameplayController();
    const context = createContext();

    controller.handleTap(context, 100, 200);
    controller.handleAimButton(context);
    controller.handlePrimary(context);

    expect(context.startCharge).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().aimMode).toBe("charge");

    controller.handleCancel(context);
    expect(context.cancelCharge).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().aimMode).toBe("aim");

    controller.handlePrimary(context);
    controller.handlePrimary(context);
    expect(context.fireCurrentWeapon).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().aimMode).toBe("idle");
  });

  it("fires instant weapons without entering charge", () => {
    const controller = new MobileGameplayController();
    const context = createContext({ weapon: WeaponType.Rifle });

    controller.handleTap(context, 100, 200);
    controller.handleAimButton(context);
    controller.handlePrimary(context);

    expect(context.startCharge).not.toHaveBeenCalled();
    expect(context.fireCurrentWeapon).toHaveBeenCalledWith({ instantPower01: 1 });
    expect(controller.getSnapshot().aimMode).toBe("idle");
  });

  it("detects aim gestures near the clamped aim anchor", () => {
    const controller = new MobileGameplayController();
    const context = createContext({
      getAimInfo: () => ({ targetX: 400, targetY: 200, angle: 0 }),
    });

    controller.handleTap(context, 100, 200);
    controller.handleAimButton(context);

    expect(controller.canStartAimGesture(context, 280, 200)).toBe(true);
    expect(
      controller.canStartAimGesture(
        context,
        280 + MOBILE_AIM_GESTURE_ZONE_RADIUS_PX + 4,
        200
      )
    ).toBe(false);
  });

  it("starts movement assist after dragging beyond the active worm", () => {
    const controller = new MobileGameplayController();
    const context = createContext();

    controller.handleMovementDragStart(context, 120);
    controller.handleMovementDrag(context, 220);
    controller.handleMovementDragEnd(context, 220);

    expect(context.captureMovementGhostSprite).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().movementGhostX).toBe(220);
    expect(controller.sync(context).showJumpButton).toBe(true);

    controller.handleJump();
    controller.updateMovementAssist(context, 0.12);
    expect(context.recordMovementStep).toHaveBeenCalledWith(1, 120, true);
  });

  it("clears transient state when leaving aim phase", () => {
    const controller = new MobileGameplayController();
    const context = createContext();
    controller.handleTap(context, 100, 200);
    controller.handleAimButton(context);

    const state = controller.sync(createContext({ phase: "projectile" }));

    expect(state.visible).toBe(false);
    expect(state.mode).toBe("idle");
    expect(controller.getSnapshot().aimTarget).toBeNull();
  });
});
