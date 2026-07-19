/**
 * contrast.test.ts — principle #22, held as a hard gate rather than an eyeball.
 *
 * A piece drawn at 1.14:1 against its board is present, correctly sized, on the
 * right square and completely invisible, and on a moody dark palette that reads
 * as atmosphere in a screenshot rather than as a bug. So every colour that
 * carries MEANING on the play surface is enumerated here against every surface it
 * can actually sit on, and held to WCAG 2.1 SC 1.4.11's 3:1 floor for a non-text
 * graphic (4.5:1 for body text).
 *
 * Pure: no canvas, no DOM, no layout. It only needs the numbers.
 */

import { describe, expect, it } from 'vitest';
import { PALETTE, contrast, luminance, type PaletteKey } from '../src/palette';

/** One enumerated obligation: this colour, on that surface, at least this ratio. */
interface Pair {
  fg: PaletteKey;
  bg: PaletteKey;
  min: number;
  /** Why this pair can actually occur on screen. */
  why: string;
}

function check({ fg, bg, min, why }: Pair): void {
  const ratio = contrast(PALETTE[fg], PALETTE[bg]);
  expect(
    ratio,
    `${fg} (${PALETTE[fg]}) on ${bg} (${PALETTE[bg]}) is ${ratio.toFixed(2)}:1, ` +
      `below the ${min}:1 floor — ${why}`,
  ).toBeGreaterThanOrEqual(min);
}

describe('stones against the surfaces they sit on', () => {
  // Stones only ever occupy dark squares, but boardLight is asserted too: a
  // renderer that ever draws a stone mid-flight, or a mode that changes the
  // parity, must not be able to make a piece vanish.
  const surfaces: PaletteKey[] = ['boardDark', 'boardLight', 'ground', 'panel'];

  for (const side of ['teal', 'amber'] as const) {
    for (const bg of surfaces) {
      it(`${side} is legible on ${bg}`, () => {
        check({
          fg: side,
          bg,
          min: 3,
          why:
            bg === 'boardDark'
              ? 'this is the square every stone actually lives on'
              : bg === 'boardLight'
                ? 'belt and braces against a parity or animation change'
                : 'the side also appears as a swatch in the HUD and the tide bar',
        });
      });
    }
  }
});

describe('shape cues drawn ON a stone', () => {
  it('the teal king ring reads against a teal stone', () => {
    check({
      fg: 'tealRing',
      bg: 'teal',
      min: 3,
      why: 'a king is only distinguishable from a man by this engraved ring',
    });
  });

  it('the amber king ring reads against an amber stone', () => {
    check({ fg: 'amberRing', bg: 'amber', min: 3, why: 'same, for the other side' });
  });

  // The frost rim marks a stone that cannot be flipped back yet — cooling. It is
  // the only signal for a rule that decides whether a jump is even legal, so it
  // has to clear the floor on BOTH stone colours, not just the one it looks nice
  // on. That constraint is what forces it dark: no light value clears 3:1 on
  // amber, whose luminance is already 0.46.
  it('the frost rim reads on a teal stone', () => {
    check({ fg: 'frost', bg: 'teal', min: 3, why: 'cooling is invisible without it' });
  });

  it('the frost rim reads on an amber stone', () => {
    check({ fg: 'frost', bg: 'amber', min: 3, why: 'cooling is invisible without it' });
  });
});

describe('board affordances', () => {
  it('the legal-destination hint reads on a dark square', () => {
    check({
      fg: 'hint',
      bg: 'boardDark',
      min: 3,
      why: 'hints are only ever drawn on empty dark squares',
    });
  });

  it('the selection halo reads on a dark square', () => {
    check({ fg: 'select', bg: 'boardDark', min: 3, why: 'the halo rings the selected stone' });
  });

  it('the last-move tint reads on a dark square', () => {
    check({
      fg: 'lastMove',
      bg: 'boardDark',
      min: 3,
      why: 'in lockstep P2P this is the only feedback that the peer moved at all',
    });
  });

  it('the last-move tint reads on a light square', () => {
    check({
      fg: 'lastMove',
      bg: 'boardLight',
      min: 3,
      why: 'a chain can pass a light square in the highlight overlay',
    });
  });
});

describe('text and status', () => {
  const surfaces: PaletteKey[] = ['panel', 'ground', 'frame'];

  for (const bg of surfaces) {
    it(`body text meets 4.5:1 on ${bg}`, () => {
      check({ fg: 'text', bg, min: 4.5, why: 'SC 1.4.3 for normal-size body text' });
    });

    it(`dimmed text meets 3:1 on ${bg}`, () => {
      check({ fg: 'textDim', bg, min: 3, why: 'SC 1.4.3 large-text floor; never body copy' });
    });
  }

  it('danger reads on a panel', () => {
    check({ fg: 'danger', bg: 'panel', min: 3, why: 'forfeit / disconnect states' });
  });

  it('good reads on a panel', () => {
    check({ fg: 'good', bg: 'panel', min: 3, why: 'ready / connected states' });
  });
});

describe('colour-blind safety, pinned as a number', () => {
  /**
   * The palette's own doc claims teal-vs-amber survives deuteranopia and
   * protanopia because the pair separates on LUMINANCE, not only hue. That claim
   * is either measurable or it is decoration. It is measurable: convert both to
   * greyscale and demand they still tell apart.
   *
   * This is the assertion that caught the original palette, where the two sides
   * sat at luminance 0.434 and 0.461 — a 1.06:1 ratio. Every screenshot looked
   * fine; to a red-green dichromat the board was one colour.
   */
  it('teal and amber separate in greyscale, not just in hue', () => {
    const ratio = contrast(PALETTE.teal, PALETTE.amber);
    expect(
      ratio,
      `teal (${PALETTE.teal}, L=${luminance(PALETTE.teal).toFixed(3)}) and amber ` +
        `(${PALETTE.amber}, L=${luminance(PALETTE.amber).toFixed(3)}) differ by only ` +
        `${ratio.toFixed(2)}:1 — in greyscale the two sides read alike, so the ` +
        `colour-blind-safety claim in palette.ts is false`,
    ).toBeGreaterThanOrEqual(1.6);
  });

  it('every palette entry is a full six-digit hex, so the maths is real', () => {
    for (const [k, v] of Object.entries(PALETTE)) {
      expect(v, `PALETTE.${k} is "${v}" — the contrast maths assumes #rrggbb`).toMatch(
        /^#[0-9a-f]{6}$/,
      );
    }
  });
});
