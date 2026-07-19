# Game Plan: Turntide

## Overview
- **Name:** Turntide
- **Repo name:** turntide
- **Tagline:** Draughts where a jump never kills — leap an enemy and it flips to your colour, so all 24 stones stay on the board.
- **Genre (directory category):** board

## Core Loop
Draughts, with one rule replaced. A jump does not remove the jumped stone — it **converts** it. You leap the adjacent enemy, land beyond it, and the stone you jumped **stays exactly where it is and turns your colour**. Nothing ever leaves the board, so the stone count is a constant and the only thing that moves is *allegiance*.

The consequence is the whole game. In draughts, capturing is subtraction and the board empties toward a quiet endgame. Here capturing is **transfer** — every jump is a two-point swing, and the board stays as crowded on the last move as the first. You are never grinding an opponent down; you are sloshing a fixed mass of material back and forth, and the tide can turn on one chain.

Three rules keep that from becoming noise:
- **Crowns don't farm.** A man that walks onto the far row crowns into a king (moves and jumps in every direction). But a king that gets **flipped loses its crown** — it converts as a plain man of its new colour. So kings are precious and cannot be manufactured by feeding a piece back and forth.
- **Cooling.** A just-converted stone is immune to being re-jumped until it has sat through one enemy turn. Without it, two stones adjacent to each other flip-flop forever and the game is a metronome. With it, every conversion buys you a guaranteed turn to consolidate — and gives your opponent a turn to build the answer.
- **The rout.** Control 18 of the 24 stones and you win instantly. A game where material only circulates would otherwise trend toward an endless even split; the rout threshold means a genuine collapse *ends*, decisively, instead of dribbling into a draw.

**Win:** reach the rout threshold, or leave your opponent with no legal move. **Lose:** the same, to you. Long games resolve on stones controlled at the turn cap.

**The tension moment-to-moment:** a jump chain is enormously swingy (each link is a 2-stone swing), so the per-turn **conversion cap** is the pressure valve — you can only flip so many stones in one turn, which means the huge cascade you can see is often one link longer than you are allowed to take. You are constantly choosing between taking the flips now and arranging a bigger, legal cascade next turn while your opponent is doing exactly the same thing to you.

## Controls
- **Desktop:** click a stone to select (legal destinations light up), click a destination to move. Arrow keys/Tab cycle selectable stones, Enter confirms. `Esc` deselects, `P` pause, `R` restart.
- **Mobile:** `@ben-gy/game-engine/drag` — **tap** a stone then tap a target (tap stays a first-class action), **or drag the stone onto the target** with the grab offset preserved and a 150–200ms snap. No D-pad (this is a board game — principle #19 routes it to `drag.ts`). Targets are the board cells themselves, sized by `minmax(0,1fr)` so they scale with the mode's board size and never drop below the 44px hit floor at 375px.

## Multiplayer
- **Mode:** live P2P (plus solo vs AI, always available).
- **If live P2P — shape:** **versus.** Justified rather than defaulted: the game's single mechanic *is* an act performed on an opponent's material — a flip has no meaning without someone to take it from. Co-op has nothing to convert (a shared side jumping its own stones is a no-op) and shared-world has no verb at all. This is one of the rare cases where versus is structural, not just the easy way to get a winner.
- **Players:** 2. **Topology: lockstep, not a snapshot star.** The game has **zero randomness and zero hidden information**, so both peers can run the identical simulation and the boards structurally cannot desync. Peers exchange only `{from, path}` — the origin square and the sequence of landing squares — and each client re-derives the flips, crown-strips and cooling flags from the same deterministic rules. **No board state is ever sent.**
- **Channels (≤12 bytes):** `mv` (a move: `{r, from, path}` where `r` is the round), `clk` (host's authoritative clock tick), `syn` (resync request → host replies with the move list).
- **Room entry:** `createRoomEntry(...)` — **Create a room** *or* **type a code → Join**. Invite link + QR are conveniences. `?room=` is honoured **once** and cleared via `clearRoomInUrl()`.
- **Late joiner:** the move list *is* the game state (a few dozen bytes), so a late joiner is sent the full move list on `syn` and replays it to the identical position. Spectates until the round ends, then joins the rematch vote.
- **What happens if the host leaves:** because peers are in lockstep, both already hold the identical position — host transfer is a **state-wise no-op**. The only authoritative thing the host owns is the **clock**, so the promoted peer's takeover is: adopt the last clock value, resume the `setInterval` tick, and start answering `syn`. Wired via `createNet({ onHostChange, onPeerLeave, onPeers })` → `session.setHost(true)`. Proven by `tests/takeover.test.ts` (a promoted client must drive the clock and be able to reach game-over) and by the manual host-leave smoke test.
- **Peer leaves mid-round:** the survivor is shown "opponent left", the round is awarded on current stones controlled, and they land on the **results screen** (never a frozen board — principle #9).

### End of round → rematch (MANDATORY)
"Play again" **never touches the room.** One `Net` for the session; `@ben-gy/game-engine/rematch` (`createRounds`) versions the rounds inside it. A rematch is a vote plus a new round number; the host broadcasts the new round with the frozen roster and the frozen `opts` (the mode).
- **While waiting:** the results screen shows who has voted, and once quorum is reached a **visible countdown** (`state().startsInMs`) — never unanimity-forever. The host can always **force start**.
- **If one declines or closes the tab:** the grace countdown expires and the round starts without them; a peer who left is dropped from the roster by `voters()`. No deadlock.
- **If the host leaves on the results screen:** the promoted peer inherits no tally, and `rematch.ts`'s `rq` resync makes the room re-declare so it can run the rematch itself.
- **Persists across rounds:** a running **match tally** (rounds won each), and **sides swap every round** so the first-move advantage — whatever the sim measures it to be — alternates rather than compounding.
- Results also offers **back to lobby** (which does *not* leave the room) and **menu** (which does, via `await net.leave()`).

## Solo
- **Vs the tide-reader AI:** alpha-beta over a conversion-aware evaluation, three strengths (Drifter / Currents / Riptide). Fully playable with no network at all.

**CUT from this build, and honestly so:** a "Rout Run" fewest-moves score-attack and a UTC "Daily Turn" were both in the original plan. Neither shipped — they were not in the required screen set and would have been scope creep on a run that spent its budget on the balance sim instead. They are good candidates for `EXPANSION_IDEAS.md` rather than claims in a README. Note that the game has **zero randomness in gameplay**, so a daily challenge would only ever seed the side assignment, never the board.

## Juice Plan
- **The flip is the whole show.** A converted stone does a 180° flip on its own axis (`rotateY`, 220ms, staggered ~60ms down the chain so a cascade reads as a *wave* rolling across the board), landing on its new colour with a brief rim-light pulse.
- **Screen shake** scaled to chain length (none for 1 flip, a real jolt at the cap) — zeroed under `prefers-reduced-motion`, where the flip degrades to a 120ms cross-fade.
- **Particles:** a small spray of the *losing* colour at each converted stone, settling into the winner's.
- **The tide bar** — a single horizontal bar of controlled stones, teal vs amber, animated on every flip. It is the primary feedback: you read the game state off the bar, not by counting. Rout thresholds are marked on it so you can see the cliff coming.
- **Sound** (`@ben-gy/game-engine/sound`): `select` (soft tick), `move` (slide), `flip` (a rising pitched blip per link, pitch climbing with chain index so a 4-chain is an arpeggio), `crown` (bright chime), `cool` (dull thud on an illegal re-jump attempt), `rout` (a swell), `lose`.
- **Cooling is legible:** cooling stones carry a frost rim and are visibly non-targetable when you select an attacker.
- Tweened, eased motion throughout; nothing snaps except the crown, which snaps on purpose.

## Style Direction
**Vibe:** clean-minimal with a cold coastal palette — closer to a well-made physical board than to neon.
**Palette:** ground `#0e1720`, board light `#1d2b38` / dark `#16212c`, **tide-teal `#2ec4b6`** vs **amber `#ff9f1c`**. Teal/amber is a deliberately colour-blind-safe pair (it separates on both hue *and* luminance, unlike red/green), and stones additionally carry a **shape cue** — kings get an engraved ring — so colour is never the only channel. Every meaningful colour is pinned ≥3:1 against every surface it sits on by `tests/contrast.test.ts` (principle #22).
**Theme:** dark.
**Reference feel:** the tactility of a good physical draughts set; the flip-legibility of Reversi.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** **DOM/CSS** — a grid board with transform-animated stones. Correct per the architecture guide for board games (crisp text, trivial 44px hit targets, accessible by default, and `rotateY` gives the flip for free).
- **Engine modules imported from `@ben-gy/game-engine` (v1.1.0 — depend, never copy):** net, rematch, turn, lobby, rng, sound, storage, drag, mobile (+ mobile.css). Plus the generated feedback widget and a local countdown.
- **Persistence:** localStorage via `@ben-gy/game-engine/storage` — settings (mute, reduced motion, AI strength, last mode), Rout Run best, daily result, "how to play" seen.

## Modes (3, with genuine spread — principle #14) — AS SHIPPED, after measurement
The host's pick travels **frozen inside the round start** via `roundOpts()`; guests render `state().hostOpts`, never their own. `modeOf()` validates any id off the wire and falls back rather than passing `undefined` to the generator.

| | **Tidepool** | **Skirmish** (default) | **Floodmark** |
|---|---|---|---|
| Board | 8×8, 24 stones | 8×8, 24 stones | 10×10, 40 stones |
| Rout | 19 of 24 | 18 of 24 | 30 of 40 |
| Flip cap / turn | 2 | 3 | 5 |
| Cooling | 1 | 1 | 1 |
| Forced capture | **OFF** | ON | ON |
| Men jump backward | no | no | **YES** |

Each moves a **rule**, not a dial. **Tidepool** — nothing is ever compulsory, so the game becomes positional and is about what you *decline* to take. **Skirmish** — the classic forced-capture tempo game. **Floodmark** — men jump backward, so a chain can double back and turn a whole region over instead of running out of board; it is the only mode where the flip cap ever binds.

Tidepool and Skirmish deliberately **share a board**: the contrast is the law, not the geometry. That was not the original plan (see below).

## Balance (principle #18 — MEASURED, and it overruled me three times)
`tests/balance.test.ts` runs 400 fixed-seed AI-vs-AI games per mode and asserts on the *shape* of the outcome. The baseline was taken **before** any tuning, and three of this plan's own claims did not survive it:

1. **The flip cap was the headline balance lever. It is not a lever at all.** Sweeping it over 2/3/4/5/6 gave *byte-identical* results on both big boards — with forward-only jumps a chain runs out of board after ~3 links, so the cap never binds. Floodmark's original pitch ("cap 5 means one chain can swing ten stones") was simply false and would have shipped as copy for a mechanic that never fires. The fix was to find the lever that *does* create cascades: **men jumping backward** (big chains ~2% → ~8% of turns, and the only setting under which the cap binds). It is confined to Floodmark because on the 8×8 it took blowouts 33% → 63%, while on the 10×10 it costs only 10% → 18%.
2. **Cooling was to be doubled in Tidepool to make it positional.** The control arm (cooling 0) showed cooling barely moves any outcome metric — its real, modest job is damping repetition (repeats 318→250 on Skirmish, 204→120 on Floodmark). Worse, **cooling 2 took Skirmish's first-player win rate to 66%**: a rule added to flavour one mode was breaking seat fairness in another. Cooling is now 1 globally and pinned by a test.
3. **Tidepool was a 6×6, and the seat bias nearly got designed around.** Early runs read 37%/43% for the first mover, and the story — "in a conversion game, whoever commits first gets punished" — is very plausible. But the *same* Skirmish config then measured 41%, 49% and 54% across three seed families: at n≈140 the 95% interval is ±8 points, so none of it meant anything. Raising n to 400 and replicating across three independent seed families showed Tidepool's edge **was** real (39.9% / 40.4% / 40.8%) while Skirmish's was not. Six candidate fixes were then measured; changing the rout, the cap, forcing capture and backward jumps **all failed** (35–43%). Only giving Tidepool the full 8×8 fixed it — **49.2% / 50.3%** — and improved every other metric too (blowouts 49%→22%, draws 2%→1%).

**The generalisable part:** the first three "obvious" diagnoses were all wrong, and the one measurement that looked most damning was noise. Sample size *is* a finding.

What held up throughout: **the leader curve is flat and slightly declining in every mode** under competent play (Skirmish ~57% at ply 30, ~36% at ply 45). An early lead genuinely is not a won game, because material only circulates — which is the property the whole design was for.

Also confirmed: **greedy chain-grabbing loses** (0–13% against a searching bot), so the snowball the design feared does not exist. Mechanism audits (principle #21) run at zero tolerance over the sim's event stream: cap violations, forced-capture violations and stone-conservation violations are all **0**.

## Non-Goals
- No flying kings (single-step kings only) — keeps the branching factor sane for the AI and the cascade legible.
- No 6x6 board (it was measured unfair for the first mover and cut — see Balance).
- No 3–4 player variant, no online ranked ladder, no move takeback, no PGN-style import/export.
- No service worker (principle #17).

## How To Play (player-facing copy)
> Draughts, with one rule changed: **a jump never kills.** Leap an adjacent enemy and it **flips to your colour** and stays put — so all 24 stones stay on the board and every capture swings two at once.
> Men step diagonally forward; reach the far row to **crown a king**, which moves any direction. A king that gets flipped **loses its crown**, so kings can't be farmed.
> A stone you just flipped is **cooling** — it can't be flipped straight back until it's sat through a turn.
> **Control 18 of the 24 stones and you win instantly.**
