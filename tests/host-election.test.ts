/**
 * host-election.test.ts — live-P2P contract gate #4.
 *
 * Turntide's netcode is lockstep, so it needs a host for exactly one thing:
 * deciding who plays the next round and freezing its settings. That makes host
 * election look unimportant right up to the moment it goes wrong, at which point
 * the room has two hosts, or none, and neither state is visible to a player — the
 * lobby just never starts.
 *
 * The engine's model is INCUMBENCY WITH TERMS, not a re-election on every join:
 *
 *   1. Announcements carry `{host, epoch}`. Higher epoch always wins; equal epoch
 *      falls back to min-id, which every peer computes identically.
 *   2. A peer NEVER self-elects on an empty roster. Zero peers is not evidence
 *      that the room is empty, only that our mesh has not formed. Such a peer is
 *      UNSETTLED: isHost() false and hostSettled() false.
 *   3. A host leaving is the only legitimate transfer: survivors elect min-id at
 *      epoch + 1, all computing the same answer from the same rule.
 *
 * Two things make this test file worth trusting where a naive one would not:
 *
 *  - Peer ids are FIXED — 'a', 'm', 'z'. An election test with random ids passes
 *    half the time by luck and proves nothing about the case it was written for.
 *  - Each simulated peer gets its OWN module instance (vi.resetModules +
 *    vi.doMock + dynamic import), because trystero's `selfId` and the engine's
 *    join registry are PAGE-level globals. Share one import between two "peers"
 *    and they silently have the same identity, so every assertion about who wins
 *    an election is an assertion about a single peer talking to itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Net } from '@ben-gy/game-engine/net';

// ── an in-memory mesh ───────────────────────────────────────────────────────
// Nodes are connected EXPLICITLY, so "two peers who cannot see each other" is a
// state this harness can actually represent — which is the whole point of rule 2.
// Messages queue and are drained by flush(), so delivery is deterministic and no
// handler can re-enter itself mid-dispatch.

interface Msg {
  from: string;
  to?: string | string[];
  name: string;
  data: unknown;
}

class Node {
  peers = new Set<string>();
  actions = new Map<string, (data: unknown, from: string) => void>();
  onJoin: Array<(id: string) => void> = [];
  onLeave: Array<(id: string) => void> = [];
  constructor(readonly id: string) {}
}

class Mesh {
  nodes = new Map<string, Node>();
  queue: Msg[] = [];

  node(id: string): Node {
    let n = this.nodes.get(id);
    if (!n) {
      n = new Node(id);
      this.nodes.set(id, n);
    }
    return n;
  }

  /** The trystero `room` shape net.ts consumes. */
  room(id: string): unknown {
    const node = this.node(id);
    return {
      makeAction: (name: string) => [
        (data: unknown, to?: string | string[]) => {
          this.queue.push({ from: id, to, name, data });
        },
        (cb: (data: unknown, from: string) => void) => node.actions.set(name, cb),
      ],
      onPeerJoin: (cb: (p: string) => void) => node.onJoin.push(cb),
      onPeerLeave: (cb: (p: string) => void) => node.onLeave.push(cb),
      getPeers: () => Object.fromEntries([...node.peers].map((p) => [p, {}])),
      leave: () => Promise.resolve(),
    };
  }

  connect(a: string, b: string): void {
    this.node(a).peers.add(b);
    this.node(b).peers.add(a);
    for (const cb of this.node(a).onJoin) cb(b);
    for (const cb of this.node(b).onJoin) cb(a);
  }

  /** Drop the link in BOTH directions — a peer closing its tab. */
  disconnect(a: string, b: string): void {
    this.node(a).peers.delete(b);
    this.node(b).peers.delete(a);
    for (const cb of this.node(a).onLeave) cb(b);
    for (const cb of this.node(b).onLeave) cb(a);
  }

  /** Everyone else sees `id` go. */
  drop(id: string): void {
    for (const other of [...this.node(id).peers]) this.disconnect(id, other);
  }

  flush(): void {
    for (let guard = 0; this.queue.length && guard < 500; guard++) {
      const m = this.queue.shift()!;
      const targets =
        m.to === undefined ? [...this.node(m.from).peers] : Array.isArray(m.to) ? m.to : [m.to];
      for (const t of targets) {
        const node = this.nodes.get(t);
        if (!node || !node.peers.has(m.from)) continue; // no link = no delivery
        node.actions.get(m.name)?.(JSON.parse(JSON.stringify(m.data)), m.from);
      }
    }
    expect(this.queue.length, 'message storm — the protocol did not converge').toBe(0);
  }
}

let mesh: Mesh;

/**
 * Give this peer its own copy of net.ts, with its own `selfId` and its own join
 * registry. Sharing a module here is the mistake that makes an election test
 * meaningless.
 */
async function spawn(id: string, claimHost = false): Promise<Net> {
  vi.resetModules();
  vi.doMock('trystero', () => ({ joinRoom: () => mesh.room(id), selfId: id }));
  vi.doMock('trystero/nostr', () => ({ getRelaySockets: () => ({}) }));
  const { createNet } = await import('@ben-gy/game-engine/net');
  return createNet({ appId: 'turntide@2', roomId: 'ROOM', claimHost });
}

/** Advance the clock, delivering whatever each tick produced. */
function tick(ms: number): void {
  for (let t = 0; t < ms; t += 250) {
    vi.advanceTimersByTime(250);
    mesh.flush();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  mesh = new Mesh();
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('trystero');
  vi.doUnmock('trystero/nostr');
});

// ─────────────────────────────────────────────────────────────────────────────

describe('(a) an incumbent keeps its room', () => {
  it('a joiner with a LOWER id does not take a live room', async () => {
    // 'z' minted the code, so it hosts from the first instant at term 1.
    const z = await spawn('z', true);
    // 'a' arrives via the link. Under the RETIRED min-id-on-every-join rule this
    // is exactly the peer that stole the room: lower id, holding no game state.
    const a = await spawn('a');

    mesh.connect('z', 'a');
    mesh.flush();

    expect(z.isHost(), 'the incumbent must keep hosting').toBe(true);
    expect(a.isHost(), 'a lower id is not a claim to a room someone is already hosting').toBe(
      false,
    );
    expect(a.host()).toBe('z');
    expect(a.hostSettled()).toBe(true);
    expect(a.hostEpoch()).toBe(z.hostEpoch());

    // And it holds — the announce loop must not flip anything on later terms.
    tick(15000);
    expect(z.isHost()).toBe(true);
    expect(a.host()).toBe('z');
    expect(a.isHost()).toBe(false);
  });
});

describe('(b) silence is not a mandate', () => {
  it('a peer that has heard nothing is not host, and knows it has not settled', async () => {
    const a = await spawn('a');

    tick(20000); // far past SETTLE_MS

    expect(a.hostSettled(), 'an empty roster is evidence of no mesh, not of an empty room').toBe(
      false,
    );
    expect(a.isHost()).toBe(false);
    expect(a.host()).toBeNull();
  });

  it('two peers who cannot see each other are BOTH non-host', async () => {
    // The phantom-host bug in one picture: both peers hold the right room code,
    // neither mesh has formed, and the old rule had each of them self-elect. Then
    // when the mesh healed, min-id handed a live game to whichever had the lower
    // id — mid-round, holding no state.
    const a = await spawn('a');
    const z = await spawn('z');

    tick(20000);

    expect(a.isHost()).toBe(false);
    expect(z.isHost()).toBe(false);
    expect(a.hostSettled()).toBe(false);
    expect(z.hostSettled()).toBe(false);
  });

  it('but a room with peers present and nobody claiming elects at the LOWEST term', async () => {
    // Rule 4: peers present plus total silence past the window is a genuinely
    // hostless room. It mints term 1 so it can never outrank a real incumbent.
    const a = await spawn('a');
    const z = await spawn('z');
    mesh.connect('a', 'z');
    mesh.flush();

    tick(20000);

    expect(a.isHost()).toBe(true);
    expect(z.isHost()).toBe(false);
    expect(z.host()).toBe('a');
    expect(a.hostEpoch()).toBe(1);
  });
});

describe('(c) a host leaving promotes exactly one survivor', () => {
  it('every survivor agrees who took over, at a higher term', async () => {
    const a = await spawn('a', true); // host
    const m = await spawn('m');
    const z = await spawn('z');
    mesh.connect('a', 'm');
    mesh.connect('a', 'z');
    mesh.connect('m', 'z');
    mesh.flush();
    tick(1000);

    expect([a.isHost(), m.isHost(), z.isHost()]).toEqual([true, false, false]);
    const before = a.hostEpoch();

    mesh.drop('a'); // tab closed
    mesh.flush();
    tick(1000);

    const hosts = [m.host(), z.host()];
    expect(new Set(hosts).size, `survivors disagree: ${hosts.join(' vs ')}`).toBe(1);
    expect(hosts[0], 'min-id among the survivors').toBe('m');
    expect([m.isHost(), z.isHost()], 'exactly one host, and it is the elected one').toEqual([
      true,
      false,
    ]);
    expect(m.hostEpoch(), 'a transfer must mint a strictly higher term').toBe(before + 1);
    expect(z.hostEpoch()).toBe(before + 1);
    expect(z.hostSettled()).toBe(true);
  });
});

describe('(d) a non-host leaving changes nothing', () => {
  it('the incumbent keeps the room at the same term', async () => {
    const a = await spawn('a', true);
    const m = await spawn('m');
    const z = await spawn('z');
    mesh.connect('a', 'm');
    mesh.connect('a', 'z');
    mesh.connect('m', 'z');
    mesh.flush();
    tick(1000);

    const epoch = a.hostEpoch();

    mesh.drop('z'); // a guest wanders off
    mesh.flush();
    tick(3000);

    expect(a.isHost(), 'the host did not leave, so nothing should have moved').toBe(true);
    expect(m.host()).toBe('a');
    expect(m.isHost()).toBe(false);
    expect(a.hostEpoch(), 'no term change without a transfer').toBe(epoch);
    expect(m.hostEpoch()).toBe(epoch);
  });
});

describe('(e) two genuine claims converge', () => {
  it('both peers created the room in the same instant; min-id breaks the tie', async () => {
    // Two "Create a room" taps on the same code, or a healed partition. Both are
    // sincerely hosting at term 1, and neither can rank the other's claim by
    // incumbency — so the rule that decides it must be one both compute alike.
    const a = await spawn('a', true);
    const z = await spawn('z', true);

    expect(a.isHost()).toBe(true);
    expect(z.isHost()).toBe(true); // …until they meet

    mesh.connect('a', 'z');
    mesh.flush();
    tick(6000);

    expect(a.host(), 'both must land on the same peer').toBe(z.host());
    expect(a.host()).toBe('a');
    expect([a.isHost(), z.isHost()], 'exactly one host after convergence').toEqual([true, false]);
    expect(a.hostEpoch()).toBe(z.hostEpoch());
  });

  it('a stale claimant capitulates instead of splitting the room', async () => {
    // A peer that self-elected during a partition returns at a LOWER term. The
    // incumbent corrects it immediately rather than letting it announce at
    // everyone for a full interval.
    const a = await spawn('a', true);
    const z = await spawn('z', true);
    mesh.connect('a', 'z');
    mesh.flush();
    tick(3000);

    // The incumbent takes a fresh term (as `takeover()` does), so 'z' is stale.
    a.takeover();
    mesh.flush();
    tick(3000);

    expect(a.isHost()).toBe(true);
    expect(z.isHost()).toBe(false);
    expect(z.host()).toBe('a');
    expect(z.hostEpoch()).toBe(a.hostEpoch());
  });
});
