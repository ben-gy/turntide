/**
 * no-deadlock.test.ts — live-P2P contract gate #5.
 *
 * The rule "start when EVERYONE has readied up" is correct and unshippable. One
 * player still reading the results, or gone to answer the door, or simply not
 * tapping, holds the entire room hostage with no way out but the menu — and from
 * the other seat it is indistinguishable from the game having crashed, because
 * nothing on screen is moving.
 *
 * So the contract is: a peer that never votes must NOT be able to hold the room.
 * Quorum starts a visible countdown; when it expires the round starts without the
 * straggler. Unanimity still starts instantly, because nobody should be made to
 * wait out a timer they have already satisfied. And losing quorum cancels the
 * countdown, because a countdown that keeps running toward a start that cannot
 * legally happen is worse than no countdown at all.
 *
 * `startsInMs` is part of the contract, not a nicety: a silent wait and a hang
 * look identical.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo, type Rounds } from '@ben-gy/game-engine/rematch';
import { Bus } from './helpers/bus';

const GRACE_MS = 8000;

interface Peer {
  id: string;
  rounds: Rounds;
  got: RoundInfo[];
}

let bus: Bus;

function seat(id: string): Peer {
  const net = bus.join(id);
  const peer: Peer = { id, rounds: null as unknown as Rounds, got: [] };
  peer.rounds = createRounds({
    net,
    playerName: id.toUpperCase(),
    minPlayers: 2,
    graceMs: GRACE_MS,
    roundOpts: () => ({ mode: 'skirmish' }),
    onRound: (info) => peer.got.push(info),
  });
  return peer;
}

function tick(ms: number): void {
  for (let t = 0; t < ms; t += 250) {
    vi.advanceTimersByTime(250);
    bus.flush();
  }
}

/** Everyone in the room, settled, with the roster quiet enough to freeze. */
function room(): [Peer, Peer, Peer] {
  const a = seat('a');
  const b = seat('b');
  const c = seat('c');
  bus.flush();
  tick(5000); // outlast ROSTER_SETTLE_MS
  return [a, b, c];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  bus = new Bus();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a straggler cannot hold the room', () => {
  it('quorum starts a countdown that is VISIBLE while it runs', () => {
    const [a, b] = room();

    expect(a.rounds.state().startsInMs, 'no countdown before quorum').toBeNull();

    a.rounds.vote();
    b.rounds.vote(); // c stays silent
    bus.flush();

    const first = a.rounds.state().startsInMs;
    expect(
      first,
      'the host is waiting on a straggler and telling nobody — a silent wait is ' +
        'indistinguishable from a hang',
    ).not.toBeNull();
    expect(first!).toBeGreaterThan(0);
    expect(first!).toBeLessThanOrEqual(GRACE_MS);

    tick(2000);
    const later = a.rounds.state().startsInMs;
    expect(later, 'the countdown is not counting down').toBeLessThan(first!);
    expect(later!).toBeGreaterThan(0);
  });

  it('the round starts WITHOUT the straggler when the countdown expires', () => {
    const [a, b, c] = room();

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    expect(a.got, 'it must not start before the grace period is spent').toHaveLength(0);

    tick(GRACE_MS + 2000);

    expect(a.got, 'the room deadlocked on a peer that never tapped').toHaveLength(1);
    expect(b.got).toHaveLength(1);
    expect(
      a.got[0].players.map((p) => p.id),
      'only the peers who actually readied up are seated',
    ).toEqual(['a', 'b']);

    // The straggler is not ejected — it learns the round began and is told, in
    // the state it can render, that it is not in this one.
    expect(c.got, 'the straggler must still receive the start so it can spectate').toHaveLength(1);
    expect(c.got[0].seated, 'it did not vote, so it is not seated').toBe(false);
    expect(c.rounds.state().phase).toBe('playing');
    expect(c.rounds.state().seated).toBe(false);

    expect(a.rounds.state().startsInMs, 'the countdown must be cleared once it fires').toBeNull();
  });

  it('the spectator can queue for the NEXT round rather than being stuck forever', () => {
    const [a, b, c] = room();
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(GRACE_MS + 2000);
    expect(c.got[0].seated).toBe(false);

    // An unseated peer's ready button must work mid-round, or it is excluded from
    // every subsequent round for the life of the room.
    c.rounds.vote();
    bus.flush();
    expect(c.rounds.state().voted).toBe(true);

    a.rounds.finish();
    b.rounds.finish();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(GRACE_MS + 2000);

    expect(a.got).toHaveLength(2);
    expect(
      a.got[1].players.map((p) => p.id),
      'the spectator readied up and must be in the next round',
    ).toEqual(['a', 'b', 'c']);
    expect(c.got[1].seated).toBe(true);
  });
});

describe('unanimity is not made to wait', () => {
  it('everyone voting starts the round immediately, with no countdown', () => {
    const [a, b, c] = room();

    a.rounds.vote();
    b.rounds.vote();
    c.rounds.vote();
    bus.flush();

    expect(a.got, 'everyone was ready and the room still made them wait').toHaveLength(1);
    expect(a.rounds.state().startsInMs, 'no countdown should ever have been armed').toBeNull();
    expect(a.got[0].players).toHaveLength(3);
  });
});

describe('losing quorum cancels the countdown', () => {
  it('a peer backing out stops the clock, and no round starts', () => {
    const [a, b] = room();

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    expect(a.rounds.state().startsInMs).not.toBeNull();

    tick(2000);
    b.rounds.unvote(); // changed their mind
    bus.flush();
    tick(500);

    expect(
      a.rounds.state().startsInMs,
      'a countdown still running toward a start that cannot legally happen',
    ).toBeNull();

    tick(GRACE_MS + 2000);
    expect(a.got, 'a round started below the minimum player count').toHaveLength(0);
    expect(a.rounds.state().votes.map((v) => v.id)).toEqual(['a']);
  });

  it('re-reaching quorum arms a FRESH countdown, not a resumed one', () => {
    const [a, b] = room();

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(4000);
    b.rounds.unvote();
    bus.flush();
    tick(500);
    expect(a.rounds.state().startsInMs).toBeNull();

    b.rounds.vote();
    bus.flush();

    const restarted = a.rounds.state().startsInMs;
    expect(restarted, 'quorum was re-reached and nothing was armed').not.toBeNull();
    expect(
      restarted!,
      'the countdown resumed mid-flight — the peer who just readied up gets less ' +
        'than the full grace period the UI promised them',
    ).toBeGreaterThan(GRACE_MS - 1000);
  });
});
