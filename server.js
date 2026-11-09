// Servidor multiplayer do Ilha Zero
// Instalar: npm install express socket.io
// Rodar:    node server.js
// Coloque o jogo (index.html) na pasta "public" ao lado deste arquivo.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;        // jogadores por partida
const LOBBY_WAIT = 20;         // segundos esperando antes de começar com quem tiver
const MIN_TO_START = 2;        // mínimo de jogadores para começar
const MAP=6000;              // mesmo tamanho do mapa do jogo
const TICK = 50;               // envia o estado 20 vezes por segundo
const MAX_SPEED = 360;         // unidades por segundo (correndo + poder do Raio, com folga)

// Dano e cadência de cada arma: o servidor confere, o cliente não decide o dano
const WEAPONS = {
  pistola:  { dmg: 16, rate: 280,  range: 650,  pel: 1 },
  smg:      { dmg: 10, rate: 85,   range: 560,  pel: 1 },
  doze:     { dmg: 13, rate: 800,  range: 330,  pel: 8 },
  fuzil:    { dmg: 21, rate: 130,  range: 880,  pel: 1 },
  precisao: { dmg: 82, rate: 1300, range: 1500, pel: 1 }
};

// Fases da zona: [espera, tempo fechando, raio final, dano por segundo]
const PHASES = [[40, 30, 1750, 1], [30, 26, 1150, 2], [24, 22, 750, 4], [18, 16, 420, 7], [14, 13, 170, 10], [10, 10, 0, 16]];

app.use(express.static(path.join(__dirname, 'public')));
// Também funciona com o index.html solto ao lado do server.js (mais fácil de enviar pelo celular)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/status', (req, res) => res.json({ online: true, salas: rooms.size }));

const rooms = new Map();
let nextRoomId = 1;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clean = (s, max) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);

function createRoom() {
  const room = {
    id: 'sala' + nextRoomId++,
    state: 'lobby',            // lobby -> jogando -> fim
    players: new Map(),
    lobbyTimer: LOBBY_WAIT,
    zone: null,
    startedAt: 0
  };
  rooms.set(room.id, room);
  return room;
}

// Coloca o jogador numa sala que ainda está no lobby e tem vaga
function findRoom() {
  for (const room of rooms.values()) {
    if (room.state === 'lobby' && room.players.size < MAX_PLAYERS) return room;
  }
  return createRoom();
}

function publicPlayer(p) {
  return { id: p.id, nome: p.nome, visual: p.visual, x: Math.round(p.x), y: Math.round(p.y), ang: Math.round(p.ang * 100) / 100, hp: Math.round(p.hp), ar: Math.round(p.ar), arma: p.arma, vivo: p.vivo, inv: !!p.inv };
}

function lobbyUpdate(room) {
  io.to(room.id).emit('lobby-update', {
    total: room.players.size,
    max: MAX_PLAYERS,
    comecaEm: room.players.size >= MIN_TO_START ? Math.ceil(room.lobbyTimer) : null,
    players: [...room.players.values()].map(p => ({ id: p.id, nome: p.nome }))
  });
}

function startMatch(room) {
  room.state = 'jogando';
  room.startedAt = Date.now();
  room.zone = { x: MAP / 2, y: MAP / 2, r: 4440, fx: MAP / 2, fy: MAP / 2, fr: 4440, tx: MAP / 2, ty: MAP / 2, tr: 4440, pi: -1, estado: 'espera', t: 0, dps: 0 };
  nextPhase(room.zone);
  // Espalha os jogadores pelo mapa
  for (const p of room.players.values()) {
    p.x = 300 + Math.random() * (MAP - 600);
    p.y = 300 + Math.random() * (MAP - 600);
    p.hp = 100; p.ar = 0; p.vivo = true; p.kills = 0; p.lastMove = Date.now(); p.lastShot = 0; p.lastFire = 0; p.lastHeal = 0; p.shield = 0; p.shieldUntil = 0; p.lastShieldAt = 0; p.inv = false;
  }
  io.to(room.id).emit('match-start', {
    sala: room.id,
    seed: Math.floor(Math.random() * 1e9),   // use para gerar o mesmo mapa em todos os aparelhos
    players: [...room.players.values()].map(publicPlayer)
  });
}

function nextPhase(z) {
  z.pi++;
  if (z.pi >= PHASES.length) { z.estado = 'fim'; return; }
  const [wait, shrink, r, dps] = PHASES[z.pi];
  z.fx = z.x; z.fy = z.y; z.fr = z.r;
  const a = Math.random() * Math.PI * 2, k = Math.random() * Math.max(0, z.r - r) * 0.85;
  z.tx = clamp(z.x + Math.cos(a) * k, r + 150, MAP - r - 150);
  z.ty = clamp(z.y + Math.sin(a) * k, r + 150, MAP - r - 150);
  z.tr = r; z.estado = 'espera'; z.t = wait; z.shrinkT = shrink; z.nextDps = dps;
}

function updateZone(room, dt) {
  const z = room.zone;
  if (z.estado === 'fim') return;
  z.t -= dt;
  if (z.estado === 'espera' && z.t <= 0) { z.estado = 'fechando'; z.t = z.shrinkT; z.dps = z.nextDps; }
  else if (z.estado === 'fechando') {
    const k = 1 - clamp(z.t / z.shrinkT, 0, 1);
    z.x = z.fx + (z.tx - z.fx) * k; z.y = z.fy + (z.ty - z.fy) * k; z.r = z.fr + (z.tr - z.fr) * k;
    if (z.t <= 0) { z.x = z.tx; z.y = z.ty; z.r = z.tr; nextPhase(z); }
  }
  // Dano da zona é calculado aqui no servidor
  for (const p of room.players.values()) {
    if (!p.vivo) continue;
    if (Math.hypot(p.x - z.x, p.y - z.y) > z.r) damage(room, p, Math.max(1, z.dps) * dt, null);
  }
}

function damage(room, target, amount, killer) {
  if (!target.vivo) return;
  if (killer) {
    // Escudo da Muralha e colete absorvem dano de tiro
    if (target.shield > 0 && Date.now() < target.shieldUntil) { const a = Math.min(target.shield, amount); target.shield -= a; amount -= a; }
    if (target.ar > 0 && amount > 0) { const a = Math.min(target.ar, amount * 0.5); target.ar -= a; amount -= a; }
    if (amount <= 0) return;
  }
  target.hp -= amount;
  if (target.hp <= 0) {
    target.hp = 0; target.vivo = false;
    if (killer) killer.kills++;
    const vivos = [...room.players.values()].filter(p => p.vivo).length;
    io.to(room.id).emit('player-dead', { id: target.id, killer: killer ? killer.id : null, colocacao: vivos + 1 });
    checkWinner(room);
  } else if (killer) {
    io.to(room.id).emit('player-hit', { id: target.id, hp: Math.round(target.hp), de: killer.id });
  }
}

function checkWinner(room) {
  if (room.state !== 'jogando') return;
  const vivos = [...room.players.values()].filter(p => p.vivo);
  if (vivos.length <= 1) {
    room.state = 'fim';
    io.to(room.id).emit('match-end', { vencedor: vivos[0] ? { id: vivos[0].id, nome: vivos[0].nome, kills: vivos[0].kills } : null });
    // Fecha a sala depois de um tempo
    setTimeout(() => {
      for (const id of room.players.keys()) {
        const s = io.sockets.sockets.get(id);
        if (s) { s.leave(room.id); s.data.room = null; }
      }
      rooms.delete(room.id);
    }, 10000);
  }
}

io.on('connection', (socket) => {
  console.log('Jogador conectou:', socket.id);

  // O cliente pede para entrar na fila mandando nome e visual
  socket.on('join', (data = {}) => {
    if (socket.data.room) return;
    const room = findRoom();
    const p = {
      id: socket.id,
      nome: clean(data.nome, 14) || 'Player' + Math.floor(Math.random() * 999),
      visual: typeof data.visual === 'object' && data.visual ? data.visual : {},
      x: 0, y: 0, ang: 0, hp: 100, ar: 0, vivo: true, arma: 'pistola', kills: 0, lastMove: Date.now(), lastShot: 0, lastFire: 0, lastHeal: 0, shield: 0, shieldUntil: 0, lastShieldAt: 0, inv: false
    };
    room.players.set(socket.id, p);
    socket.join(room.id);
    socket.data.room = room.id;
    if (room.players.size === MIN_TO_START) room.lobbyTimer = LOBBY_WAIT;
    lobbyUpdate(room);
    if (room.players.size >= MAX_PLAYERS) startMatch(room);
  });

  // Posição: o servidor recusa saltos impossíveis (teleporte)
  socket.on('move', (data = {}) => {
    const room = rooms.get(socket.data.room);
    const p = room && room.players.get(socket.id);
    if (!p || !p.vivo || room.state !== 'jogando') return;
    const now = Date.now(), dt = Math.max(0.016, (now - p.lastMove) / 1000);
    const x = clamp(Number(data.x) || 0, 0, MAP), y = clamp(Number(data.y) || 0, 0, MAP);
    const maxStep = MAX_SPEED * dt * 1.5 + 10;
    if (Math.hypot(x - p.x, y - p.y) <= maxStep) { p.x = x; p.y = y; }
    else socket.emit('corrigir', { x: p.x, y: p.y });   // manda o jogador de volta para a última posição válida
    p.ang = Number(data.ang) || 0;
    if (WEAPONS[data.arma]) p.arma = data.arma;
    p.inv = data.inv === true;
    p.lastMove = now;
  });

  const myPlayer = () => {
    const room = rooms.get(socket.data.room);
    const p = room && room.players.get(socket.id);
    return p && p.vivo && room.state === 'jogando' ? { room, p } : null;
  };

  // Cura (kit médico ou poder da Iara): no máximo 50 de vida a cada 1,8 s
  socket.on('heal', (data = {}) => {
    const r = myPlayer(); if (!r) return;
    const now = Date.now();
    if (now - r.p.lastHeal < 1800) return;
    r.p.lastHeal = now;
    r.p.hp = Math.min(100, r.p.hp + clamp(Number(data.n) || 0, 0, 50));
  });

  // Colete e escudo
  socket.on('gear', (data = {}) => {
    const r = myPlayer(); if (!r) return;
    if (data.ar !== undefined) r.p.ar = clamp(Number(data.ar) || 0, 0, Math.max(r.p.ar, Math.min(100, r.p.ar + 50)));
    const now = Date.now();
    if (data.shield === true && now - r.p.lastShieldAt > 30000) { r.p.lastShieldAt = now; r.p.shield = 80; r.p.shieldUntil = now + 6000; }
  });

  // Disparo (mesmo errando): só serve para os outros verem o tiro e ouvirem o som
  socket.on('fire', () => {
    const r = myPlayer(); if (!r) return;
    const now = Date.now(), W = WEAPONS[r.p.arma];
    if (now - r.p.lastFire < W.rate * 0.7) return;
    r.p.lastFire = now;
    socket.to(r.room.id).emit('shot-fx', { de: r.p.id, arma: r.p.arma });
  });

  // Tiro: o cliente diz em quem acertou; o servidor confere arma, cadência, distância e calcula o dano
  socket.on('shoot', (data = {}) => {
    const room = rooms.get(socket.data.room);
    if (!room || room.state !== 'jogando') return;
    const shooter = room.players.get(socket.id);
    const target = room.players.get(data.alvoId);
    if (!shooter || !shooter.vivo || !target || !target.vivo || target === shooter) return;
    const W = WEAPONS[shooter.arma];
    const now = Date.now();
    if (now - shooter.lastShot < W.rate * 0.8) return;               // atirando rápido demais
    if (Math.hypot(target.x - shooter.x, target.y - shooter.y) > W.range + 60) return; // longe demais
    shooter.lastShot = now;
    const pellets = clamp(Number(data.pellets) || 1, 1, W.pel);
    const head = data.cabeca === true;
    damage(room, target, W.dmg * pellets * (head ? 2 : 1), shooter);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const p = room.players.get(socket.id);
    room.players.delete(socket.id);
    if (room.state === 'lobby') lobbyUpdate(room);
    else if (room.state === 'jogando' && p && p.vivo) {
      io.to(room.id).emit('player-left', { id: socket.id });
      checkWinner(room);
    }
    if (room.players.size === 0) rooms.delete(room.id);
    console.log('Jogador saiu:', socket.id);
  });
});

// Loop principal: contagem do lobby, zona e envio do estado
let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = (now - last) / 1000; last = now;
  for (const room of rooms.values()) {
    if (room.state === 'lobby') {
      if (room.players.size >= MIN_TO_START) {
        const before = Math.ceil(room.lobbyTimer);
        room.lobbyTimer -= dt;
        if (Math.ceil(room.lobbyTimer) !== before) lobbyUpdate(room);
        if (room.lobbyTimer <= 0) startMatch(room);
      }
    } else if (room.state === 'jogando') {
      updateZone(room, dt);
      const z = room.zone;
      io.to(room.id).volatile.emit('state', {
        players: [...room.players.values()].map(publicPlayer),
        zona: { x: Math.round(z.x), y: Math.round(z.y), r: Math.round(z.r), tx: Math.round(z.tx), ty: Math.round(z.ty), tr: z.tr, estado: z.estado, t: Math.ceil(z.t) }
      });
    }
  }
}, TICK);

server.listen(PORT, () => console.log('Servidor do Ilha Zero rodando na porta ' + PORT));
