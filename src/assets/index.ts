// Central export of terrain tile URLs via Vite's asset handling.
// Using new URL ensures assets are bundled and relative for subfolder deployment.
export const groundTiles: string[] = [
  new URL('./ground1.png', import.meta.url).toString(),
  new URL('./ground2.png', import.meta.url).toString(),
];