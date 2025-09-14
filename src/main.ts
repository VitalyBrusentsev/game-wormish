import { Game } from "./game";

function main(): void {
  const canvasContainer = document.body;
  const resize = () => {
    // Recreate game on resize for simplicity
    canvasContainer.innerHTML = "";
    const width = window.innerWidth | 0;
    const height = window.innerHeight | 0;
    const game = new Game(width, height);
    game.mount(canvasContainer);
    requestAnimationFrame((t) => game.frame(t));
  };
  window.addEventListener("resize", () => {
    // Debounce recreate
    resize();
  });
  resize();
}

main();