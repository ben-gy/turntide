// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * main.ts — bootstrap and screens.
 *
 * One room per session. A rematch is a new ROUND NUMBER inside the living mesh,
 * never a leave-and-rejoin: Trystero memoizes joinRoom while leave() defers its
 * teardown, so a same-tick rejoin hands back a corpse and both players sit alone
 * in a room with the right code. `net.leave()` is called in exactly two places —
 * genuinely returning to the menu, and page unload.
 *
 * The screens are: menu, how to play (auto-shown once), room entry, lobby, the
 * game, and results. Every one of them except the game shows the footer, and
 * `body.playing` is what hides it, so the feedback trigger is reachable
 * everywhere it should be and nowhere it would be in the way.
 */

import { createNet, roomAppId, setTurnConfig, type Net } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type RoundInfo, type Rounds } from '@ben-gy/game-engine/rematch';
import {
  clearRoomInUrl,
  createLobby,
  createRoomEntry,
  normalizeRoomCode,
  setRoomInUrl,
} from '@ben-gy/game-engine/lobby';
import { createSfx } from '@ben-gy/game-engine/sound';
import { createStore } from '@ben-gy/game-engine/storage';
import { hardenViewport } from '@ben-gy/game-engine/mobile';

import './styles/main.css';

import { aiMove, STRENGTHS, STRENGTH_IDS, strengthOf, type Strength } from './ai';
import { createBoard, type BoardView } from './board';
import { createCountdown, type Countdown } from './countdown';
import { Game, seatsFor, type PlayerInfo } from './game';
import { MODES, MODE_IDS, DEFAULT_MODE, modeOf, type ModeId } from './modes';
import { createSession, type Session } from './session';
import { AMBER, TEAL, type Move, type Side } from './turntide';
import {
  applyPalette,
  defaultName,
  escapeHtml,
  formatClock,
  reasonLine,
  sideClass,
  sideName,
} from './ui';

const SLUG = 'turntide';

/**
 * Signaling relays — a deliberate game-side override of the engine's
 * `DEFAULT_RELAYS`, and it should be temporary.
 *
 * Measured during this build's two-peer smoke test: of the engine's six curated
 * relays, THREE were impaired at once. `wss://nostr.wine` answers reads but
 * REJECTS writes ("restricted: sign up ... to write events"), `wss://relay.damus.io`
 * was rate-limiting announces ("you are noting too much"), and
 * `wss://relay.nostr.band` did not answer at all. Peers announce over these, so a
 * write-restricted relay is not a degraded relay — it is a dead one that still
 * looks alive to a connection check. With half the list dead the two peers landed
 * on non-overlapping working subsets and never discovered each other.
 *
 * These are all write-open at time of writing. This is the wrapper the engine's
 * own guidance asks for when the package cannot express something (see its
 * DEPRECATED.md note in the factory repo); the real fix belongs in the engine's
 * shared list, and is logged in EXPANSION_IDEAS.md under "Engine" so one release
 * can fix the whole fleet instead of each game carrying its own list.
 */
const RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr.mom',
  'wss://nostr-pub.wellorder.net',
];
/** Per-turn budget in a live room. Long, because this is a thinking game — but
 *  finite, because a room that hangs on an absent player is worse than a rushed
 *  move. The host plays a legal move for a seat that runs out. */
const TURN_MS = 60_000;

const store = createStore(SLUG);
const reducedMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let muted = store.get<boolean>('muted', false);
const sfx = createSfx(muted);

let modeId: ModeId = modeOf(store.get<string>('mode', DEFAULT_MODE)).id;
let strengthId: Strength = strengthOf(store.get<string>('strength', 'currents')).id;

// ── app shell ───────────────────────────────────────────────────────────────

const app = document.getElementById('app')!;
app.innerHTML = `
  <main class="main-content" id="screen"></main>
  <footer class="site-footer">
    Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
    · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
  </footer>`;
const screen = document.getElementById('screen')!;

/** Every screen goes through here, so `playing` can never be left behind on the
 *  menu — which would hide the footer and the feedback entry point with it. */
function setScreen(html: string, playing = false): HTMLElement {
  screen.innerHTML = html;
  document.body.classList.toggle('playing', playing);
  screen.scrollTop = 0;
  return screen;
}

function unlockAudio(): void {
  try {
    sfx.unlock();
  } catch {
    /* audio stays silent — never a blocker */
  }
}
document.addEventListener('pointerdown', unlockAudio, { once: true });

function toast(message: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 2600);
}

// ── session-wide state ──────────────────────────────────────────────────────

let net: Net | null = null;
let rounds: Rounds | null = null;
let lobbyView: { destroy: () => void } | null = null;
let roomCode = '';

let game: Game | null = null;
let session: Session | null = null;
let board: BoardView | null = null;
let countdown: Countdown | null = null;
let botTimer: ReturnType<typeof setTimeout> | undefined;
let soloRound = 0;
let paused = false;

/** Rounds won this match, by player id — the thing that makes a rematch a match. */
const tally = new Map<string, number>();

/** `?room=` is honoured ONCE. Left in the URL it drags every later visit —
 *  from history, or a home-screen icon — back into a room that is long gone. */
const linkedRoom = new URLSearchParams(location.search).get('room');
let pendingRoom = linkedRoom ? normalizeRoomCode(linkedRoom) : '';
if (linkedRoom) clearRoomInUrl();

// ── boot ────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  applyPalette();
  try {
    // MUST happen before any mesh exists: Trystero builds one global offer pool
    // from whichever joinRoom fires first, so a turnless mesh created earlier
    // leaves the game room STUN-only in one direction.
    setTurnConfig(await getTurnConfig());
  } catch {
    // Fail open — STUN-only still connects for most pairs.
  }
  try {
    hardenViewport();
  } catch {
    /* non-fatal */
  }

  window.addEventListener('resize', () => board?.resize());
  window.addEventListener('pagehide', () => {
    try {
      void net?.leave();
    } catch {
      /* leaving on unload is best-effort */
    }
  });

  if (!store.get<boolean>('seenHowTo', false)) showHowTo(() => showMenu());
  else showMenu();
}

// ── menu ────────────────────────────────────────────────────────────────────

function showMenu(): void {
  teardownRound();
  const modeButtons = MODE_IDS.map((id) => {
    const m = MODES[id];
    return `<button type="button" class="pick mode-pick${id === modeId ? ' on' : ''}" data-mode="${id}">
      <span class="pick-name">${escapeHtml(m.name)}</span>
      <span class="pick-blurb">${escapeHtml(m.blurb)}</span>
    </button>`;
  }).join('');

  const strengthButtons = STRENGTH_IDS.map((id) => {
    const s = STRENGTHS[id];
    return `<button type="button" class="pick chip${id === strengthId ? ' on' : ''}" data-strength="${id}">
      <span class="pick-name">${escapeHtml(s.name)}</span>
      <span class="pick-blurb">${escapeHtml(s.blurb)}</span>
    </button>`;
  }).join('');

  setScreen(`
    <div class="menu">
      <header class="brand">
        <h1 class="brand-title">Turntide</h1>
        <p class="brand-sub">Draughts where a jump never kills — leap an enemy and it flips to your colour.</p>
      </header>
      <div class="menu-actions">
        <button type="button" class="btn primary" data-act="solo">Play solo</button>
        <button type="button" class="btn" data-act="friends">Play with friends</button>
      </div>
      <section class="panel">
        <h2 class="panel-title">Mode</h2>
        <div class="picks">${modeButtons}</div>
      </section>
      <section class="panel">
        <h2 class="panel-title">Solo opponent</h2>
        <div class="picks row">${strengthButtons}</div>
      </section>
      <div class="menu-links">
        <button type="button" class="btn ghost" data-act="howto">How to play</button>
        <button type="button" class="btn ghost" data-act="about">About</button>
        <button type="button" class="btn ghost" data-act="mute">${muted ? 'Sound off' : 'Sound on'}</button>
      </div>
    </div>`);

  screen.querySelectorAll<HTMLElement>('[data-mode]').forEach((el) =>
    el.addEventListener('click', () => {
      modeId = modeOf(el.dataset.mode).id;
      store.set('mode', modeId);
      showMenu();
    }),
  );
  screen.querySelectorAll<HTMLElement>('[data-strength]').forEach((el) =>
    el.addEventListener('click', () => {
      strengthId = strengthOf(el.dataset.strength).id;
      store.set('strength', strengthId);
      showMenu();
    }),
  );
  screen.querySelector('[data-act="solo"]')?.addEventListener('click', () => startSolo());
  screen.querySelector('[data-act="friends"]')?.addEventListener('click', () => enterMultiplayer());
  screen.querySelector('[data-act="howto"]')?.addEventListener('click', () => showHowTo(showMenu));
  screen.querySelector('[data-act="about"]')?.addEventListener('click', () => showAbout());
  screen.querySelector('[data-act="mute"]')?.addEventListener('click', () => {
    muted = !muted;
    sfx.setMuted(muted);
    store.set('muted', muted);
    showMenu();
  });
}

function showHowTo(onDone: () => void): void {
  setScreen(`
    <div class="sheet">
      <h2 class="sheet-title">How to play</h2>
      <p>Draughts, with one rule changed: <b>a jump never kills</b>. Leap an adjacent enemy and it
        <b>flips to your colour</b> and stays exactly where it is — so every stone stays on the
        board and every capture swings two.</p>
      <p>Men step diagonally forward. Reach the far row to <b>crown a king</b>, which moves in any
        direction. A king that gets flipped loses its crown, so kings cannot be farmed.</p>
      <p>A stone you just flipped is <b>cooling</b> — it carries a rim and cannot be flipped back
        until it has sat through one enemy turn.</p>
      <p>You can only flip so many stones in a turn, so the biggest chain you can see is often one
        link longer than you are allowed to take.</p>
      <p><b>Control enough of the board and you win instantly</b> — the tide bar marks both cliffs.
        A player with no legal move loses.</p>
      <p class="dim">Tap a stone then tap a target, or drag it there. On a jump chain, tap each
        landing square in turn; where stopping early is legal, a <b>Stop here</b> button appears.</p>
      <button type="button" class="btn primary" data-act="done">Got it</button>
    </div>`);
  screen.querySelector('[data-act="done"]')?.addEventListener('click', () => {
    store.set('seenHowTo', true);
    onDone();
  });
}

function showAbout(): void {
  setScreen(`
    <div class="sheet">
      <h2 class="sheet-title">About</h2>
      <p>Turntide is a small browser game — no accounts, no tracking, no server holding your game.</p>
      <p class="dim">Multiplayer is peer-to-peer: your moves travel directly between browsers.
        A free public signaling relay is used only to introduce the two peers to each other, and a
        relay server may carry the connection when a direct one cannot be made.</p>
      <p class="dim">Only the origin and landing squares of each move are ever sent — both players
        run the identical rules, so nothing else needs to cross the wire.</p>
      <div class="row-btns">
        <button type="button" class="btn" data-act="feedback">Send feedback</button>
        <button type="button" class="btn ghost" data-act="back">Back</button>
      </div>
    </div>`);
  screen.querySelector('[data-act="back"]')?.addEventListener('click', () => showMenu());
  screen.querySelector('[data-act="feedback"]')?.addEventListener('click', () => {
    try {
      (window as any).feedback?.open();
    } catch {
      toast('Feedback is unavailable right now.');
    }
  });
}

// ── solo ────────────────────────────────────────────────────────────────────

function startSolo(): void {
  teardownRound();
  soloRound++;
  const mode = modeOf(modeId);
  // Sides alternate between solo games so the opening edge, whatever it is,
  // does not always land on the same player.
  const humanSide: Side = soloRound % 2 === 1 ? TEAL : AMBER;
  const botSide: Side = humanSide === TEAL ? AMBER : TEAL;
  const players: PlayerInfo[] = [
    { id: 'you', name: 'You', side: humanSide, local: true, bot: false },
    { id: 'bot', name: strengthOf(strengthId).name, side: botSide, local: false, bot: true },
  ];

  game = new Game({ mode, players });
  session = createSession({
    game,
    round: soloRound,
    net: null,
    isHost: true,
    turnMs: 0, // no clock solo — a timer that plays for you is not a safety net
    onAdvance: afterAdvance,
    onEnd: () => showResults(),
  });

  renderGameScreen('Solo');
  startCountdown();
}

const botSeed = Math.floor(Math.random() * 0xffffffff) >>> 0;

function maybeBotTurn(): void {
  if (botTimer) clearTimeout(botTimer);
  const g = game;
  const s = session;
  if (!g || !s || g.over() || paused) return;
  if (!g.playerFor(g.turn)?.bot) return;
  // On a timeout so the player's own move paints before the bot thinks.
  botTimer = setTimeout(() => {
    if (!game || !session || game.over() || paused) return;
    const move = aiMove(game.pos, game.mode, strengthId, botSeed);
    if (!move) return;
    session.sendMove({ from: move.from, path: [...move.path] });
  }, 320);
}

// ── multiplayer ─────────────────────────────────────────────────────────────

function enterMultiplayer(): void {
  if (pendingRoom) {
    const code = pendingRoom;
    pendingRoom = '';
    joinRoom(code, false);
    return;
  }
  showRoomEntry();
}

function showRoomEntry(): void {
  // No panel class on the wrapper — createRoomEntry renders its own `.room-entry`
  // card, and nesting the two draws a box inside a box.
  const host = setScreen('<div class="room-entry-host"></div>');
  const container = host.querySelector<HTMLElement>('.room-entry-host')!;
  createRoomEntry({
    container,
    title: 'Play with friends',
    subtitle: 'Start a new room, or enter a code to join a friend.',
    onSubmit: (code, created) => joinRoom(code, created),
    onCancel: () => showMenu(),
  });
}

function joinRoom(code: string, created: boolean): void {
  roomCode = normalizeRoomCode(code);
  setRoomInUrl(roomCode);
  tally.clear();

  try {
    net = createNet(
      {
        appId: roomAppId(SLUG),
        roomId: roomCode,
        // ONLY the peer that minted the code claims the room. Anyone arriving by
        // link or typed code must defer, or two peers race to host.
        claimHost: created,
        relayUrls: RELAYS,
      },
      {
        onPeerLeave: (id) => {
          session?.peerLeft(id);
          updateHud();
        },
        onPeers: () => updateHud(),
        onHostChange: (_id, isSelfHost) => {
          // State-wise a no-op: both peers already hold the identical position.
          // All the promoted peer takes on is the clock and answering resyncs.
          session?.setHost(isSelfHost);
          updateHud();
        },
      },
    );
  } catch {
    toast('Could not open that room. Try again.');
    showMenu();
    return;
  }

  const name = store.get<string>('name', '') || defaultName(net.selfId);

  rounds = createRounds({
    net,
    playerName: name,
    minPlayers: 2,
    // The HOST's mode is what the room plays, frozen into the start. A guest
    // rendering its own pick would be a confident lie — and here the mode changes
    // the board SIZE, so disagreeing means playing two different games.
    roundOpts: () => modeId,
    onRound: (info) => startNetRound(info),
    onChange: () => onRoundsChange(),
  });

  showLobby();
}

function showLobby(): void {
  teardownRound();
  if (!net || !rounds) return showMenu();
  const host = setScreen('<div class="lobby-host"></div>');
  const container = host.querySelector<HTMLElement>('.lobby-host')!;
  lobbyView?.destroy();
  lobbyView = createLobby({
    container,
    net,
    rounds,
    roomCode,
    minPlayers: 2,
    maxPlayers: 2,
    onCancel: () => void leaveRoom(),
  });
}

async function leaveRoom(): Promise<void> {
  teardownRound();
  lobbyView?.destroy();
  lobbyView = null;
  rounds?.destroy();
  rounds = null;
  const leaving = net;
  net = null;
  clearRoomInUrl();
  try {
    // The one legitimate leave: genuinely going back to the menu.
    await leaving?.leave();
  } catch {
    /* already gone */
  }
  showMenu();
}

function startNetRound(info: RoundInfo): void {
  if (!net) return;
  const mode = modeOf(info.opts);

  if (!info.seated) {
    // The round started without us. lobby.ts already renders the spectator
    // state with a live ready toggle for the next round — leaving it mounted is
    // the whole fix for "I got ejected".
    return;
  }

  teardownRound();
  lobbyView?.destroy();
  lobbyView = null;

  const seats = seatsFor(info.players, info.round, net.selfId);
  game = new Game({ mode, players: seats });
  session = createSession({
    game,
    round: info.round,
    net,
    isHost: info.isHost,
    turnMs: TURN_MS,
    reset: () => new Game({ mode, players: seats }),
    onAdopt: (g) => {
      game = g;
      board?.setGame(g);
      updateHud();
    },
    onAdvance: afterAdvance,
    onClock: () => updateClock(),
    onTimeout: (side) => toast(`${sideName(side)} ran out of time.`),
    onEnd: () => showResults(),
    onError: (message) => toast(message),
  });

  renderGameScreen(`Room ${roomCode} · round ${info.round}`);
  startCountdown();
}

function onRoundsChange(): void {
  // The results screen shows who has voted and the countdown to an auto-start;
  // a silent wait is indistinguishable from a hang.
  const votes = screen.querySelector<HTMLElement>('.rematch-status');
  if (!votes || !rounds) return;
  const s = rounds.state();
  const waiting = s.present.length - s.votes.length;
  votes.textContent = s.startsInMs
    ? `Starting in ${Math.ceil(s.startsInMs / 1000)}s…`
    : s.votes.length
      ? `${s.votes.length} of ${s.present.length} ready${waiting > 0 ? ' — waiting' : ''}`
      : 'Tap Play again when you are ready.';
}

// ── the game screen ─────────────────────────────────────────────────────────

function renderGameScreen(subtitle: string): void {
  setScreen(
    `<div class="game">
      <div class="hud">
        <div class="hud-turn"><span class="turn-dot"></span><span class="turn-who">…</span></div>
        <div class="hud-clock" hidden></div>
        <button type="button" class="btn ghost hud-pause" data-act="pause">Pause</button>
      </div>
      <p class="hud-sub dim">${escapeHtml(subtitle)}</p>
      <div class="board-host"></div>
    </div>
    <div class="overlay pause-overlay" hidden>
      <div class="overlay-card">
        <h2>Paused</h2>
        <p class="pause-note dim"></p>
        <button type="button" class="btn primary" data-act="resume">Resume</button>
        <button type="button" class="btn" data-act="restart">Restart</button>
        <button type="button" class="btn ghost" data-act="howto">How to play</button>
        <button type="button" class="btn ghost" data-act="quit">Leave game</button>
      </div>
    </div>`,
    true,
  );

  const host = screen.querySelector<HTMLElement>('.board-host')!;
  board = createBoard({
    root: host,
    game: game!,
    sfx,
    reducedMotion,
    onMove: (move: Move) => playLocal(move),
    onChange: () => updateHud(),
  });
  board.resize();

  screen.querySelector('[data-act="pause"]')?.addEventListener('click', () => setPaused(true));
  screen.querySelector('[data-act="resume"]')?.addEventListener('click', () => setPaused(false));
  screen.querySelector('[data-act="howto"]')?.addEventListener('click', () => showHowTo(() => showMenu()));
  screen.querySelector('[data-act="restart"]')?.addEventListener('click', () => {
    if (net) return;
    soloRound--; // keep the side alternation honest across a restart
    startSolo();
  });
  screen.querySelector('[data-act="quit"]')?.addEventListener('click', () => {
    if (net) showLobby();
    else showMenu();
  });

  const restart = screen.querySelector<HTMLElement>('[data-act="restart"]');
  if (restart && net) restart.hidden = true;
  const note = screen.querySelector<HTMLElement>('.pause-note');
  if (note) {
    note.textContent = net
      ? 'The turn clock keeps running — your opponent is still waiting.'
      : 'Take your time.';
  }

  updateHud();
}

function startCountdown(): void {
  const root = screen.querySelector<HTMLElement>('.game');
  board?.setInteractive(false);
  if (!root) return;
  countdown?.cancel();
  countdown = createCountdown({
    root,
    sfx,
    reducedMotion,
    onDone: () => {
      countdown = null;
      board?.setInteractive(true);
      updateHud();
      maybeBotTurn();
    },
  });
}

function playLocal(move: Move): void {
  if (!session) return;
  const ok = session.sendMove({ from: move.from, path: [...move.path] });
  if (!ok) {
    try {
      sfx.play('hit');
    } catch {
      /* audio is best-effort */
    }
    board?.render();
  }
}

function afterAdvance(): void {
  board?.render();
  updateHud();
  maybeBotTurn();
}

function setPaused(on: boolean): void {
  paused = on;
  session?.setPaused(on);
  board?.setInteractive(!on && !countdown);
  const overlay = screen.querySelector<HTMLElement>('.pause-overlay');
  if (overlay) overlay.hidden = !on;
  if (!on) maybeBotTurn();
}

function updateHud(): void {
  const g = game;
  if (!g) return;
  const who = screen.querySelector<HTMLElement>('.turn-who');
  const dot = screen.querySelector<HTMLElement>('.turn-dot');
  if (!who || !dot) return;

  const side = g.turn;
  dot.className = `turn-dot ${sideClass(side)}`;
  const player = g.playerFor(side);
  if (g.over()) who.textContent = 'Round over';
  else if (player?.local) who.textContent = `Your turn · ${sideName(side)}`;
  else if (player?.bot) who.textContent = `${player.name} is reading the tide…`;
  else who.textContent = `${player?.name ?? sideName(side)} · ${sideName(side)}`;

  updateClock();
}

function updateClock(): void {
  const el = screen.querySelector<HTMLElement>('.hud-clock');
  if (!el || !session) return;
  const clock = session.clock();
  if (clock.turnMs <= 0) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = formatClock(clock.leftMs);
  el.classList.toggle('low', clock.leftMs <= 10_000);
}

// ── results ─────────────────────────────────────────────────────────────────

function showResults(): void {
  const g = game;
  if (!g) return showMenu();
  board?.setInteractive(false);
  countdown?.cancel();
  countdown = null;
  if (botTimer) clearTimeout(botTimer);

  const summary = g.summary();
  const localSide = g.localSide();
  const won = localSide !== null && summary.winner === localSide;
  const drew = summary.winner === 0;

  if (rounds) {
    // Reopen voting — a rematch is a vote plus a new round number, and the mesh
    // is never touched.
    rounds.finish();
    const winner = g.players.find((p) => p.side === summary.winner);
    if (winner) tally.set(winner.id, (tally.get(winner.id) ?? 0) + 1);
  }

  try {
    sfx.play(drew ? 'blip' : won ? 'win' : 'lose');
  } catch {
    /* audio is best-effort */
  }

  const rows = summary.players
    .map((p) => {
      const wins = tally.get(g.players.find((q) => q.side === p.side)?.id ?? '') ?? 0;
      return `<tr class="${sideClass(p.side)}${p.side === summary.winner ? ' win' : ''}">
        <th scope="row"><span class="turn-dot ${sideClass(p.side)}"></span>${escapeHtml(p.name)}</th>
        <td>${p.control}</td>
        <td>${p.kings}</td>
        <td>${p.converted}</td>
        <td>${p.bestChain}</td>
        <td>${p.turns}</td>
        ${rounds ? `<td class="tally">${wins}</td>` : ''}
      </tr>`;
    })
    .join('');

  const headline = drew ? 'Dead level' : won ? 'You win' : localSide === null ? 'Round over' : 'You lose';

  setScreen(`
    <div class="results">
      <h2 class="results-title ${drew ? '' : won ? 'good' : 'bad'}">${headline}</h2>
      <p class="results-reason">${escapeHtml(reasonLine(summary.reason, summary.winner))}</p>
      <table class="score">
        <thead><tr>
          <th scope="col">Player</th><th scope="col" title="Stones controlled">Stones</th>
          <th scope="col">Kings</th><th scope="col">Flipped</th>
          <th scope="col" title="Longest chain landed">Best</th><th scope="col">Turns</th>
          ${rounds ? '<th scope="col">Won</th>' : ''}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="dim missed">${
        summary.missedBest > 0
          ? `Biggest chain left on the table: <b>${summary.missedBest}</b> stones.`
          : 'Nobody left a bigger chain on the table.'
      }</p>
      ${rounds ? '<p class="rematch-status dim">Tap Play again when you are ready.</p>' : ''}
      <div class="row-btns">
        <button type="button" class="btn primary" data-act="again">Play again</button>
        <button type="button" class="btn" data-act="share">Share</button>
        <button type="button" class="btn ghost" data-act="feedback">Send feedback</button>
        ${rounds ? '<button type="button" class="btn ghost" data-act="lobby">Back to lobby</button>' : ''}
        <button type="button" class="btn ghost" data-act="menu">Menu</button>
      </div>
    </div>`);

  onRoundsChange();

  screen.querySelector('[data-act="again"]')?.addEventListener('click', () => {
    if (rounds) {
      rounds.vote();
      onRoundsChange();
    } else {
      startSolo();
    }
  });
  screen.querySelector('[data-act="share"]')?.addEventListener('click', () => void share(summary.players.find((p) => p.side === localSide)?.bestChain ?? 0, headline));
  screen.querySelector('[data-act="feedback"]')?.addEventListener('click', () => {
    try {
      (window as any).feedback?.open();
    } catch {
      toast('Feedback is unavailable right now.');
    }
  });
  screen.querySelector('[data-act="lobby"]')?.addEventListener('click', () => showLobby());
  screen.querySelector('[data-act="menu"]')?.addEventListener('click', () => {
    if (net) void leaveRoom();
    else showMenu();
  });
}

async function share(bestChain: number, headline: string): Promise<void> {
  const mode = game ? game.mode.name : MODES[DEFAULT_MODE].name;
  const text = `Turntide · ${mode} — ${headline}. Best chain: ${bestChain}.`;
  const url = 'https://turntide.benrichardson.dev/';
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Turntide', text, url });
      return;
    }
  } catch {
    /* cancelled — fall through to the clipboard */
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('Result copied');
  } catch {
    toast(text);
  }
}

// ── teardown ────────────────────────────────────────────────────────────────

function teardownRound(): void {
  if (botTimer) clearTimeout(botTimer);
  botTimer = undefined;
  paused = false;
  countdown?.cancel();
  countdown = null;
  session?.destroy();
  session = null;
  board?.destroy();
  board = null;
  game = null;
  document.body.classList.remove('playing');
}

void boot();

/** Exported for the browser console and for tests that drive the shell. */
export const _app = {
  showMenu,
  startSolo,
  get session(): Session | null {
    return session;
  },
  get game(): Game | null {
    return game;
  },
};

// Keep the side constants reachable from a debug console without a second import.
export { TEAL, AMBER };
