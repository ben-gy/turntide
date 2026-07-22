// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * turntide.ts — the rules. Pure, deterministic, zero randomness.
 *
 * Draughts with one rule replaced: a jump CONVERTS instead of captures. You leap
 * an adjacent enemy, land on the empty square beyond it, and the stone you
 * jumped stays exactly where it is and turns your colour. Nothing ever leaves
 * the board, so the total stone count is a constant for the whole round and the
 * only thing that moves is allegiance.
 *
 * Three rules stop that from degenerating:
 *
 *  - CROWNS DON'T FARM. A man that walks onto the far row crowns. A king that is
 *    FLIPPED loses its crown and converts as a plain man. So you cannot
 *    manufacture kings by feeding a piece back and forth across the line.
 *  - COOLING. A freshly converted stone is immune to being flipped back until it
 *    has sat through `mode.cooling` enemy turns. Without it, two adjacent stones
 *    oscillate forever and the game is a metronome.
 *  - THE FLIP CAP. A single turn may convert at most `mode.flipCap` stones. A
 *    jump chain is a 2-stone swing per link, so uncapped chains would make the
 *    game a slot machine; the cap is the pressure valve, and it is the constant
 *    the balance sim leans on hardest.
 *
 * Because there is no randomness and no hidden information, two peers running
 * this file over the same move list are byte-identical by construction — which
 * is why the netcode is lockstep and no board state is ever transmitted.
 *
 * Representation: parallel typed arrays indexed r*size+c. Play happens on the
 * dark squares only, i.e. where (r + c) % 2 === 1. Typed arrays (rather than
 * objects) because the balance sim clones positions hundreds of thousands of
 * times and `.slice()` on three small typed arrays is the cheap way to do it.
 */

import type { Mode } from './modes';

/** Teal moves UP the board (toward row 0). Amber moves DOWN. */
export const TEAL = 1 as const;
export const AMBER = 2 as const;
export type Side = typeof TEAL | typeof AMBER;

export const EMPTY = 0 as const;

export function other(s: Side): Side {
  return s === TEAL ? AMBER : TEAL;
}

export interface Pos {
  size: number;
  /** 0 empty, 1 teal, 2 amber. Light squares are always 0. */
  owner: Int8Array;
  /** 1 if the stone on this square is a king. */
  king: Uint8Array;
  /** Enemy turns of flip-immunity remaining for the stone on this square. */
  cool: Uint8Array;
  /** Side to move. */
  turn: Side;
  /** Plies played so far. */
  ply: number;
}

export type EndReason = '' | 'rout' | 'blocked' | 'cap' | 'left';

export interface Outcome {
  over: boolean;
  /** The winning side, or 0 for a draw. */
  winner: Side | 0;
  reason: EndReason;
}

export interface Move {
  /** Origin square index. */
  from: number;
  /** Landing squares in order. Length 1 for a simple step. */
  path: number[];
  /** Squares whose stones this move converts, in chain order. */
  flips: number[];
  /** True if the moving stone crowned at the end of this move. */
  crowned: boolean;
}

/** Square index helpers. */
export const rowOf = (i: number, size: number): number => (i / size) | 0;
export const colOf = (i: number, size: number): number => i % size;
export const isPlayable = (i: number, size: number): boolean =>
  (rowOf(i, size) + colOf(i, size)) % 2 === 1;

/** Step one diagonal from `i`, or -1 if that leaves the board. */
function step(i: number, dr: number, dc: number, size: number): number {
  const r = rowOf(i, size) + dr;
  const c = colOf(i, size) + dc;
  if (r < 0 || r >= size || c < 0 || c >= size) return -1;
  return r * size + c;
}

/** The row a side crowns on. */
export function crownRow(s: Side, size: number): number {
  return s === TEAL ? 0 : size - 1;
}

/** Forward row delta for a man of side `s`. */
function forward(s: Side): number {
  return s === TEAL ? -1 : 1;
}

// ── setup ───────────────────────────────────────────────────────────────────

/**
 * The opening position. Fully determined by the mode — there is no seed and no
 * randomness anywhere in it, so both peers (and the daily challenge) start from
 * a byte-identical board. Amber fills the top `rows`, Teal the bottom `rows`,
 * which makes the position point-symmetric: neither side starts ahead, by
 * construction rather than by tuning.
 */
export function initial(mode: Mode): Pos {
  const size = mode.size;
  const n = size * size;
  const owner = new Int8Array(n);
  const king = new Uint8Array(n);
  const cool = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    if (!isPlayable(i, size)) continue;
    const r = rowOf(i, size);
    if (r < mode.rows) owner[i] = AMBER;
    else if (r >= size - mode.rows) owner[i] = TEAL;
  }

  // Teal moves first — the classic draughts convention. Whether that is an
  // advantage is MEASURED in tests/balance.test.ts, not assumed; sides also swap
  // every round of a match so any residual edge alternates.
  return { size, owner, king, cool, turn: TEAL, ply: 0 };
}

export function clonePos(p: Pos): Pos {
  return {
    size: p.size,
    owner: p.owner.slice(),
    king: p.king.slice(),
    cool: p.cool.slice(),
    turn: p.turn,
    ply: p.ply,
  };
}

/** How many stones a side controls. The score, and the rout check. */
export function control(p: Pos, s: Side): number {
  let n = 0;
  for (let i = 0; i < p.owner.length; i++) if (p.owner[i] === s) n++;
  return n;
}

/** Kings a side holds — used by the evaluation and the results breakdown. */
export function kings(p: Pos, s: Side): number {
  let n = 0;
  for (let i = 0; i < p.owner.length; i++) if (p.owner[i] === s && p.king[i]) n++;
  return n;
}

// ── move generation ─────────────────────────────────────────────────────────

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/** Directions a stone may STEP: men forward only, kings all four. */
function dirsFor(s: Side, isKing: boolean): ReadonlyArray<readonly [number, number]> {
  if (isKing) return DIRS;
  const f = forward(s);
  return f === -1 ? [DIRS[0], DIRS[1]] : [DIRS[2], DIRS[3]];
}

/**
 * Directions a stone may JUMP.
 *
 * Separate from stepping because `menJumpBack` is the lever that decides whether
 * cascades are real. With men restricted to forward jumps (English draughts), a
 * chain has to keep advancing, so it runs out of board almost immediately — the
 * balance sim measured a maximum of 3 links across thousands of turns, and the
 * flip cap therefore never bound on anything. Letting men jump backward
 * (international draughts) is what makes a chain able to double back and turn a
 * region over, which is the drama the whole design is built around.
 */
function jumpDirsFor(
  s: Side,
  isKing: boolean,
  menJumpBack: boolean,
): ReadonlyArray<readonly [number, number]> {
  if (isKing || menJumpBack) return DIRS;
  return dirsFor(s, false);
}

/**
 * Every jump chain available to the stone on `from`.
 *
 * Chains are searched on a working copy with make/undo, because the board really
 * does change mid-chain: the mover vacates its square, and each converted stone
 * becomes friendly (so it can never be taken twice in one turn) while still
 * OCCUPYING its square, which is what makes long chains block themselves.
 *
 * `forcedCapture` also governs chain CONTINUATION: with it on, a chain that can
 * continue must, so only the maximal branches are emitted; with it off, stopping
 * early is a legal choice and both are emitted.
 */
function genJumps(p: Pos, mode: Mode, from: number): Move[] {
  const side = p.owner[from] as Side;
  if (side !== TEAL && side !== AMBER) return [];
  const out: Move[] = [];
  const size = p.size;
  const crown = crownRow(side, size);

  const recurse = (cur: number, isKing: boolean, path: number[], flips: number[]): void => {
    if (flips.length < mode.flipCap) {
      for (const [dr, dc] of jumpDirsFor(side, isKing, mode.menJumpBack)) {
        const mid = step(cur, dr, dc, size);
        if (mid < 0) continue;
        const to = step(mid, dr, dc, size);
        if (to < 0) continue;
        // Jumpable only if it is an enemy, not cooling, and the far square is clear.
        if (p.owner[mid] !== other(side)) continue;
        if (p.cool[mid] > 0) continue;
        if (p.owner[to] !== EMPTY) continue;

        // ── make ──
        const midKing = p.king[mid];
        const midCool = p.cool[mid];
        p.owner[mid] = side;
        p.king[mid] = 0; // a flipped king loses its crown
        p.cool[mid] = mode.cooling;
        p.owner[cur] = EMPTY;
        p.king[cur] = 0;
        p.owner[to] = side;
        // Crowning ends the move, so a man that lands on the far row stops here.
        const crowns = !isKing && rowOf(to, size) === crown;
        p.king[to] = crowns || isKing ? 1 : 0;

        path.push(to);
        flips.push(mid);

        if (crowns) {
          out.push({ from, path: [...path], flips: [...flips], crowned: true });
        } else {
          const before = out.length;
          recurse(to, isKing, path, flips);
          // Nothing deeper was legal, so this chain ends here.
          if (out.length === before) {
            out.push({ from, path: [...path], flips: [...flips], crowned: false });
          } else if (!mode.forcedCapture) {
            // Stopping early is a real choice when capture is not forced.
            out.push({ from, path: [...path], flips: [...flips], crowned: false });
          }
        }

        path.pop();
        flips.pop();

        // ── undo ──
        p.king[to] = 0;
        p.owner[to] = EMPTY;
        p.owner[cur] = side;
        p.king[cur] = isKing ? 1 : 0;
        p.owner[mid] = other(side);
        p.king[mid] = midKing;
        p.cool[mid] = midCool;
      }
    }
  };

  recurse(from, p.king[from] === 1, [], []);
  return out;
}

/** Simple (non-jumping) steps for the stone on `from`. */
function genSteps(p: Pos, from: number): Move[] {
  const side = p.owner[from] as Side;
  const isKing = p.king[from] === 1;
  const size = p.size;
  const crown = crownRow(side, size);
  const out: Move[] = [];
  for (const [dr, dc] of dirsFor(side, isKing)) {
    const to = step(from, dr, dc, size);
    if (to < 0 || p.owner[to] !== EMPTY) continue;
    out.push({
      from,
      path: [to],
      flips: [],
      crowned: !isKing && rowOf(to, size) === crown,
    });
  }
  return out;
}

/**
 * Every legal move for the side to move.
 *
 * With forced capture on, jumps strictly displace steps (classic draughts). With
 * it off, both are offered — which is what makes Tidepool a positional game
 * rather than a tempo one.
 */
export function legalMoves(p: Pos, mode: Mode): Move[] {
  const jumps: Move[] = [];
  const steps: Move[] = [];
  for (let i = 0; i < p.owner.length; i++) {
    if (p.owner[i] !== p.turn) continue;
    const j = genJumps(p, mode, i);
    if (j.length) jumps.push(...j);
    steps.push(...genSteps(p, i));
  }
  if (mode.forcedCapture && jumps.length) return jumps;
  return [...jumps, ...steps];
}

/** Does `move` appear in the legal list? The host's validation gate. */
export function isLegal(p: Pos, mode: Mode, move: { from: number; path: number[] }): Move | null {
  for (const m of legalMoves(p, mode)) {
    if (m.from !== move.from || m.path.length !== move.path.length) continue;
    let same = true;
    for (let i = 0; i < m.path.length; i++) {
      if (m.path[i] !== move.path[i]) {
        same = false;
        break;
      }
    }
    if (same) return m;
  }
  return null;
}

// ── applying a move ─────────────────────────────────────────────────────────

/**
 * Apply a legal move in place and hand the turn over.
 *
 * Cooling bookkeeping is the subtle part. A stone converted on this turn is set
 * to `mode.cooling`, and at the END of every turn we decrement the cool counters
 * of the stones owned by the side that did NOT just move. That ordering is what
 * makes "immune until it has sat through one enemy turn" literally true: the
 * stone I just flipped keeps its full counter through my own turn-end, spends
 * the opponent's entire turn immune, and only ticks down when that turn ends.
 * Decrementing everything at turn end instead would expire the immunity before
 * the opponent ever got to look at it.
 */
export function applyMove(p: Pos, mode: Mode, move: Move): void {
  const side = p.turn;
  const from = move.from;
  const to = move.path[move.path.length - 1];
  const wasKing = p.king[from] === 1;

  for (const mid of move.flips) {
    p.owner[mid] = side;
    p.king[mid] = 0; // flipped kings are demoted
    p.cool[mid] = mode.cooling;
  }

  p.owner[from] = EMPTY;
  p.king[from] = 0;
  p.cool[from] = 0;
  p.owner[to] = side;
  p.king[to] = wasKing || move.crowned ? 1 : 0;
  // A stone that MOVES spends its own immunity — cooling buys you a turn to
  // consolidate, not a shield you can carry around the board.
  p.cool[to] = 0;

  // End of turn: the non-mover's stones cool down by one.
  const foe = other(side);
  for (let i = 0; i < p.owner.length; i++) {
    if (p.owner[i] === foe && p.cool[i] > 0) p.cool[i]--;
  }

  p.turn = foe;
  p.ply++;
}

/**
 * Has the round ended in this position, with `side` having just moved?
 *
 * Order matters: rout is checked first because it is an INSTANT win, then
 * blockage (a side with no legal move loses, as in draughts), then the turn cap,
 * which resolves on stones controlled so a long game still produces a result
 * rather than a shrug.
 */
export function outcome(p: Pos, mode: Mode): Outcome {
  const teal = control(p, TEAL);
  const amber = control(p, AMBER);

  if (teal >= mode.rout) return { over: true, winner: TEAL, reason: 'rout' };
  if (amber >= mode.rout) return { over: true, winner: AMBER, reason: 'rout' };

  if (legalMoves(p, mode).length === 0) {
    // The side to move is stuck, so it loses.
    return { over: true, winner: other(p.turn), reason: 'blocked' };
  }

  if (p.ply >= mode.turnCap) {
    const winner = teal === amber ? 0 : teal > amber ? TEAL : AMBER;
    return { over: true, winner, reason: 'cap' };
  }

  return { over: false, winner: 0, reason: '' };
}

// ── serialization ───────────────────────────────────────────────────────────

/**
 * A compact key for the position, used for repetition detection in the sim (the
 * flip-loop metric cooling exists to kill) and by tests. Cooling counters are
 * part of the key because two boards that look identical but differ in what is
 * currently immune are genuinely different positions.
 */
export function posKey(p: Pos): string {
  let s = `${p.turn}:`;
  for (let i = 0; i < p.owner.length; i++) {
    if (p.owner[i] === EMPTY) continue;
    s += `${i}${p.owner[i]}${p.king[i]}${p.cool[i]},`;
  }
  return s;
}

/** The wire form of a move — origin plus landing squares, and nothing else. */
export function wireMove(m: Move): { from: number; path: number[] } {
  return { from: m.from, path: [...m.path] };
}

/** Replay a move list from the opening. This IS the netcode's state transfer. */
export function replay(
  mode: Mode,
  moves: ReadonlyArray<{ from: number; path: number[] }>,
): { pos: Pos; ok: boolean } {
  const pos = initial(mode);
  for (const w of moves) {
    const m = isLegal(pos, mode, w);
    if (!m) return { pos, ok: false };
    applyMove(pos, mode, m);
  }
  return { pos, ok: true };
}
