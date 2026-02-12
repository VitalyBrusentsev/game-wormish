import { afterEach, describe, expect, it, vi } from "vitest";
import { detectControlProfile } from "../mobile/control-profile";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectControlProfile", () => {
  it("returns desktop when no window is available", () => {
    vi.stubGlobal("window", undefined);
    expect(detectControlProfile()).toBe("desktop");
  });

  it("returns mobile portrait for coarse pointer in portrait orientation", () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 1 });
    vi.stubGlobal("window", {
      innerWidth: 390,
      innerHeight: 844,
      matchMedia: (query: string) => ({
        matches: query === "(pointer: coarse)" || query === "(any-pointer: coarse)",
      }),
    });

    expect(detectControlProfile()).toBe("mobile-portrait");
  });

  it("returns desktop when device is not in portrait mode", () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 2 });
    vi.stubGlobal("window", {
      innerWidth: 1024,
      innerHeight: 600,
      matchMedia: (_query: string) => ({ matches: true }),
    });

    expect(detectControlProfile()).toBe("desktop");
  });
});
