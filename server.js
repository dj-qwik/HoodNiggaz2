// Hood Niggas 2 game server: serves the game page and relays online rooms over WebSockets.
// No dependencies, so Render only needs Node to run it.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');
const MAX_PER_ROOM = 8;          // 4 players plus a few spectators
const MAX_MESSAGE = 64 * 1024;   // a game state update is ~1-2 KB

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (err, body) => {
      if (err) { res.writeHead(500); res.end('Could not load the game.'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(body);
    });
    return;
  }
  const song = url.match(/^\/music\/([A-Za-z0-9_-]+\.mp3)$/);
  if (song) { sendSong(req, res, path.join(__dirname, 'public', 'music', song[1])); return; }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
});

// songs support byte ranges so browsers can stream and loop them
function sendSong(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m || (!m[1] && !m[2])) {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res); return;
    }
    let start = m[1] ? parseInt(m[1], 10) : Math.max(0, st.size - parseInt(m[2], 10));
    let end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

/* ---------- minimal WebSocket (RFC 6455) ---------- */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

class Client {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.frags = []; this.open = true; this.alive = true;
    this.id = crypto.randomBytes(6).toString('base64url');
    this.room = null; this.presence = {};
    socket.setNoDelay(true);
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.socket.destroy());
  }
  send(text) { if (this.open) this.socket.write(encodeFrame(0x1, Buffer.from(text))); }
  close() { if (!this.open) return; try { this.socket.write(encodeFrame(0x8, Buffer.alloc(0))); } catch (e) {} this.socket.end(); this.open = false; }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1], fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MESSAGE || !masked) { this.close(); this.socket.destroy(); return; }
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4), data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.socket.write(encodeFrame(0xA, data)); continue; }
      if (op === 0xA) { this.alive = true; continue; }
      if (op === 0x1 || op === 0x0) {
        this.frags.push(data);
        if (fin) { const msg = Buffer.concat(this.frags).toString('utf8'); this.frags = []; this.onMessage(msg); }
      }
    }
  }
  onMessage(text) {
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (m.t === 'join' && !this.room && typeof m.room === 'string' && /^[a-z0-9][a-z0-9_.-]{0,47}$/.test(m.room)) {
      let r = rooms.get(m.room);
      if (!r) { r = new Set(); rooms.set(m.room, r); }
      if (r.size >= MAX_PER_ROOM) { this.send(JSON.stringify({ t: 'full' })); this.close(); return; }
      this.room = m.room;
      this.send(JSON.stringify({ t: 'welcome', id: this.id, peers: [...r].map(c => ({ id: c.id, presence: c.presence })) }));
      r.add(this);
      broadcast(r, this, { t: 'p', id: this.id, presence: this.presence });
    } else if (m.t === 'p' && this.room && m.presence && typeof m.presence === 'object') {
      this.presence = m.presence;
      broadcast(rooms.get(this.room), this, { t: 'p', id: this.id, presence: m.presence });
    }
  }
  onClose() {
    this.open = false;
    const r = this.room && rooms.get(this.room); if (!r) return;
    r.delete(this);
    if (r.size === 0) rooms.delete(this.room);
    else broadcast(r, null, { t: 'leave', id: this.id });
  }
}

const rooms = new Map();
const clients = new Set();
function broadcast(room, except, msg) {
  if (!room) return;
  const frame = encodeFrame(0x1, Buffer.from(JSON.stringify(msg)));
  for (const c of room) if (c !== except && c.open) c.socket.write(frame);
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url.split('?')[0] !== '/ws' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const c = new Client(socket); clients.add(c);
  socket.on('close', () => clients.delete(c));
});

// keep connections alive through Render's proxy and drop dead ones
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.socket.destroy(); continue; }
    c.alive = false;
    try { c.socket.write(encodeFrame(0x9, Buffer.alloc(0))); } catch (e) {}
  }
}, 25000);

server.listen(PORT, () => console.log('Game server running on port ' + PORT));
