export {};

declare global {
  interface Window {
    spriteOffsets?: Partial<
      Record<
        "tail2" | "tail1" | "torso" | "belt1" | "collar" | "head" | "helmet" | "face",
        { x: number; y: number }
      >
    >;
  }
}
