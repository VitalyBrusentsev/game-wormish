import { describe, expect, it, vi } from "vitest";
import { MobileGestureController } from "../mobile/mobile-gesture-controller";

type MutablePointerEvent = Event & {
  pointerId: number;
  isPrimary: boolean;
  pointerType: string;
  button: number;
  clientX: number;
  clientY: number;
};

class FakeCanvas extends EventTarget {
  width = 200;
  height = 100;

  setPointerCapture = vi.fn();
  hasPointerCapture = vi.fn(() => false);
  releasePointerCapture = vi.fn();

  getBoundingClientRect() {
    return {
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 110,
      bottom: 70,
      width: 100,
      height: 50,
      toJSON: () => ({}),
    } as DOMRect;
  }
}

function createPointerEvent(
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number
): MutablePointerEvent {
  const event = new Event(type, { bubbles: false, cancelable: true }) as MutablePointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    isPrimary: { value: true },
    pointerType: { value: "touch" },
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
}

describe("MobileGestureController", () => {
  it("normalizes pointer coordinates to canvas space for world and pan callbacks", () => {
    const canvas = new FakeCanvas();
    const onPan = vi.fn();
    const screenToWorld = vi.fn((x: number, y: number) => ({ x, y }));

    const controller = new MobileGestureController(canvas as unknown as HTMLCanvasElement, {
      isEnabled: () => true,
      isAimGestureActive: () => false,
      screenToWorld,
      canStartWormInteraction: () => false,
      onTap: () => { },
      onPan,
      onMovementDragStart: () => { },
      onMovementDrag: () => { },
      onMovementDragEnd: () => { },
      onAimGesture: () => { },
    });

    canvas.dispatchEvent(createPointerEvent("pointerdown", 1, 60, 45));
    canvas.dispatchEvent(createPointerEvent("pointermove", 1, 70, 50));
    canvas.dispatchEvent(createPointerEvent("pointerup", 1, 70, 50));

    expect(screenToWorld).toHaveBeenCalledWith(100, 50);
    expect(screenToWorld).toHaveBeenCalledWith(120, 60);
    expect(onPan).toHaveBeenCalledWith(20, 10);

    controller.dispose();
  });
});
