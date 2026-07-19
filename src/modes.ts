/**
 * modes.ts — the three shapes a Turntide round can take.
 *
 * A mode must change how the game PLAYS, not just a number (principle #14).
 * Board size alone would be a dial, so each mode also moves a rule:
 *
 *  - Tidepool  — forced capture OFF. Nothing is compulsory, so the game becomes
 *                positional: it is about what you DECLINE to take.
 *  - Skirmish  — the classic: forced capture. The default.
 *  - Floodmark — the cascade mode: MEN JUMP BACKWARD, so a chain can double back
 *                and turn a whole region over instead of running out of board.
 *
 * All three of those were settled BY MEASUREMENT, against the design's own
 * predictions (tests/balance.test.ts, and the sweep documented there):
 *
 *  - The FLIP CAP was supposed to be the load-bearing balance lever. It is not a
 *    lever at all: caps of 3, 4, 5 and 6 produced byte-identical results on both
 *    big boards, because with forward-only jumps a chain runs out of board after
 *    ~3 links and the cap never binds. It is retained as a guarantee, not a dial.
 *  - COOLING was supposed to be doubled in Tidepool to make it positional.
 *    Measured, cooling 2 made Skirmish's FIRST-PLAYER win rate 66% and shortened
 *    games; cooling 1 is now global, and cooling's real (modest) job is damping
 *    repetition, not defining a mode.
 *  - menJumpBack is what actually creates cascades (big chains ~2% -> ~8% of
 *    turns, and it is the only setting under which the cap ever binds). It is
 *    confined to Floodmark because on the 8x8 it took blowouts from 33% to 63%,
 *    while on the 10x10 it costs only 10% -> 18%.
 *  - TIDEPOOL WAS A 6x6, and that is why it is not one now. At n=400 across three
 *    independent seed families it gave the FIRST mover 39.9% / 40.4% / 40.8% —
 *    a real ~10-point second-mover edge, not the noise it looked like at n=140.
 *    With optional capture on a small board, moving first means committing to a
 *    structure your opponent can simply decline to engage, and 12 stones leave no
 *    room to build a second threat. Six candidate fixes were measured; changing
 *    the rout, the cap, forcing capture and backward jumps ALL failed (35-43%).
 *    Only giving it the full 8x8 with 24 stones fixed it — 49.2% / 50.3% — while
 *    also improving every other metric (blowouts 49% -> 22%, draws 2% -> 1%).
 *    So Tidepool and Skirmish deliberately share a board: the contrast is the
 *    LAW, not the geometry, which is the honest version of "modes differ by rule".
 *
 * The HOST's pick is what the room plays, and it travels frozen inside the round
 * start (see rematch.ts `roundOpts()`), because a setting each peer reads from
 * its own UI is a setting two peers can disagree about — and here a mode changes
 * the BOARD SIZE, so disagreeing means playing two different games.
 */

export type ModeId = 'tidepool' | 'skirmish' | 'floodmark';

export interface Mode {
  id: ModeId;
  name: string;
  /** One line, shown under the mode's name in the menu and lobby. */
  blurb: string;
  /** Board is size x size. Play happens on the dark squares only. */
  size: number;
  /** Rows of stones per side at setup. */
  rows: number;
  /** Controlling this many stones wins instantly. */
  rout: number;
  /** Most stones a single turn may convert. The cascade pressure valve. */
  flipCap: number;
  /** Enemy turns a freshly converted stone is immune to being flipped back. */
  cooling: number;
  /** Must you jump when a jump is available? */
  forcedCapture: boolean;
  /**
   * May a MAN jump backward? (Kings always can.) This is the lever that decides
   * whether cascades exist at all — see the note on `jumpDirsFor`. Measured, not
   * assumed: with it off, the balance sim found chains never exceeded 3 links
   * and the flip cap never bound on anything.
   */
  menJumpBack: boolean;
  /** Plies before the round resolves on stones controlled. */
  turnCap: number;
}

export const MODES: Record<ModeId, Mode> = {
  tidepool: {
    id: 'tidepool',
    name: 'Tidepool',
    blurb: 'Same board, opposite law — nothing is ever forced',
    size: 8,
    rows: 3,
    rout: 19,
    flipCap: 2,
    cooling: 1,
    forcedCapture: false,
    menJumpBack: false,
    turnCap: 200,
  },
  skirmish: {
    id: 'skirmish',
    name: 'Skirmish',
    blurb: '8x8 · forced capture · the classic tempo game',
    size: 8,
    rows: 3,
    rout: 18,
    flipCap: 3,
    cooling: 1,
    forcedCapture: true,
    menJumpBack: false,
    turnCap: 200,
  },
  floodmark: {
    id: 'floodmark',
    name: 'Floodmark',
    blurb: '10x10 · men jump backward · chains double back and turn a region over',
    size: 10,
    rows: 4,
    rout: 30,
    flipCap: 5,
    cooling: 1,
    forcedCapture: true,
    menJumpBack: true,
    turnCap: 240,
  },
};

export const MODE_IDS: ModeId[] = ['tidepool', 'skirmish', 'floodmark'];

export const DEFAULT_MODE: ModeId = 'skirmish';

/**
 * Validate a mode id that arrived off the wire or out of localStorage.
 *
 * `MODES[id] || DEFAULT` is NOT good enough: 'constructor' and 'toString' are
 * truthy on a plain object, so an untrusted key can hand the generator a Mode of
 * undefined fields. Guard with hasOwn, and never let `undefined` reach a caller.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id as ModeId];
  return MODES[DEFAULT_MODE];
}

/** Total stones on the board for a mode — constant for the whole round. */
export function stoneCount(mode: Mode): number {
  // Dark squares per row = size / 2, times the rows each side, times two sides.
  return (mode.size / 2) * mode.rows * 2;
}
