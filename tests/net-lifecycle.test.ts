/**
 * net-lifecycle.test.ts — live-P2P contract gate #3, and the most valuable
 * trivial test in the suite.
 *
 * ONE ROOM PER SESSION. The obvious way to write "Play again" is to leave the
 * room and rejoin it, and it is a trap with no visible failure. Trystero memoizes
 * joinRoom on appId+roomId while room.leave() defers its real teardown behind a
 * ~99ms timer, so a same-tick rejoin hands back the room that is about to be
 * destroyed. Moments later the deferred teardown unsubscribes from every relay
 * and clears the announce loop, and the "fresh" Net is a corpse: permanently
 * deaf, roster of one. Both players then sit in the correct room code, alone,
 * each believing they are the host.
 *
 * It is deterministic, it is permanent, and on screen it looks exactly like a
 * flaky relay — which is why it survived so long. The engine now makes the trap
 * throw at the call site, and this file asserts that it does, plus the invariant
 * the whole design rests on: a whole session, however many rounds, performs
 * exactly ONE join.
 *
 * The triviality is the point. Nothing here needs a network, and that is why it
 * can run on every commit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── trystero stub ───────────────────────────────────────────────────────────
// Mirrors the two behaviours net.ts actually depends on: joinRoom memoized per
// appId+roomId, and room.leave() resolving asynchronously. No transport at all.

const joinRoom = vi.fn();
let openRooms = 0;

vi.mock('trystero', () => {
  interface FakeRoom {
    makeAction: (name: string) => [ReturnType<typeof vi.fn>, (cb: unknown) => void];
    onPeerJoin: (cb: unknown) => void;
    onPeerLeave: (cb: unknown) => void;
    getPeers: () => Record<string, unknown>;
    leave: () => Promise<void>;
  }
  const make = (): FakeRoom => {
    openRooms++;
    return {
      makeAction: () => [vi.fn(), () => {}],
      onPeerJoin: () => {},
      onPeerLeave: () => {},
      getPeers: () => ({}),
      // Async, like the real one — this is what creates the window in which a
      // rejoin aliases a dying room.
      leave: () => new Promise<void>((res) => setTimeout(res, 0)),
    };
  };
  return {
    joinRoom: (...args: unknown[]) => {
      joinRoom(...args);
      return make();
    },
    selfId: 'self-peer',
  };
});

vi.mock('trystero/nostr', () => ({ getRelaySockets: () => ({}) }));

import { createNet, netStats, resetNetStats } from '@ben-gy/game-engine/net';

const CFG = { appId: 'turntide@2', roomId: 'K7QM' };

describe('one join per session', () => {
  beforeEach(() => {
    resetNetStats();
    joinRoom.mockClear();
    openRooms = 0;
  });

  it('a whole multi-round session joins exactly once', async () => {
    const net = createNet(CFG);

    // Everything a session does inside the living room: channels for the game
    // protocol, roster subscriptions for the lobby, rounds coming and going.
    net.channel('mv', () => {});
    net.channel('rs', () => {});
    net.onPeersChange(() => {});
    net.channel('mv', () => {}); // a second round attaches a second receiver
    net.onPeersChange(() => {});

    expect(
      netStats().joins,
      'a rematch must version rounds INSIDE the room, never rejoin it',
    ).toBe(1);
    expect(joinRoom).toHaveBeenCalledTimes(1);

    await net.leave();
    expect(netStats().active, 'the registry must be empty after a completed leave').toEqual([]);
  });

  it('leaving and coming back later is one join each, not a leak', async () => {
    const a = createNet(CFG);
    await a.leave();
    const b = createNet(CFG); // legitimate: the previous leave has RESOLVED
    expect(netStats().joins).toBe(2);
    await b.leave();
  });
});

describe('the leave/rejoin trap fails loudly', () => {
  beforeEach(() => {
    resetNetStats();
    joinRoom.mockClear();
  });

  it('throws when the same room is rejoined while still tearing down', async () => {
    const net = createNet(CFG);

    // Deliberately NOT awaited — this is the exact same-tick rejoin the trap
    // needs. The registry is marked 'leaving' synchronously inside leave().
    const pending = net.leave();

    expect(() => createNet(CFG)).toThrow(/tearing down/i);

    await pending;
    // …and once the teardown really has completed, the same room is fine again.
    const again = createNet(CFG);
    expect(netStats().joins).toBe(2);
    await again.leave();
  });

  it('throws when the same room is joined twice concurrently', async () => {
    const net = createNet(CFG);
    expect(() => createNet(CFG)).toThrow(/already joined/i);
    expect(netStats().joins, 'the failed second join must not be counted').toBe(1);
    await net.leave();
  });

  it('a DIFFERENT room on the same page is not blocked', async () => {
    const a = createNet(CFG);
    const b = createNet({ ...CFG, roomId: 'ZZ99' });
    expect(netStats().joins).toBe(2);
    expect(netStats().active).toHaveLength(2);
    await Promise.all([a.leave(), b.leave()]);
    expect(netStats().active).toEqual([]);
  });
});

describe('a net that was never left still holds its slot', () => {
  afterEach(() => resetNetStats());

  it('reports itself as active so a stray second createNet is caught', () => {
    resetNetStats();
    createNet(CFG);
    expect(netStats().active).toEqual(['turntide@2/K7QM']);
  });
});
