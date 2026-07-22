// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * ai.ts — the tide-reader. Alpha-beta over a conversion-aware evaluation.
 *
 * This is the solo opponent AND the balance sim's bot, which is deliberate: the
 * thing that referees the game's fairness is the same thing a player actually
 * faces, so a tuning change that flatters the sim but plays badly shows up in
 * both places at once.
 *
 * The evaluation cannot just count material the way a draughts engine does.
 * Material here is CIRCULATING, not accumulating — the stone count is constant
 * and a jump is a 2-stone swing rather than a 1-stone gain. So the terms that
 * matter are: control (which is literally the win condition via the rout),
 * kings (scarce, because flipping demotes them), advancement (crowning is the
 * only way to make one), and EXPOSURE — how much the opponent could flip on
 * their reply, which in a game of swings is the dominant tactical term.
 */

import type { Mode } from './modes';
import {
  AMBER,
  TEAL,
  applyMove,
  clonePos,
  control,
  crownRow,
  kings,
  legalMoves,
  other,
  outcome,
  rowOf,
  type Move,
  type Pos,
  type Side,
} from './turntide';
import { makeRng } from '@ben-gy/game-engine/rng';

export type Strength = 'drifter' | 'currents' | 'riptide';

export interface StrengthSpec {
  id: Strength;
  name: string;
  blurb: string;
  depth: number;
  /** 0 = always the best move; higher = more willing to take a near-best one. */
  slack: number;
}

export const STRENGTHS: Record<Strength, StrengthSpec> = {
  drifter: { id: 'drifter', name: 'Drifter', blurb: 'Reads one turn ahead', depth: 1, slack: 55 },
  currents: { id: 'currents', name: 'Currents', blurb: 'Sees the reply coming', depth: 3, slack: 12 },
  riptide: { id: 'riptide', name: 'Riptide', blurb: 'Plays the whole chain', depth: 5, slack: 0 },
};

export const STRENGTH_IDS: Strength[] = ['drifter', 'currents', 'riptide'];

export function strengthOf(id: unknown): StrengthSpec {
  if (typeof id === 'string' && Object.hasOwn(STRENGTHS, id)) return STRENGTHS[id as Strength];
  return STRENGTHS.currents;
}

const WIN = 1e6;

/**
 * Static evaluation from TEAL's point of view (positive = good for Teal).
 *
 * `exposure` is computed by asking the opponent for their jump moves and taking
 * the largest chain they could land — cheap, and it is the term that stops the
 * bot walking a stone into a five-link cascade because the immediate count
 * looked fine.
 */
export function evaluate(p: Pos, mode: Mode): number {
  const teal = control(p, TEAL);
  const amber = control(p, AMBER);

  // Control dominates: it is the rout condition, and the rout is how games end.
  let score = (teal - amber) * 100;

  // Kings are scarce by design (flipping demotes), so they are worth real weight.
  score += (kings(p, TEAL) - kings(p, AMBER)) * 60;

  // Advancement — the only route to a king is walking one there.
  for (let i = 0; i < p.owner.length; i++) {
    const o = p.owner[i];
    if (o === 0 || p.king[i]) continue;
    const s = o as Side;
    const dist = Math.abs(rowOf(i, p.size) - crownRow(s, p.size));
    const adv = (p.size - 1 - dist) * 4;
    score += s === TEAL ? adv : -adv;
  }

  // Exposure: the biggest chain the side to move could take right now. A swing
  // is worth twice its links (I gain them AND they lose them), so it is scaled
  // to match the control term rather than treated as a soft positional nudge.
  let best = 0;
  for (const m of legalMoves(p, mode)) best = Math.max(best, m.flips.length);
  const threat = best * 2 * 100;
  score += p.turn === TEAL ? threat * 0.35 : -threat * 0.35;

  return score;
}

/** Jumps first, longest chains first — cheap ordering that prunes hard. */
function ordered(moves: Move[]): Move[] {
  return [...moves].sort((a, b) => b.flips.length - a.flips.length);
}

function search(p: Pos, mode: Mode, depth: number, alpha: number, beta: number): number {
  const end = outcome(p, mode);
  if (end.over) {
    if (end.winner === 0) return 0;
    // Prefer faster wins and slower losses, so a won position is actually
    // converted instead of shuffled.
    const mag = WIN - p.ply;
    return end.winner === TEAL ? mag : -mag;
  }
  if (depth <= 0) return evaluate(p, mode);

  const moves = ordered(legalMoves(p, mode));
  const maximizing = p.turn === TEAL;
  let bestScore = maximizing ? -Infinity : Infinity;

  for (const m of moves) {
    const next = clonePos(p);
    applyMove(next, mode, m);
    const s = search(next, mode, depth - 1, alpha, beta);
    if (maximizing) {
      if (s > bestScore) bestScore = s;
      if (bestScore > alpha) alpha = bestScore;
    } else {
      if (s < bestScore) bestScore = s;
      if (bestScore < beta) beta = bestScore;
    }
    if (beta <= alpha) break;
  }
  return bestScore;
}

export interface ChooseOpts {
  depth: number;
  /** Points of evaluation the bot is willing to give away, for variety. */
  slack?: number;
  /** Seeded RNG for tie-breaking. Solo/sim only — never touches P2P state. */
  rand?: () => number;
}

/**
 * Pick a move for the side to move.
 *
 * Ties (and near-ties within `slack`) are broken with a seeded RNG so the bot is
 * not a metronome — which matters for the sim, where hundreds of games from
 * different seeds must actually be different games rather than one game replayed.
 */
export function chooseMove(p: Pos, mode: Mode, opts: ChooseOpts): Move | null {
  const moves = ordered(legalMoves(p, mode));
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];

  const rand = opts.rand ?? Math.random;
  const maximizing = p.turn === TEAL;
  const scored: Array<{ m: Move; s: number }> = [];

  let alpha = -Infinity;
  let beta = Infinity;
  for (const m of moves) {
    const next = clonePos(p);
    applyMove(next, mode, m);
    const s = search(next, mode, opts.depth - 1, alpha, beta);
    scored.push({ m, s });
    // Widen the window only in the direction that helps — full-width per root
    // move would cost the ordering benefit entirely.
    if (maximizing) alpha = Math.max(alpha, s);
    else beta = Math.min(beta, s);
  }

  const best = maximizing
    ? Math.max(...scored.map((x) => x.s))
    : Math.min(...scored.map((x) => x.s));
  const slack = opts.slack ?? 0;
  const pool = scored.filter((x) => (maximizing ? x.s >= best - slack : x.s <= best + slack));
  return pool[Math.floor(rand() * pool.length) % pool.length].m;
}

/** Convenience wrapper for the solo game. */
export function aiMove(p: Pos, mode: Mode, strength: Strength, seed: number): Move | null {
  const spec = strengthOf(strength);
  return chooseMove(p, mode, {
    depth: spec.depth,
    slack: spec.slack,
    rand: makeRng(seed ^ (p.ply * 0x9e3779b1)),
  });
}

/**
 * Named policies for the balance sim. A single bot playing itself measures only
 * that bot's blind spots, so the sim pits genuinely different lines against each
 * other — and `greedy` in particular exists to answer the question the design
 * doc is most worried about: does grabbing the longest chain every time simply
 * win?
 */
export type Policy = 'greedy' | 'search' | 'cautious';

export function policyMove(
  p: Pos,
  mode: Mode,
  policy: Policy,
  depth: number,
  rand: () => number,
): Move | null {
  const moves = legalMoves(p, mode);
  if (moves.length === 0) return null;

  if (policy === 'greedy') {
    // Always take the longest chain available; tie-break at random.
    const best = Math.max(...moves.map((m) => m.flips.length));
    const pool = moves.filter((m) => m.flips.length === best);
    return pool[Math.floor(rand() * pool.length) % pool.length];
  }

  if (policy === 'cautious') {
    // Minimise what the opponent can flip back, ignoring your own gain.
    let bestVal = Infinity;
    let pool: Move[] = [];
    for (const m of moves) {
      const next = clonePos(p);
      applyMove(next, mode, m);
      let reply = 0;
      for (const r of legalMoves(next, mode)) reply = Math.max(reply, r.flips.length);
      const val = reply - m.flips.length * 0.5;
      if (val < bestVal - 1e-9) {
        bestVal = val;
        pool = [m];
      } else if (Math.abs(val - bestVal) < 1e-9) {
        pool.push(m);
      }
    }
    return pool[Math.floor(rand() * pool.length) % pool.length];
  }

  return chooseMove(p, mode, { depth, slack: 8, rand });
}

export { other, TEAL, AMBER };
