/**
 * sim.ts — the AI-vs-AI harness the balance tests are built on.
 *
 * Deliberately separate from the assertions so the same instrumented run can be
 * interrogated several ways, and so the MECHANISM audits (principle #21) can
 * inspect the event stream from OUTSIDE the simulation rather than
 * re-implementing the rule and comparing it to itself.
 *
 * Everything here is seeded — no `Math.random`, no `Date.now` — so a failing
 * assertion names a seed you can replay exactly.
 */

import { makeRng } from '@ben-gy/game-engine/rng';
import { policyMove, type Policy } from '../../src/ai';
import type { Mode } from '../../src/modes';
import {
  AMBER,
  TEAL,
  applyMove,
  control,
  initial,
  kings,
  legalMoves,
  outcome,
  posKey,
  type Move,
  type Pos,
  type Side,
} from '../../src/turntide';

/** One recorded turn. The audit trail — never drained mid-run. */
export interface SimEvent {
  ply: number;
  side: Side;
  /** Stones converted by this turn. */
  flips: number;
  /** The longest chain that WAS available to this side on this turn. */
  bestAvailable: number;
  crowned: boolean;
  /** Stones controlled by Teal after the turn. */
  teal: number;
  amber: number;
}

export interface SimResult {
  winner: Side | 0;
  reason: string;
  plies: number;
  /** Full per-turn history. */
  events: SimEvent[];
  /** Positions that recurred — the flip-loop metric cooling exists to kill. */
  repeats: number;
  /** Final control split. */
  finalTeal: number;
  finalAmber: number;
  finalKings: [number, number];
  seed: number;
  /** Policy that played each seat. */
  seats: [Policy, Policy];
}

export interface SimOpts {
  mode: Mode;
  seed: number;
  /** Policy for Teal (moves first) and Amber. */
  seats: [Policy, Policy];
  /** Search depth for the 'search' policy. Keep low — this runs hundreds of times. */
  depth?: number;
}

/** Play one complete game. Deterministic in `seed`. */
export function playGame(opts: SimOpts): SimResult {
  const { mode, seed, seats } = opts;
  const depth = opts.depth ?? 2;
  const rng = makeRng(seed);
  const p: Pos = initial(mode);
  const events: SimEvent[] = [];
  const seen = new Map<string, number>();
  let repeats = 0;

  for (;;) {
    const end = outcome(p, mode);
    if (end.over) {
      return {
        winner: end.winner,
        reason: end.reason,
        plies: p.ply,
        events,
        repeats,
        finalTeal: control(p, TEAL),
        finalAmber: control(p, AMBER),
        finalKings: [kings(p, TEAL), kings(p, AMBER)],
        seed,
        seats,
      };
    }

    const side = p.turn;
    const policy = side === TEAL ? seats[0] : seats[1];
    const moves = legalMoves(p, mode);
    const bestAvailable = moves.reduce((n, m) => Math.max(n, m.flips.length), 0);

    const m: Move | null = policyMove(p, mode, policy, depth, rng);
    if (!m) {
      // outcome() should already have called this; belt and braces.
      return {
        winner: side === TEAL ? AMBER : TEAL,
        reason: 'blocked',
        plies: p.ply,
        events,
        repeats,
        finalTeal: control(p, TEAL),
        finalAmber: control(p, AMBER),
        finalKings: [kings(p, TEAL), kings(p, AMBER)],
        seed,
        seats,
      };
    }

    applyMove(p, mode, m);

    events.push({
      ply: p.ply,
      side,
      flips: m.flips.length,
      bestAvailable,
      crowned: m.crowned,
      teal: control(p, TEAL),
      amber: control(p, AMBER),
    });

    const key = posKey(p);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) repeats++;
  }
}

/** Run a matrix of games, alternating which policy sits in which seat. */
export function runMatrix(
  mode: Mode,
  games: number,
  seats: [Policy, Policy],
  depth = 2,
  seed0 = 1000,
): SimResult[] {
  const out: SimResult[] = [];
  for (let i = 0; i < games; i++) {
    // Swap seats on odd games so a policy edge cannot masquerade as a seat edge.
    const swap = i % 2 === 1;
    const s: [Policy, Policy] = swap ? [seats[1], seats[0]] : seats;
    out.push(playGame({ mode, seed: seed0 + i, seats: s, depth }));
  }
  return out;
}

// ── metrics ─────────────────────────────────────────────────────────────────

/** Win rate for the FIRST-MOVING seat (Teal), regardless of policy. */
export function seatWinRate(rs: SimResult[]): number {
  const decisive = rs.filter((r) => r.winner !== 0);
  if (!decisive.length) return 0.5;
  return decisive.filter((r) => r.winner === TEAL).length / decisive.length;
}

/**
 * P(whoever led after `ply` plies eventually won).
 *
 * Positions that are TIED at `ply` are EXCLUDED, not bucketed as "behind" —
 * counting ties as behind is the exact artifact that produced a confident,
 * completely wrong reading on Hexbloom. Games already decided by `ply`, and
 * draws, are excluded too.
 */
export function leaderHolds(rs: SimResult[], ply: number): { p: number; n: number } {
  let held = 0;
  let n = 0;
  for (const r of rs) {
    if (r.winner === 0) continue;
    const e = r.events.find((x) => x.ply === ply);
    if (!e) continue; // game was already over
    if (e.teal === e.amber) continue; // TIED — not a leader
    const leader: Side = e.teal > e.amber ? TEAL : AMBER;
    n++;
    if (leader === r.winner) held++;
  }
  return { p: n ? held / n : 0.5, n };
}

/** Fraction of games decided by a large final control gap. */
export function blowoutRate(rs: SimResult[], gap: number): number {
  if (!rs.length) return 0;
  return rs.filter((r) => Math.abs(r.finalTeal - r.finalAmber) >= gap).length / rs.length;
}

export function drawRate(rs: SimResult[]): number {
  if (!rs.length) return 0;
  return rs.filter((r) => r.winner === 0).length / rs.length;
}

export function meanPlies(rs: SimResult[]): number {
  if (!rs.length) return 0;
  return rs.reduce((s, r) => s + r.plies, 0) / rs.length;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── MECHANISM audits (principle #21) ────────────────────────────────────────
// These do not ask "did the game feel balanced". They audit, from outside the
// sim, whether the rules actually did what they claim — at zero tolerance. A
// broken rule mostly just shifts the outcome curve, which is indistinguishable
// from intended difficulty; only a rule-violation COUNT has no grey zone.

/**
 * Turns that converted more stones than the mode's cap allows.
 *
 * The cap is the single constant the whole balance rests on, and it is enforced
 * deep inside a recursive chain search — precisely the place an optimisation
 * could silently break it while every outcome metric stayed plausible.
 */
export function capViolations(rs: SimResult[], mode: Mode): number {
  let n = 0;
  for (const r of rs) for (const e of r.events) if (e.flips > mode.flipCap) n++;
  return n;
}

/**
 * Turns where a jump was available but the mover played a quiet move anyway,
 * in a FORCED-CAPTURE mode. Must be zero, or forced capture is a lie and
 * Tidepool is not actually a different mode from Skirmish.
 */
export function forcedCaptureViolations(rs: SimResult[], mode: Mode): number {
  if (!mode.forcedCapture) return 0;
  let n = 0;
  for (const r of rs) {
    for (const e of r.events) if (e.bestAvailable > 0 && e.flips === 0) n++;
  }
  return n;
}

/**
 * Total stones must be invariant for the entire game — it is the premise of the
 * whole design ("nothing ever leaves the board"). A single dropped stone would
 * make every control-based metric above quietly wrong.
 */
export function stoneCountViolations(rs: SimResult[], total: number): number {
  let n = 0;
  for (const r of rs) for (const e of r.events) if (e.teal + e.amber !== total) n++;
  return n;
}

/** Largest chain anyone actually landed — the "is the cascade real" feel metric. */
export function chainHistogram(rs: SimResult[]): number[] {
  const h: number[] = [];
  for (const r of rs) {
    for (const e of r.events) {
      h[e.flips] = (h[e.flips] ?? 0) + 1;
    }
  }
  for (let i = 0; i < h.length; i++) h[i] = h[i] ?? 0;
  return h;
}
