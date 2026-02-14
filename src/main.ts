import { Game } from "./game";
import { createGameDebugApi } from "./debug/game-debug";

const SINGLE_PLAYER_CONFIG = {
  playerTeamColor: "Blue" as const,
  playerStartSide: "left" as const,
};

function main(): void {
  const canvasContainer = document.body;
  let game: Game | null = null;
  let resizeScheduled = false;

  const readViewportSize = () => {
    const viewport = window.visualViewport;
    if (viewport) {
      const scale =
        Number.isFinite(viewport.scale) && viewport.scale > 0
          ? viewport.scale
          : 1;
      return {
        width: Math.max(1, Math.round(viewport.width * scale)),
        height: Math.max(1, Math.round(viewport.height * scale)),
      };
    }
    return {
      width: Math.max(1, window.innerWidth | 0),
      height: Math.max(1, window.innerHeight | 0),
    };
  };

  const applyResize = () => {
    resizeScheduled = false;
    const { width, height } = readViewportSize();
    if (!game) {
      const newGame = new Game(width, height, {
        singlePlayer: SINGLE_PLAYER_CONFIG,
      });
      newGame.mount(canvasContainer);
      newGame.start();
      window.Game = createGameDebugApi(newGame);
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
  window.visualViewport?.addEventListener("resize", scheduleResize);
  window.visualViewport?.addEventListener("scroll", scheduleResize);
  applyResize();
}

main();
