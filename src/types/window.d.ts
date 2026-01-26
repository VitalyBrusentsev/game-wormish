export {};

declare global {
  interface Window {
    spriteOffsets?: Partial<
      Record<"tail2" | "tail1" | "torso" | "head" | "helmet" | "face", { x: number; y: number }>
    >;
  }
}
