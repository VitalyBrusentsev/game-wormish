import { Game } from "./game";

function main(): void {
  const canvasContainer = document.body;
  let game: Game | null = null;
  let resizeScheduled = false;

  const applyResize = () => {
    resizeScheduled = false;
    const width = window.innerWidth | 0;
    const height = window.innerHeight | 0;
    if (!game) {
      const newGame = new Game(width, height);
      newGame.mount(canvasContainer);
      newGame.start();
      game = newGame;
      return;
    }
    game.resize(width, height);
  };

  const scheduleResize = () => {
    if (resizeScheduled) return;
    resizeScheduled = true;
    requestAnimationFrame(() => applyResize());
  };

  window.addEventListener("resize", scheduleResize);
  applyResize();
}

main();
