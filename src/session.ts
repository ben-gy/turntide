// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * session.ts — the netcode. LOCKSTEP, because Turntide can afford it.
 *
 * The rules are deterministic and there is no hidden information, so two peers
 * running turntide.ts over the same ordered move list hold byte-identical
 * boards by construction. Peers therefore exchange ONLY `{from, path}` — the
 * origin square and the landing squares — and each re-derives the flips, the
 * crown strips and the cooling flags itself. No board state ever crosses the
 * wire, which is why a 10x10 round costs a few dozen bytes a turn.
 *
 * What the host owns is the CLOCK, and nothing else. That is deliberate: it
 * makes host transfer a state-wise no-op (both peers already hold the identical
 * position), so promotion is "adopt the clock value, resume the interval, start
 * answering resync" — see `setHost`, which is network-free precisely so it can
 * be unit-tested without a mesh.
 *
 * The clock runs on setInterval, never rAF: a backgrounded tab freezes rAF, and
 * a turn timer that stops when you switch tabs is a room that hangs.
 */

import { Game, type WireMove } from './game';
import { legalMoves, type Move, type Side } from './turntide';

/**
 * The slice of `Net` this module needs. Structural, so a test can drive a whole
 * session with a two-line fake and no WebRTC anywhere near it.
 */
export interface SessionNet {
  readonly selfId: string;
  channel<T>(
    name: string,
    onReceive: (data: T, from: string) => void,
  ): ((data: T, toPeers?: string | string[]) => void) & { off: () => void };
}

/** Default per-turn budget. Generous — this is a thinking game, not a reflex one. */
export const DEFAULT_TURN_MS = 45_000;

/** Display tick. Fine enough to animate a bar, coarse enough to be free. */
export const TICK_MS = 250;

/** Host broadcasts its authoritative remaining time this often (ticks). */
const BROADCAST_EVERY = 4;

export interface ClockState {
  /** Full per-turn budget. */
  turnMs: number;
  /** Milliseconds left for the side to move. */
  leftMs: number;
  /** Whose clock this is. */
  side: Side;
  running: boolean;
}

export interface SessionConfig {
  /** Injected so tests can drive a session without a network. */
  game: Game;
  /** The rematch round number. Moves for any other round are ignored. */
  round: number;
  /** Omit entirely for a solo/offline session. */
  net?: SessionNet | null;
  isHost: boolean;
  /** Per-turn budget. Pass 0 to run without a clock at all (solo). */
  turnMs?: number;
  /**
   * Build a fresh Game for this round. Only needed to recover from a genuine
   * divergence, where the incoming history is not an extension of ours and the
   * only honest repair is to replay from the opening.
   */
  reset?: () => Game;
  /**
   * The position advanced (local move, remote move, or a clock timeout). Read
   * `game.lastMove` for what actually happened — it is the same object on every
   * peer, which is the point of lockstep.
   */
  onAdvance?: () => void;
  /** The Game instance was replaced by a resync. Re-point the renderer at it. */
  onAdopt?: (game: Game) => void;
  /** The round ended (rout, blockage, cap, or an opponent leaving). */
  onEnd?: () => void;
  /** Clock ticked. Repaint the HUD. */
  onClock?: (clock: ClockState) => void;
  /** The clock ran out and a move was played for the idle seat. */
  onTimeout?: (side: Side) => void;
  /** Something went wrong that the player should be told about. */
  onError?: (message: string) => void;
}

export interface Session {
  /** The live Game — may be replaced by a resync, so always read it through this. */
  game(): Game;
  round(): number;
  /** Validate, apply and broadcast a local move. False = it was not legal. */
  sendMove(w: WireMove): boolean;
  /**
   * Promotion / demotion. Network-free on purpose: it adopts the current clock
   * value, resumes the host-only duties (ticking down, broadcasting, playing for
   * an idle seat) and starts answering resync requests. Wired from
   * `createNet`'s `onHostChange`.
   */
  setHost(isHost: boolean): void;
  isHost(): boolean;
  clock(): ClockState;
  /** Pause the clock locally (solo), or for a host-side pause. */
  setPaused(paused: boolean): void;
  /** A peer dropped. Award the round so the survivor reaches the summary. */
  peerLeft(peerId: string): void;
  /** Ask the host for the authoritative move list. */
  requestSync(): void;
  destroy(): void;
}

interface MoveMsg {
  /** Round number — a move from a stale round is ignored, never applied. */
  r: number;
  /** Index in the move list. Anything but the next one means we missed something. */
  i: number;
  from: number;
  path: number[];
}

interface ClkMsg {
  r: number;
  i: number;
  ms: number;
}

interface HistMsg {
  r: number;
  moves: WireMove[];
}

/**
 * The move the host plays on behalf of a seat whose clock expired. Longest chain
 * first, then lowest origin — deterministic, so the same idle position always
 * produces the same move and a timeout is never a coin flip.
 */
export function fallbackMove(moves: Move[]): Move | null {
  let best: Move | null = null;
  for (const m of moves) {
    if (!best) {
      best = m;
      continue;
    }
    if (m.flips.length !== best.flips.length) {
      if (m.flips.length > best.flips.length) best = m;
      continue;
    }
    if (m.from !== best.from) {
      if (m.from < best.from) best = m;
      continue;
    }
    const a = m.path[m.path.length - 1];
    const b = best.path[best.path.length - 1];
    if (a < b) best = m;
  }
  return best;
}

/** Is `a` a prefix of `b` (both wire move lists)? */
function isPrefix(a: ReadonlyArray<WireMove>, b: ReadonlyArray<WireMove>): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].from !== b[i].from) return false;
    if (a[i].path.length !== b[i].path.length) return false;
    for (let j = 0; j < a[i].path.length; j++) if (a[i].path[j] !== b[i].path[j]) return false;
  }
  return true;
}

export function createSession(cfg: SessionConfig): Session {
  let game = cfg.game;
  const round = cfg.round;
  const turnMs = cfg.turnMs ?? DEFAULT_TURN_MS;
  const net = cfg.net ?? null;

  let host = cfg.isHost;
  let left = turnMs;
  let paused = false;
  let ended = false;
  let destroyed = false;
  let ticks = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const state = (): ClockState => ({
    turnMs,
    leftMs: Math.max(0, left),
    side: game.turn,
    running: !!timer && !paused && !ended,
  });

  // ── wire ──────────────────────────────────────────────────────────────────

  const sendMv = net?.channel<MoveMsg>('mv', (msg) => {
    if (destroyed || msg.r !== round) return;
    const next = game.history.length;
    // Already have it — a duplicate from a retry, which is free.
    if (msg.i < next) return;
    // A gap: we missed a move, so the position we would derive is wrong. Ask for
    // the whole list rather than applying something on top of a stale board.
    if (msg.i > next) return requestSync();
    if (!game.applyWire({ from: msg.from, path: msg.path })) {
      // Legal-move validation failed, so our boards genuinely disagree. Never
      // guess; resync.
      requestSync();
      return;
    }
    advanced();
  });

  const sendClk = net?.channel<ClkMsg>('clk', (msg) => {
    if (destroyed || host || msg.r !== round) return;
    // Only trust a clock for the move we are actually on — a late tick for an
    // older ply would rewind the bar.
    if (msg.i !== game.history.length) return;
    left = msg.ms;
    cfg.onClock?.(state());
  });

  const sendSyn = net?.channel<null>('syn', (_d, from) => {
    if (destroyed || !host) return;
    sendHist?.(
      { r: round, moves: game.history.map((w) => ({ from: w.from, path: [...w.path] })) },
      from,
    );
  });

  const sendHist = net?.channel<HistMsg>('hist', (msg) => {
    if (destroyed || msg.r !== round) return;
    adopt(msg.moves);
  });

  /**
   * Reconcile against the host's authoritative move list. The common case is a
   * dropped packet, where our list is a prefix and applying the tail is enough.
   * A genuine divergence — different moves at the same index — can only be
   * repaired by replaying from the opening into a fresh Game.
   */
  function adopt(moves: WireMove[]): void {
    if (isPrefix(game.history, moves)) {
      if (moves.length <= game.history.length) return;
      for (const w of moves.slice(game.history.length)) {
        if (!game.applyWire(w)) {
          cfg.onError?.('Lost sync with the other player.');
          return;
        }
      }
      advanced();
      return;
    }

    if (!cfg.reset) {
      cfg.onError?.('Lost sync with the other player.');
      return;
    }
    const fresh = cfg.reset();
    for (const w of moves) {
      if (!fresh.applyWire(w)) {
        cfg.onError?.('Lost sync with the other player.');
        return;
      }
    }
    game = fresh;
    cfg.onAdopt?.(game);
    advanced();
  }

  // ── clock ─────────────────────────────────────────────────────────────────

  function ensureTimer(): void {
    // turnMs 0 means "no clock" — a solo game where a timer that played for you
    // would be hostile rather than a safety net.
    if (turnMs <= 0 || timer || destroyed || ended) return;
    timer = setInterval(tick, TICK_MS);
  }

  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function tick(): void {
    if (destroyed || paused || ended) return;
    if (game.over()) return finish();

    left -= TICK_MS;
    if (left <= 0) {
      left = 0;
      cfg.onClock?.(state());
      // Only the host acts on expiry. If both peers did, the same seat would be
      // played for twice and the lists would fork.
      if (host) expire();
      return;
    }

    ticks++;
    if (host && ticks % BROADCAST_EVERY === 0) broadcastClock();
    cfg.onClock?.(state());
  }

  function broadcastClock(): void {
    sendClk?.({ r: round, i: game.history.length, ms: Math.max(0, left) });
  }

  /** The idle seat's time ran out. Play for it so a room can never hang. */
  function expire(): void {
    const pick = fallbackMove(legalMoves(game.pos, game.mode));
    if (!pick) return finish();
    const side = game.turn;
    const i = game.history.length;
    game.commit(pick);
    sendMv?.({ r: round, i, from: pick.from, path: [...pick.path] });
    cfg.onTimeout?.(side);
    advanced();
  }

  function advanced(): void {
    left = turnMs;
    ticks = 0;
    if (host) broadcastClock();
    cfg.onAdvance?.();
    cfg.onClock?.(state());
    if (game.over()) finish();
  }

  function finish(): void {
    if (ended) return;
    ended = true;
    stopTimer();
    cfg.onEnd?.();
  }

  ensureTimer();

  return {
    game: () => game,
    round: () => round,

    sendMove(w: WireMove): boolean {
      if (destroyed || ended) return false;
      const i = game.history.length;
      if (!game.applyWire(w)) return false;
      sendMv?.({ r: round, i, from: w.from, path: [...w.path] });
      advanced();
      return true;
    },

    setHost(isHost: boolean): void {
      host = isHost;
      if (host) {
        // The clock value carries over untouched — both peers were already
        // holding the same one, so promotion changes who ticks it, not what it
        // says. Resume the interval and start answering `syn`.
        ensureTimer();
        broadcastClock();
      }
      cfg.onClock?.(state());
    },

    isHost: () => host,
    clock: state,

    setPaused(p: boolean): void {
      paused = p;
      cfg.onClock?.(state());
    },

    peerLeft(peerId: string): void {
      if (ended) return;
      const gone = game.players.find((p) => p.id === peerId);
      if (!gone) return;
      // Award it rather than freezing the board — the survivor must always reach
      // a summary screen.
      game.forfeit(gone.side);
      finish();
    },

    requestSync,

    destroy(): void {
      destroyed = true;
      stopTimer();
      sendMv?.off();
      sendClk?.off();
      sendSyn?.off();
      sendHist?.off();
    },
  };

  function requestSync(): void {
    if (destroyed || host) return;
    sendSyn?.(null);
  }
}
