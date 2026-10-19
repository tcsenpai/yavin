import './style.css';
import { Game } from './game/game';
import { level0 } from './levels/level0Briefing';
import { level1 } from './levels/level1Approach';
import { level2 } from './levels/level2Surface';
import { level3 } from './levels/level3Dogfight';
import { level4 } from './levels/level4Trench';
import { level5 } from './levels/level5Epilogue';
import { levelSpace } from './levels/levelSpaceBattle';

const app = document.getElementById('app')!;
const game = new Game(app, [level0, level1, levelSpace, level2, level3, level4, level5]);
if (import.meta.env.DEV) Object.assign(window, { game });
