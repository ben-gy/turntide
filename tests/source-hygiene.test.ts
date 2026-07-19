/**
 * source-hygiene.test.ts — the checks that catch a whole class of "it built fine
 * and shipped broken".
 *
 * A stray control byte in a source file survives tsc, survives vite, and then
 * corrupts a template literal or a CSS selector in production. `console.log` in
 * shipped code is a slow leak of state into a player's devtools. A canonical link
 * on a single-page game points the crawler at a URL that is not this one. The
 * analytics beacon silently disappearing means no data and nobody notices for a
 * month. And a copy of the shared engine under src/ means this game has quietly
 * forked it and will never get a fix again.
 *
 * All of them are one grep. So they are one test.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs with the project root as cwd. (import.meta.url is not a file: URL
// under the jsdom environment, so it cannot be used here.)
const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const SRC_DIR = join(ROOT, 'src');
const TESTS_DIR = join(ROOT, 'tests');
const allSources = [...walk(SRC_DIR), ...walk(TESTS_DIR)];
const read = (p: string): string => readFileSync(p, 'utf8');
const rel = (p: string): string => relative(ROOT, p);

describe('no control bytes anywhere in the tree', () => {
  /**
   * Everything below 0x20 except tab (\x09), newline (\x0a) and carriage return
   * (\x0d), plus DEL (\x7f). Written with escapes on purpose: a literal control
   * byte in THIS file would be exactly the bug it is meant to catch.
   */
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

  it('finds none in src/ or tests/', () => {
    expect(allSources.length, 'walked no files at all — the walker is broken').toBeGreaterThan(5);

    const bad: string[] = [];
    for (const file of allSources) {
      const text = read(file);
      const m = CONTROL.exec(text);
      if (!m) continue;
      const at = m.index;
      const line = text.slice(0, at).split('\n').length;
      const code = `\\x${text.charCodeAt(at).toString(16).padStart(2, '0')}`;
      bad.push(`${rel(file)}:${line} contains ${code}`);
    }
    expect(bad, `control bytes survive the build and corrupt strings at runtime`).toEqual([]);
  });
});

describe('shipped code is quiet', () => {
  it('has no console.log / console.error in src/', () => {
    const noisy: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const text = read(file);
      text.split('\n').forEach((line, i) => {
        if (/console\.(log|error)\(/.test(line)) noisy.push(`${rel(file)}:${i + 1}`);
      });
    }
    expect(noisy, 'debug logging left in a production build').toEqual([]);
  });
});

describe('index.html', () => {
  const html = read(join(ROOT, 'index.html'));

  it('carries no canonical link', () => {
    // A single-page game served at one URL gains nothing from a canonical tag and
    // loses everything if it ever points at the wrong host.
    expect(html).not.toMatch(/<link[^>]+rel=["']canonical["']/i);
  });

  it('carries the Cloudflare beacon token', () => {
    expect(
      html,
      'the analytics beacon token is missing — the game would ship with no traffic data',
    ).toContain('ba2bab2193ba42c1bea3d6714fcd0e28');
  });
});

describe('the engine is a package, not a copy', () => {
  it('has no src/engine/ directory', () => {
    expect(
      existsSync(join(SRC_DIR, 'engine')),
      'src/engine/ exists — the shared engine has been vendored into this game, ' +
        'which forks it permanently. Import @ben-gy/game-engine instead.',
    ).toBe(false);
  });

  it('imports the engine by package specifier where it imports it at all', () => {
    const offenders: string[] = [];
    for (const file of allSources) {
      for (const m of read(file).matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (/(^|\/)engine\/(net|rematch|lobby|rng|turn|storage)/.test(m[1])) {
          offenders.push(`${rel(file)} -> ${m[1]}`);
        }
      }
    }
    expect(offenders, 'a relative import of a vendored engine file').toEqual([]);
  });
});

describe('the [hidden] safety net', () => {
  const css = join(ROOT, 'src/styles/main.css');

  it('main.css forces [hidden] to display:none', () => {
    // Safari honours `[hidden]` far less aggressively than Chromium once any
    // `display` is set on the element, so an overlay that Chromium hides stays
    // painted over the board on an iPhone — blurring the game and eating taps.
    // Chromium-only verification cannot see it, so it is pinned here.
    // The stylesheet must EXIST for this check to mean anything. It was briefly
    // written concurrently, and a "skip if absent" branch here would have made
    // this mandatory guard silently never fire — which is the same failure mode
    // as not having the guard at all.
    expect(existsSync(css), 'src/styles/main.css must exist for this guard to fire').toBe(true);
    const text = read(css).replace(/\s+/g, ' ');
    expect(text, 'src/styles/main.css must contain `[hidden] { display: none !important }`').toMatch(
      /\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/i,
    );
  });
});
