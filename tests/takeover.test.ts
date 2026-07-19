/**
 * takeover.test.ts — the host leaving must not freeze or end the game.
 * (Live-P2P contract gate #2 — the automated half; the manual half is the
 * two-tab smoke test where the host tab is closed outright.)
 *
 * Turntide's peers run in LOCKSTEP, so a host transfer is state-wise a no-op:
 * both peers already hold a byte-identical position, because both replayed the
 * same move list through the same pure rules. That makes this test sharper than
 * it would be for a snapshot star — there is exactly ONE authoritative thing to
 * take over, the turn clock, so this file is about proving the clock survives
 * promotion and that a promoted peer can still drive the round to a finish.
 *
 * The value being guarded is specific: BEFORE promotion a client must not act on
 * clock expiry (or the same seat gets played twice, by both peers), and AFTER
 * promotion it must, or the room hangs forever on an absent player. Those two
 * are the same line of code with opposite signs, which is exactly the kind of
 * thing that is easy to get backwards and impossible to notice by playing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODES } from '../src/modes';
import { Game, type PlayerInfo } from '../src/game';
import { AMBER, TEAL, legalMoves, type Side } from '../src/turntide';
import { DEFAULT_TURN_MS, TICK_MS, createSession, fallbackMove, type SessionNet } from '../src/session';

/** A net that records what was sent and can inject inbound messages. */
function fakeNet(selfId = 'peer-a'): SessionNet & {
  sent: Array<{ chan: string; data: unknown }>;
  deliver: (chan: string, data: unknown, from?: string) => void;
} {
  const handlers = new Map<string, Array<(d: unknown, from: string) => void>>();
  const sent: Array<{ chan: string; data: unknown }> = [];
  return {
    selfId,
    sent,
    channel<T>(name: string, onReceive: (data: T, from: string) => void) {
      const list = handlers.get(name) ?? [];
      list.push(onReceive as (d: unknown, f: string) => void);
      handlers.set(name, list);
      const send = ((data: T) => {
        sent.push({ chan: name, data });
      }) as ((data: T, to?: string | string[]) => void) & { off: () => void };
      send.off = () => {
        handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== onReceive));
      };
      return send;
    },
    deliver(chan, data, from = 'peer-b') {
      for (const h of handlers.get(chan) ?? []) h(data, from);
    },
  };
}

function players(localSide: Side): PlayerInfo[] {
  return [
    { id: 'peer-a', name: 'A', side: localSide, local: true, bot: false },
    { id: 'peer-b', name: 'B', side: localSide === TEAL ? AMBER : TEAL, local: false, bot: false },
  ];
}

const mode = MODES.skirmish;

function newGame(localSide: Side = TEAL): Game {
  return new Game({ mode, players: players(localSide) });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('before promotion, a client is NOT authoritative', () => {
  it('does not play a move when the clock runs out', () => {
    const game = newGame();
    const net = fakeNet();
    const session = createSession({ game, round: 1, net, isHost: false, turnMs: 2000 });

    // Run well past expiry.
    vi.advanceTimersByTime(6000);

    expect(game.history.length).toBe(0);
    expect(net.sent.filter((s) => s.chan === 'mv').length).toBe(0);
    // A client also never broadcasts the clock — two tickers would fight.
    expect(net.sent.filter((s) => s.chan === 'clk').length).toBe(0);
    session.destroy();
  });

  it('adopts the clock value the host broadcasts rather than its own', () => {
    const game = newGame();
    const net = fakeNet();
    const session = createSession({ game, round: 1, net, isHost: false, turnMs: DEFAULT_TURN_MS });

    vi.advanceTimersByTime(TICK_MS * 4);
    net.deliver('clk', { r: 1, i: 0, ms: 12_345 });
    expect(session.clock().leftMs).toBe(12_345);
    session.destroy();
  });
});

describe('after promotion, the survivor drives the round', () => {
  it('takes over the clock and plays for an absent seat instead of hanging', () => {
    // Amber is local; TEAL (the departed host's seat) is to move and will never
    // move again. Without takeover this room hangs forever.
    const game = newGame(AMBER);
    const net = fakeNet();
    const session = createSession({ game, round: 1, net, isHost: false, turnMs: 2000 });

    vi.advanceTimersByTime(3000);
    expect(game.history.length).toBe(0); // still a client — correctly inert

    session.setHost(true);
    expect(session.isHost()).toBe(true);

    vi.advanceTimersByTime(3000);

    // It moved the game on, and told the room.
    expect(game.history.length).toBeGreaterThan(0);
    expect(net.sent.filter((s) => s.chan === 'mv').length).toBeGreaterThan(0);
    session.destroy();
  });

  it('promotion preserves the clock reading rather than resetting it', () => {
    // Both peers already held the same value, so promotion changes WHO ticks it,
    // not what it says. Resetting here would silently gift the absent player a
    // fresh turn every time a host left.
    const game = newGame();
    const net = fakeNet();
    const session = createSession({ game, round: 1, net, isHost: false, turnMs: 10_000 });

    net.deliver('clk', { r: 1, i: 0, ms: 4000 });
    const before = session.clock().leftMs;
    session.setHost(true);
    expect(session.clock().leftMs).toBe(before);
    session.destroy();
  });

  it('a promoted host can drive the round all the way to game over', () => {
    // The gate that matters: not just "it moved once", but "it can still END".
    // Both seats are absent, so the promoted peer must play every remaining move
    // off the clock until the position resolves.
    const game = newGame(AMBER);
    const net = fakeNet();
    const session = createSession({ game, round: 1, net, isHost: true, turnMs: 1000 });

    // Bounded: the mode's own turn cap is the guarantee that this terminates.
    for (let i = 0; i < mode.turnCap + 5 && !game.over(); i++) {
      vi.advanceTimersByTime(1500);
    }

    expect(game.over()).toBe(true);
    const summary = game.summary();
    expect(summary.over).toBe(true);
    // Everyone's result, every time (principle #9) — including in a round that
    // finished with nobody present to play it.
    expect(summary.players).toHaveLength(2);
    expect(summary.players.map((p) => p.side).sort()).toEqual([TEAL, AMBER].sort());
    session.destroy();
  });
});

describe('a peer leaving lands the survivor on the summary, never a frozen board', () => {
  it('forfeits to the survivor and reports the round finished', () => {
    const game = newGame(TEAL);
    const net = fakeNet();
    const ended = vi.fn();
    const session = createSession({ game, round: 1, net, isHost: true, turnMs: 0, onEnd: ended });

    expect(game.over()).toBe(false);
    session.peerLeft('peer-b');

    expect(game.over()).toBe(true);
    const s = game.summary();
    expect(s.reason).toBe('left');
    expect(s.winner).toBe(TEAL); // the one still here
    expect(s.players).toHaveLength(2);
    expect(ended).toHaveBeenCalled();
    session.destroy();
  });
});

describe('the fallback move is deterministic', () => {
  it('two peers computing it independently pick the SAME move', () => {
    // It is broadcast, so in principle only the host's choice matters — but a
    // tie broken by array order or Math.random would be a desync waiting for the
    // first dropped packet, and it costs nothing to make it total.
    const game = newGame();
    const moves = legalMoves(game.pos, mode);
    const a = fallbackMove(moves);
    const b = fallbackMove([...moves].reverse());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect({ from: a!.from, path: a!.path }).toEqual({ from: b!.from, path: b!.path });
  });

  it('prefers the longest chain available', () => {
    const game = newGame();
    const moves = legalMoves(game.pos, mode);
    const best = Math.max(...moves.map((m) => m.flips.length));
    expect(fallbackMove(moves)!.flips.length).toBe(best);
  });

  it('returns null when there is nothing to play', () => {
    expect(fallbackMove([])).toBeNull();
  });
});
