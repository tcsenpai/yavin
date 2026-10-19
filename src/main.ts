import '@fontsource/orbitron/600.css';
import '@fontsource/orbitron/800.css';
import '@fontsource/news-cycle/400.css';
import '@fontsource/news-cycle/700.css';
import './style.css';
import { Game } from './game/game';
import { briefing } from './levels/briefing';
import { epilogue } from './levels/epilogue';
import { mission1 } from './levels/mission1Assault';
import { mission2 } from './levels/mission2Surface';
import { mission3 } from './levels/mission3Trench';
import { skirmishLevels } from './levels/skirmish';
import { training } from './levels/training';

const app = document.getElementById('app')!;
const levels = [training, mission1, mission2, mission3, epilogue, briefing, ...skirmishLevels];
// Campaign flow: straight into the battle; the briefing hologram is an optional extra.
const campaign = [mission1.id, mission2.id, mission3.id, epilogue.id];
const game = new Game(app, levels, campaign);
if (import.meta.env.DEV) Object.assign(window, { game });
