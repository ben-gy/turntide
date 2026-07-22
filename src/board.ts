// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * board.ts — the board, drawn in DOM.
 *
 * DOM rather than canvas because this is a board game: crisp text, 44px hit
 * targets for free, and — the reason that actually decided it — `rotateY` gives
 * us THE FLIP. A converted stone turning over on its own axis is the game's
 * whole identity, and staggering the turn down the chain (~60ms a link) is what
 * makes a cascade read as a wave rolling across the board rather than four
 * squares changing colour at once.
 *
 * Layout is pure percentage: the grid is `minmax(0, 1fr)` columns and each stone
 * is one cell wide, positioned with `translate(c*100%, r*100%)`. No pixel cell
 * size is ever computed, so a 10x10 fits at 375px for the same reason an 8x8
 * does, and the transform is a transition away from being an animation.
 *
 * Input is Pointer Events only, through the engine's drag classifier, so tap and
 * drag come off ONE gesture stream: tap a stone then tap a target, or drag the
 * stone onto the target with the grab offset preserved. Coordinates always come
 * from `clientX/Y - getBoundingClientRect()`, never `offsetX/offsetY`, which
 * reports relative to whatever child happened to be under the finger.
 */

import { makeDraggable, type Draggable } from '@ben-gy/game-engine/drag';
import type { Sfx } from '@ben-gy/game-engine/sound';
import type { Game } from './game';
import { stoneCount } from './modes';
import {
  AMBER,
  EMPTY,
  TEAL,
  colOf,
  isPlayable,
  rowOf,
  type Move,
  type Side,
} from './turntide';

/** Per-link stagger down a chain — the thing that makes a cascade read as a wave. */
const FLIP_STAGGER_MS = 60;

export interface BoardConfig {
  root: HTMLElement;
  game: Game;
  sfx: Sfx;
  reducedMotion: boolean;
  /** A complete legal move was built locally. The caller commits it. */
  onMove: (move: Move) => void;
  /** The chain grew, or the selection changed — repaint anything outside the board. */
  onChange?: () => void;
}

export interface BoardView {
  render(): void;
  /** Re-measure. Guarded against transient 0-size layouts. */
  resize(): void;
  /** Point the view at a different Game (a resync replaced it, or a new round). */
  setGame(game: Game): void;
  /** Input on/off — used by the countdown, the pause overlay and the results screen. */
  setInteractive(on: boolean): void;
  destroy(): void;
}

export function createBoard(cfg: BoardConfig): BoardView {
  let game = cfg.game;
  let interactive = false;
  /** Move count at the last paint, so we can tell a new move from a repaint. */
  let paintedPly = -1;
  let size = game.mode.size;

  cfg.root.innerHTML = `
    <div class="tide" role="img" aria-label="Stones controlled">
      <div class="tide-track">
        <div class="tide-fill teal"></div>
        <div class="tide-fill amber"></div>
        <span class="tide-mark teal"></span>
        <span class="tide-mark amber"></span>
      </div>
      <div class="tide-nums">
        <span class="tide-num teal"><b class="v">0</b> teal</span>
        <span class="tide-num amber">amber <b class="v">0</b></span>
      </div>
    </div>
    <div class="board-frame">
      <div class="board"><div class="cells"></div><div class="stones"></div></div>
    </div>
    <div class="board-actions">
      <button type="button" class="btn stop-here" hidden>Stop here</button>
    </div>`;

  const boardEl = cfg.root.querySelector<HTMLElement>('.board')!;
  const cellsEl = cfg.root.querySelector<HTMLElement>('.cells')!;
  const stonesEl = cfg.root.querySelector<HTMLElement>('.stones')!;
  const stopBtn = cfg.root.querySelector<HTMLButtonElement>('.stop-here')!;
  const tideTeal = cfg.root.querySelector<HTMLElement>('.tide-fill.teal')!;
  const tideAmber = cfg.root.querySelector<HTMLElement>('.tide-fill.amber')!;
  const markTeal = cfg.root.querySelector<HTMLElement>('.tide-mark.teal')!;
  const markAmber = cfg.root.querySelector<HTMLElement>('.tide-mark.amber')!;
  const numTeal = cfg.root.querySelector<HTMLElement>('.tide-num.teal .v')!;
  const numAmber = cfg.root.querySelector<HTMLElement>('.tide-num.amber .v')!;

  /** square index -> its cell element. Rebuilt only when the board size changes. */
  let cells: HTMLElement[] = [];
  /** square index -> the stone standing on it. Re-keyed as stones move. */
  let stones = new Map<number, HTMLElement>();

  function buildGrid(): void {
    size = game.mode.size;
    boardEl.style.setProperty('--n', String(size));
    cellsEl.innerHTML = '';
    stonesEl.innerHTML = '';
    stones = new Map();
    cells = [];
    for (let i = 0; i < size * size; i++) {
      const c = document.createElement('div');
      c.className = isPlayable(i, size) ? 'cell playable' : 'cell';
      cellsEl.appendChild(c);
      cells.push(c);
    }
  }

  function makeStone(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'stone';
    // The outer element owns the TRANSLATE and the inner `.turner` owns the
    // ROTATION — one transform each, so sliding and flipping never fight over
    // the same property.
    el.innerHTML =
      '<span class="turner">' +
      '<span class="face front"><span class="ring"></span></span>' +
      '<span class="face back"></span>' +
      '</span>';
    stonesEl.appendChild(el);
    return el;
  }

  // ── painting ──────────────────────────────────────────────────────────────

  function render(): void {
    if (size !== game.mode.size || cells.length !== game.mode.size * game.mode.size) buildGrid();

    const pos = game.pos;
    const fresh = game.history.length !== paintedPly;
    const last = game.lastMove;

    // A move re-keys the mover's element from its origin to its landing square
    // BEFORE anything else, so the transform transition animates the slide
    // instead of the stone vanishing at one end and appearing at the other.
    if (fresh && last) {
      const mover = stones.get(last.from);
      if (mover) {
        stones.delete(last.from);
        stones.set(last.path[last.path.length - 1], mover);
      }
    }

    const sel = game.sel;
    const head = game.head();
    const targets = new Set(game.targets());
    const lastSquares = new Set<number>(last ? [last.from, ...last.path] : []);
    const selectable = interactive && game.isLocalTurn() && !game.over() ? game.selectable() : [];
    const selectableSet = new Set(selectable);

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const playable = isPlayable(i, size);
      cell.className =
        'cell' +
        (playable ? ' playable' : '') +
        (targets.has(i) ? ' hint' : '') +
        (lastSquares.has(i) ? ' last' : '') +
        (i === sel ? ' sel' : '') +
        (i === head && head !== sel ? ' head' : '') +
        (selectableSet.has(i) ? ' can' : '');
    }

    const seen = new Set<number>();
    for (let i = 0; i < pos.owner.length; i++) {
      const owner = pos.owner[i];
      if (owner === EMPTY) continue;
      seen.add(i);
      let el = stones.get(i);
      if (!el) {
        el = makeStone();
        stones.set(i, el);
        // Place it without animating in from the corner.
        el.style.setProperty('--r', String(rowOf(i, size)));
        el.style.setProperty('--c', String(colOf(i, size)));
        el.classList.add('placed');
      }
      el.style.setProperty('--r', String(rowOf(i, size)));
      el.style.setProperty('--c', String(colOf(i, size)));
      const side = owner as Side;
      el.classList.toggle('teal', side === TEAL);
      el.classList.toggle('amber', side === AMBER);
      el.classList.toggle('king', pos.king[i] === 1);
      el.classList.toggle('cool', pos.cool[i] > 0);
      el.classList.toggle('is-sel', i === sel || i === head);
    }

    for (const [sq, el] of [...stones]) {
      if (seen.has(sq)) continue;
      el.remove();
      stones.delete(sq);
    }

    if (fresh && last && last.flips.length) animateFlips(last.flips, pos.turn);
    if (fresh) {
      paintedPly = game.history.length;
      if (last) juice(last.flips.length);
    }

    paintTide();

    const canStop = interactive && game.isLocalTurn() && game.canStop();
    stopBtn.hidden = !canStop;
  }

  /**
   * The signature animation. Each converted stone turns 180 degrees on its own
   * axis, one link behind the last, so a four-chain is a wave and not a flash.
   * The back face carries the colour the stone is turning AWAY from, so the
   * change happens at the halfway point where you cannot see either face.
   */
  function animateFlips(flips: number[], turnNow: Side): void {
    // The side that just moved is the one that owns the flipped stones now.
    const wasSide: Side = turnNow === TEAL ? AMBER : TEAL;
    flips.forEach((sq, k) => {
      const el = stones.get(sq);
      if (!el) return;
      const back = el.querySelector<HTMLElement>('.face.back');
      if (back) {
        back.classList.toggle('teal', wasSide === AMBER);
        back.classList.toggle('amber', wasSide === TEAL);
      }
      el.classList.remove('flip');
      // Force a reflow so re-adding the class restarts the animation on a stone
      // flipped twice in quick succession.
      void el.offsetWidth;
      el.style.setProperty('--flip-delay', `${k * FLIP_STAGGER_MS}ms`);
      el.classList.add('flip');
      if (!cfg.reducedMotion) {
        window.setTimeout(() => {
          try {
            cfg.sfx.play('coin');
          } catch {
            /* audio is best-effort */
          }
        }, k * FLIP_STAGGER_MS);
      }
    });
  }

  function juice(flipCount: number): void {
    try {
      cfg.sfx.play(flipCount ? 'jump' : 'select');
    } catch {
      /* audio is best-effort */
    }
    if (cfg.reducedMotion || flipCount < 2) return;
    boardEl.classList.remove('shake');
    void boardEl.offsetWidth;
    boardEl.classList.add('shake');
    window.setTimeout(() => boardEl.classList.remove('shake'), 320);
  }

  /**
   * The tide bar — the primary read on the game state. You are meant to know
   * whether you are winning without counting anything, and to SEE the rout
   * threshold coming, so both cliffs are marked on the track.
   */
  function paintTide(): void {
    const total = stoneCount(game.mode);
    let teal = 0;
    let amber = 0;
    for (let i = 0; i < game.pos.owner.length; i++) {
      if (game.pos.owner[i] === TEAL) teal++;
      else if (game.pos.owner[i] === AMBER) amber++;
    }
    const pct = (n: number): string => `${(n / total) * 100}%`;
    tideTeal.style.width = pct(teal);
    tideAmber.style.width = pct(amber);
    markTeal.style.left = pct(game.mode.rout);
    markAmber.style.left = pct(total - game.mode.rout);
    numTeal.textContent = String(teal);
    numAmber.textContent = String(amber);
  }

  // ── input ─────────────────────────────────────────────────────────────────

  /**
   * Which square a client point falls on, or -1. Reads from the board's own
   * rect, and refuses to divide by a zero-size box — a board measured mid-layout
   * (or in a backgrounded tab) reports 0x0, and a scale computed from that puts
   * every stone in the corner.
   */
  function squareAt(clientX: number, clientY: number): number {
    const rect = boardEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return -1;
    const c = Math.floor(((clientX - rect.left) / rect.width) * size);
    const r = Math.floor(((clientY - rect.top) / rect.height) * size);
    if (r < 0 || r >= size || c < 0 || c >= size) return -1;
    return r * size + c;
  }

  function tapSquare(sq: number): void {
    if (!interactive || sq < 0 || game.over() || !game.isLocalTurn()) return;

    if (game.sel !== null && game.targets().includes(sq)) {
      const move = game.step(sq);
      if (move) cfg.onMove(move);
      else {
        render();
        cfg.onChange?.();
      }
      return;
    }

    if (game.select(sq)) {
      try {
        cfg.sfx.play('select');
      } catch {
        /* audio is best-effort */
      }
      render();
      cfg.onChange?.();
      return;
    }

    // A tap on nothing useful clears the chain rather than leaving it half-built.
    if (game.sel !== null) {
      game.clearSelection();
      render();
      cfg.onChange?.();
    }
  }

  /** The square the current gesture started on — captured on pointerdown, not
   *  at drag-start, because by then the finger has already travelled the slop. */
  let downSquare = -1;
  let dragEl: HTMLElement | null = null;

  const onPointerDown = (e: PointerEvent): void => {
    downSquare = squareAt(e.clientX, e.clientY);
  };
  boardEl.addEventListener('pointerdown', onPointerDown);

  function clearDrag(): void {
    if (!dragEl) return;
    dragEl.classList.remove('dragging');
    dragEl.style.removeProperty('--dx');
    dragEl.style.removeProperty('--dy');
    dragEl = null;
  }

  const drag: Draggable = makeDraggable(boardEl, {
    onTap: (e) => {
      clearDrag();
      const sq = squareAt(e.clientX, e.clientY);
      tapSquare(sq >= 0 ? sq : downSquare);
    },

    onDragStart: () => {
      if (!interactive || downSquare < 0 || game.over() || !game.isLocalTurn()) return;
      // Picking a stone up IS selecting it — dragging must not require a tap first.
      if (downSquare !== game.head() && !game.select(downSquare)) return;
      const el = stones.get(downSquare);
      if (!el) return;
      dragEl = el;
      el.classList.add('dragging');
      render();
    },

    onDragMove: (dx, dy) => {
      if (!dragEl) return;
      // Grab offset preserved: the stone tracks the finger exactly, rather than
      // snapping its centre under it.
      dragEl.style.setProperty('--dx', `${dx}px`);
      dragEl.style.setProperty('--dy', `${dy}px`);
    },

    onDrop: (_dx, _dy, e) => {
      const target = squareAt(e.clientX, e.clientY);
      const wasDragging = !!dragEl;
      // Clearing first restores the snap transition, so an illegal drop eases
      // home instead of teleporting.
      clearDrag();
      if (!wasDragging) return;
      if (target >= 0 && game.targets().includes(target)) tapSquare(target);
      else render();
    },

    onCancel: () => {
      // A cancelled gesture is an ABORT — a call came in, or the browser took
      // the pointer. Snap back; never treat it as a drop.
      clearDrag();
      render();
    },
  });

  stopBtn.addEventListener('click', () => {
    if (!interactive || !game.canStop()) return;
    const move = game.stopHere();
    if (move) cfg.onMove(move);
  });

  buildGrid();
  render();

  return {
    render,

    resize(): void {
      const rect = boardEl.getBoundingClientRect();
      // Never derive anything from a 0x0 measurement — that is a board mid-layout
      // or in a hidden tab, not a board that is genuinely zero wide.
      if (rect.width <= 0 || rect.height <= 0) return;
      boardEl.style.setProperty('--cell', `${rect.width / size}px`);
      render();
    },

    setGame(next: Game): void {
      game = next;
      paintedPly = -1;
      buildGrid();
      render();
    },

    setInteractive(on: boolean): void {
      interactive = on;
      if (!on) {
        clearDrag();
        game.clearSelection();
      }
      render();
    },

    destroy(): void {
      drag.destroy();
      boardEl.removeEventListener('pointerdown', onPointerDown);
      cfg.root.innerHTML = '';
    },
  };
}
