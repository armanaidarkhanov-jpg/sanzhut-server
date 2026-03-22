const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Sanzhut Server Running'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─── GAME LOGIC ─────────────────────────────────────────────────────────
const SUITS    = ['♠','♥','♦','♣'];
const REG_VALS = ['4','5','6','7','8','9','10','J','Q','K','A','2','3'];
const SEQ_BAD  = new Set(['2','3','JB','JR']);
const VR = {};
REG_VALS.forEach((v,i) => VR[v] = i);
VR['JB'] = 13; VR['JR'] = 14;

const getLV  = idx => REG_VALS[Math.max(0, Math.min(idx, REG_VALS.length-1))];
const advLV  = (idx, ct) => Math.min(idx + ({single:1,pair:2,small_bomb:3,big_bomb:4}[ct]||0), REG_VALS.length-1);
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

function nextActive(from, fins, total = 4) {
  let n = (from + 1) % total, t = 0;
  while (fins.includes(n) && t < total) { n = (n + 1) % total; t++; }
  return n;
}

// ─── TURN TIMER ─────────────────────────────────────────────────────────
const TURN_TIMEOUT = 30000;

function startTurnTimer(room) {
  clearTurnTimer(room);
  room.turnDeadline = Date.now() + TURN_TIMEOUT;
  room.turnTimer = setTimeout(() => autoPass(room), TURN_TIMEOUT);
}

function clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  room.turnDeadline = null;
}

function autoPass(room) {
  if (room.phase !== 'playing') return;
  const seatIdx = room.currentPlayer;
  const p = room.players[seatIdx];
  if (!p) return;

  if (room.table && room.table.playedBy !== seatIdx) {
    room.passStreak++;
    const active = [0,1,2,3].filter(i => !room.finished.includes(i));
    const needed = active.filter(i => i !== room.table.playedBy).length;
    room.currentPlayer = nextActive(seatIdx, room.finished);
    room.log.push(`${p.name} пасует (авто)`);
    if (room.passStreak >= needed) {
      room.table = null;
      room.passStreak = 0;
      room.log.push('— Стол очищен —');
    }
  } else {
    room.currentPlayer = nextActive(seatIdx, room.finished);
    room.log.push(`${p.name} пропускает ход (авто)`);
  }
  room.log = room.log.slice(-12);
  broadcastRoom(room);
  startTurnTimer(room);
}

// ─── ROOMS ─────────────────────────────────────────────────────────────
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substr(2, 5).toUpperCase();
}

function getPublicState(room, forPlayerId) {
  return {
    roomCode: room.code,
    phase: room.phase,
    currentPlayer: room.currentPlayer,
    turnDeadline: room.turnDeadline || null,
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      cardCount: (room.hands[i] || []).length,
      level: getLV(room.levels[i]),
      levelIdx: room.levels[i],
      finished: room.finished.includes(i),
      isMe: p.id === forPlayerId,
      seatIndex: i,
      connected: p.connected !== false,
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
    if (p.socketId) {
      io.to(p.socketId).emit('gameState', getPublicState(room, p.id));
    }
  });
}

function startGame(room) {
  const deck = shuffle(createDeck());
  const hands = [[], [], [], []];
  deck.forEach((c, i) => hands[i % 4].push(c));

  let first = 0;
  for (let i = 0; i < 4; i++) {
    if (hands[i].some(c => c.isSpade4)) { first = i; break; }
  }

  room.hands = hands;
  room.currentPlayer = first;
  room.table = null;
  room.finished = [];
  room.passStreak = 0;
  room.phase = 'playing';
  room.log = [`${room.players[first].name} ходит первым (4♠)`];
  startTurnTimer(room);
}

// ─── SOCKET EVENTS ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', ({ playerName }) => {
    const code = generateCode();
    const room = {
      code,
      phase: 'waiting',
      players: [{ id: socket.id, socketId: socket.id, name: playerName || 'Игрок 1', connected: true }],
      hands: [[], [], [], []],
      levels: [0, 0, 0, 0],
      currentPlayer: 0,
      table: null,
      log: [],
      finished: [],
      passStreak: 0,
      turnDeadline: null,
      turnTimer: null,
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
    if (room.players.length >= 4) { socket.emit('error', 'Комната заполнена'); return; }

    const seatIdx = room.players.length;
    room.players.push({
      id: socket.id, socketId: socket.id,
      name: playerName || `Игрок ${seatIdx + 1}`,
      connected: true,
    });
    socket.join(code.toUpperCase());
    broadcastRoom(room);

    if (room.players.length === 4) {
      startGame(room);
      broadcastRoom(room);
    }
  });

  socket.on('rejoinRoom', ({ code, playerId }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', 'Комната не найдена'); return; }
    const p = room.players.find(p => p.id === playerId);
    if (p) {
      p.socketId = socket.id;
      p.connected = true;
      socket.join(code);
      room.log.push(`${p.name} переподключился`);
      room.log = room.log.slice(-12);
      broadcastRoom(room);
    }
  });

  socket.on('playCards', ({ code, cardIds, chamVal }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;
    const seatIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (seatIdx !== room.currentPlayer) return;

    const hand = room.hands[seatIdx];
    const selected = hand.filter(c => cardIds.includes(c.id));
    if (!selected.length) return;
    if (selected.some(c => c.type === 'chameleon') && !chamVal) return;

    const combo = detectCombo(selected, chamVal);
    if (!combo) return;
    if (room.table && !canBeat(combo, room.table.combo)) return;

    room.hands[seatIdx] = hand.filter(c => !cardIds.includes(c.id));
    const pname = room.players[seatIdx].name;

    if (room.hands[seatIdx].length === 0) {
      room.finished.push(seatIdx);
      const is44 = combo.type === 'pair' && selected.every(c => rvOf(c, chamVal) === '4');
      if (is44) {
        if (room.levels[seatIdx] === 0) {
          room.levels[seatIdx] = 2;
          room.log.push(`${pname} вышел с 4-4! → уровень 6`);
        } else {
          [0,1,2,3].forEach(i => {
            if (i !== seatIdx && !room.finished.includes(i))
              room.levels[i] = Math.max(0, room.levels[i] - 1);
          });
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
      const active = [0,1,2,3].filter(i => !room.finished.includes(i));
      if (active.length <= 1) {
        room.phase = 'finished';
        room.log.push('🏆 Партия окончена!');
        clearTurnTimer(room);
      }
    } else {
      const myLV = getLV(room.levels[seatIdx]);
      if (selected.some(c => rvOf(c, chamVal) === myLV)) {
        const left = room.hands[seatIdx].filter(c => c.value === myLV && c.type === 'regular').length;
        if (left === 0) {
          room.levels[seatIdx] = Math.max(0, room.levels[seatIdx] - 1);
          room.log.push(`${pname} потратил все ${myLV}! -1 уровень`);
        }
      }
      room.log.push(`${pname}: ${selected.length}к`);
    }

    room.table = { cards: selected, combo, playedBy: seatIdx };
    room.currentPlayer = nextActive(seatIdx, room.finished);
    room.passStreak = 0;
    room.log = room.log.slice(-12);
    if (room.phase === 'playing') startTurnTimer(room);
    broadcastRoom(room);
  });

  socket.on('pass', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;
    const seatIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (seatIdx !== room.currentPlayer) return;
    if (!room.table || room.table.playedBy === seatIdx) return;

    room.log.push(`${room.players[seatIdx].name} пасует`);
    room.passStreak++;
    const active = [0,1,2,3].filter(i => !room.finished.includes(i));
    const needed = room.table ? active.filter(i => i !== room.table.playedBy).length : 0;
    room.currentPlayer = nextActive(seatIdx, room.finished);

    if (room.passStreak >= needed) {
      room.table = null;
      room.passStreak = 0;
      room.log.push('— Стол очищен —');
    }
    room.log = room.log.slice(-12);
    startTurnTimer(room);
    broadcastRoom(room);
  });

  socket.on('newGame', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'finished') return;
    const seatIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (seatIdx !== 0) return;
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Sanzhut server on port ${PORT}`));
