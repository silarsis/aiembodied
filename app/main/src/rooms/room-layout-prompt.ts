/** The prompt for the "Room layout" job. Kept apart so it has its own test. */
import { LIGHTING_PRESETS } from './room-palette.js';
import { MAX_LAYOUT_OBJECTS, OBJECT_CATEGORIES } from './room-layout.js';

const EXAMPLE = {
  name: 'Cosy reading room',
  description: 'A warm room with an armchair by the fireplace and a wall of books.',
  shell: {
    width: 6,
    depth: 5,
    height: 2.8,
    floor: 'warm oak',
    walls: 'soft cream',
    windows: [{ wall: 'north', width: 1.6 }],
    door: { wall: 'east' },
  },
  lighting: 'warm evening',
  objects: [
    {
      id: 'bookshelf',
      name: 'bookshelf',
      search: 'bookshelf wooden',
      category: 'storage',
      size: [1.6, 2.0, 0.35],
      color: 'walnut',
      place: { against: 'west', near: null, on: null, facing: null, corner: false },
      surface: false,
      idle: 'browses the books',
    },
    {
      id: 'armchair',
      name: 'armchair',
      search: 'armchair fabric',
      category: 'seat',
      size: [0.9, 0.95, 0.9],
      color: 'rust',
      place: { against: null, near: 'coffee_table', on: null, facing: 'center', corner: false },
      seat_height: 0.45,
      idle: 'reads a book here',
    },
    {
      id: 'coffee_table',
      name: 'coffee table',
      search: 'coffee table',
      category: 'table',
      size: [1.0, 0.42, 0.6],
      color: 'oak',
      place: { against: null, near: null, on: null, facing: null, corner: false },
      surface: true,
    },
    {
      id: 'mug',
      name: 'mug',
      search: 'mug cup',
      category: 'prop',
      size: [0.09, 0.1, 0.09],
      color: 'white',
      place: { against: null, near: null, on: 'coffee_table', facing: null, corner: false },
      grabbable: true,
    },
  ],
};

export function buildLayoutPrompt(description: string): { system: string; user: string } {
  const system = [
    'You design small 3D rooms for a virtual character to live in. Reply with ONE JSON object and nothing else: no prose, no code fences.',
    '',
    'Schema:',
    '- name, description: short text.',
    '- shell: width (x) and depth (z) in metres, 3 to 10; height 2.4 to 3.5; floor and walls: a plain colour word such as "warm oak", "soft cream", "slate"; windows: list of {wall, width}; door: {wall} or null. Walls are north, south, east or west. The viewer looks at the room from the south wall, so the north wall is the back wall: do not put the door on the south wall.',
    `- lighting: one of ${LIGHTING_PRESETS.map((l) => `"${l}"`).join(', ')}.`,
    `- objects: at most ${MAX_LAYOUT_OBJECTS}, each with id (short lowercase slug), name, search (2 or 3 words to look it up in a library of free 3D models), category (one of ${OBJECT_CATEGORIES.join(', ')}; if none fits, any short word such as rug or aquarium, which is treated as a prop), size [width, height, depth] in metres, color (a plain colour word for the simple fallback shape), place, and optionally seat_height (metres, seats and beds), grabbable (small props the character can pick up: mugs, books, cups), surface (tables, counters and shelves that things can stand on) and idle (what the character does there, a few words).`,
    '- place: {against: a wall name or null, near: the id of another object or null, on: the id of a surface object or null, facing: "center" or an object id or null, corner: true or false}. Leave place fields null to let the layout pick a free spot. Use "against" for big furniture, "near" for things that belong together (chair near desk), and "on" for small props on tables.',
    '',
    'Rules: sizes are real-world sizes; size seats like real furniture (seat height about 0.45 m, an armchair about 0.85 m wide and 0.85 m deep). Never place objects on top of each other except with "on". Keep the middle of the room open for walking. Give every seat a clear place to sit, and include a few things to pick up if it suits the room.',
    '',
    'Example:',
    JSON.stringify(EXAMPLE),
  ].join('\n');
  return { system, user: `Design this room: ${description.trim()}` };
}

/** Appended to the conversation when the first reply could not be used. */
export function buildRetryNote(problem: string): string {
  return `That reply could not be used: ${problem}. Reply again with ONE valid JSON object that follows the schema, and nothing else.`;
}
