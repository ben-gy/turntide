/**
 * bus.ts — an in-memory stand-in for the P2P mesh, for PROTOCOL tests only.
 *
 * It models the three things rematch.ts and the lobby actually depend on: a
 * roster, an elected host, and named channels that deliver to peers who are still
 * in the room. It deliberately does NOT model transport — no relays, no ICE, no
 * flakiness — because the decisions being tested (who starts a round, with which
 * roster, at which number) must be correct before transport is even interesting.
 *
 * Delivery is QUEUED and drained by `flush()`, never synchronous. Real trystero
 * sends are async, and a synchronous bus quietly changes the interleaving — a
 * start would be received and acked before the sender had even recorded that it
 * sent one, which is an ordering that can never happen in production and would
 * make the test lie in both directions.
 */

import type { Net, PeerId, Unsubscribe } from '@ben-gy/game-engine/net';

interface Envelope {
  from: PeerId;
  to?: PeerId | PeerId[];
  name: string;
  data: unknown;
}

class Member {
  channels = new Map<string, Set<(data: unknown, from: PeerId) => void>>();
  peerSubs = new Set<(peers: PeerId[]) => void>();
  constructor(readonly id: PeerId) {}
}

export class Bus {
  private members = new Map<PeerId, Member>();
  private queue: Envelope[] = [];
  private hostId: PeerId | null = null;

  /** Add a peer and hand back the Net-shaped fake it should be given. */
  join(id: PeerId): Net {
    this.members.set(id, new Member(id));
    if (this.hostId === null) this.hostId = id;
    this.notifyRoster();
    return this.netFor(id);
  }

  /** A peer closes its tab. Everyone else's roster changes. */
  leave(id: PeerId): void {
    this.members.delete(id);
    if (this.hostId === id) this.hostId = null;
    this.notifyRoster();
  }

  /** Promote a survivor — what net.ts's epoch election would have decided. */
  setHost(id: PeerId | null): void {
    this.hostId = id;
  }

  peers(): PeerId[] {
    return [...this.members.keys()].sort();
  }

  /** Inject a raw message as if `from` had sent it — for replay/stale cases. */
  inject(from: PeerId, name: string, data: unknown, to?: PeerId): void {
    this.queue.push({ from, to, name, data });
  }

  private notifyRoster(): void {
    const list = this.peers();
    for (const m of [...this.members.values()]) for (const cb of [...m.peerSubs]) cb(list);
  }

  /** Deliver everything queued, including anything the handlers queue in turn. */
  flush(): void {
    let guard = 0;
    while (this.queue.length) {
      if (++guard > 2000) throw new Error('bus: message storm — the protocol did not converge');
      const e = this.queue.shift()!;
      const targets =
        e.to === undefined
          ? this.peers().filter((p) => p !== e.from)
          : Array.isArray(e.to)
            ? e.to
            : [e.to];
      for (const t of targets) {
        if (t === e.from) continue;
        const m = this.members.get(t);
        if (!m) continue; // gone — a send to a departed peer is simply lost
        for (const h of [...(m.channels.get(e.name) ?? [])]) {
          h(structuredClone(e.data), e.from);
        }
      }
    }
  }

  private netFor(id: PeerId): Net {
    const bus = this;
    const me = (): Member => {
      const m = bus.members.get(id);
      if (!m) throw new Error(`bus: ${id} has left the room`);
      return m;
    };

    const net: Partial<Net> = {
      selfId: id,
      peers: () => bus.peers(),
      host: () => bus.hostId,
      isHost: () => bus.hostId === id,
      hostSettled: () => bus.hostId !== null,
      hostEpoch: () => 1,
      count: () => bus.peers().length,

      onPeersChange(cb: (peers: PeerId[]) => void): Unsubscribe {
        me().peerSubs.add(cb);
        return () => me().peerSubs.delete(cb);
      },

      channel<T>(name: string, onReceive: (data: T, from: PeerId) => void) {
        const set =
          me().channels.get(name) ?? new Set<(data: unknown, from: PeerId) => void>();
        me().channels.set(name, set);
        const h = onReceive as (data: unknown, from: PeerId) => void;
        set.add(h);
        const send = ((data: T, to?: PeerId | PeerId[]) => {
          if (!bus.members.has(id)) return; // a departed peer sends nothing
          bus.queue.push({ from: id, to, name, data });
        }) as ((data: T, to?: PeerId | PeerId[]) => void) & { off: Unsubscribe };
        send.off = () => set.delete(h);
        return send;
      },

      ping: () => Promise.resolve(0),
      takeover: () => bus.setHost(id),
      leave: () => {
        bus.leave(id);
        return Promise.resolve();
      },
    };

    return net as Net;
  }
}
