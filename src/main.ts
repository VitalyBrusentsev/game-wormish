import { Game } from "./game";

function main(): void {
  const canvasContainer = document.body;
  let game: Game | null = null;
  let lastWidth = 0;
  let lastHeight = 0;
  let resizeScheduled = false;

  const recreateGame = () => {
    resizeScheduled = false;
    const width = window.innerWidth | 0;
    const height = window.innerHeight | 0;
    const dimensionsChanged = width !== lastWidth || height !== lastHeight;
    if (!game || dimensionsChanged) {
      lastWidth = width;
      lastHeight = height;
      if (game) {
        game.dispose();
        game = null;
      }
      const newGame = new Game(width, height);
      newGame.mount(canvasContainer);
      newGame.start();
      game = newGame;
    }
  };

  const scheduleResize = () => {
    if (resizeScheduled) return;
    resizeScheduled = true;
    requestAnimationFrame(() => recreateGame());
  };

  window.addEventListener("resize", scheduleResize);
  recreateGame();
}

main();