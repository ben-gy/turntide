# Turntide

**Draughts where a jump never kills — leap an enemy and it flips to your colour, so all 24 stones stay on the board.**

🎮 Play: https://turntide.benrichardson.dev

## What it is

Turntide is draughts with exactly one rule replaced, and the replacement changes everything downstream. **A jump does not capture — it converts.** You leap an adjacent enemy stone, land on the empty square beyond it, and the stone you jumped *stays exactly where it is and turns your colour*.

Nothing ever leaves the board. The stone count is a constant from the first move to the last, so the game is never about grinding an opponent down — it is about *allegiance*. Every jump is a two-stone swing (you gain one, they lose one), and the board is as crowded at the finish as at the start. Where draughts empties toward a quiet endgame, Turntide stays loud: the tide can turn on a single chain.

Three rules keep that from becoming noise. **Crowns don't farm** — a man that walks onto the far row crowns into a king, but a king that gets *flipped* loses its crown and converts as a plain man, so kings are scarce and cannot be manufactured. **Cooling** — a stone you just flipped can't be flipped straight back until it has sat through a turn, which stops two adjacent stones oscillating forever. And **the rout** — control 18 of the 24 stones and you win instantly, so a genuine collapse ends decisively instead of dribbling toward an even split.

Play it solo against the tide-reader AI at three strengths, or hand a friend a room code and play head-to-head with nothing between you but a browser.

## How to play

Draughts movement: men step diagonally forward one square; reach the far row to **crown a king**, which moves in every direction. Tap a stone to select it, then tap where it should land — or drag it there. A jump chain is built one hop at a time, so keep tapping to extend it.

- **Desktop:** click to select, click to move. `Esc` deselects, `P` pauses, `R` restarts.
- **Mobile:** tap-then-tap, or drag the stone onto its target. Everything is thumb-reachable and the site footer hides while a round is live.

**Goal:** control 18 of the 24 stones (30 of 40 on Floodmark), or leave your opponent with no legal move.

### Modes

| | **Tidepool** | **Skirmish** (default) | **Floodmark** |
|---|---|---|---|
| Board | 8×8, 24 stones | 8×8, 24 stones | 10×10, 40 stones |
| Rout at | 19 | 18 | 30 |
| Forced capture | **no** | yes | yes |
| Men jump backward | no | no | **yes** |

Each mode moves a *rule*, not a dial. **Tidepool** makes nothing compulsory, so the game turns positional and becomes about what you decline to take. **Skirmish** is the classic forced-capture tempo game. **Floodmark** lets men jump backward, so chains double back and turn whole regions over — it is the only mode where the per-turn flip cap ever actually binds.

## Multiplayer

Live peer-to-peer for 2 players, over a room code you can type or share as a link. **There is no game server.** Turntide has zero randomness and zero hidden information, which means both browsers can run the identical simulation — so the netcode is **lockstep**: peers exchange only `{from, path}` (the origin square and the landing squares) and each client re-derives the flips, crown-strips and cooling flags itself. No board state is ever transmitted.

That design makes the awkward cases cheap. **Host transfer is a state-wise no-op** — both peers already hold the same position, so a promoted peer simply picks up the turn clock and carries on. A **late joiner** replays the move list, which is a few dozen bytes. A peer who leaves hands the survivor a finished round and a results screen rather than a frozen board.

Sides **swap every round**, so whatever residual first-move edge exists alternates between players across a match instead of compounding on one of them.

A public signaling relay (and, where a direct connection is impossible, a TURN relay) brokers the initial WebRTC handshake — that is the only extra network traffic multiplayer introduces, and no data is stored on any server.

## Balance

Competitive games get simulated, not argued about. `tests/balance.test.ts` plays 400 seeded AI-vs-AI games per mode and asserts on the *shape* of the outcome — leader-holds curve, seat fairness, blowout rate, draw rate, termination — plus zero-tolerance mechanism audits over the simulation's event stream.

It overruled the design three times: the per-turn flip cap turned out not to be a balance lever at all (chains never got long enough for it to bind), doubling the cooling duration silently pushed one mode's first-player win rate to 66%, and a seat bias that looked real at n≈140 was pure noise — while a *different* one, on a 6×6 board, was real and got that board cut from the game. The full record is in the header of `src/modes.ts` and `tests/balance.test.ts`.

## Tech

- Vite 6 + vanilla TypeScript
- DOM/CSS rendering (crisp text, easy 44px tap targets, and `rotateY` gives the signature flip animation for free)
- Shared engine: [`@ben-gy/game-engine`](https://github.com/ben-gy/gh-game-engine) — P2P netcode, multi-round sessions, lobby, deterministic RNG, procedural audio, mobile hardening
- Vitest for the rules, the balance sim, the netcode contract, contrast and source hygiene
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## License

MIT
