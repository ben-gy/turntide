// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * ui.ts — small shared pieces of the shell: palette plumbing, text for the
 * things the rules produce, and the handful of helpers main.ts would otherwise
 * repeat five times.
 */

import { PALETTE } from './palette';
import { AMBER, TEAL, type EndReason, type Side } from './turntide';

/**
 * Mirror the palette into CSS custom properties AT RUNTIME.
 *
 * The colours are pinned by tests/contrast.test.ts, and they have already moved
 * once because a measured value failed the >=3:1 bar. Hand-copying them into the
 * stylesheet makes that a two-place edit and therefore, eventually, a drift; the
 * stylesheet names `var(--tt-teal)` and this is the only definition of it.
 */
export function applyPalette(): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(PALETTE)) {
    root.style.setProperty(`--tt-${kebab(key)}`, value);
  }
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export function sideName(side: Side): string {
  return side === TEAL ? 'Teal' : 'Amber';
}

export function sideClass(side: Side): string {
  return side === TEAL ? 'teal' : 'amber';
}

/** Player-facing sentence for how a round ended. */
export function reasonLine(reason: EndReason, winner: Side | 0): string {
  if (reason === 'left') return 'Your opponent left the room.';
  if (reason === 'rout') return `${sideName(winner as Side)} routed the board.`;
  if (reason === 'blocked') return `${sideName(winner === TEAL ? AMBER : TEAL)} had no legal move.`;
  if (reason === 'cap') {
    return winner === 0 ? 'The turn cap ran out, dead level.' : 'The turn cap ran out — most stones wins.';
  }
  return '';
}

/** mm:ss for the turn clock. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** A stable, friendly default name so a lobby never renders a raw peer id. */
export function defaultName(selfId: string): string {
  return `Player ${selfId.slice(0, 4).toUpperCase()}`;
}
