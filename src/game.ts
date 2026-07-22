// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * game.ts — the round's state machine, and the contract the UI and the netcode
 * both speak. Deliberately free of DOM and of the network so it can be tested
 * as pure logic (and so the netcode's takeover path is testable without a mesh).
 *
 * The interesting part is CHAIN INPUT. A jump chain is one move, but a player
 * builds it one hop at a time: tap the stone, tap where it lands, tap where it
 * lands next. So the game holds a PREFIX of landing squares and narrows the
 * candidate move list as the prefix grows. That is also what makes optional
 * capture (Tidepool) expressible in a UI at all: when a chain can legally stop
 * where it is AND continue, both are live candidates and the player is offered
 * an explicit "stop here".
 */

import { modeOf, type Mode, type ModeId } from './modes';
import {
  AMBER,
  TEAL,
  applyMove,
  control,
  initial,
  isLegal,
  kings,
  legalMoves,
  other,
  outcome,
  type EndReason,
  type Move,
  type Pos,
  type Side,
} from './turntide';

/** A move as it travels between peers — origin and landing squares, nothing else. */
export interface WireMove {
  from: number;
  path: number[];
}

export interface PlayerInfo {
  /** Peer id in multiplayer; a synthetic id solo. */
  id: string;
  name: string;
  side: Side;
  /** True if this seat is driven by the local human. */
  local: boolean;
  /** True if this seat is the AI. */
  bot: boolean;
}

export interface RoundSummary {
  over: boolean;
  winner: Side | 0;
  reason: EndReason;
  /** Per-player breakdown — principle #9: everyone's result, every time. */
  players: Array<{
    name: string;
    side: Side;
    control: number;
    kings: number;
    /** Stones this player converted across the round. */
    converted: number;
    /** Longest single chain they landed. */
    bestChain: number;
    /** Turns they took. */
    turns: number;
  }>;
  plies: number;
  /** The biggest chain that was AVAILABLE to anyone and not taken — what was left on the table. */
  missedBest: number;
}

export interface GameOpts {
  mode: ModeId | Mode;
  players: PlayerInfo[];
}

/** Per-side running tallies, for the results breakdown. */
interface Tally {
  converted: number;
  bestChain: number;
  turns: number;
}

export class Game {
  readonly mode: Mode;
  readonly players: PlayerInfo[];
  pos: Pos;
  /** Every move played, in order — this IS the transferable game state. */
  history: WireMove[] = [];
  /** Selected origin square, or null. */
  sel: number | null = null;
  /** Landing squares chosen so far in the current (possibly chained) move. */
  prefix: number[] = [];
  /** The squares touched by the last completed move, for highlighting. */
  lastMove: { from: number; path: number[]; flips: number[] } | null = null;

  private tally: Record<Side, Tally> = {
    [TEAL]: { converted: 0, bestChain: 0, turns: 0 },
    [AMBER]: { converted: 0, bestChain: 0, turns: 0 },
  };
  private missedBest = 0;
  /** Set when a peer leaves and the round is awarded early. */
  private forfeited: Side | 0 | null = null;

  constructor(opts: GameOpts) {
    this.mode = typeof opts.mode === 'string' ? modeOf(opts.mode) : opts.mode;
    this.players = opts.players;
    this.pos = initial(this.mode);
  }

  // ── queries ───────────────────────────────────────────────────────────────

  get turn(): Side {
    return this.pos.turn;
  }

  playerFor(side: Side): PlayerInfo | undefined {
    return this.players.find((p) => p.side === side);
  }

  /** The local human's side, or null if this peer is only spectating. */
  localSide(): Side | null {
    return this.players.find((p) => p.local)?.side ?? null;
  }

  isLocalTurn(): boolean {
    const p = this.playerFor(this.turn);
    return !!p?.local;
  }

  /** Squares the side to move could legally start a move from. */
  selectable(): number[] {
    const s = new Set<number>();
    for (const m of legalMoves(this.pos, this.mode)) s.add(m.from);
    return [...s];
  }

  /** Moves still consistent with the current selection + prefix. */
  private candidates(): Move[] {
    if (this.sel === null) return [];
    return legalMoves(this.pos, this.mode).filter((m) => {
      if (m.from !== this.sel) return false;
      if (m.path.length < this.prefix.length) return false;
      for (let i = 0; i < this.prefix.length; i++) if (m.path[i] !== this.prefix[i]) return false;
      return true;
    });
  }

  /** Legal NEXT landing squares given the current selection + prefix. */
  targets(): number[] {
    const n = this.prefix.length;
    const out = new Set<number>();
    for (const m of this.candidates()) if (m.path.length > n) out.add(m.path[n]);
    return [...out];
  }

  /**
   * True when the chain built so far is itself a complete legal move AND could
   * also continue. Only reachable with optional capture (Tidepool) — with forced
   * capture the generator only emits maximal chains, so there is nothing to stop.
   */
  canStop(): boolean {
    const exact = this.candidates().some((m) => m.path.length === this.prefix.length);
    return exact && this.targets().length > 0;
  }

  /** The square the moving stone currently occupies mid-chain (for rendering). */
  head(): number | null {
    if (this.sel === null) return null;
    return this.prefix.length ? this.prefix[this.prefix.length - 1] : this.sel;
  }

  // ── input ─────────────────────────────────────────────────────────────────

  select(square: number): boolean {
    if (this.over()) return false;
    if (!this.isLocalTurn()) return false;
    if (!this.selectable().includes(square)) return false;
    this.sel = square;
    this.prefix = [];
    return true;
  }

  clearSelection(): void {
    this.sel = null;
    this.prefix = [];
  }

  /**
   * Extend the current move to `square`.
   *
   * Returns the completed move if this hop finished it, or null if the chain is
   * still being built (the caller should re-render and wait for the next tap).
   */
  step(square: number): Move | null {
    if (this.sel === null || !this.targets().includes(square)) return null;
    this.prefix = [...this.prefix, square];

    const cands = this.candidates();
    const exact = cands.filter((m) => m.path.length === this.prefix.length);
    const longer = cands.filter((m) => m.path.length > this.prefix.length);

    // Complete and unambiguous — commit. If it could also continue, the caller
    // must offer canStop() instead, so we only auto-commit when nothing follows.
    if (exact.length === 1 && longer.length === 0) return exact[0];
    return null;
  }

  /** Commit the chain exactly as built (only valid when canStop()). */
  stopHere(): Move | null {
    const exact = this.candidates().find((m) => m.path.length === this.prefix.length);
    return exact ?? null;
  }

  // ── mutation ──────────────────────────────────────────────────────────────

  /**
   * Apply a move that has already been validated. The single mutation path, used
   * identically by local input, the AI, and moves arriving off the wire — which
   * is what makes lockstep peers structurally identical.
   */
  commit(move: Move): void {
    const side = this.pos.turn;
    const avail = legalMoves(this.pos, this.mode).reduce((n, m) => Math.max(n, m.flips.length), 0);
    if (avail > move.flips.length) this.missedBest = Math.max(this.missedBest, avail);

    applyMove(this.pos, this.mode, move);
    this.history.push({ from: move.from, path: [...move.path] });
    this.lastMove = { from: move.from, path: [...move.path], flips: [...move.flips] };

    const t = this.tally[side];
    t.converted += move.flips.length;
    t.bestChain = Math.max(t.bestChain, move.flips.length);
    t.turns++;

    this.clearSelection();
  }

  /** Validate + apply a move that arrived off the wire. False means desync. */
  applyWire(w: WireMove): boolean {
    const m = isLegal(this.pos, this.mode, w);
    if (!m) return false;
    this.commit(m);
    return true;
  }

  /** Award the round without playing it out — a peer left. */
  forfeit(loser: Side): void {
    this.forfeited = other(loser);
  }

  // ── outcome ───────────────────────────────────────────────────────────────

  over(): boolean {
    return this.forfeited !== null || outcome(this.pos, this.mode).over;
  }

  summary(): RoundSummary {
    const end = outcome(this.pos, this.mode);
    const winner = this.forfeited !== null ? this.forfeited : end.winner;
    const reason: EndReason = this.forfeited !== null ? 'left' : end.reason;

    return {
      over: this.forfeited !== null || end.over,
      winner,
      reason,
      // EVERY player's breakdown, always — not just the local one.
      players: this.players.map((p) => ({
        name: p.name,
        side: p.side,
        control: control(this.pos, p.side),
        kings: kings(this.pos, p.side),
        converted: this.tally[p.side].converted,
        bestChain: this.tally[p.side].bestChain,
        turns: this.tally[p.side].turns,
      })),
      plies: this.pos.ply,
      missedBest: this.missedBest,
    };
  }
}

/**
 * Seat assignment for a round.
 *
 * Sides ALTERNATE by round number so that whatever residual first-move edge
 * exists (the balance sim puts it within a few points of chance, but "within a
 * few points" is not "zero") alternates between the players across a match
 * rather than compounding on one of them.
 */
export function seatsFor(
  players: Array<{ id: string; name: string }>,
  round: number,
  selfId: string,
): PlayerInfo[] {
  const swap = round % 2 === 0;
  return players.slice(0, 2).map((p, i) => ({
    id: p.id,
    name: p.name,
    side: (swap ? i === 1 : i === 0) ? TEAL : AMBER,
    local: p.id === selfId,
    bot: false,
  }));
}
