export type ControlProfile = "desktop" | "mobile-portrait";

function hasCoarsePointer(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") {
    try {
      if (window.matchMedia("(pointer: coarse)").matches) return true;
      if (window.matchMedia("(any-pointer: coarse)").matches) return true;
    } catch {
      // ignore and fallback
    }
  }
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

function isPortraitOrientation(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") {
    try {
      return window.matchMedia("(orientation: portrait)").matches;
    } catch {
      // ignore and fallback
    }
  }
  return window.innerHeight >= window.innerWidth;
}

export function detectControlProfile(): ControlProfile {
  if (typeof window === "undefined") return "desktop";
  const coarse = hasCoarsePointer();
  const portrait = isPortraitOrientation();
  return coarse && portrait ? "mobile-portrait" : "desktop";
}
