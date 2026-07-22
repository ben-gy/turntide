// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * palette.ts — every colour that carries meaning, in one place.
 *
 * Principle #22: a piece drawn at 1.14:1 against its board is ON the board, the
 * right size, non-overlapping, and completely invisible — and on a moody dark
 * palette that reads as atmosphere in a screenshot. So the colours live here as
 * constants rather than as literals scattered through the renderer, and
 * tests/contrast.test.ts holds every one of them to >=3:1 against every surface
 * it can actually sit on (WCAG 2.1 SC 1.4.11, the floor for a non-text graphic).
 *
 * Teal vs amber is chosen to be colour-blind safe: the pair separates on
 * LUMINANCE as well as hue, so it survives deuteranopia and protanopia where a
 * red/green pair collapses. Colour is still never the only channel — kings carry
 * an engraved ring and cooling stones a frost rim, both shape cues.
 */

export const PALETTE = {
  /** Page background, behind everything. */
  ground: '#0e1720',
  /** The board's outer frame — a stone can never sit on this, but text does. */
  frame: '#0a1017',
  /** The two board square colours. Stones only ever sit on `dark`. */
  boardLight: '#1d2b38',
  boardDark: '#16212c',

  /**
   * The two sides.
   *
   * Teal is deliberately DARKER than a "nice" bright teal would be. The bright
   * #2ec4b6 sat at luminance 0.434 against amber's 0.461 — a 1.06:1 luminance
   * ratio, i.e. the two sides were the SAME shade of grey. The colour-blind claim
   * this palette makes is a luminance claim, and it was false; tests/contrast.ts
   * now pins it at >= 1.6:1, and this value is what satisfies it while keeping
   * teal above 3:1 on every surface it sits on.
   */
  teal: '#1a9086',
  amber: '#ff9f1c',
  /** Kings: the engraved ring drawn on top of a stone's own colour. */
  tealRing: '#04211e',
  amberRing: '#4a2c00',

  /**
   * A stone that cannot be flipped yet. Drawn as a rim on the stone.
   *
   * Dark, not pale, and that is forced rather than chosen: a rim must clear 3:1
   * against BOTH stone colours, and no light value can — a near-white rim is only
   * 1.6:1 on amber. Below both stones is the only side of them a single colour
   * can be legible from.
   */
  frost: '#0a2a35',

  /** Legal-destination marker, drawn on an empty dark square. */
  hint: '#7fd1c4',
  /** The currently selected stone's halo. */
  select: '#f5f7fa',
  /** The last move's from/to squares. Light enough to clear 3:1 on BOTH squares. */
  lastMove: '#5c7d96',

  /** Text. */
  text: '#e8eef4',
  textDim: '#93a6b8',
  /** Panel/surface behind HUD text and menus. */
  panel: '#152029',
  panelEdge: '#25333f',

  /** Status colours. */
  danger: '#ff6b6b',
  good: '#66d9a0',
} as const;

export type PaletteKey = keyof typeof PALETTE;

/** Relative luminance per WCAG 2.1. */
export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const v = [0, 1, 2].map((i) => {
    const c = parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

/** WCAG contrast ratio between two hex colours. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
