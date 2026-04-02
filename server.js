const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Van Zan Server Running'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─── GAME LOGIC ───────────────────────────────────────────────────────────────────────────────────────
const SUITS    = ['♠','♥','♦','♣'];
const REG_VALS = ['4','5','6','7','8','9','10','J','Q','K','A','2','3'];
const SEQ_BAD  = new Set(['2','3','JB','JR']);
const VR = {};
REG_VALS.forEach((v,i) => VR[v] = i);
VR['JB'] = 13; VR['JR'] = 14;
const MAX_LEVEL = REG_VALS.length - 1;

const getLV  = idx => REG_VALS[Math.max(0, Math.min(idx, MAX_LEVEL))];
const advLV  = (idx, ct) => Math.min(idx + ({single:1,pair:2,small_bomb:3,big_bomb:4}[ct]||0), MAX_LEVEL);
const rvOf   = (c, cv) => c.type === 'chameleon' ? (cv || '4') : c.value;

function createDeck() {
  let id = 0, cards = [];
  for (const s of SUITS) for (const v of REG_VALS)
    cards.push({ id: id++, value: v, suit: s, type: 'regular', isSpade4: v==='4' && s==='♠' });
  cards.push({ id: id++, value: 'JB', suit: null, type: 'joker_black', isSpade4: false });
  cards.push({ id: id++, value: 'JR', suit: null, type: 'joker_red',   isSpade4: false });
  cards.push({ id: id++, value: 'CH', suit: null, type: 'chameleon',   isSpade4: false });
  return cards;
}

function shuffle(a) {
  const b = [...a];
  for (let i = b.length-1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function detectCombo(cards, cv = null) {
  if (!cards?.length) return null;
  const n = cards.length;
  const res = cards.map(c => ({ ...c, rv: rvOf(c, cv) }));
  const ranks = res.map(c => VR[c.rv] ?? -1);
  const hasCh = cards.some(c => c.type === 'chameleon');
  const nonCh = res.filter(c => c.type !== 'chameleon');
  const ncR = nonCh.map(c => VR[c.rv] ?? -1);
  const allSame = () => ranks.every(r => r === ranks[0]);
  if (n === 1) return { type: 'single', rank: ranks[0] };
  if (n === 2) {
    if (allSame()) return { type: 'pair', rank: ranks[0] };
    if (hasCh && ncR.length === 1) return { type: 'pair', rank: ncR[0] };
  }
  if (n === 3) {
    if (allSame()) return { type: 'small_bomb', rank: ranks[0] };
    if (hasCh && new Set(ncR).size === 1 && ncR.length === 2) return { type: 'small_bomb', rank: ncR[0] };
  }
  if (n === 4) {
    if (allSame()) return { type: 'big_bomb', rank: ranks[0] };
    if (hasCh && new Set(ncR).size === 1 && ncR.length === 3) return { type: 'big_bomb', rank: ncR[0] };
  }
  if (n >= 4) { const h = chkHatar(res, hasCh, n); if (h) return h; }
  if (n >= 6 && n % 2 === 0) { const s = chkSanzhut(res, n); if (s) return s; }
  return null;
}

function chkHatar(res, hasCh, n) {
  const nonCh = res.filter(c => c.type !== 'chameleon');
  if (nonCh.some(c => SEQ_BAD.has(c.rv))) return null;
  const ncR = [...new Set(nonCh.map(c => VR[c.rv] ?? -1))].sort((a,b) => a-b);
  if (ncR.length !== nonCh.length) return null;
  if (!hasCh) {
    if (ncR[ncR.length-1] - ncR[0] === n-1) return { type: 'hatar', length: n, rank: ncR[0] };
  } else {
    const span = ncR[ncR.length-1] - ncR[0] + 1, gaps = span - nonCh.length;
    if (gaps === 1 && span === n) return { type: 'hatar', length: n, rank: ncR[0] };
    if (gaps === 0 && nonCh.length === n-1) return { type: 'hatar', length: n, rank: ncR[0] > 0 ? ncR[0]-1 : ncR[0] };
  }
  return null;
}

function chkSanzhut(res, n) {
  const nonCh = res.filter(c => c.type !== 'chameleon');
  if (nonCh.some(c => SEQ_BAD.has(c.rv))) return null;
  const vc = {};
  nonCh.forEach(c => { vc[c.rv] = (vc[c.rv] || 0) + 1; });
  const vals = Object.keys(vc);
  if (vals.some(v => vc[v] !== 2)) return null;
  const rk = vals.map(v => VR[v]).sort((a,b) => a-b);
  const pairs = n / 2;
  if (rk[rk.length-1] - rk[0] === pairs-1 && rk.length === pairs)
    return { type: 'sanzhut', pairs, rank: rk[0] };
  return null;
}

function canBeat(played, table) {
  if (!table) return true;
  const { type:pt, rank:pr, length:pl, pairs:pp } = played;
  const { type:tt, rank:tr, length:tl, pairs:tp } = table;
  if (pt === 'big_bomb') return tt === 'big_bomb' ? pr > tr : true;
  if (tt === 'single' && tr === VR['JR']) return false;
  if (pt === 'small_bomb') {
    if (tt === 'single') return true;
    if (tt === 'pair')   return true;
    if (tt === 'hatar')  return true;
    if (tt === 'small_bomb') return pr > tr;
    return false;
  }
  if (pt === tt) {
    if (['single','pair','small_bomb','big_bomb'].includes(pt)) return pr > tr;
    if (pt === 'hatar')   return pl === tl && pr > tr;
    if (pt === 'sanzhut') return pp === tp && pr > tr;
  }
  return false;
}

function nextActive(from, fins, total) {
  let n = (from + 1) % total, t = 0;
  while (fins.includes(n) && t < total) { n = (n + 1) % total; t++; }
  return n;
}

// ─── ROUND END HELPER ─────────────────────────────────────────────────────────────────────────────────
function checkRoundEnd(room) {
  const total = room.playerCount;
  const active = [];
  for (let i = 0; i < total; i++) { if (!room.finished.includes(i)) active.push(i); }

  if (room.gameMode === 'streak3') {
    // Streak mode: first to finish wins the round
    if (room.finished.length >= 1) {
      const winner = room.finished[0];
      room.streakWins[winner] = (room.streakWins[winner] || 0) + 1;
      // Reset others' streaks
      for (let i = 0; i < total; i++) {
        if (i !== winner) room.streakWins[i] = 0;
      }
      room.wins[winner] = (room.wins[winner] || 0) + 1;
      room.log.push(`🔥 ${room.players[winner]?.name} побеждает! Серия: ${room.streakWins[winner]}`);

      // Check if 3 wins in a row
      if (room.streakWins[winner] >= 3) {
        room.champion = winner;
        room.log.push(`🏆 ${room.players[winner]?.name} — ЧЕМПИОН! 3 победы подряд!`);
      }
      room.phase = 'finished';
      clearTurnTimer(room);
      return true;
    }
    return false;
  }

  // Classic mode
  if (!room.champion) {
    const champIdx = room.levels.findIndex(l => l >= MAX_LEVEL);
    if (champIdx !== -1) {
      room.champion = champIdx;
      room.wins[champIdx] = (room.wins[champIdx] || 0) + 1;
      room.log.push(`🏆 ${room.players[champIdx]?.name} — ЧЕМПИОН СЕССИИ!`);
      room.phase = 'finished';
      clearTurnTimer(room);
      return true;
    }
  }
  if (active.length <= 1) {
    if (!room.champion && room.finished.length > 0) room.wins[room.finished[0]]++;
    room.log.push('🏆 Партия окончена!');
    room.phase = 'finished';
    clearTurnTimer(room);
    return true;
  }
  return false;
}

// ─── TURN TIMER ─────────────────────────────────────────────────────────────────────────────────────────
const TURN_TIMEOUT = 30000;

function clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  if (room.botTimer)  { clearTimeout(room.botTimer);  room.botTimer  = null; }
  room.turnDeadline = null;
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  room.turnDeadline = Date.now() + TURN_TIMEOUT;
  room.turnTimer = setTimeout(() => autoPass(room), TURN_TIMEOUT);
}

function afterTurnChange(room) {
  startTurnTimer(room);
  const cp = room.players[room.currentPlayer];
  if (cp?.isBot && room.phase === 'playing') scheduleBot(room);
}

function autoPass(room) {
  if (room.phase !== 'playing') return;
  const total = room.playerCount;
  const seatIdx = room.currentPlayer;
  const p = room.players[seatIdx];
  if (!p) return;

  const hasBots = room.players.some(pl => pl.isBot);
  if (hasBots && !p.isBot) {
    room.afkStreak = (room.afkStreak || 0) + 1;
    if (room.afkStreak >= 2) {
      room.phase = 'finished';
      room.abandoned = true;
      room.log.push(`🚪 ${p.name} покинул игру`);
      room.log = room.log.slice(-12);
      clearTurnTimer(room);
      broadcastRoom(room);
      setTimeout(() => { delete rooms[room.code]; }, 60000);
      return;
    }
  }

  if (room.table && room.table.playedBy !== seatIdx) {
    room.passStreak++;
    const active = [];
    for (let i = 0; i < total; i++) { if (!room.finished.includes(i)) active.push(i); }
    const needed = active.filter(i => i !== room.table.playedBy).length;
    room.currentPlayer = nextActive(seatIdx, room.finished, total);
    room.log.push(`${p.name} пасует (авто)`);
    if (room.passStreak >= needed) { room.table = null; room.passStreak = 0; room.log.push('— Стол очищен —'); }
  } else {
    if (room.table && room.table.playedBy === seatIdx) {
      room.table = null; room.passStreak = 0; room.log.push('— Стол очищен —');
    }
    room.currentPlayer = nextActive(seatIdx, room.finished, total);
    room.log.push(`${p.name} пропускает ход (авто)`);
  }
  room.log = room.log.slice(-12);
  broadcastRoom(room);
  afterTurnChange(room);
}

// ─── BOT LOGIC ──────────────────────────────────────────────────────────────────────────────────────────
const BOT_NAMES = ['Алибек 🤖', 'Даурен 🤖', 'Санжар 🤖', 'Нурлан 🤖', 'Бауржан 🤖'];

function scheduleBot(room) {
  if (room.botTimer) return;
  const total = room.playerCount;
  const seatIdx = room.currentPlayer;
  const p = room.players[seatIdx];
  if (!p?.isBot || room.phase !== 'playing') return;

  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (room.phase !== 'playing' || room.currentPlayer !== seatIdx) return;

    const hand = room.hands[seatIdx];
    if (!hand?.length) return;

    if (room.table && room.table.playedBy === seatIdx) {
      room.table = null;
      room.passStreak = 0;
      room.log.push('— Стол очищен —');
    }

    if (!room.table) {
      const card = hand[0];
      const combo = detectCombo([card]);
      if (!combo) return;
      room.hands[seatIdx] = hand.filter(c => c.id !== card.id);
      room.table = { cards: [card], combo, playedBy: seatIdx };
      room.log.push(`${p.name}: 1к`);
      if (room.hands[seatIdx].length === 0) {
        room.finished.push(seatIdx);
        room.log.push(`${p.name} вышел`);
        room.log = room.log.slice(-12);
        if (checkRoundEnd(room)) { broadcastRoom(room); return; }
      }
      room.currentPlayer = nextActive(seatIdx, room.finished, total);
      room.passStreak = 0;
      room.log = room.log.slice(-12);
      broadcastRoom(room);
      afterTurnChange(room);
    } else {
      let played = false;
      if (room.table.combo.type === 'single') {
        const rankNeeded = room.table.combo.rank;
        const candidate = hand.find(c => (VR[c.value] ?? -1) > rankNeeded && c.type === 'regular');
        if (candidate) {
          const combo = detectCombo([candidate]);
          if (combo && canBeat(combo, room.table.combo)) {
            room.hands[seatIdx] = hand.filter(c => c.id !== candidate.id);
            room.table = { cards: [candidate], combo, playedBy: seatIdx };
            room.log.push(`${p.name}: 1к`);
            if (room.hands[seatIdx].length === 0) {
              room.finished.push(seatIdx);
              room.log = room.log.slice(-12);
              if (checkRoundEnd(room)) { broadcastRoom(room); return; }
            }
            room.currentPlayer = nextActive(seatIdx, room.finished, total);
            room.passStreak = 0;
            room.log = room.log.slice(-12);
            broadcastRoom(room);
            afterTurnChange(room);
            played = true;
          }
        }
      }
      if (!played) {
        room.log.push(`${p.name} пасует`);
        room.passStreak++;
        const active = [];
        for (let i = 0; i < total; i++) { if (!room.finished.includes(i)) active.push(i); }
        const needed = active.filter(i => i !== room.table.playedBy).length;
        room.currentPlayer = nextActive(seatIdx, room.finished, total);
        if (room.passStreak >= needed) { room.table = null; room.passStreak = 0; room.log.push('— Стол очищен —'); }
        room.log = room.log.slice(-12);
        broadcastRoom(room);
        afterTurnChange(room);
      }
    }
  }, 1200 + Math.random() * 800);
}

// ─── ROOMS ──────────────────────────────────────────────────────────────────────────────────────────────
const rooms = {};

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────────────────────────────────
const ROOMS_FILE = './rooms-backup.json';
let saveTimeout = null;

function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const data = {};
      for (const [code, room] of Object.entries(rooms))
        data[code] = { ...room, turnTimer: undefined, botTimer: undefined };
      fs.writeFileSync(ROOMS_FILE, JSON.stringify(data));
    } catch(e) { console.log('Save error:', e.message); }
  }, 1000);
}

function loadRooms() {
  try {
    if (!fs.existsSync(ROOMS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    for (const [code, room] of Object.entries(data)) {
      room.turnTimer = null; room.botTimer = null;
      if (!room.champion) room.champion = null;
      if (!room.afkStreak) room.afkStreak = 0;
      if (!room.gameMode) room.gameMode = 'classic';
      if (!room.playerCount) room.playerCount = room.players?.length || 4;
      if (!room.maxPlayers) room.maxPlayers = room.playerCount;
      if (!room.streakWins) room.streakWins = new Array(room.playerCount).fill(0);
      if (!room.dealerIdx) room.dealerIdx = 0;
      rooms[code] = room;
      if (room.phase === 'playing') {
        if (room.turnDeadline && room.turnDeadline > Date.now()) {
          const remaining = room.turnDeadline - Date.now();
          room.turnTimer = setTimeout(() => autoPass(room), remaining);
        } else {
          setTimeout(() => autoPass(room), 500);
        }
        const cp = room.players[room.currentPlayer];
        if (cp?.isBot) scheduleBot(room);
      }
    }
    console.log(`Loaded ${Object.keys(data).length} room(s) from backup`);
  } catch(e) { console.log('Load error:', e.message); }
}

function generateCode() {
  return Math.random().toString(36).substr(2, 5).toUpperCase();
}

function getPublicState(room, forPlayerId) {
  const total = room.playerCount;
  return {
    roomCode: room.code,
    phase: room.phase,
    currentPlayer: room.currentPlayer,
    turnDeadline: room.turnDeadline || null,
    champion: room.champion ?? null,
    abandoned: room.abandoned || false,
    gameMode: room.gameMode || 'classic',
    playerCount: total,
    maxPlayers: room.maxPlayers || total,
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      cardCount: (room.hands[i] || []).length,
      level: getLV(room.levels[i] || 0),
      levelIdx: room.levels[i] || 0,
      finished: room.finished.includes(i),
      isMe: p.id === forPlayerId,
      seatIndex: i,
      connected: p.connected !== false,
      wins: room.wins?.[i] || 0,
      isBot: p.isBot || false,
      streakWins: room.streakWins?.[i] || 0,
    })),
    table: room.table,
    log: room.log,
    myCards: (() => {
      const seatIdx = room.players.findIndex(p => p.id === forPlayerId);
      return seatIdx >= 0 ? (room.hands[seatIdx] || []) : [];
    })(),
    mySeatIndex: room.players.findIndex(p => p.id === forPlayerId),
    passStreak: room.passStreak,
    finished: room.finished
  };
}

function broadcastRoom(room) {
  room.players.forEach(p => {
    if (p.socketId) io.to(p.socketId).emit('gameState', getPublicState(room, p.id));
  });
  scheduleSave();
}

function startGame(room) {
  const total = room.playerCount;
  const deck = shuffle(createDeck());
  const hands = [];
  for (let i = 0; i < total; i++) hands.push([]);
  // Deal cards round-robin starting from dealer
  const dealer = room.dealerIdx || 0;
  deck.forEach((c, i) => hands[(dealer + i) % total].push(c));
  // Rotate dealer for next round
  room.dealerIdx = (dealer + 1) % total;

  let first = 0;
  for (let i = 0; i < total; i++) { if (hands[i].some(c => c.isSpade4)) { first = i; break; } }
  room.hands = hands;
  room.currentPlayer = first;
  room.table = null;
  room.finished = [];
  room.passStreak = 0;
  room.afkStreak = 0;
  room.abandoned = false;
  room.phase = 'playing';
  room.log = [`${room.players[first].name} ходит первым (4♠)`];
  afterTurnChange(room);
}

// ─── SOCKET EVENTS ──────────────────────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', ({ playerName, gameMode, maxPlayers }) => {
    const code = generateCode();
    const mode = (gameMode === 'streak3') ? 'streak3' : 'classic';
    const max = Math.max(3, Math.min(6, parseInt(maxPlayers) || 4));
    const room = {
      code, phase: 'waiting',
      gameMode: mode,
      maxPlayers: max,
      playerCount: 0, // will be set when game starts
      players: [{ id: socket.id, socketId: socket.id, name: playerName || 'Игрок 1', connected: true }],
      hands: [], levels: [], wins: [], streakWins: [],
      currentPlayer: 0, table: null, log: [], finished: [], passStreak: 0,
      turnDeadline: null, turnTimer: null, botTimer: null, champion: null,
      afkStreak: 0, abandoned: false, dealerIdx: 0,
    };
    rooms[code] = room;
    socket.join(code);
    socket.emit('roomCreated', { code });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, playerName }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) { socket.emit('error', 'Комната не найдена'); return; }
    if (room.phase !== 'waiting') { socket.emit('error', 'Игра уже началась'); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit('error', 'Комната заполнена'); return; }
    const seatIdx = room.players.length;
    room.players.push({ id: socket.id, socketId: socket.id, name: playerName || `Игрок ${seatIdx+1}`, connected: true });
    socket.join(code.toUpperCase());
    broadcastRoom(room);
  });

  socket.on('startGame', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'waiting') return;
    if (room.players[0]?.socketId !== socket.id) return; // only host
    if (room.players.length < 3) { socket.emit('error', 'Минимум 3 игрока'); return; }
    const total = room.players.length;
    room.playerCount = total;
    room.levels = new Array(total).fill(0);
    room.wins = new Array(total).fill(0);
    room.streakWins = new Array(total).fill(0);
    room.hands = [];
    for (let i = 0; i < total; i++) room.hands.push([]);
    startGame(room);
    broadcastRoom(room);
  });

  socket.on('fillWithBots', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'waiting') return;
    if (room.players[0]?.socketId !== socket.id) return;
    let bi = 0;
    while (room.players.length < room.maxPlayers) {
      room.players.push({ id: `bot_${Date.now()}_${bi}`, socketId: null, name: BOT_NAMES[bi] || `Бот ${bi+1}`, connected: true, isBot: true });
      bi++;
    }
    const total = room.players.length;
    room.playerCount = total;
    room.levels = new Array(total).fill(0);
    room.wins = new Array(total).fill(0);
    room.streakWins = new Array(total).fill(0);
    room.hands = [];
    for (let i = 0; i < total; i++) room.hands.push([]);
    startGame(room);
    broadcastRoom(room);
  });

  socket.on('rejoinRoom', ({ code, playerId }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', 'Комната не найдена'); return; }
    const p = room.players.find(p => p.id === playerId);
    if (p) {
      p.socketId = socket.id; p.connected = true;
      room.afkStreak = 0;
      socket.join(code);
      room.log.push(`${p.name} переподключился`);
      room.log = room.log.slice(-12);
      broadcastRoom(room);
    }
  });

  socket.on('playCards', ({ code, cardIds, chamVal }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;
    const total = room.playerCount;
    const seatIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (seatIdx !== room.currentPlayer) return;
    const hand = room.hands[seatIdx];
    const selected = hand.filter(c => cardIds.includes(c.id));
    if (!selected.length) return;
    if (selected.some(c => c.type === 'chameleon') && !chamVal) return;
    const combo = detectCombo(selected, chamVal);
    if (!combo) return;
    if (room.table && !canBeat(combo, room.table.combo)) return;

    room.afkStreak = 0;
    room.hands[seatIdx] = hand.filter(c => !cardIds.includes(c.id));
    const pname = room.players[seatIdx].name;

    if (room.hands[seatIdx].length === 0) {
      room.finished.push(seatIdx);

      if (room.gameMode === 'streak3') {
        // Streak mode: just finish, no level logic
        room.log.push(`${pname} сбросил все карты!`);
      } else {
        // Classic mode: level logic
        const is44 = combo.type === 'pair' && selected.every(c => rvOf(c, chamVal) === '4');
        if (is44) {
          if (room.levels[seatIdx] === 0) { room.levels[seatIdx] = 2; room.log.push(`${pname} вышел с 4-4! → уровень 6`); }
          else {
            for (let i = 0; i < total; i++) { if (i !== seatIdx && !room.finished.includes(i)) room.levels[i] = Math.max(0, room.levels[i]-1); }
            room.log.push(`${pname} вышел с 4-4! Все -1 уровень`);
          }
        } else {
          const hasLv = selected.some(c => rvOf(c, chamVal) === getLV(room.levels[seatIdx]));
          if (hasLv) {
            const oldLv = getLV(room.levels[seatIdx]);
            room.levels[seatIdx] = advLV(room.levels[seatIdx], combo.type);
            room.log.push(`${pname} вышел с ${oldLv}! → ${getLV(room.levels[seatIdx])}`);
          } else {
            room.log.push(`${pname} вышел (уровень без изменений)`);
          }
        }
      }

      room.table = { cards: selected, combo, playedBy: seatIdx };
      room.currentPlayer = nextActive(seatIdx, room.finished, total);
      room.passStreak = 0;
      room.log = room.log.slice(-12);
      if (checkRoundEnd(room)) { broadcastRoom(room); return; }
    } else {
      if (room.gameMode === 'classic') {
        const myLV = getLV(room.levels[seatIdx]);
        if (selected.some(c => rvOf(c, chamVal) === myLV)) {
          const left = room.hands[seatIdx].filter(c => c.value === myLV && c.type === 'regular').length;
          if (left === 0) { room.levels[seatIdx] = Math.max(0, room.levels[seatIdx]-1); room.log.push(`${pname} потратил все ${myLV}! -1 уровень`); }
        }
      }
      room.log.push(`${pname}: ${selected.length}к`);
      room.table = { cards: selected, combo, playedBy: seatIdx };
      room.currentPlayer = nextActive(seatIdx, room.finished, total);
      room.passStreak = 0;
    }
    room.log = room.log.slice(-12);
    if (room.phase === 'playing') afterTurnChange(room);
    broadcastRoom(room);
  });

  socket.on('pass', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;
    const total = room.playerCount;
    const seatIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (seatIdx !== room.currentPlayer) return;
    if (!room.table || room.table.playedBy === seatIdx) return;
    room.afkStreak = 0;
    room.log.push(`${room.players[seatIdx].name} пасует`);
    room.passStreak++;
    const active = [];
    for (let i = 0; i < total; i++) { if (!room.finished.includes(i)) active.push(i); }
    const needed = room.table ? active.filter(i => i !== room.table.playedBy).length : 0;
    room.currentPlayer = nextActive(seatIdx, room.finished, total);
    if (room.passStreak >= needed) { room.table = null; room.passStreak = 0; room.log.push('— Стол очищен —'); }
    room.log = room.log.slice(-12);
    afterTurnChange(room);
    broadcastRoom(room);
  });

  socket.on('clearTable', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;
    const seatIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (seatIdx !== room.currentPlayer) return;
    if (!room.table || room.table.playedBy !== seatIdx) return;
    room.afkStreak = 0;
    room.table = null;
    room.passStreak = 0;
    room.log.push('— Стол закрыт —');
    room.log = room.log.slice(-12);
    broadcastRoom(room);
    afterTurnChange(room);
  });

  socket.on('sendReaction', ({ code, toSeatIdx, emoji }) => {
    const room = rooms[code];
    if (!room) return;
    const fromSeatIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (fromSeatIdx === -1) return;
    io.to(code).emit('reaction', { fromSeatIdx, toSeatIdx, emoji, fromName: room.players[fromSeatIdx]?.name });
  });

  socket.on('newGame', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'finished') return;
    const seatIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (seatIdx !== 0) return;

    if (room.gameMode === 'streak3') {
      if (room.champion !== null && room.champion !== undefined) {
        // Champion found — reset everything for new session
        room.streakWins = new Array(room.playerCount).fill(0);
        room.wins = new Array(room.playerCount).fill(0);
        room.champion = null;
      }
      // Otherwise just start next round (streaks persist)
    } else {
      // Classic mode
      if (room.champion !== null && room.champion !== undefined) {
        room.levels = new Array(room.playerCount).fill(0);
        room.champion = null;
      }
    }
    startGame(room);
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      const p = room.players.find(p => p.socketId === socket.id);
      if (p) {
        p.connected = false;
        room.log.push(`⚠️ ${p.name} отключился`);
        room.log = room.log.slice(-12);
        broadcastRoom(room);
        break;
      }
    }
  });
});

loadRooms();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Van Zan server on port ${PORT}`));
