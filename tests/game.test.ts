/**
 * game.test.ts — the round's state machine.
 *
 * src/turntide.ts owns the RULES and has its own suite. This file owns the layer
 * between the rules and the two things that drive them: a thumb on a phone, and a
 * move arriving off the wire. Everything here is a path that a rules test cannot
 * reach, because it is about how a move is BUILT rather than whether it is legal:
 *
 *  - Chain input. A jump chain is ONE move on the wire but three taps on a phone.
 *    The machine holds a prefix of landing squares and narrows as it grows.
 *  - Optional capture. In Tidepool a chain that can continue may also stop, so
 *    both are live candidates and "stop here" has to be offerable. In Skirmish the
 *    generator only emits maximal chains, so it must NOT be.
 *  - The wire gate. An illegal move off the wire must be REFUSED, not applied.
 *    Lockstep peers share no state, so one bad apply is a permanent silent desync.
 *  - The results screen, for every player, not just the local one.
 *  - Seat alternation, which is the compensation for the first-move edge.
 */

import { describe, expect, it } from 'vitest';
import { Game, seatsFor, type WireMove } from '../src/game';
import { MODES, type Mode } from '../src/modes';
import { AMBER, TEAL, initial, legalMoves, type Pos } from '../src/turntide';

// ── a hand-built position ───────────────────────────────────────────────────
// Indices are r * size + c; play happens where (r + c) is odd. Building the board
// explicitly (rather than playing into a position) keeps every assertion below
// readable and makes the chain deterministic without a search.

const at = (r: number, c: number, size = 8): number => r * size + c;

function empty(mode: Mode): Pos {
  const p = initial(mode);
  p.owner.fill(0);
  p.king.fill(0);
  p.cool.fill(0);
  return p;
}

/**
 * Teal man at (5,2) with TWO first hops available, one of which continues:
 *
 *   . . . . . . . .    (0)
 *   . . . . . . T .    (1,6)  <- the far end of the two-link chain
 *   . . . . . a .      (2,5)  amber
 *   . . . . x . . .    (3,4)  the mid-chain landing square
 *   . a . a . . . .    (4,1) and (4,3) amber
 *   . . t . . . . .    (5,2) the teal man
 *
 * So: 42 -> 28 -> 14 converts two, and 42 -> 24 converts one and stops.
 */
function chainBoard(mode: Mode): Pos {
  const p = empty(mode);
  p.owner[at(5, 2)] = TEAL;
  p.owner[at(4, 3)] = AMBER;
  p.owner[at(4, 1)] = AMBER;
  p.owner[at(2, 5)] = AMBER;
  // A stone each side keeps `outcome()` honest — a side with nothing to do would
  // read as 'blocked' and end the round before any of this could be tested.
  p.owner[at(7, 0)] = TEAL;
  p.owner[at(0, 7)] = AMBER;
  p.turn = TEAL;
  return p;
}

const FROM = at(5, 2); // 42
const MID = at(3, 4); // 28
const END = at(1, 6); // 14
const SHORT = at(3, 0); // 24 — the one-flip alternative

function gameOn(modeId: 'tidepool' | 'skirmish', pos?: Pos): Game {
  const g = new Game({
    mode: modeId,
    players: [
      { id: 'me', name: 'Me', side: TEAL, local: true, bot: false },
      { id: 'you', name: 'You', side: AMBER, local: false, bot: false },
    ],
  });
  if (pos) g.pos = pos;
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('chain input: one move, three taps', () => {
  it('step() returns null mid-chain and the Move only when the chain completes', () => {
    const g = gameOn('skirmish', chainBoard(MODES.skirmish));

    expect(g.select(FROM), 'the chaining stone must be selectable').toBe(true);
    expect(g.head(), 'before any hop the head is the origin').toBe(FROM);

    const mid = g.step(MID);
    expect(mid, 'the chain can continue, so this tap must NOT commit a move').toBeNull();
    expect(g.prefix).toEqual([MID]);
    expect(g.head(), 'mid-chain the stone renders on its latest landing square').toBe(MID);

    const done = g.step(END);
    expect(done, 'the final hop must hand back the completed move').not.toBeNull();
    expect(done!.from).toBe(FROM);
    expect(done!.path).toEqual([MID, END]);
    expect(done!.flips, 'two stones change allegiance, and neither leaves the board').toHaveLength(
      2,
    );
  });

  it('targets() narrows as the prefix grows', () => {
    const g = gameOn('skirmish', chainBoard(MODES.skirmish));
    g.select(FROM);

    expect(
      [...g.targets()].sort((x, y) => x - y),
      'both first hops are offered before the player has committed to one',
    ).toEqual([SHORT, MID].sort((x, y) => x - y));

    g.step(MID);
    expect(g.targets(), 'once the branch is chosen only its continuation remains').toEqual([END]);

    g.step(END);
    expect(g.targets(), 'a completed chain has nowhere left to go').toEqual([]);
  });

  it('a tap on a square that is not a legal target is ignored, not applied', () => {
    const g = gameOn('skirmish', chainBoard(MODES.skirmish));
    g.select(FROM);
    expect(g.step(at(3, 2)), 'an empty non-target square').toBeNull();
    expect(g.prefix, 'a stray tap must not advance the chain').toEqual([]);
  });

  it('selection is refused when it is not the local turn', () => {
    const p = chainBoard(MODES.skirmish);
    p.turn = AMBER;
    const g = gameOn('skirmish', p);
    expect(g.isLocalTurn()).toBe(false);
    expect(g.select(at(4, 3)), 'the local player must not be able to move the peer\'s stone').toBe(
      false,
    );
  });

  it('clearSelection() puts the machine back where it started', () => {
    const g = gameOn('skirmish', chainBoard(MODES.skirmish));
    g.select(FROM);
    g.step(MID);
    g.clearSelection();
    expect(g.sel).toBeNull();
    expect(g.prefix).toEqual([]);
    expect(g.head()).toBeNull();
    expect(g.targets()).toEqual([]);
  });
});

describe('optional capture is expressible in a UI — and only where it exists', () => {
  it('Tidepool offers "stop here" mid-chain, and stopping commits exactly one flip', () => {
    const g = gameOn('tidepool', chainBoard(MODES.tidepool));
    g.select(FROM);
    g.step(MID);

    expect(
      g.canStop(),
      'with capture optional, a chain that CAN continue may also end here — and if ' +
        'the UI cannot offer that, half of Tidepool is unreachable',
    ).toBe(true);
    expect(g.targets(), 'continuing is still on the table too').toEqual([END]);

    const m = g.stopHere();
    expect(m).not.toBeNull();
    expect(m!.path).toEqual([MID]);
    expect(m!.flips).toHaveLength(1);

    g.commit(m!);
    expect(g.pos.owner[at(4, 3)], 'the jumped stone flipped rather than vanishing').toBe(TEAL);
    expect(g.pos.owner[MID], 'the mover is on its landing square').toBe(TEAL);
    expect(g.pos.turn).toBe(AMBER);
  });

  it('Skirmish never offers it, because forced capture only emits maximal chains', () => {
    const g = gameOn('skirmish', chainBoard(MODES.skirmish));
    g.select(FROM);
    g.step(MID);

    expect(
      g.canStop(),
      'a "stop here" button in Skirmish would offer an illegal move',
    ).toBe(false);
    expect(g.stopHere(), 'there is no complete move of this length to commit').toBeNull();
  });

  it('Skirmish forces the jump: a quiet step is not even generated', () => {
    const g = gameOn('skirmish', chainBoard(MODES.skirmish));
    const froms = new Set(legalMoves(g.pos, g.mode).map((m) => m.from));
    expect(froms, 'the other teal stone may not shuffle while a jump is available').toEqual(
      new Set([FROM]),
    );

    const t = gameOn('tidepool', chainBoard(MODES.tidepool));
    const quiet = legalMoves(t.pos, t.mode).filter((m) => m.flips.length === 0);
    expect(quiet.length, 'in Tidepool declining is a real option').toBeGreaterThan(0);
  });
});

describe('the wire gate', () => {
  it('applies a legal move off the wire identically to a local one', () => {
    const wire: WireMove = { from: FROM, path: [MID, END] };

    const local = gameOn('skirmish', chainBoard(MODES.skirmish));
    local.select(FROM);
    local.step(MID);
    local.commit(local.step(END)!);

    const remote = gameOn('skirmish', chainBoard(MODES.skirmish));
    expect(remote.applyWire(wire)).toBe(true);

    // Lockstep's whole premise: the same move list produces the same bytes.
    expect([...remote.pos.owner]).toEqual([...local.pos.owner]);
    expect([...remote.pos.king]).toEqual([...local.pos.king]);
    expect([...remote.pos.cool]).toEqual([...local.pos.cool]);
    expect(remote.pos.turn).toBe(local.pos.turn);
    expect(remote.history).toEqual(local.history);
  });

  it('REFUSES an illegal move rather than desyncing', () => {
    const illegal: Array<[string, WireMove]> = [
      ['a truncated chain, which forced capture does not permit', { from: FROM, path: [MID] }],
      ['a landing square nothing can reach', { from: FROM, path: [at(3, 2)] }],
      ['an origin with no stone on it', { from: at(6, 1), path: [at(5, 0)] }],
      ['a path that leaves the board', { from: FROM, path: [-1] }],
      ['an empty path', { from: FROM, path: [] }],
    ];

    for (const [why, wire] of illegal) {
      const g = gameOn('skirmish', chainBoard(MODES.skirmish));
      const before = [...g.pos.owner];
      expect(g.applyWire(wire), `accepted an illegal move: ${why}`).toBe(false);
      expect([...g.pos.owner], `mutated the board on a refused move: ${why}`).toEqual(before);
      expect(g.history, 'a refused move must not enter the history').toEqual([]);
      expect(g.pos.turn, 'a refused move must not pass the turn').toBe(TEAL);
    }
  });
});

describe('summary(): every player, every time', () => {
  it('reports converted / bestChain / turns per side, not just for the local seat', () => {
    const g = gameOn('skirmish', chainBoard(MODES.skirmish));

    // Teal plays the two-link chain.
    expect(g.applyWire({ from: FROM, path: [MID, END] })).toBe(true);
    // Amber replies with a quiet step (its lone stone at (0,7) walks down).
    const amberMove = legalMoves(g.pos, g.mode)[0];
    g.commit(amberMove);

    const s = g.summary();
    expect(s.players, 'principle #9 — the results screen shows everyone').toHaveLength(2);

    const teal = s.players.find((p) => p.side === TEAL)!;
    const amber = s.players.find((p) => p.side === AMBER)!;

    expect(teal.name).toBe('Me');
    expect(amber.name).toBe('You');
    expect(teal.converted, 'the chain turned two amber stones teal').toBe(2);
    expect(teal.bestChain).toBe(2);
    expect(teal.turns).toBe(1);
    expect(amber.converted, 'a quiet step converts nothing').toBe(0);
    expect(amber.bestChain).toBe(0);
    expect(amber.turns).toBe(1);
    expect(s.plies).toBe(2);

    // Control is read off the live board, so it must reflect the conversions.
    expect(teal.control).toBe(4); // the two originals plus the two it flipped
    expect(amber.control).toBe(2);
    expect(
      teal.control + amber.control,
      'nothing ever leaves the board — the stone count is a constant',
    ).toBe(6);
  });

  it('bestChain keeps the LONGEST chain, not the most recent one', () => {
    const g = gameOn('skirmish', chainBoard(MODES.skirmish));
    g.applyWire({ from: FROM, path: [MID, END] }); // 2 flips
    g.commit(legalMoves(g.pos, g.mode)[0]); // amber replies

    // Teal now makes a smaller move; the 2-chain must survive in the tally.
    const small = legalMoves(g.pos, g.mode).find((m) => m.flips.length < 2)!;
    g.commit(small);

    const teal = g.summary().players.find((p) => p.side === TEAL)!;
    expect(teal.bestChain).toBe(2);
    expect(teal.turns).toBe(2);
    expect(teal.converted, 'converted is a running total, not a per-turn figure').toBe(
      2 + small.flips.length,
    );
  });

  it('missedBest records the chain that was left on the table', () => {
    // Only reachable in Tidepool: with capture forced there is nothing to decline.
    const g = gameOn('tidepool', chainBoard(MODES.tidepool));
    const best = legalMoves(g.pos, g.mode).reduce((n, m) => Math.max(n, m.flips.length), 0);
    expect(best, 'the fixture must actually offer a 2-chain to decline').toBe(2);

    const declined = legalMoves(g.pos, g.mode).find((m) => m.flips.length === 0)!;
    g.commit(declined);

    expect(
      g.summary().missedBest,
      'declining a 2-chain is the signature Tidepool decision — the results screen ' +
        'has to be able to name it',
    ).toBe(2);
  });

  it('missedBest stays 0 when the biggest available chain is the one played', () => {
    const g = gameOn('skirmish', chainBoard(MODES.skirmish));
    g.applyWire({ from: FROM, path: [MID, END] });
    expect(g.summary().missedBest).toBe(0);
  });
});

describe('forfeit(): a survivor still reaches a results screen', () => {
  it('awards the round to the other side, with reason "left"', () => {
    const g = gameOn('skirmish', chainBoard(MODES.skirmish));
    g.applyWire({ from: FROM, path: [MID, END] });

    expect(g.over(), 'the round is still live before anyone leaves').toBe(false);

    g.forfeit(AMBER); // the amber seat closed its tab

    expect(g.over()).toBe(true);
    const s = g.summary();
    expect(s.over).toBe(true);
    expect(s.winner).toBe(TEAL);
    expect(s.reason).toBe('left');
    expect(
      s.players,
      'a forfeit is still a result — both breakdowns must be there to render',
    ).toHaveLength(2);
    expect(s.players.find((p) => p.side === TEAL)!.converted).toBe(2);
  });

  it('a forfeit by the leader still hands the round to the survivor', () => {
    const g = gameOn('skirmish', chainBoard(MODES.skirmish));
    g.applyWire({ from: FROM, path: [MID, END] }); // teal is ahead 4-2
    g.forfeit(TEAL);
    expect(g.summary().winner, 'the score does not decide a walkover; leaving does').toBe(AMBER);
  });

  it('a live round reports over:false and no winner', () => {
    const g = gameOn('skirmish', chainBoard(MODES.skirmish));
    const s = g.summary();
    expect(s.over).toBe(false);
    expect(s.winner).toBe(0);
    expect(s.reason).toBe('');
  });
});

describe('seatsFor(): sides alternate by round', () => {
  const players = [
    { id: 'p1', name: 'One' },
    { id: 'p2', name: 'Two' },
  ];

  it('the same player gets the OPPOSITE side on consecutive rounds', () => {
    // The balance sim puts the first-move edge within a few points of chance, and
    // "within a few points" is not zero. Alternating is the compensation, so it
    // is pinned here rather than trusted.
    const r1 = seatsFor(players, 1, 'p1');
    const r2 = seatsFor(players, 2, 'p1');
    const r3 = seatsFor(players, 3, 'p1');

    const side = (seats: ReturnType<typeof seatsFor>, id: string): number =>
      seats.find((p) => p.id === id)!.side;

    expect(side(r1, 'p1')).toBe(TEAL);
    expect(side(r2, 'p1'), 'p1 held the first move twice running').toBe(AMBER);
    expect(side(r3, 'p1'), 'and back again on the next round').toBe(TEAL);

    expect(side(r1, 'p2')).toBe(AMBER);
    expect(side(r2, 'p2')).toBe(TEAL);
  });

  it('the two seats are always opposite sides, never the same one', () => {
    for (let round = 1; round <= 8; round++) {
      const seats = seatsFor(players, round, 'p1');
      expect(seats).toHaveLength(2);
      expect(new Set(seats.map((s) => s.side)).size, `round ${round} seated both on one side`).toBe(
        2,
      );
    }
  });

  it('marks exactly the local peer as local, from that peer\'s own view', () => {
    for (const self of ['p1', 'p2']) {
      const seats = seatsFor(players, 1, self);
      expect(seats.filter((s) => s.local).map((s) => s.id)).toEqual([self]);
      expect(seats.every((s) => !s.bot)).toBe(true);
    }
  });

  it('both peers derive IDENTICAL sides from the same frozen roster', () => {
    // The roster travels frozen with the round start precisely so this holds. If
    // the two peers disagreed here they would each be playing the other's colour.
    for (let round = 1; round <= 4; round++) {
      const mine = seatsFor(players, round, 'p1');
      const theirs = seatsFor(players, round, 'p2');
      expect(mine.map((s) => `${s.id}:${s.side}`)).toEqual(theirs.map((s) => `${s.id}:${s.side}`));
    }
  });

  it('a Game built from those seats knows whose turn it is locally', () => {
    const seats = seatsFor(players, 1, 'p1');
    const g = new Game({ mode: 'skirmish', players: seats });
    expect(g.localSide()).toBe(TEAL);
    expect(g.turn, 'teal always opens; it is the SEAT that alternates').toBe(TEAL);
    expect(g.isLocalTurn()).toBe(true);

    const other = new Game({ mode: 'skirmish', players: seatsFor(players, 1, 'p2') });
    expect(other.localSide()).toBe(AMBER);
    expect(other.isLocalTurn(), 'the amber seat waits for the opening move').toBe(false);
  });
});
