/**
 * Entry point: menu → match → (end screen) → menu.
 */
import { Game } from './game';
import { loadGameAssets } from './render/assets';
import { showMenu } from './ui/menu';

const root = document.getElementById('game-root')!;

// AI-painted sprites load once in the background; matches started before the
// load finishes simply use the procedural art.
const assetsPromise = loadGameAssets();

function boot(): void {
  showMenu(root, ({ config }) => {
    void assetsPromise.then((assets) => {
      new Game(root, config, boot, assets);
    });
  });
}

boot();
