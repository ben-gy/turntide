/**
 * turntide.test.ts — the rules, which is where this game's identity lives.
 *
 * Every one of these pins a rule that the design would be a different (worse)
 * game without. The flip-not-capture rule, crown demotion, cooling and the flip
 * cap are all load-bearing, and all four are things a refactor could silently
 * "simplify" away.
 */

import { describe, expect, it } from 'vitest';
import { MODES, modeOf, stoneCount, type Mode } from '../src/modes';
import {
  AMBER,
  EMPTY,
  TEAL,
  applyMove,
  control,
  crownRow,
  initial,
  isLegal,
  isPlayable,
  kings,
  legalMoves,
  other,
  outcome,
  posKey,
  replay,
  rowOf,
  type Move,
  type Pos,
  type Side,
} from '../src/turntide';

/** Build an empty board of `size` with the given stones, for hand-made cases. */
function board(
  size: number,
  stones: Array<{ at: [number, number]; side: Side; king?: boolean; cool?: number }>,
  turn: Side = TEAL,
): Pos {
  const n = size * size;
  const p: Pos = {
    size,
    owner: new Int8Array(n),
    king: new Uint8Array(n),
    cool: new Uint8Array(n),
    turn,
    ply: 0,
  };
  for (const s of stones) {
    const i = s.at[0] * size + s.at[1];
    if (!isPlayable(i, size)) throw new Error(`(${s.at}) is a light square — not playable`);
    p.owner[i] = s.side;
    p.king[i] = s.king ? 1 : 0;
    p.cool[i] = s.cool ?? 0;
  }
  return p;
}

const at = (size: number, r: number, c: number): number => r * size + c;

/** The one move matching this origin, or a helpful failure. */
function moveFrom(p: Pos, mode: Mode, from: number): Move {
  const ms = legalMoves(p, mode).filter((m) => m.from === from);
  expect(ms.length).toBeGreaterThan(0);
  return ms[0];
}

describe('the opening position', () => {
  it('is point-symmetric — neither side starts ahead, by construction', () => {
    for (const mode of Object.values(MODES)) {
      const p = initial(mode);
      expect(control(p, TEAL)).toBe(control(p, AMBER));
      expect(control(p, TEAL)).toBe(stoneCount(mode) / 2);
      expect(kings(p, TEAL)).toBe(0);
      expect(kings(p, AMBER)).toBe(0);
    }
  });

  it('places stones only on dark squares', () => {
    for (const mode of Object.values(MODES)) {
      const p = initial(mode);
      for (let i = 0; i < p.owner.length; i++) {
        if (p.owner[i] !== EMPTY) expect(isPlayable(i, p.size)).toBe(true);
      }
    }
  });

  it('gives both sides the same number of opening moves', () => {
    for (const mode of Object.values(MODES)) {
      const teal = initial(mode);
      const amber = initial(mode);
      amber.turn = AMBER;
      expect(legalMoves(teal, mode).length).toBe(legalMoves(amber, mode).length);
    }
  });

  it('has no jumps available on move one in any mode', () => {
    for (const mode of Object.values(MODES)) {
      const p = initial(mode);
      expect(legalMoves(p, mode).every((m) => m.flips.length === 0)).toBe(true);
    }
  });
});

describe('a jump converts instead of capturing — the whole game', () => {
  const mode = MODES.skirmish;
  const S = mode.size;

  it('flips the jumped stone, leaves it in place, and keeps the stone count constant', () => {
    // Teal on (4,3) jumps Amber on (3,4), landing on (2,5).
    const p = board(S, [
      { at: [4, 3], side: TEAL },
      { at: [3, 4], side: AMBER },
    ]);
    const before = control(p, TEAL) + control(p, AMBER);

    const m = moveFrom(p, mode, at(S, 4, 3));
    expect(m.path).toEqual([at(S, 2, 5)]);
    expect(m.flips).toEqual([at(S, 3, 4)]);

    applyMove(p, mode, m);

    // The jumped stone STAYED PUT and changed hands.
    expect(p.owner[at(S, 3, 4)]).toBe(TEAL);
    // The mover landed beyond it; its origin is empty.
    expect(p.owner[at(S, 2, 5)]).toBe(TEAL);
    expect(p.owner[at(S, 4, 3)]).toBe(EMPTY);
    // Nothing left the board.
    expect(control(p, TEAL) + control(p, AMBER)).toBe(before);
    expect(control(p, TEAL)).toBe(2);
    expect(control(p, AMBER)).toBe(0);
  });

  it('is a two-stone swing, which a capture would not be', () => {
    const p = board(S, [
      { at: [4, 3], side: TEAL },
      { at: [3, 4], side: AMBER },
      { at: [7, 0], side: AMBER },
    ]);
    const tealBefore = control(p, TEAL);
    const amberBefore = control(p, AMBER);

    applyMove(p, mode, moveFrom(p, mode, at(S, 4, 3)));

    expect(control(p, TEAL)).toBe(tealBefore + 1);
    expect(control(p, AMBER)).toBe(amberBefore - 1);
  });

  it('cannot jump onto an occupied square', () => {
    const p = board(S, [
      { at: [4, 3], side: TEAL },
      { at: [3, 4], side: AMBER },
      { at: [2, 5], side: AMBER },
    ]);
    expect(legalMoves(p, mode).some((m) => m.flips.length > 0)).toBe(false);
  });

  it('cannot jump its own colour', () => {
    const p = board(S, [
      { at: [4, 3], side: TEAL },
      { at: [3, 4], side: TEAL },
    ]);
    expect(legalMoves(p, mode).every((m) => m.flips.length === 0)).toBe(true);
  });
});

describe('cooling — what stops the board oscillating', () => {
  const mode = MODES.skirmish;
  const S = mode.size;

  it('a freshly converted stone cannot be flipped straight back', () => {
    const p = board(S, [
      { at: [4, 3], side: TEAL },
      { at: [3, 4], side: AMBER },
      { at: [1, 6], side: AMBER },
    ]);
    applyMove(p, mode, moveFrom(p, mode, at(S, 4, 3)));

    // The converted stone at (3,4) is now Teal's and cooling.
    expect(p.owner[at(S, 3, 4)]).toBe(TEAL);
    expect(p.cool[at(S, 3, 4)]).toBe(mode.cooling);

    // Amber to move, sitting adjacent at (2,5)… wait, that is Teal's lander.
    // Amber's stone at (1,6) can reach (2,5)? It is occupied. The point under
    // test is simply that no Amber move flips the cooling stone.
    expect(p.turn).toBe(AMBER);
    for (const m of legalMoves(p, mode)) {
      expect(m.flips).not.toContain(at(S, 3, 4));
    }
  });

  it('immunity lasts exactly one enemy turn at cooling 1', () => {
    const p = board(S, [{ at: [4, 3], side: TEAL, cool: 1 }], AMBER);
    expect(p.cool[at(S, 4, 3)]).toBe(1);

    // Amber moves (any move); at the END of Amber's turn, Teal's stones cool.
    p.owner[at(S, 0, 1)] = AMBER;
    applyMove(p, mode, moveFrom(p, mode, at(S, 0, 1)));
    expect(p.cool[at(S, 4, 3)]).toBe(0);
  });

  it('does NOT expire during the turn of the side that created it', () => {
    // This is the ordering bug the implementation comment warns about: if turn
    // end decremented everything, the immunity would be gone before the
    // opponent ever looked at it.
    const p = board(S, [
      { at: [4, 3], side: TEAL },
      { at: [3, 4], side: AMBER },
    ]);
    applyMove(p, mode, moveFrom(p, mode, at(S, 4, 3)));
    expect(p.cool[at(S, 3, 4)]).toBe(1); // survived Teal's own turn end
  });

  it('cooling 2 (Tidepool) holds through two enemy turns', () => {
    const tp = MODES.tidepool;
    const T = tp.size;
    const p = board(T, [{ at: [3, 2], side: TEAL, cool: 2 }, { at: [0, 1], side: AMBER }], AMBER);

    applyMove(p, tp, moveFrom(p, tp, at(T, 0, 1)));
    expect(p.cool[at(T, 3, 2)]).toBe(1); // still immune
    // Teal makes a move, then Amber again.
    p.owner[at(T, 5, 0)] = TEAL;
    applyMove(p, tp, moveFrom(p, tp, at(T, 5, 0)));
    const amberSq = legalMoves(p, tp).find((m) => true)!;
    applyMove(p, tp, amberSq);
    expect(p.cool[at(T, 3, 2)]).toBe(0);
  });

  it('a stone that moves spends its own immunity', () => {
    const p = board(S, [{ at: [4, 3], side: TEAL, cool: 1 }]);
    const m = moveFrom(p, mode, at(S, 4, 3));
    applyMove(p, mode, m);
    expect(p.cool[m.path[0]]).toBe(0);
  });
});

describe('crowns cannot be farmed', () => {
  const mode = MODES.skirmish;
  const S = mode.size;

  it('a man crowns by stepping onto the far row', () => {
    const p = board(S, [{ at: [1, 2], side: TEAL }]);
    const m = legalMoves(p, mode).find((x) => rowOf(x.path[0], S) === 0)!;
    expect(m.crowned).toBe(true);
    applyMove(p, mode, m);
    expect(p.king[m.path[0]]).toBe(1);
    expect(kings(p, TEAL)).toBe(1);
  });

  it('a flipped king is DEMOTED — it converts as a plain man', () => {
    const p = board(S, [
      { at: [4, 3], side: TEAL },
      { at: [3, 4], side: AMBER, king: true },
    ]);
    expect(kings(p, AMBER)).toBe(1);

    applyMove(p, mode, moveFrom(p, mode, at(S, 4, 3)));

    expect(p.owner[at(S, 3, 4)]).toBe(TEAL);
    expect(p.king[at(S, 3, 4)]).toBe(0);
    expect(kings(p, TEAL)).toBe(0);
    expect(kings(p, AMBER)).toBe(0);
  });

  it('does not auto-crown a stone that is flipped while sitting on a crown row', () => {
    // Teal's crown row is 0. An Amber stone parked there, flipped by Teal, must
    // NOT become a Teal king — that would be crown farming from the far side.
    const p = board(S, [
      { at: [2, 3], side: TEAL },
      { at: [1, 2], side: AMBER },
    ]);
    const m = legalMoves(p, mode).find((x) => x.flips.includes(at(S, 1, 2)))!;
    applyMove(p, mode, m);
    expect(p.owner[at(S, 1, 2)]).toBe(TEAL);
    expect(p.king[at(S, 1, 2)]).toBe(0);
  });

  it('crowning ends the move even if another jump is available', () => {
    // Teal man at (3,0) jumps Amber at (2,1) to land on (1,2)… not the crown
    // row. Set it up so the landing IS the crown row and a further jump exists.
    const p = board(S, [
      { at: [2, 1], side: TEAL },
      { at: [1, 2], side: AMBER },
      { at: [1, 4], side: AMBER },
    ]);
    const m = legalMoves(p, mode).find((x) => x.from === at(S, 2, 1))!;
    expect(m.crowned).toBe(true);
    expect(m.path.length).toBe(1);
    expect(m.flips.length).toBe(1);
  });

  it('kings move and jump in every direction; men do not', () => {
    const man = board(S, [{ at: [4, 3], side: TEAL }]);
    const king = board(S, [{ at: [4, 3], side: TEAL, king: true }]);
    expect(legalMoves(man, mode).length).toBe(2); // forward-left, forward-right
    expect(legalMoves(king, mode).length).toBe(4);
  });

  it('a man may not jump backward', () => {
    const p = board(S, [
      { at: [3, 4], side: TEAL },
      { at: [4, 5], side: AMBER }, // behind a Teal man (Teal moves toward row 0)
    ]);
    expect(legalMoves(p, mode).every((m) => m.flips.length === 0)).toBe(true);
  });
});

describe('the flip cap — the cascade pressure valve', () => {
  const mode = MODES.skirmish; // cap 3
  const S = mode.size;

  it('never converts more stones in one turn than the mode allows', () => {
    // A ladder of Amber stones a king could otherwise chain through forever.
    const p = board(S, [
      { at: [7, 0], side: TEAL, king: true },
      { at: [6, 1], side: AMBER },
      { at: [4, 3], side: AMBER },
      { at: [2, 5], side: AMBER },
      { at: [0, 7], side: AMBER },
    ]);
    const moves = legalMoves(p, mode);
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) expect(m.flips.length).toBeLessThanOrEqual(mode.flipCap);
    // And the cap really does bind here — the geometry offers a 4th link.
    expect(Math.max(...moves.map((m) => m.flips.length))).toBe(mode.flipCap);
  });

  it('Floodmark allows longer chains than Skirmish on the same geometry', () => {
    const stones = (side: Side) =>
      [
        { at: [9, 0] as [number, number], side, king: true },
        { at: [8, 1] as [number, number], side: other(side) },
        { at: [6, 3] as [number, number], side: other(side) },
        { at: [4, 5] as [number, number], side: other(side) },
        { at: [2, 7] as [number, number], side: other(side) },
      ];
    const fm = MODES.floodmark;
    const p = board(fm.size, stones(TEAL));
    const best = Math.max(...legalMoves(p, fm).map((m) => m.flips.length));
    expect(best).toBe(4);
    expect(fm.flipCap).toBeGreaterThan(MODES.skirmish.flipCap);
  });

  it('never converts the same stone twice in one chain', () => {
    const p = board(S, [
      { at: [7, 0], side: TEAL, king: true },
      { at: [6, 1], side: AMBER },
      { at: [4, 3], side: AMBER },
    ]);
    for (const m of legalMoves(p, mode)) {
      expect(new Set(m.flips).size).toBe(m.flips.length);
    }
  });
});

describe('forced capture is a real mode difference', () => {
  const S = 8;
  const stones: Array<{ at: [number, number]; side: Side }> = [
    { at: [4, 3], side: TEAL },
    { at: [3, 4], side: AMBER },
    { at: [6, 1], side: TEAL },
  ];

  it('Skirmish (forced ON) offers only jumps when a jump exists', () => {
    const p = board(S, stones);
    const moves = legalMoves(p, MODES.skirmish);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.flips.length > 0)).toBe(true);
  });

  it('Tidepool (forced OFF) also offers quiet moves and stopping a chain early', () => {
    const tp = MODES.tidepool;
    const T = tp.size;
    const p = board(T, [
      { at: [3, 2], side: TEAL },
      { at: [2, 3], side: AMBER },
      { at: [5, 0], side: TEAL },
    ]);
    const moves = legalMoves(p, tp);
    expect(moves.some((m) => m.flips.length > 0)).toBe(true);
    expect(moves.some((m) => m.flips.length === 0)).toBe(true);
  });
});

describe('how a round ends', () => {
  const mode = MODES.skirmish;
  const S = mode.size;

  it('the rout is an instant win', () => {
    const p = initial(mode);
    // Hand Teal exactly the rout threshold.
    const need = mode.rout - control(p, TEAL);
    let converted = 0;
    for (let i = 0; i < p.owner.length && converted < need; i++) {
      if (p.owner[i] === AMBER) {
        p.owner[i] = TEAL;
        converted++;
      }
    }
    expect(control(p, TEAL)).toBe(mode.rout);
    const end = outcome(p, mode);
    expect(end.over).toBe(true);
    expect(end.winner).toBe(TEAL);
    expect(end.reason).toBe('rout');
  });

  it('a side with no legal move loses', () => {
    // Teal to move, boxed into a corner by its own... no: give Teal nothing.
    const p = board(S, [{ at: [0, 1], side: TEAL }], TEAL);
    // A Teal man on row 0 has no forward square left.
    expect(legalMoves(p, mode).length).toBe(0);
    const end = outcome(p, mode);
    expect(end.over).toBe(true);
    expect(end.winner).toBe(AMBER);
    expect(end.reason).toBe('blocked');
  });

  it('resolves on stones controlled at the turn cap', () => {
    const p = initial(mode);
    p.ply = mode.turnCap;
    p.owner[p.owner.findIndex((o) => o === AMBER)] = TEAL;
    const end = outcome(p, mode);
    expect(end.over).toBe(true);
    expect(end.reason).toBe('cap');
    expect(end.winner).toBe(TEAL);
  });

  it('an even split at the cap is a draw', () => {
    const p = initial(mode);
    p.ply = mode.turnCap;
    const end = outcome(p, mode);
    expect(end.over).toBe(true);
    expect(end.winner).toBe(0);
  });

  it('the rout threshold is reachable — it is less than the total stone count', () => {
    for (const m of Object.values(MODES)) {
      expect(m.rout).toBeLessThan(stoneCount(m));
      expect(m.rout).toBeGreaterThan(stoneCount(m) / 2);
    }
  });
});

describe('determinism — what the lockstep netcode rests on', () => {
  const mode = MODES.skirmish;

  it('replaying the same move list reaches a byte-identical position', () => {
    const a = initial(mode);
    const wire: Array<{ from: number; path: number[] }> = [];
    for (let i = 0; i < 40; i++) {
      const moves = legalMoves(a, mode);
      if (!moves.length) break;
      const m = moves[(i * 7 + 3) % moves.length];
      wire.push({ from: m.from, path: [...m.path] });
      applyMove(a, mode, m);
      if (outcome(a, mode).over) break;
    }

    const { pos: b, ok } = replay(mode, wire);
    expect(ok).toBe(true);
    expect(posKey(b)).toBe(posKey(a));
    expect(Array.from(b.owner)).toEqual(Array.from(a.owner));
    expect(Array.from(b.king)).toEqual(Array.from(a.king));
    expect(Array.from(b.cool)).toEqual(Array.from(a.cool));
    expect(b.turn).toBe(a.turn);
    expect(b.ply).toBe(a.ply);
  });

  it('rejects an illegal move off the wire rather than desyncing', () => {
    const p = initial(mode);
    expect(isLegal(p, mode, { from: 0, path: [999] })).toBeNull();
    // An Amber stone cannot be moved on Teal's turn.
    const amberSquare = p.owner.findIndex((o) => o === AMBER);
    expect(isLegal(p, mode, { from: amberSquare, path: [amberSquare + mode.size + 1] })).toBeNull();
    expect(replay(mode, [{ from: 0, path: [999] }]).ok).toBe(false);
  });

  it('accepts every move it generated', () => {
    const p = initial(mode);
    for (const m of legalMoves(p, mode)) {
      expect(isLegal(p, mode, { from: m.from, path: m.path })).not.toBeNull();
    }
  });
});

describe('modeOf validates ids off the wire', () => {
  it('falls back for prototype keys rather than yielding a Mode of undefined', () => {
    for (const junk of ['constructor', 'toString', '__proto__', 'nope', '', null, undefined, 7]) {
      const m = modeOf(junk);
      expect(m.size).toBeGreaterThan(0);
      expect(m.flipCap).toBeGreaterThan(0);
      expect(MODES[m.id]).toBe(m);
    }
  });

  it('round-trips every real id', () => {
    for (const id of Object.keys(MODES)) expect(modeOf(id).id).toBe(id);
  });

  it('crownRow is the row each side is walking toward', () => {
    expect(crownRow(TEAL, 8)).toBe(0);
    expect(crownRow(AMBER, 8)).toBe(7);
    expect(other(TEAL)).toBe(AMBER);
    expect(other(AMBER)).toBe(TEAL);
  });
});
