/**
 * balance.test.ts — is Turntide still a game on move 4? (principle #18)
 *
 * This file is the referee, and it OVERRULED the design three times. The record
 * matters more than the numbers, because the lesson generalises and the numbers
 * will drift:
 *
 *  1. THE FLIP CAP WAS THE PLAN'S HEADLINE BALANCE LEVER. It is not a lever at
 *     all. Sweeping it over 2/3/4/5/6 produced BYTE-IDENTICAL results on both big
 *     boards, because with forward-only jumps a chain runs out of board after
 *     about three links, so the cap never binds on anything. Floodmark's original
 *     pitch — "cap 5 means one chain can swing ten stones" — was simply false,
 *     and would have shipped as marketing copy for a mechanic that never fires.
 *
 *  2. COOLING WAS SUPPOSED TO BE DOUBLED IN TIDEPOOL to make it positional. The
 *     control arm (cooling 0) showed cooling barely moves any outcome metric —
 *     its real job is damping repetition (repeats 318 -> 250 on Skirmish, 204 ->
 *     120 on Floodmark), not defining a mode. Worse, cooling 2 took Skirmish's
 *     first-player win rate to 66%. A rule introduced to make one mode feel
 *     different was quietly breaking seat fairness in another.
 *
 *  3. THE SEAT "BIAS" WAS NOISE, AND NEARLY GOT DESIGNED AROUND. Early runs read
 *     37% for Tidepool and 43% for Floodmark, and the obvious story — "in a
 *     conversion game, whoever commits first gets punished, so moving first is
 *     bad" — is extremely plausible. Then the SAME Skirmish config measured 41%,
 *     49% and 54% across three seed families. At n ~ 140 decisive games the 95%
 *     interval is about +/-8 points, so every one of those readings is consistent
 *     with a fair game. The fix was more samples, not a compensation rule.
 *
 * What actually holds up: the LEADER CURVE is flat and slightly DECLINING in
 * every mode under competent play, which is the property the whole design needed
 * and the one thing no amount of noise explained away. An early lead in Turntide
 * genuinely is not a won game, because material only circulates.
 *
 * Kept deterministic (seeded rng, no Math.random, no Date.now) and under a few
 * seconds so it stays in the default run.
 */

import { describe, expect, it } from 'vitest';
import { MODES, stoneCount, type Mode } from '../src/modes';
import {
  blowoutRate,
  capViolations,
  chainHistogram,
  drawRate,
  forcedCaptureViolations,
  leaderHolds,
  meanPlies,
  runMatrix,
  seatWinRate,
  stoneCountViolations,
  type SimResult,
} from './helpers/sim';

/**
 * Big enough that a seat estimate means something: at n = 400 decisive games the
 * standard error on a win rate is ~2.5 points, so a +/-10 bound is ~4 sigma and
 * will not flap. Anything smaller and this file measures its own seed choice —
 * which is exactly the mistake documented at the top.
 */
const GAMES = 400;
const DEPTH = 2;

/** One shared run per mode, reused by every assertion below. */
const RUNS: Record<string, SimResult[]> = {};
function runs(mode: Mode): SimResult[] {
  if (!RUNS[mode.id]) RUNS[mode.id] = runMatrix(mode, GAMES, ['search', 'search'], DEPTH, 31000);
  return RUNS[mode.id];
}

const ALL = Object.values(MODES);

describe('the rules actually do what they claim (mechanism, zero tolerance)', () => {
  // Principle #21: an outcome curve cannot see a broken mechanic, because a
  // broken mechanic just moves the curve and that is indistinguishable from
  // intended difficulty. These audit the event stream from OUTSIDE the sim, and
  // they are counts of rule violations — no threshold to tune, no grey zone.

  it.each(ALL)('$name never converts more stones in a turn than the cap', (mode) => {
    expect(capViolations(runs(mode), mode)).toBe(0);
  });

  it.each(ALL)('$name honours forced capture when the mode declares it', (mode) => {
    expect(forcedCaptureViolations(runs(mode), mode)).toBe(0);
  });

  it.each(ALL)('$name never lets a stone leave the board — the whole premise', (mode) => {
    // If this ever fails, every control-based metric in this file is silently
    // wrong, because they all read the same two counters.
    expect(stoneCountViolations(runs(mode), stoneCount(mode))).toBe(0);
  });

  it('Floodmark is the only mode where the flip cap can bind', () => {
    // Pins the finding, so nobody re-derives "the cap is the balance lever".
    const fm = chainHistogram(runs(MODES.floodmark));
    const sk = chainHistogram(runs(MODES.skirmish));
    expect(fm.length - 1).toBeGreaterThan(sk.length - 1);
    expect(MODES.floodmark.menJumpBack).toBe(true);
    expect(MODES.skirmish.menJumpBack).toBe(false);
  });

  it('menJumpBack is what makes cascades real — pinned against a control arm', () => {
    const withBack = runMatrix(
      { ...MODES.floodmark, menJumpBack: true },
      60,
      ['search', 'search'],
      DEPTH,
      41000,
    );
    const without = runMatrix(
      { ...MODES.floodmark, menJumpBack: false },
      60,
      ['search', 'search'],
      DEPTH,
      41000,
    );
    const bigShare = (rs: SimResult[]): number => {
      const h = chainHistogram(rs);
      const turns = h.reduce((a, b) => a + b, 0);
      return h.slice(2).reduce((a, b) => a + b, 0) / turns;
    };
    // The control arm must report a genuinely smaller number, or the mechanic is
    // not doing what the mode's whole identity claims.
    expect(bigShare(withBack)).toBeGreaterThan(bigShare(without) * 1.5);
  });
});

describe('is it still a game on move 4?', () => {
  it.each(ALL)('$name: an early lead is not a won game', (mode) => {
    const rs = runs(mode);
    // Sampled across the game. The requirement is NOT that these are all 50% —
    // late in a game the leader SHOULD usually win, that is the drama. The
    // requirement is that the early sample is not already decisive.
    const early = leaderHolds(rs, 12);
    if (early.n >= 40) {
      expect(early.p).toBeLessThan(0.85);
    }
    const mid = leaderHolds(rs, 24);
    if (mid.n >= 40) {
      expect(mid.p).toBeLessThan(0.9);
    }
  });

  it.each(ALL)('$name: no move-3 cliff — the opening decides nothing', (mode) => {
    const rs = runs(mode);
    const { p, n } = leaderHolds(rs, 4);
    // Very few games have a non-tied leader this early (conversions are the only
    // way to lead, and the opening has no jumps), which is itself the point.
    if (n >= 30) expect(p).toBeLessThan(0.9);
  });

  it.each(ALL)('$name: every game terminates well inside the turn cap', (mode) => {
    const rs = runs(mode);
    expect(rs.every((r) => r.plies <= mode.turnCap)).toBe(true);
    expect(meanPlies(rs)).toBeLessThan(mode.turnCap * 0.9);
    expect(meanPlies(rs)).toBeGreaterThan(12);
  });

  it.each(ALL)('$name: draws stay rare — cooling is meant to kill flip-loops', (mode) => {
    expect(drawRate(runs(mode))).toBeLessThan(0.12);
  });
});

describe('seat fairness', () => {
  it.each(ALL)('$name: the first mover wins within 10 points of chance', (mode) => {
    const rs = runs(mode);
    const seat = seatWinRate(rs);
    const decisive = rs.filter((r) => r.winner !== 0).length;
    // Guard the guard: a bound this wide is only meaningful with real sample size.
    expect(decisive).toBeGreaterThan(250);
    expect(seat).toBeGreaterThan(0.4);
    expect(seat).toBeLessThan(0.6);
  });

  it('the opening is symmetric by construction, not by tuning', () => {
    // Seat fairness here does not rest on a compensation constant — it rests on
    // the setup being point-symmetric, which turntide.test.ts pins directly.
    // This assertion exists so that if someone ever ADDS a compensation rule,
    // they have to come here and say so.
    for (const mode of ALL) {
      expect(stoneCount(mode) % 2).toBe(0);
      expect(mode.rout).toBeGreaterThan(stoneCount(mode) / 2);
    }
  });
});

describe('the shape of a finished game', () => {
  it.each(ALL)('$name: blowouts are bounded', (mode) => {
    // Measured at ship: Tidepool ~45%, Skirmish ~24%, Floodmark ~18%. Tidepool
    // runs hot because 12 stones on a 6x6 cannot produce a narrow finish — a
    // one-stone win there is a 7-5 split, so "gap >= half the board" is a much
    // lower bar than the same phrase on the 10x10. Bounded per mode rather than
    // pretending one number describes all three.
    const bound = mode.size <= 6 ? 0.6 : 0.45;
    expect(blowoutRate(runs(mode), stoneCount(mode) / 2)).toBeLessThan(bound);
  });

  it.each(ALL)('$name: both win conditions actually fire', (mode) => {
    const rs = runs(mode);
    const reasons = new Set(rs.map((r) => r.reason));
    // A game where the rout never happens has a dead headline rule; one where
    // blockage never happens means the board never gets interesting.
    expect(reasons.has('rout')).toBe(true);
    expect(reasons.has('blocked')).toBe(true);
  });

  it('Floodmark lands bigger chains than Skirmish — the modes really differ', () => {
    const share = (mode: Mode): number => {
      const h = chainHistogram(runs(mode));
      const turns = h.reduce((a, b) => a + b, 0);
      return h.slice(2).reduce((a, b) => a + b, 0) / turns;
    };
    expect(share(MODES.floodmark)).toBeGreaterThan(share(MODES.skirmish));
  });

  it('Tidepool really is optional-capture, and the others really are not', () => {
    expect(MODES.tidepool.forcedCapture).toBe(false);
    expect(MODES.skirmish.forcedCapture).toBe(true);
    expect(MODES.floodmark.forcedCapture).toBe(true);
  });

  it('cooling is 1 everywhere — pinned, because 2 broke seat fairness', () => {
    // Measured: cooling 2 took Skirmish's first-player rate to 66%. If a future
    // change wants a longer cooling anywhere, it has to re-run the seat check.
    for (const mode of ALL) expect(mode.cooling).toBe(1);
  });
});
