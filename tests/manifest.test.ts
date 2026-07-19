/**
 * manifest.test.ts — principle #17: the game must install to a phone home screen
 * and open full-bleed, not in a browser chrome with an address bar eating the
 * board.
 *
 * Every failure this catches is invisible in dev and only shows up on a real
 * phone, days later: a manifest that does not parse (the browser silently falls
 * back to a browser tab), a missing maskable icon (Android crops the artwork into
 * a circle and clips it), an icon path that 404s, a missing apple-touch-icon
 * (iOS screenshots the page and uses that as the icon).
 *
 * It also asserts there is NO service worker. This game is a few hundred KB of
 * static files behind a CDN; a SW buys nothing and costs a stale-cache class of
 * bug where players on two different builds cannot see each other in a room.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const RAW = read('public/manifest.webmanifest');
const HTML = read('index.html');

interface Icon {
  src: string;
  sizes: string;
  type?: string;
  purpose?: string;
}
interface Manifest {
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  background_color?: string;
  theme_color?: string;
  icons?: Icon[];
}

describe('public/manifest.webmanifest', () => {
  let m: Manifest;

  it('parses as JSON', () => {
    // A manifest with a trailing comma is not a warning — the browser drops the
    // whole thing and "Add to Home Screen" quietly produces a bookmark.
    expect(() => JSON.parse(RAW)).not.toThrow();
    m = JSON.parse(RAW) as Manifest;
    expect(m).toBeTypeOf('object');
  });

  it('has the fields that make an install a standalone app', () => {
    m = JSON.parse(RAW) as Manifest;
    expect(m.name, 'name').toBeTruthy();
    expect(m.short_name, 'short_name — the label under the home-screen icon').toBeTruthy();
    expect((m.short_name ?? '').length, 'short_name gets truncated past ~12 chars').toBeLessThan(13);
    expect(m.start_url, 'start_url').toBeTruthy();
    expect(m.scope, 'scope').toBeTruthy();
    expect(m.display, 'display must be standalone or the app opens in browser chrome').toBe(
      'standalone',
    );
    expect(m.background_color, 'background_color paints the splash').toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(m.theme_color, 'theme_color paints the status bar').toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('declares 192, 512 and a 512 maskable icon', () => {
    m = JSON.parse(RAW) as Manifest;
    const icons = m.icons ?? [];
    expect(icons.length, 'no icons at all').toBeGreaterThanOrEqual(3);

    const at = (size: string, purpose?: string): Icon | undefined =>
      icons.find(
        (i) =>
          i.sizes === size &&
          (purpose
            ? (i.purpose ?? 'any').split(/\s+/).includes(purpose)
            : (i.purpose ?? 'any').split(/\s+/).includes('any')),
      );

    expect(at('192x192'), 'no 192x192 "any" icon').toBeTruthy();
    expect(at('512x512'), 'no 512x512 "any" icon').toBeTruthy();
    expect(
      at('512x512', 'maskable'),
      'no 512x512 maskable icon — Android crops the square artwork into its own ' +
        'shape and clips the edges off',
    ).toBeTruthy();
  });

  it('every icon it references exists on disk and is not a placeholder', () => {
    m = JSON.parse(RAW) as Manifest;
    for (const icon of m.icons ?? []) {
      const path = join(ROOT, 'public', icon.src.replace(/^\//, ''));
      expect(existsSync(path), `manifest references ${icon.src} which does not exist`).toBe(true);
      expect(
        statSync(path).size,
        `${icon.src} is trivially small — almost certainly a blank or 1x1 placeholder`,
      ).toBeGreaterThan(1024);
      expect(icon.src.endsWith('.png'), `${icon.src} should be a PNG`).toBe(true);
    }
  });

  it('ships an apple-touch-icon file', () => {
    const path = join(ROOT, 'public/icons/apple-touch-icon.png');
    expect(existsSync(path), 'public/icons/apple-touch-icon.png is missing — iOS would ' + 'screenshot the page and use that as the home-screen icon').toBe(true);
    expect(statSync(path).size).toBeGreaterThan(1024);
  });

  it('has no stray icons/ files the manifest and html both ignore', () => {
    // Not a correctness gate, but a dead icon is usually a rename that only got
    // half-applied — and the half that got missed is the one in the manifest.
    const referenced = new Set<string>([
      ...(JSON.parse(RAW) as Manifest).icons!.map((i) => i.src.split('/').pop()!),
      'apple-touch-icon.png',
    ]);
    for (const f of readdirSync(join(ROOT, 'public/icons'))) {
      expect(referenced.has(f), `public/icons/${f} is referenced by nothing`).toBe(true);
    }
  });
});

describe('index.html install metadata', () => {
  it('links the manifest', () => {
    expect(HTML).toMatch(/<link[^>]+rel=["']manifest["'][^>]*>/i);
  });

  it('declares a theme-color', () => {
    expect(HTML).toMatch(/<meta[^>]+name=["']theme-color["'][^>]+content=["']#[0-9a-fA-F]{6}["']/i);
  });

  it('agrees with the manifest about the theme colour', () => {
    const m = JSON.parse(RAW) as Manifest;
    const tag = /<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{6})["']/i.exec(
      HTML,
    );
    expect(tag, 'no theme-color meta tag').toBeTruthy();
    expect(
      tag![1].toLowerCase(),
      'the status bar would change colour on install — html and manifest disagree',
    ).toBe((m.theme_color ?? '').toLowerCase());
  });

  it('carries the iOS-only tags, which the manifest does not cover', () => {
    expect(HTML, 'apple-touch-icon link').toMatch(/rel=["']apple-touch-icon["']/i);
    expect(HTML, 'apple-mobile-web-app-capable').toMatch(/name=["']apple-mobile-web-app-capable["']/i);
    expect(HTML, 'apple-mobile-web-app-title').toMatch(/name=["']apple-mobile-web-app-title["']/i);
  });
});

describe('no service worker', () => {
  it('is registered nowhere in index.html or src/', () => {
    const files = ['index.html'];
    const walk = (dir: string): void => {
      for (const name of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (name.name.startsWith('.')) continue;
        const p = `${dir}/${name.name}`;
        if (name.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk('src');

    const offenders = files.filter((f) => {
      const text = read(f);
      return /serviceWorker\s*\.\s*register|navigator\.serviceWorker|workbox|registerSW/.test(text);
    });
    expect(
      offenders,
      'a service worker means a player can be pinned to a stale build, which in a ' +
        'P2P game shows up as "we are in the same room and cannot see each other"',
    ).toEqual([]);
  });
});
