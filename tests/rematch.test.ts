/**
 * rematch.test.ts — live-P2P contract gate #3, the protocol half.
 *
 * "Play again" is where multiplayer games go to die. The obvious implementation
 * (leave the room, rejoin it) is a trap that net-lifecycle.test.ts nails shut; the
 * correct one — keep one living room and version the rounds inside it — has its
 * own failure modes, and they are the ones this file pins:
 *
 *  - TWO ROUNDS STARTING. Both peers tap at the same instant and each fires a
 *    start. In a lockstep game that is not a cosmetic bug: the two peers are
 *    running different boards from move one.
 *  - DISAGREEING ABOUT WHO IS WHO. If each peer derives the roster locally,
 *    player 0 on one screen is player 1 on the other, and the results screen
 *    confidently puts the winner's score under the loser's name.
 *  - DISAGREEING ABOUT THE MODE. Turntide's modes change the BOARD SIZE. Two
 *    peers reading their own local mode picker are playing 8x8 against 10x10 with
 *    no error anywhere.
 *  - DEADLOCKING ON SOMEONE WHO LEFT. A vote from a peer who then closed their
 *    tab must not hold the room open forever.
 *
 * The bus is an in-memory stand-in for the mesh (tests/helpers/bus.ts): this file
 * tests DECISIONS, not transport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo, type Rounds } from '@ben-gy/game-engine/rematch';
import { Bus } from './helpers/bus';

/** Turntide's round settings — the thing that must travel frozen. */
interface Opts {
  mode: string;
}

interface Peer {
  id: string;
  rounds: Rounds;
  got: RoundInfo[];
  opts: Opts;
}

let bus: Bus;

function seat(id: string, mode: string): Peer {
  const net = bus.join(id);
  const peer: Peer = { id, rounds: null as unknown as Rounds, got: [], opts: { mode } };
  peer.rounds = createRounds({
    net,
    playerName: id.toUpperCase(),
    minPlayers: 2,
    roundOpts: () => peer.opts,
    onRound: (info) => peer.got.push(info),
  });
  return peer;
}

/** Advance the clock in small steps, draining the bus after each. */
function tick(ms: number): void {
  for (let t = 0; t < ms; t += 250) {
    vi.advanceTimersByTime(250);
    bus.flush();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  // go() draws its seed from Math.random. Pinning it is what makes "both peers
  // got the SAME seed" a real assertion rather than a coincidence of one draw.
  vi.spyOn(Math, 'random').mockReturnValue(0.4242424242);
  bus = new Bus();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('both peers vote, exactly one round starts', () => {
  it('same round number, same seed, same frozen roster, one host', () => {
    const a = seat('a', 'floodmark'); // host: 10x10
    const b = seat('b', 'tidepool'); // guest: 8x8, and it must NOT win
    bus.flush();
    tick(5000); // outlast ROSTER_SETTLE_MS so a start may freeze the roster

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(2000);

    expect(a.got, 'the host started no round, or started several').toHaveLength(1);
    expect(b.got, 'the guest missed the start, or got it twice').toHaveLength(1);

    const [ra, rb] = [a.got[0], b.got[0]];
    expect(ra.round).toBe(1);
    expect(rb.round).toBe(1);
    expect(rb.seed, 'a lockstep game with two seeds is two different games').toBe(ra.seed);
    expect(rb.players, 'the roster must be the host\'s frozen bytes, not a local re-derivation')
      .toEqual(ra.players);
    expect(ra.players.map((p) => p.id)).toEqual(['a', 'b']);
    expect([ra.isHost, rb.isHost], 'exactly one host for the round').toEqual([true, false]);
    expect([ra.seated, rb.seated], 'both voters must be seated').toEqual([true, true]);
  });

  it("the HOST's mode travels frozen, and the guest's local pick is ignored", () => {
    const a = seat('a', 'floodmark');
    const b = seat('b', 'tidepool');
    bus.flush();
    tick(5000);

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(2000);

    expect(a.got[0].opts).toEqual({ mode: 'floodmark' });
    expect(
      b.got[0].opts,
      'the guest played its own mode — on a different board size to the host',
    ).toEqual({ mode: 'floodmark' });
    expect(b.got[0].opts).toEqual(a.got[0].opts);
  });

  it('the guest can see what the host has chosen before the round starts', () => {
    const a = seat('a', 'floodmark');
    const b = seat('b', 'tidepool');
    bus.flush();
    tick(2000);

    expect(
      b.rounds.state().hostOpts,
      'a lobby that renders its OWN setting as the host\'s is telling a confident lie',
    ).toEqual({ mode: 'floodmark' });
    expect(a.rounds.state().hostOpts).toEqual({ mode: 'floodmark' });
  });
});

describe('rounds are monotonic', () => {
  function playRound(a: Peer, b: Peer): void {
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(2000);
  }

  it('a duplicate start for the round already playing is a no-op', () => {
    const a = seat('a', 'skirmish');
    const b = seat('b', 'skirmish');
    bus.flush();
    tick(5000);
    playRound(a, b);
    expect(b.got).toHaveLength(1);

    // The host re-broadcasts to late connectors and retries unacked starts, so
    // duplicates are ROUTINE. They must be free.
    bus.inject('a', 'rs', { round: 1, seed: 999, roster: [{ id: 'a', name: 'A' }], opts: {} }, 'b');
    bus.flush();

    expect(b.got, 'a duplicate start restarted a live game').toHaveLength(1);
    expect(b.got[0].seed).not.toBe(999);
  });

  it('a stale start from an earlier round cannot rewind a peer', () => {
    const a = seat('a', 'skirmish');
    const b = seat('b', 'skirmish');
    bus.flush();
    tick(5000);
    playRound(a, b);

    a.rounds.finish();
    b.rounds.finish();
    tick(5000);
    playRound(a, b);
    expect(b.got.map((r) => r.round)).toEqual([1, 2]);

    // A round-1 start arriving late — the classic replay off a slow relay.
    bus.inject('a', 'rs', { round: 1, seed: 7, roster: [], opts: {} }, 'b');
    bus.flush();

    expect(b.got.map((r) => r.round), 'a late round-1 start rewound the session').toEqual([1, 2]);
    expect(b.rounds.state().round).toBe(2);
  });

  it('two peers pressing at the same instant still start one round', () => {
    const a = seat('a', 'skirmish');
    const b = seat('b', 'skirmish');
    bus.flush();
    tick(5000);

    // Both vote before ANY message is delivered — the true simultaneous case.
    a.rounds.vote();
    b.rounds.vote();
    b.rounds.go(); // a guest's go() must be inert; only the host may start
    a.rounds.go();
    bus.flush();
    tick(2000);

    expect(a.got).toHaveLength(1);
    expect(b.got).toHaveLength(1);
    expect(b.got[0].round).toBe(1);
  });
});

describe('a peer who leaves is dropped, not waited for', () => {
  it('the frozen roster excludes them and the round starts anyway', () => {
    const a = seat('a', 'skirmish');
    const b = seat('b', 'skirmish');
    const c = seat('c', 'skirmish');
    bus.flush();
    tick(5000);

    c.rounds.vote(); // readied up…
    bus.flush();
    bus.leave('c'); // …then closed the tab
    bus.flush();

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(6000);

    expect(a.got, 'the room deadlocked on a peer that is not there').toHaveLength(1);
    expect(
      a.got[0].players.map((p) => p.id),
      'a departed voter must not be seated in the round',
    ).toEqual(['a', 'b']);
    expect(b.got[0].players).toEqual(a.got[0].players);
  });
});

describe('a promoted host can still run the rematch', () => {
  it('the survivor starts round 2 with the right number and its own opts', () => {
    const a = seat('a', 'skirmish');
    const b = seat('b', 'floodmark');
    const c = seat('c', 'skirmish');
    bus.flush();
    tick(5000);

    a.rounds.vote();
    b.rounds.vote();
    c.rounds.vote();
    bus.flush();
    tick(2000);
    expect(a.got).toHaveLength(1);

    a.rounds.finish();
    b.rounds.finish();
    c.rounds.finish();

    // The host's tab closes. net.ts's election would promote min-id among the
    // survivors; the bus stands in for that decision.
    a.rounds.destroy();
    bus.leave('a');
    bus.setHost('b');
    bus.flush();
    tick(5000);

    b.rounds.vote();
    c.rounds.vote();
    bus.flush();
    tick(6000);

    expect(b.got.map((r) => r.round), 'the promoted host could not start a rematch').toEqual([
      1, 2,
    ]);
    expect(c.got.map((r) => r.round)).toEqual([1, 2]);
    expect(c.got[1].seed).toBe(b.got[1].seed);
    expect(c.got[1].players.map((p) => p.id)).toEqual(['b', 'c']);
    expect(
      c.got[1].opts,
      'after promotion the NEW host owns the mode — it must travel like the old one did',
    ).toEqual({ mode: 'floodmark' });
    expect([b.got[1].isHost, c.got[1].isHost]).toEqual([true, false]);
  });
});
