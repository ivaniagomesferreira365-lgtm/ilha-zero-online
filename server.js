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
const MIN_TO_START = 1;        // com 1 jogador a contagem já começa; o resto vira bot
const BOT_FILL = 10;           // a partida sempre tem pelo menos este total (gente + bots)
const MAP=6000;              // mesmo tamanho do mapa do jogo
const TICK = 50;               // envia o estado 20 vezes por segundo
const MAX_SPEED = 360;         // unidades por segundo (correndo + poder do Raio, com folga)

// Dano e cadência de cada arma: o servidor confere, o cliente não decide o dano
const WEAPONS = {
  pistola:  { dmg: 16, rate: 280,  range: 650,  pel: 1 },
  desert:   { dmg: 36, rate: 430,  range: 700,  pel: 1 },
  smg:      { dmg: 10, rate: 85,   range: 560,  pel: 1 },
  mp40:     { dmg: 13, rate: 95,   range: 520,  pel: 1 },
  doze:     { dmg: 13, rate: 800,  range: 330,  pel: 8 },
  m1887:    { dmg: 17, rate: 650,  range: 300,  pel: 8 },
  fuzil:    { dmg: 21, rate: 130,  range: 880,  pel: 1 },
  ak:       { dmg: 27, rate: 155,  range: 860,  pel: 1 },
  m4:       { dmg: 19, rate: 115,  range: 900,  pel: 1 },
  precisao: { dmg: 82, rate: 1300, range: 1500, pel: 1 },
  awm:      { dmg: 96, rate: 1700, range: 1600, pel: 1 }
};
const BOT_WEAPONS = ['smg', 'mp40', 'fuzil', 'ak', 'm4', 'doze', 'm1887', 'desert', 'fuzil', 'ak', 'm4', 'precisao'];
const BOT_NAMES = ['Tatu_Pro', 'Jaguar77', 'Sombra', 'Ventania', 'Pirarucu', 'Mandacaru', 'Neblina', 'Trovão', 'Curupira', 'Saci_X', 'Boto', 'Sucuri', 'Arara', 'Quati', 'LoboGuará', 'Caipora', 'Faísca', 'Maré', 'Jabuti', 'Capivara9', 'Tucano', 'Piranha', 'Gavião', 'Carcará'];

// Fases da zona: [espera, tempo fechando, raio final, dano por segundo]
const PHASES = [[40, 30, 2100, 1], [30, 26, 1150, 2], [24, 22, 750, 4], [18, 16, 420, 7], [14, 13, 170, 10], [10, 10, 0, 16]];

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
    bots: Math.max(0, BOT_FILL - room.players.size),
    players: [...room.players.values()].map(p => ({ id: p.id, nome: p.nome }))
  });
}

function startMatch(room) {
  addBots(room);
  room.state = 'jogando';
  room.startedAt = Date.now();
  room.zone = { x: MAP / 2, y: MAP / 2, r: 4440, fx: MAP / 2, fy: MAP / 2, fr: 4440, tx: MAP / 2, ty: MAP / 2, tr: 4440, pi: -1, estado: 'espera', t: 0, dps: 0 };
  nextPhase(room.zone);
  // Espalha os jogadores pelo mapa
  for (const p of room.players.values()) {
    for (let k = 0; k < 30; k++) {   // bots never start right next to a person
      p.x = 300 + Math.random() * (MAP - 600);
      p.y = 300 + Math.random() * (MAP - 600);
      if (!p.bot || ![...room.players.values()].some(o => !o.bot && o !== p && o.x && Math.hypot(o.x - p.x, o.y - p.y) < 700)) break;
    }
    if (p.bot) { p.arma = Math.random() < 0.5 ? 'pistola' : (Math.random() < 0.5 ? 'smg' : 'mp40'); p.ai.upgradeAt = Date.now() + 20000 + Math.random() * 40000; }
    p.hp = 100; p.ar = p.bot ? (Math.random() < 0.5 ? 50 : 0) : 0; p.vivo = true; p.kills = 0; p.lastMove = Date.now(); p.lastShot = 0; p.lastFire = 0; p.lastHeal = 0; p.shield = 0; p.shieldUntil = 0; p.lastShieldAt = 0; p.inv = false;
  }
  io.to(room.id).emit('match-start', {
    sala: room.id,
    seed: Math.floor(Math.random() * 1e9),   // use para gerar o mesmo mapa em todos os aparelhos
    players: [...room.players.values()].map(publicPlayer)
  });
}

/* ---------- bots ---------- */
let nextBotId = 1;
function addBots(room) {
  const used = new Set([...room.players.values()].map(p => p.nome));
  const names = BOT_NAMES.filter(n => !used.has(n)).sort(() => Math.random() - 0.5);
  while (room.players.size < BOT_FILL) {
    const id = 'bot' + nextBotId++;
    room.players.set(id, {
      id, bot: true, nome: names.pop() || ('Bot' + id.slice(3)),
      visual: { shirt: Math.floor(Math.random() * 7), pants: Math.floor(Math.random() * 5), skin: Math.floor(Math.random() * 5), head: 'nada', back: 'nada', wskin: 'padrao', outfit: 'basico', evo: 1 },
      x: 0, y: 0, ang: 0, hp: 100, ar: 0, vivo: true, arma: BOT_WEAPONS[Math.floor(Math.random() * BOT_WEAPONS.length)], kills: 0,
      lastMove: Date.now(), lastShot: 0, lastFire: 0, lastHeal: 0, shield: 0, shieldUntil: 0, lastShieldAt: 0, inv: false,
      ai: { tx: 0, ty: 0, target: null, think: 0, strafe: Math.random() < 0.5 ? 1 : -1, heals: 2, react: 0 }
    });
  }
}
const humansAlive = room => [...room.players.values()].some(p => !p.bot && p.vivo);
// The server does not know the map (houses, walls), so bots miss more than the
// offline ones and keep their distance; they still move, chase, flee the zone and heal.
function botThink(room, b, dt) {
  const ai = b.ai, z = room.zone, W = WEAPONS[b.arma], now = Date.now();
  ai.think -= dt;
  if (ai.think <= 0) {
    ai.think = 0.4 + Math.random() * 0.3;
    // nearest living enemy we can "see" (humans spotted from a bit further)
    let best = null, bd = 1e9;
    for (const o of room.players.values()) {
      if (o === b || !o.vivo || o.inv) continue;
      if (!o.bot && now - room.startedAt < 12000) continue;   // first seconds: let people grab loot
      const d = Math.hypot(o.x - b.x, o.y - b.y), see = o.bot ? 380 : 650;
      if (d < see && d < bd) { bd = d; best = o; }
    }
    if (best && best !== ai.target) ai.react = best.bot ? 0.4 + Math.random() * 0.4 : 0.8 + Math.random() * 0.6;
    if (ai.upgradeAt && now > ai.upgradeAt) { ai.upgradeAt = 0; b.arma = BOT_WEAPONS[Math.floor(Math.random() * BOT_WEAPONS.length)]; }   // "found" a better gun
    if (best && best.bot && best !== ai.target && Math.random() < 0.45) best = null;   // lost sight (houses, trees)
    ai.target = best;
    if (Math.random() < 0.3) ai.strafe *= -1;
    if (!ai.target) {
      const outNow = Math.hypot(b.x - z.x, b.y - z.y) > z.r - 80, outNext = Math.hypot(b.x - z.tx, b.y - z.ty) > z.tr - 60;
      const reached = Math.hypot(b.x - ai.tx, b.y - ai.ty) < 40;
      if (outNow || (outNext && (z.estado === 'fechando' || z.t < 12))) {
        const a = Math.random() * 6.28, k = Math.random() * z.tr * 0.5; ai.tx = z.tx + Math.cos(a) * k; ai.ty = z.ty + Math.sin(a) * k;
      } else if (reached || !ai.tx) {
        const a = Math.random() * 6.28, k = Math.sqrt(Math.random()) * Math.min(z.r, 2600) * 0.85;
        ai.tx = clamp(z.x + Math.cos(a) * k, 200, MAP - 200); ai.ty = clamp(z.y + Math.sin(a) * k, 200, MAP - 200);
      }
    }
    // heal out of a fight (inhaler style)
    if (b.hp < 60 && ai.heals > 0 && now - b.lastHeal > 4000 && (!ai.target || Math.hypot(ai.target.x - b.x, ai.target.y - b.y) > 400)) {
      ai.heals--; b.lastHeal = now; b.hp = Math.min(100, b.hp + 30);
    }
  }
  let vx = 0, vy = 0, speed = 175;
  const t = ai.target;
  if (t && t.vivo) {
    const dx = t.x - b.x, dy = t.y - b.y, d = Math.hypot(dx, dy) || 1, nx = dx / d, ny = dy / d;
    const want = Math.min(W.range * 0.55, 380);
    const f = d > want + 60 ? 1 : d < want - 60 ? -0.7 : 0;
    vx = nx * f - ny * ai.strafe * 0.75; vy = ny * f + nx * ai.strafe * 0.75;
    b.ang = Math.atan2(dy, dx);
    ai.react -= dt;
    const gap = Math.max(W.rate, 240);
    if (ai.react <= 0 && d < W.range * 0.9 && now - b.lastShot >= gap) {
      b.lastShot = now; b.lastFire = now;
      io.to(room.id).emit('shot-fx', { de: b.id, arma: b.arma });
      // chance to hit falls with distance and is lower against people (walls the server cannot see)
      const base = t.bot ? 0.16 : 0.2, acc = base * clamp(1.15 - d / W.range, 0.25, 1);
      let hits = 0; for (let i = 0; i < W.pel; i++) if (Math.random() < acc) hits++;
      if (hits > 0) {
        const head = W.pel === 1 && Math.random() < 0.08;
        // automatic weapons fire slower than real cadence here, so each bot shot counts a little more
        const mult = W.rate < gap ? Math.min(1.5, gap / W.rate) * 0.7 : 1;
        damage(room, t, W.dmg * hits * (head ? 2 : 1) * mult, b);
      }
    }
  } else {
    const dx = ai.tx - b.x, dy = ai.ty - b.y, d = Math.hypot(dx, dy);
    if (d > 10) { vx = dx / d; vy = dy / d; b.ang = Math.atan2(dy, dx); }
    if (Math.hypot(b.x - z.x, b.y - z.y) > z.r - 80) speed = 230;
  }
  const l = Math.hypot(vx, vy); if (l > 1) { vx /= l; vy /= l; }
  b.x = clamp(b.x + vx * speed * dt, 150, MAP - 150);
  b.y = clamp(b.y + vy * speed * dt, 150, MAP - 150);
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
  if (vivos.length <= 1 || !humansAlive(room)) {
    room.state = 'fim';
    const w = vivos.length === 1 ? vivos[0] : null;
    io.to(room.id).emit('match-end', { vencedor: w ? { id: w.id, nome: w.nome, kills: w.kills } : null });
    // Fecha a sala depois de um tempo
    setTimeout(() => {
      for (const id of room.players.keys()) {
        const s = io.sockets.sockets.get(id); // bots have no socket
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
    if (![...room.players.values()].some(q => !q.bot)) rooms.delete(room.id);
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
      for (const p of room.players.values()) if (p.bot && p.vivo && room.state === 'jogando') botThink(room, p, dt);
      if (room.state !== 'jogando') continue;
      const z = room.zone;
      io.to(room.id).volatile.emit('state', {
        players: [...room.players.values()].map(publicPlayer),
        zona: { x: Math.round(z.x), y: Math.round(z.y), r: Math.round(z.r), tx: Math.round(z.tx), ty: Math.round(z.ty), tr: z.tr, estado: z.estado, t: Math.ceil(z.t) }
      });
    }
  }
}, TICK);

server.listen(PORT, () => console.log('Servidor do Ilha Zero rodando na porta ' + PORT));
