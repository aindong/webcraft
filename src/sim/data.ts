/**
 * Data-driven definitions for races, units, and buildings.
 * All gameplay content lives here — adding a third race is a data change,
 * not a code change.
 */

export interface Cost {
  gold: number;
  wood: number;
}

export interface UnitDef {
  id: string;
  name: string;
  /** one-line tooltip description shown in the HUD */
  desc: string;
  cost: Cost;
  food: number;
  hp: number;
  /** tiles per second */
  speed: number;
  damage: number;
  /** attack range in tiles (1.2 = melee) */
  range: number;
  /** seconds between attacks */
  attackPeriod: number;
  /** auto-acquire targets within this many tiles */
  aggroRange: number;
  /** seconds to train */
  trainTime: number;
  sight: number;
  isWorker: boolean;
  /** building level required to train (1 = always) */
  requiresLevel: number;
  /** drawn size hint for renderer */
  scale: number;
}

export interface BuildingLevelDef {
  name: string;
  /** cost to upgrade INTO this level (ignored for level 1 — that's the build cost) */
  cost: Cost;
  /** seconds to upgrade into this level */
  upgradeTime: number;
  hp: number;
  providesFood: number;
  /** damage for defensive towers; 0 = doesn't attack */
  damage: number;
  range: number;
  attackPeriod: number;
}

export interface BuildingDef {
  id: string;
  name: string;
  /** one-line tooltip description shown in the HUD */
  desc: string;
  cost: Cost;
  /** footprint in tiles */
  size: number;
  buildTime: number;
  sight: number;
  isTownHall: boolean;
  /** unit ids this building can train */
  trains: string[];
  levels: BuildingLevelDef[];
}

export interface VoiceProfile {
  pitch: number;
  rate: number;
  select: string[];
  move: string[];
  attack: string[];
  build: string[];
  workComplete: string[];
  trainReady: string[];
  underAttack: string[];
  noGold: string[];
  noWood: string[];
  noFood: string[];
  victory: string[];
  defeat: string[];
}

export interface RaceDef {
  id: string;
  name: string;
  description: string;
  worker: string;
  townHall: string;
  /** buildable by workers, in build-menu order */
  buildings: string[];
  voice: VoiceProfile;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const UNITS: Record<string, UnitDef> = {
  // ----- Human -----
  peasant: {
    id: 'peasant', name: 'Peasant',
    desc: 'Gathers gold and lumber and constructs buildings. Keeps chopping nearby forests until told otherwise.',
    cost: { gold: 75, wood: 0 }, food: 1,
    hp: 45, speed: 2.2, damage: 5, range: 1.2, attackPeriod: 1.6,
    aggroRange: 0, trainTime: 12, sight: 5, isWorker: true, requiresLevel: 1, scale: 0.85,
  },
  footman: {
    id: 'footman', name: 'Footman',
    desc: 'Sturdy front-line melee soldier — the backbone of any army.',
    cost: { gold: 135, wood: 0 }, food: 2,
    hp: 100, speed: 2.4, damage: 10, range: 1.2, attackPeriod: 1.2,
    aggroRange: 5, trainTime: 18, sight: 6, isWorker: false, requiresLevel: 1, scale: 1,
  },
  archer: {
    id: 'archer', name: 'Archer',
    desc: 'Fragile ranged attacker. Deadly behind a line of footmen.',
    cost: { gold: 110, wood: 50 }, food: 2,
    hp: 60, speed: 2.5, damage: 12, range: 5, attackPeriod: 1.5,
    aggroRange: 6, trainTime: 20, sight: 7, isWorker: false, requiresLevel: 2, scale: 0.95,
  },
  knight: {
    id: 'knight', name: 'Knight',
    desc: 'Fast, heavily armored cavalry that excels at breaking enemy lines.',
    cost: { gold: 220, wood: 40 }, food: 3,
    hp: 160, speed: 3.2, damage: 18, range: 1.3, attackPeriod: 1.3,
    aggroRange: 5, trainTime: 28, sight: 6, isWorker: false, requiresLevel: 3, scale: 1.15,
  },

  // ----- Orc -----
  peon: {
    id: 'peon', name: 'Peon',
    desc: 'Gathers gold and lumber and builds structures. Works until the work is done.',
    cost: { gold: 75, wood: 0 }, food: 1,
    hp: 45, speed: 2.1, damage: 5, range: 1.2, attackPeriod: 1.7,
    aggroRange: 0, trainTime: 12, sight: 5, isWorker: true, requiresLevel: 1, scale: 0.9,
  },
  grunt: {
    id: 'grunt', name: 'Grunt',
    desc: 'Tough melee bruiser. Hits hard and soaks damage.',
    cost: { gold: 140, wood: 0 }, food: 2,
    hp: 110, speed: 2.3, damage: 10, range: 1.2, attackPeriod: 1.3,
    aggroRange: 5, trainTime: 18, sight: 6, isWorker: false, requiresLevel: 1, scale: 1.05,
  },
  spearthrower: {
    id: 'spearthrower', name: 'Spear Thrower',
    desc: 'Ranged hunter who skewers foes from afar but falls quickly in melee.',
    cost: { gold: 115, wood: 45 }, food: 2,
    hp: 60, speed: 2.4, damage: 12, range: 4.5, attackPeriod: 1.6,
    aggroRange: 6, trainTime: 20, sight: 7, isWorker: false, requiresLevel: 2, scale: 1,
  },
  raider: {
    id: 'raider', name: 'Raider',
    desc: 'Swift wolf-riding shock troops, perfect for flanking and raids.',
    cost: { gold: 230, wood: 40 }, food: 3,
    hp: 150, speed: 3.4, damage: 17, range: 1.3, attackPeriod: 1.3,
    aggroRange: 5, trainTime: 28, sight: 6, isWorker: false, requiresLevel: 3, scale: 1.15,
  },
};

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

const NO_ATTACK = { damage: 0, range: 0, attackPeriod: 1 };

export const BUILDINGS: Record<string, BuildingDef> = {
  // ----- Human -----
  townhall: {
    id: 'townhall', name: 'Town Hall',
    desc: 'Seat of power: trains Peasants and receives gold and lumber. Upgrade to Keep and Castle for more food.',
    cost: { gold: 400, wood: 250 }, size: 3, buildTime: 60, sight: 8,
    isTownHall: true, trains: ['peasant'],
    levels: [
      { name: 'Town Hall', cost: { gold: 0, wood: 0 }, upgradeTime: 0, hp: 1200, providesFood: 5, ...NO_ATTACK },
      { name: 'Keep', cost: { gold: 500, wood: 300 }, upgradeTime: 45, hp: 1700, providesFood: 8, ...NO_ATTACK },
      { name: 'Castle', cost: { gold: 800, wood: 400 }, upgradeTime: 60, hp: 2400, providesFood: 12, ...NO_ATTACK },
    ],
  },
  house: {
    id: 'house', name: 'House',
    desc: 'Raises your food cap so you can train more units. Upgrades to a Manor.',
    cost: { gold: 80, wood: 30 }, size: 2, buildTime: 18, sight: 4,
    isTownHall: false, trains: [],
    levels: [
      { name: 'House', cost: { gold: 0, wood: 0 }, upgradeTime: 0, hp: 270, providesFood: 4, ...NO_ATTACK },
      { name: 'Manor', cost: { gold: 100, wood: 60 }, upgradeTime: 20, hp: 430, providesFood: 8, ...NO_ATTACK },
    ],
  },
  barracks: {
    id: 'barracks', name: 'Barracks',
    desc: 'Trains your military. Upgrade it to unlock Archers (II) and Knights (III).',
    cost: { gold: 180, wood: 70 }, size: 3, buildTime: 35, sight: 5,
    isTownHall: false, trains: ['footman', 'archer', 'knight'],
    levels: [
      { name: 'Barracks', cost: { gold: 0, wood: 0 }, upgradeTime: 0, hp: 650, providesFood: 0, ...NO_ATTACK },
      { name: 'Barracks II', cost: { gold: 200, wood: 100 }, upgradeTime: 30, hp: 850, providesFood: 0, ...NO_ATTACK },
      { name: 'Barracks III', cost: { gold: 350, wood: 150 }, upgradeTime: 40, hp: 1050, providesFood: 0, ...NO_ATTACK },
    ],
  },
  tower: {
    id: 'tower', name: 'Watch Tower',
    desc: 'Defensive tower that automatically shoots nearby enemies.',
    cost: { gold: 120, wood: 80 }, size: 2, buildTime: 30, sight: 8,
    isTownHall: false, trains: [],
    levels: [
      { name: 'Watch Tower', cost: { gold: 0, wood: 0 }, upgradeTime: 0, hp: 380, providesFood: 0, damage: 13, range: 6, attackPeriod: 1.4 },
      { name: 'Guard Tower', cost: { gold: 150, wood: 100 }, upgradeTime: 25, hp: 520, providesFood: 0, damage: 19, range: 7, attackPeriod: 1.2 },
    ],
  },

  // ----- Orc -----
  greathall: {
    id: 'greathall', name: 'Great Hall',
    desc: 'Heart of the camp: trains Peons and receives gold and lumber. Upgrade to Stronghold and Fortress for more food.',
    cost: { gold: 400, wood: 250 }, size: 3, buildTime: 60, sight: 8,
    isTownHall: true, trains: ['peon'],
    levels: [
      { name: 'Great Hall', cost: { gold: 0, wood: 0 }, upgradeTime: 0, hp: 1200, providesFood: 5, ...NO_ATTACK },
      { name: 'Stronghold', cost: { gold: 500, wood: 300 }, upgradeTime: 45, hp: 1700, providesFood: 8, ...NO_ATTACK },
      { name: 'Fortress', cost: { gold: 800, wood: 400 }, upgradeTime: 60, hp: 2400, providesFood: 12, ...NO_ATTACK },
    ],
  },
  hut: {
    id: 'hut', name: 'Hut',
    desc: 'Raises your food cap so you can train more units. Upgrades to a War Hut.',
    cost: { gold: 80, wood: 30 }, size: 2, buildTime: 18, sight: 4,
    isTownHall: false, trains: [],
    levels: [
      { name: 'Hut', cost: { gold: 0, wood: 0 }, upgradeTime: 0, hp: 270, providesFood: 4, ...NO_ATTACK },
      { name: 'War Hut', cost: { gold: 100, wood: 60 }, upgradeTime: 20, hp: 430, providesFood: 8, ...NO_ATTACK },
    ],
  },
  warcamp: {
    id: 'warcamp', name: 'War Camp',
    desc: 'Trains your military. Upgrade it to unlock Spear Throwers (II) and Raiders (III).',
    cost: { gold: 180, wood: 70 }, size: 3, buildTime: 35, sight: 5,
    isTownHall: false, trains: ['grunt', 'spearthrower', 'raider'],
    levels: [
      { name: 'War Camp', cost: { gold: 0, wood: 0 }, upgradeTime: 0, hp: 650, providesFood: 0, ...NO_ATTACK },
      { name: 'War Camp II', cost: { gold: 200, wood: 100 }, upgradeTime: 30, hp: 850, providesFood: 0, ...NO_ATTACK },
      { name: 'War Camp III', cost: { gold: 350, wood: 150 }, upgradeTime: 40, hp: 1050, providesFood: 0, ...NO_ATTACK },
    ],
  },
  spiketower: {
    id: 'spiketower', name: 'Spiked Tower',
    desc: 'Defensive tower that automatically skewers nearby enemies.',
    cost: { gold: 120, wood: 80 }, size: 2, buildTime: 30, sight: 8,
    isTownHall: false, trains: [],
    levels: [
      { name: 'Spiked Tower', cost: { gold: 0, wood: 0 }, upgradeTime: 0, hp: 380, providesFood: 0, damage: 13, range: 6, attackPeriod: 1.4 },
      { name: 'Bone Tower', cost: { gold: 150, wood: 100 }, upgradeTime: 25, hp: 520, providesFood: 0, damage: 19, range: 7, attackPeriod: 1.2 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Races (original voice lines in the spirit of the classics — no copied audio)
// ---------------------------------------------------------------------------

export const RACES: Record<string, RaceDef> = {
  human: {
    id: 'human', name: 'Humans',
    description: 'Disciplined builders of the Alliance of the Vale. Sturdy keeps, loyal footmen, deadly archers.',
    worker: 'peasant', townHall: 'townhall',
    buildings: ['townhall', 'house', 'barracks', 'tower'],
    voice: {
      pitch: 1.15, rate: 1.05,
      select: ['Yes, milord?', 'Your command?', 'At your service.', 'Hmm?'],
      move: ['Right away.', 'As you wish.', 'Off I go!', 'On my way.'],
      attack: ['For the Vale!', 'Charge!', 'Have at thee!'],
      build: ['I shall build it.', 'Hammer and nail!'],
      workComplete: ['Work complete!', 'The job is finished!'],
      trainReady: ['Ready for duty!', 'Reporting in!'],
      underAttack: ['We are under attack!', 'The town is besieged!'],
      noGold: ['Not enough gold, milord.', 'The coffers are empty!'],
      noWood: ['We require more lumber.', 'Not enough wood!'],
      noFood: ['We need more houses.', 'Our people need food!'],
      victory: ['Victory for the Vale!'],
      defeat: ['The kingdom has fallen...'],
    },
  },
  orc: {
    id: 'orc', name: 'Orcs',
    description: 'Brutal warbands of the Ashfang Horde. Cheap huts, hard-hitting grunts, savage raiders.',
    worker: 'peon', townHall: 'greathall',
    buildings: ['greathall', 'hut', 'warcamp', 'spiketower'],
    voice: {
      pitch: 0.35, rate: 0.9,
      select: ['Hrm?', 'What you want?', 'Me listen.', 'Yes, chief?'],
      move: ['Gruk gruk.', 'Me go.', 'Stomp stomp.', 'Moving.'],
      attack: ['For the Horde!', 'Crush them!', 'Waaagh!'],
      build: ['Me build it.', 'Work work.'],
      workComplete: ['Job done!', 'Building finished!'],
      trainReady: ['Ready to crush!', 'Me ready!'],
      underAttack: ['Camp under attack!', 'Enemies in the camp!'],
      noGold: ['Need more gold!', 'No shiny rocks!'],
      noWood: ['Need more wood!', 'Chop more trees!'],
      noFood: ['Build more huts!', 'Not enough food!'],
      victory: ['The Horde is victorious!'],
      defeat: ['The clan is broken...'],
    },
  },
};

export function unitDef(id: string): UnitDef {
  return UNITS[id];
}

export function buildingDef(id: string): BuildingDef {
  return BUILDINGS[id];
}

export function raceDef(id: string): RaceDef {
  return RACES[id];
}
