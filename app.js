import { Chess } from './vendor/chess.js';

/* ---------- Motor UCI (Stockfish en Web Worker) ---------- */

class Engine {
  constructor() {
    this.worker = new Worker('vendor/stockfish-19-lite-single.js');
    this.waiter = null;
    this.chain = Promise.resolve();
    this.gen = 0;
    this.worker.onmessage = (e) => {
      if (this.waiter) this.waiter(typeof e.data === 'string' ? e.data : String(e.data));
    };
    this.ready = this.#run('uci', 'uciok');
  }

  post(cmd) { this.worker.postMessage(cmd); }

  #run(cmd, until) {
    return new Promise((resolve) => {
      this.waiter = (line) => {
        if (line.startsWith(until)) { this.waiter = null; resolve(line); }
      };
      this.post(cmd);
    });
  }

  #enqueue(fn) {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  setOptions(opts) {
    const gen = this.gen;
    return this.#enqueue(async () => {
      await this.ready;
      if (gen !== this.gen) return;
      for (const [k, v] of Object.entries(opts)) this.post(`setoption name ${k} value ${v}`);
      await this.#run('isready', 'readyok');
    });
  }

  /** Devuelve { best, lines:[{score, pv}] } o null si se abortó. score: centipeons desde el lado a mover. */
  search(fen, go, multipv = 1) {
    const gen = this.gen;
    return this.#enqueue(async () => {
      if (gen !== this.gen) return null;
      await this.ready;
      this.post(`setoption name MultiPV value ${multipv}`);
      this.post(`position fen ${fen}`);
      const byPv = {};
      const best = await new Promise((resolve) => {
        this.waiter = (line) => {
          if (line.startsWith('bestmove')) { this.waiter = null; resolve(line.split(' ')[1]); return; }
          if (!line.startsWith('info') || !line.includes(' pv ') || /bound/.test(line)) return;
          const sc = line.match(/score (cp|mate) (-?\d+)/);
          if (!sc) return;
          const idx = Number((line.match(/multipv (\d+)/) || [0, 1])[1]);
          const n = Number(sc[2]);
          byPv[idx] = {
            score: sc[1] === 'cp' ? n : Math.sign(n || 1) * (10000 - Math.abs(n) * 10),
            mate: sc[1] === 'mate' ? n : null,
            pv: line.split(' pv ')[1].trim().split(' '),
          };
        };
        this.post(`go ${go}`);
      });
      if (gen !== this.gen) return null;
      const lines = Object.keys(byPv).sort((a, b) => a - b).map((k) => byPv[k]);
      return { best, lines };
    });
  }

  abort() { this.gen++; this.post('stop'); }
}

/* ---------- Utilidades ---------- */

const PIECE_GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const PIECE_NAME = { p: 'un peón', n: 'un caballo', b: 'un alfil', r: 'una torre', q: 'la dama', k: 'el rey' };
const PIECE_NAME_SHORT = { p: 'peón', n: 'caballo', b: 'alfil', r: 'torre', q: 'dama', k: 'rey' };
const FILES = 'abcdefgh';

const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1000, Math.min(1000, cp)))) - 1);
const accuracy = (drop) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));

const CLASSES = {
  best: { label: 'Mejor jugada', sym: '★', css: 'c-best' },
  good: { label: 'Buena jugada', sym: '', css: 'c-good' },
  inacc: { label: 'Imprecisión', sym: '?!', css: 'c-inacc' },
  mistake: { label: 'Error', sym: '?', css: 'c-mistake' },
  blunder: { label: 'Error grave', sym: '??', css: 'c-blunder' },
};

function classify(drop, isBest) {
  if (isBest || drop < 1) return 'best';
  if (drop < 5) return 'good';
  if (drop < 10) return 'inacc';
  if (drop < 20) return 'mistake';
  return 'blunder';
}

const uciParts = (u) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });

function tryMove(fen, uci) {
  const g = new Chess(fen);
  try { return { g, mv: g.move(uciParts(uci)) }; } catch { return null; }
}

/** Explica por qué el rival puede castigar la jugada. */
function describeRefutation(fenAfter, refUci, lines) {
  const top = lines && lines[0];
  if (top && top.mate !== null && top.mate > 0) return `Permite mate en ${top.mate}.`;
  const r = tryMove(fenAfter, refUci);
  if (!r) return '';
  const { mv, g } = r;
  const parts = [];
  if (mv.captured) parts.push(`el rival captura ${PIECE_NAME[mv.captured]} en ${mv.to}`);
  if (g.isCheckmate()) parts.push('da mate');
  else if (g.isCheck()) parts.push('da jaque');
  if (!parts.length) parts.push(`el rival responde ${mv.san}, con ventaja`);
  const s = parts.join(' y ');
  return `Tras tu jugada, ${s} (${mv.san}).`;
}

function describeBest(fenBefore, bestUci, mate) {
  const r = tryMove(fenBefore, bestUci);
  if (!r) return '';
  const { mv, g } = r;
  let why = '';
  if (mate !== null && mate > 0) why = `, que lleva a mate en ${mate}`;
  else if (g.isCheckmate()) why = ' (mate)';
  else if (mv.captured) why = `, ganando ${PIECE_NAME[mv.captured]}`;
  else if (g.isCheck()) why = ', con jaque';
  else if (mv.isKingsideCastle() || mv.isQueensideCastle()) why = ', poniendo tu rey a salvo';
  return `Mejor era ${mv.san}${why}.`;
}

/* ---------- Estado ---------- */

const GOAL = 2000; // nivel objetivo: suficiente para ganar a casi cualquiera en la calle
const STORE_KEY = 'ruta3000';
const store = (() => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
})();
const saveStore = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* sin almacenamiento */ } };

const $ = (id) => document.getElementById(id);
const analysis = new Engine();
const opponent = new Engine();

let game = new Chess();
let playerColor = 'w';
let elo = store.nextElo || 1600;
let records = [];       // una entrada por jugada (ply)
let selected = null;
let lastMove = null;
let thinking = false;
let over = false;
let session = 0;
let prePromise = null;  // análisis de la posición actual (turno del jugador)
let hintLevel = 0;
let hintsUsed = 0;
let hintMove = null;
let evalWhite = null;   // cp desde blancas
let pendingPromo = null;
const pendingEvals = new Set();

/* ---------- Render ---------- */

function squareName(file, rank) { return FILES[file] + (rank + 1); }

function renderBoard() {
  const board = $('board');
  const flip = playerColor === 'b';
  const b = game.board();
  const legal = selected ? game.moves({ square: selected, verbose: true }) : [];
  const targets = new Map(legal.map((m) => [m.to, m]));
  const kingInCheck = game.isCheck() ? game.turn() : null;
  let html = '';
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const rank = flip ? i : 7 - i;
      const file = flip ? 7 - j : j;
      const sq = squareName(file, rank);
      const piece = b[7 - rank][file];
      const cls = ['sq', (file + rank) % 2 === 0 ? 'd' : 'l'];
      if (lastMove && (lastMove.from === sq || lastMove.to === sq)) cls.push('last');
      if (selected === sq) cls.push('sel');
      if (hintMove && hintLevel >= 2 && hintMove.slice(0, 2) === sq) cls.push('hintfrom');
      if (piece && piece.type === 'k' && piece.color === kingInCheck) cls.push('chk');
      let inner = '';
      if (targets.has(sq)) inner += piece || targets.get(sq).flags.includes('e') ? '<span class="ring"></span>' : '<span class="dot"></span>';
      if (piece) inner += `<span class="pc ${piece.color}">${PIECE_GLYPH[piece.type]}</span>`;
      if (j === 0) inner += `<span class="coord r">${rank + 1}</span>`;
      if (i === 7) inner += `<span class="coord f">${FILES[file]}</span>`;
      html += `<div class="${cls.join(' ')}" data-sq="${sq}" role="gridcell">${inner}</div>`;
    }
  }
  board.innerHTML = html;
  renderArrow();
}

function renderArrow() {
  const svg = $('arrows');
  svg.querySelectorAll('line').forEach((n) => n.remove());
  if (!hintMove || hintLevel < 3) return;
  const flip = playerColor === 'b';
  const pos = (sq) => {
    const f = FILES.indexOf(sq[0]); const r = Number(sq[1]) - 1;
    return [flip ? 7 - f + 0.5 : f + 0.5, flip ? r + 0.5 : 7 - r + 0.5];
  };
  const [x1, y1] = pos(hintMove.slice(0, 2));
  const [x2, y2] = pos(hintMove.slice(2, 4));
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  Object.entries({ x1, y1, x2, y2, stroke: '#3b82f6', 'stroke-width': 0.18, 'stroke-opacity': 0.85, 'marker-end': 'url(#ah)', 'stroke-linecap': 'round' })
    .forEach(([k, v]) => line.setAttribute(k, v));
  svg.appendChild(line);
}

function playerTags() {
  const opp = playerColor === 'w' ? 'Negras' : 'Blancas';
  const me = playerColor === 'w' ? 'Blancas' : 'Negras';
  const oppCol = playerColor === 'w' ? 'b' : 'w';
  $('tagTop').innerHTML = `<span>Stockfish 19 · ${opp}</span><span class="muted">ELO ${elo >= 3190 ? 'máx.' : elo}${thinking ? ' · pensando…' : ''}</span>`;
  $('tagBottom').innerHTML = `<span>Tú · ${me}</span><span class="muted">${capturedText(oppCol)}</span>`;
}

function capturedText(oppCol) {
  const taken = [];
  for (const r of records) if (r.captured && r.color !== oppCol) taken.push(PIECE_GLYPH[r.captured]);
  return taken.join('');
}

function renderStatus() {
  let text;
  if (over) text = $('status').dataset.result || 'Partida terminada';
  else if (game.turn() === playerColor) text = game.isCheck() ? '¡Estás en jaque! Tu turno.' : 'Tu turno.';
  else text = 'Stockfish está pensando…';
  $('status').innerHTML = `<strong>${text}</strong>`;
  $('btnUndo').disabled = over || thinking || !records.some((r) => r.color === playerColor);
  $('btnHint').disabled = over || thinking || game.turn() !== playerColor;
  $('btnResign').disabled = over;
  playerTags();
}

function renderMoves() {
  const el = $('movelist');
  let html = '';
  for (let i = 0; i < records.length; i += 2) {
    html += `<span class="n">${i / 2 + 1}.</span>`;
    for (const r of [records[i], records[i + 1]]) {
      if (!r) { html += '<span></span>'; continue; }
      const c = r.color === playerColor && r.cls ? CLASSES[r.cls] : null;
      const badge = c && c.sym ? `<span class="badge ${c.css}">${c.sym}</span>` : '';
      html += `<span class="m">${r.san}${badge}</span>`;
    }
  }
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

function renderEval() {
  $('evalbar').hidden = !$('showEval').checked;
  if (evalWhite === null) return;
  $('evalfill').style.height = `${100 - winPct(evalWhite)}%`;
}

function renderRoad() {
  const beaten = store.beaten || 0;
  $('roadFill').style.width = `${Math.max(0, Math.min(100, ((beaten - 1320) / (GOAL - 1320)) * 100))}%`;
  $('roadText').textContent = beaten
    ? `Mayor nivel que has vencido: ${beaten}. Meta: ${GOAL}.`
    : 'Aún no has vencido a ningún nivel. Meta: ' + GOAL + '.';
  document.querySelectorAll('#presets button').forEach((b) => b.classList.toggle('on', Number(b.dataset.elo) === elo));
  $('elo').value = elo;
  $('eloOut').textContent = elo;
}

function renderAll() {
  renderBoard(); renderStatus(); renderMoves(); renderEval(); renderRoad();
}

function showCoach(html) { $('coach').innerHTML = `<h2>Entrenador</h2>${html}`; }

/* ---------- Flujo de juego ---------- */

function startTurn() {
  if (over || game.turn() !== playerColor) return;
  hintLevel = 0; hintMove = null;
  const sid = session;
  prePromise = analysis.search(game.fen(), 'depth 14', 3);
  prePromise.then((r) => {
    if (!r || sid !== session || !r.lines[0]) return;
    evalWhite = r.lines[0].score * (game.turn() === 'w' ? 1 : -1);
    renderEval();
  });
}

function endGame(result) {
  over = true; thinking = false;
  const sid = session;
  $('status').dataset.result = result.text;
  renderAll();
  if (result.win !== null) {
    store.played = (store.played || 0) + 1;
    if (result.win === 'player') {
      store.beaten = Math.max(store.beaten || 0, elo);
      store.nextElo = Math.min(3190, elo + 100);
    } else if (result.win === 'engine') {
      store.nextElo = Math.max(1320, elo - 100);
    } else store.nextElo = elo;
    saveStore();
    renderRoad();
  }
  $('review').hidden = false;
  $('review').innerHTML = '<h2>Analizando la partida…</h2>';
  Promise.all([...pendingEvals]).then(() => { if (sid === session) renderReview(result); });
}

function checkOver() {
  if (!game.isGameOver()) return false;
  if (game.isCheckmate()) {
    const playerWon = game.turn() !== playerColor;
    endGame({ text: playerWon ? '¡Jaque mate! Ganaste.' : 'Jaque mate. Gana Stockfish.', win: playerWon ? 'player' : 'engine' });
  } else {
    const why = game.isStalemate() ? 'Tablas por ahogado.' : game.isThreefoldRepetition() ? 'Tablas por repetición.'
      : game.isInsufficientMaterial() ? 'Tablas por material insuficiente.' : 'Tablas.';
    endGame({ text: why, win: 'draw' });
  }
  return true;
}

function recordMove(mv) {
  records.push({
    color: mv.color, san: mv.san, uci: mv.from + mv.to + (mv.promotion || ''),
    captured: mv.captured, fenBefore: mv.before, fenAfter: mv.after,
  });
  lastMove = { from: mv.from, to: mv.to };
}

function attemptMove(from, to, promotion) {
  const prePromiseAtMove = prePromise;
  let mv;
  try { mv = game.move({ from, to, promotion }); } catch { return false; }
  selected = null; hintMove = null; hintLevel = 0;
  recordMove(mv);
  const rec = records[records.length - 1];
  const ev = evaluateMove(rec, prePromiseAtMove);
  pendingEvals.add(ev);
  ev.finally(() => pendingEvals.delete(ev));
  if (!checkOver()) {
    renderAll();
    engineMove();
  }
  return true;
}

async function evaluateMove(rec, pre) {
  const sid = session;
  const preRes = await pre;
  if (!preRes || sid !== session || rec.dead || !preRes.lines[0]) return;
  const best = preRes.lines[0];
  rec.bestUci = best.pv[0];
  rec.preScore = best.score;
  let after; let refute = null; let refLines = null;
  if (rec.uci === rec.bestUci) {
    after = best.score;
  } else {
    const g = new Chess(rec.fenAfter);
    if (g.isCheckmate()) after = 10000;
    else if (g.isGameOver()) after = 0;
    else {
      const post = await analysis.search(rec.fenAfter, 'depth 14', 1);
      if (!post || sid !== session || rec.dead || !post.lines[0]) return;
      after = -post.lines[0].score;
      refute = post.lines[0].pv[0];
      refLines = post.lines;
    }
  }
  const drop = Math.max(0, winPct(best.score) - winPct(after));
  rec.drop = drop;
  rec.acc = accuracy(drop);
  rec.cls = classify(drop, rec.uci === rec.bestUci);
  rec.bestMate = best.mate;
  rec.explain = refute ? describeRefutation(rec.fenAfter, refute, refLines) : '';
  renderMoves();
  showFeedback(rec);
}

function showFeedback(rec) {
  const c = CLASSES[rec.cls];
  const bad = rec.cls === 'mistake' || rec.cls === 'blunder';
  let html = `<p><span class="badge ${c.css}">${c.sym || '✓'} ${c.label}</span> <strong>${rec.san}</strong></p>`;
  if (rec.cls === 'best') {
    html += `<p class="muted">Coincide con la elección del motor. Sigue así.</p>`;
  } else {
    if (rec.explain && rec.cls !== 'good') html += `<p>${rec.explain}</p>`;
    if (rec.cls !== 'good' || rec.drop >= 2) html += `<p>${describeBest(rec.fenBefore, rec.bestUci, rec.bestMate)}</p>`;
    if (rec.cls === 'good') html += `<p class="muted">Sólida, aunque había algo ligeramente mejor.</p>`;
  }
  if (bad) {
    html += `<div class="coach-actions"><button id="btnRetry" class="primary">Deshacer y reintentar</button></div>
      <p class="muted small">Antes de mover: ¿qué amenaza el rival? ¿Alguna captura o jaque que pase por alto?</p>`;
  }
  showCoach(html);
  const retry = $('btnRetry');
  if (retry) retry.onclick = undo;
}

async function engineMove() {
  const sid = session;
  thinking = true; renderStatus();
  const t = elo >= 2600 ? 1200 : 700;
  const res = await opponent.search(game.fen(), `movetime ${t}`);
  if (!res || sid !== session) return;
  thinking = false;
  const mv = game.move(uciParts(res.best));
  recordMove(mv);
  if (!checkOver()) { renderAll(); startTurn(); }
}

function newGame() {
  session++;
  analysis.abort(); opponent.abort();
  game = new Chess(); records = []; selected = null; lastMove = null; thinking = false; over = false;
  hintLevel = 0; hintMove = null; hintsUsed = 0; evalWhite = null; pendingPromo = null;
  $('promo').hidden = true; $('review').hidden = true;
  delete $('status').dataset.result;
  const pick = $('color').value;
  playerColor = pick === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : pick;
  opponent.setOptions(elo >= 3190 ? { UCI_LimitStrength: false } : { UCI_LimitStrength: true, UCI_Elo: elo });
  showCoach('<p class="muted">Haz tu primera jugada. Te diré qué tan buena fue.</p>');
  renderAll();
  if (playerColor === 'b') engineMove(); else startTurn();
}

function undo() {
  if (over || thinking) return;
  while (records.length) {
    const r = records.pop();
    r.dead = true;
    game.undo();
    if (r.color === playerColor) break;
  }
  analysis.abort();
  selected = null;
  const last = records[records.length - 1];
  lastMove = last ? { from: last.uci.slice(0, 2), to: last.uci.slice(2, 4) } : null;
  showCoach('<p class="muted">Jugada deshecha. Inténtalo de nuevo.</p>');
  renderAll();
  startTurn();
}

async function hint() {
  if (over || thinking || game.turn() !== playerColor) return;
  if (hintLevel === 0) hintsUsed++;
  const res = await prePromise;
  if (!res || !res.lines[0]) return;
  hintMove = res.lines[0].pv[0];
  hintLevel = Math.min(3, hintLevel + 1);
  const piece = game.get(hintMove.slice(0, 2));
  if (hintLevel === 1) showCoach(`<p><strong>Pista 1/3:</strong> la mejor jugada la hace ${PIECE_NAME[piece.type]}. Pulsa «Pista» para más detalle.</p>`);
  if (hintLevel === 2) showCoach(`<p><strong>Pista 2/3:</strong> mueve ${PIECE_NAME[piece.type]} de ${hintMove.slice(0, 2)}.</p>`);
  if (hintLevel === 3) {
    const r = tryMove(game.fen(), hintMove);
    showCoach(`<p><strong>Pista 3/3:</strong> ${r ? r.mv.san : hintMove} (${hintMove.slice(0, 2)} → ${hintMove.slice(2, 4)}).</p>`);
  }
  renderBoard();
}

function resign() {
  if (over) return;
  endGame({ text: 'Te rendiste. Gana Stockfish.', win: 'engine' });
}

/* ---------- Revisión de la partida ---------- */

function renderReview(result) {
  const mine = records.filter((r) => r.color === playerColor && r.cls);
  const el = $('review');
  el.hidden = false;
  if (!mine.length) { el.innerHTML = `<h2>${result.text}</h2><p class="muted">Partida demasiado corta para analizar.</p>`; return; }
  const count = (k) => mine.filter((r) => r.cls === k).length;
  const avg = (arr) => (arr.length ? arr.reduce((s, r) => s + r.acc, 0) / arr.length : null);
  const acc = avg(mine);
  const opening = avg(mine.slice(0, 10));
  const later = avg(mine.slice(10));
  const worst = [...mine].filter((r) => r.cls === 'mistake' || r.cls === 'blunder').sort((a, b) => b.drop - a.drop).slice(0, 3);

  const tips = [];
  if (count('blunder') >= 2) tips.push('Varios errores graves: antes de cada jugada, comprueba capturas, jaques y amenazas del rival (rutina «CCA»).');
  if (opening !== null && later !== null && opening - later > 15) tips.push('Tu precisión cae después de la apertura: practica finales y planes de medio juego.');
  if (opening !== null && opening < 70) tips.push('Apertura floja: desarrolla piezas, controla el centro y enroca pronto.');
  if (hintsUsed > 3) tips.push('Usaste muchas pistas; intenta calcular 2-3 jugadas tú antes de pedirlas.');
  if (!tips.length) tips.push(result.win === 'player' ? 'Buena partida. Sube de nivel para seguir progresando.' : 'Partida sólida. Repite el nivel hasta ganar con comodidad.');

  const next = store.nextElo || elo;
  el.innerHTML = `
    <h2>${result.text}</h2>
    <div class="review-stats">
      <div><b>${Math.round(acc)}%</b>precisión</div>
      <div><b>${count('best')}</b>mejores</div>
      <div><b>${count('inacc')}</b>imprec.</div>
      <div><b>${count('mistake')}</b>errores</div>
      <div><b>${count('blunder')}</b>graves</div>
    </div>
    ${worst.length ? `<p><strong>Jugadas a revisar</strong></p><ul>${worst.map((r) =>
      `<li>${Math.floor(records.indexOf(r) / 2) + 1}. ${r.san} — ${describeBest(r.fenBefore, r.bestUci, r.bestMate)}</li>`).join('')}</ul>` : ''}
    <p><strong>Consejos</strong></p><ul>${tips.map((t) => `<li>${t}</li>`).join('')}</ul>
    <div class="coach-actions"><button id="btnNext" class="primary">Siguiente partida (ELO ${next})</button></div>`;
  $('btnNext').onclick = () => { elo = next; newGame(); };
}

/* ---------- Interacción ---------- */

function onBoardClick(e) {
  const cell = e.target.closest('.sq');
  if (!cell || over || thinking || pendingPromo || game.turn() !== playerColor) return;
  const sq = cell.dataset.sq;
  if (selected) {
    const moves = game.moves({ square: selected, verbose: true }).filter((m) => m.to === sq);
    if (moves.length) {
      if (moves[0].promotion) { askPromotion(selected, sq); return; }
      attemptMove(selected, sq);
      return;
    }
  }
  const p = game.get(sq);
  selected = p && p.color === playerColor && selected !== sq ? sq : null;
  renderBoard();
}

function askPromotion(from, to) {
  pendingPromo = { from, to };
  const box = $('promo');
  box.innerHTML = ['q', 'r', 'b', 'n'].map((t) =>
    `<button data-p="${t}" title="${PIECE_NAME_SHORT[t]}"><span class="pc ${playerColor}">${PIECE_GLYPH[t]}</span></button>`).join('');
  box.hidden = false;
}

$('promo').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !pendingPromo) return;
  const { from, to } = pendingPromo;
  pendingPromo = null;
  $('promo').hidden = true;
  attemptMove(from, to, b.dataset.p);
});

$('board').addEventListener('click', onBoardClick);
$('btnNew').onclick = newGame;
$('btnUndo').onclick = undo;
$('btnHint').onclick = hint;
$('btnResign').onclick = resign;
$('showEval').onchange = renderEval;
$('elo').oninput = (e) => { elo = Number(e.target.value); renderRoad(); };
$('elo').onchange = newGame;

$('presets').innerHTML = [1400, 1600, 1800, 2000, 2400, 3000, 3190]
  .map((v) => `<button data-elo="${v}">${v === 3190 ? 'Máx.' : v}</button>`).join('');
$('presets').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  elo = Number(b.dataset.elo);
  newGame();
};
$('color').onchange = newGame;

// Exponer para pruebas automáticas
window.__chess = { get game() { return game; }, get over() { return over; } };

newGame();
