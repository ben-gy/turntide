/**
 * room-code.test.ts — live-P2P contract gate #1.
 *
 * The single most expensive multiplayer bug is also the most boring: two players
 * hold what they believe is the same room code, and land in two different rooms.
 * Nothing errors. Both lobbies say "waiting for a player". The room code is a
 * STRING, and a string typed by a human on a phone keyboard — lower case,
 * autocorrect's trailing space, the dash they added because it looked like it
 * wanted one — is not the string the invite link carries.
 *
 * So: every plausible way of typing a code must canonicalise to exactly the same
 * bytes the link does. That is the whole gate.
 */

import { describe, expect, it } from 'vitest';
import { normalizeRoomCode } from '@ben-gy/game-engine/lobby';

/** What an invite link carries: the already-canonical form. */
const CANON = 'K7QM';

describe('a hand-typed code reaches the same room as the link', () => {
  const typings: Array<[string, string]> = [
    ['exactly as printed', 'K7QM'],
    ['lower case (the phone keyboard default)', 'k7qm'],
    ['mixed case', 'k7Qm'],
    ['leading and trailing whitespace', '  K7QM  '],
    ['a trailing space from autocorrect', 'K7QM '],
    ['read aloud with a dash', 'K7-QM'],
    ['spaced out for legibility', 'K 7 Q M'],
    ['lower case with dashes and spaces at once', ' k7-q m '],
    ['pasted with a stray newline', 'K7QM\n'],
    ['pasted with a tab', '\tk7qm'],
  ];

  for (const [why, raw] of typings) {
    it(`${why}: ${JSON.stringify(raw)} -> ${CANON}`, () => {
      expect(
        normalizeRoomCode(raw),
        `${JSON.stringify(raw)} canonicalises to a DIFFERENT room than the invite ` +
          `link's ${CANON} — the two players would sit in separate rooms, each ` +
          `showing "waiting", with no error anywhere`,
      ).toBe(CANON);
    });
  }

  it('all of them agree with each other, not just with the constant', () => {
    const results = new Set(typings.map(([, raw]) => normalizeRoomCode(raw)));
    expect(results.size, `${[...results].join(', ')} — these are different rooms`).toBe(1);
  });
});

describe('the canonical form is a fixed point', () => {
  // The code is normalised on input, again on submit, and again when it is put in
  // the URL. If normalising twice changed anything, the room id would depend on
  // how many times the code happened to pass through the function.
  it('normalising twice is the same as normalising once', () => {
    for (const raw of ['k7qm', ' K7-QM ', 'abcd', 'ZZ99', '', 'a b c d e f g h i j']) {
      const once = normalizeRoomCode(raw);
      expect(normalizeRoomCode(once), `not idempotent for ${JSON.stringify(raw)}`).toBe(once);
    }
  });
});

describe('what it strips, and what it must not', () => {
  it('drops punctuation and separators entirely', () => {
    expect(normalizeRoomCode('K7.Q,M!')).toBe(CANON);
    expect(normalizeRoomCode('K/7\\Q_M')).toBe(CANON);
  });

  it('drops non-ASCII rather than passing bytes a room id cannot carry', () => {
    expect(normalizeRoomCode('K7QMé')).toBe(CANON);
    expect(normalizeRoomCode('K7QM✨')).toBe(CANON);
  });

  it('keeps digits — the alphabet is alphanumeric, not letters', () => {
    expect(normalizeRoomCode('2345')).toBe('2345');
  });

  it('caps the length so a pasted paragraph cannot become a room id', () => {
    expect(normalizeRoomCode('ABCDEFGHIJKLMNOP')).toBe('ABCDEFGH');
    expect(normalizeRoomCode('ABCDEFGHIJKLMNOP').length).toBeLessThanOrEqual(8);
  });

  it('returns empty for input with nothing usable in it, rather than throwing', () => {
    // The lobby needs to be able to tell "they typed nothing valid" from "they
    // typed a room" — a throw here would be an uncaught error on every keystroke.
    expect(normalizeRoomCode('---')).toBe('');
    expect(normalizeRoomCode('   ')).toBe('');
    expect(normalizeRoomCode('')).toBe('');
  });
});
