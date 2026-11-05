// Headless online test: runs several copies of the game page in one Node process, joined to a shared
// stand-in for the online room, and walks through the lobby: ready-up, the 60-second countdown,
// the skip vote, a full round, the trip back to the lobby, and a full room.
//
//   node tools/netsim.js public/index.html
//
// Like tools/sim.js it can't show what the game looks like; it checks the flow and catches crashes.
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(process.argv[2], 'utf8');
let code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
code = code.replace(/\ntoLobby\(\);\nrequestAnimationFrame\(frame\);/, `
window.__dbg = () => ({ state, players: players.length, me: players.findIndex(p => p.isMe), alive: players.filter(p => p.alive).length,
  role: NET.role, code: NET.code, lobby: (NET.role === 'host' ? NET.lobby : (NET.hostG && NET.hostG.lb) || []).length,
  lc: NET.role === 'host' ? (NET.lcEnd ? Math.ceil((NET.lcEnd - performance.now()) / 1000) : -1) : (NET.hostG ? NET.hostG.lc : null),
  le: curLe(), rd: NET.myRd === curLe(), inSeat: iAmIn(), yaw: mainView.yaw, overT, rid: NET.rid, winners: winners.length,
  spawns: players.map(p => p.pos.x.toFixed(2) + ',' + p.pos.z.toFixed(2)) });
toLobby();
requestAnimationFrame(frame);`);

// ---- shared clock and room ----
let simNow = 1000;
const performance = { now: () => simNow };
const hub = { peers: new Map(), subs: new Map(), next: 0 };
function snapshotFor(me) {
  return [...hub.peers.values()].map(p => ({ peer: p.id, kind: 'viewer', isMe: p.id === me, sameTab: p.id === me, presence: p.presence, updatedAt: p.at }));
}
function notify(joined, left) {
  hub.subs.forEach((hs, id) => hs.forEach(h => h({ peers: snapshotFor(id), joined, left, updated: [] })));
}
function roomApi() {
  return {
    join(name) {
      const id = 'peer' + (hub.next++);
      hub.peers.set(id, { id, presence: {}, at: simNow, name });
      hub.subs.set(id, []);
      const room = {
        name,
        peers: () => snapshotFor(id),
        onPeers(h) { hub.subs.get(id).push(h); h({ peers: snapshotFor(id), joined: snapshotFor(id), left: [], updated: [] }); return () => {}; },
        presence(patch) { const p = hub.peers.get(id); if (!p) return Promise.resolve(); for (const k in patch) { if (patch[k] === null) delete p.presence[k]; else p.presence[k] = patch[k]; } p.at = simNow; return Promise.resolve(); },
        leave() { hub.peers.delete(id); hub.subs.delete(id); notify([], [{ peer: id }]); return Promise.resolve(); }
      };
      setTimeout(() => notify([{ peer: id }], []), 0);
      return Promise.resolve(room);
    }
  };
}

// ---- stand-in three.js and DOM (same as tools/sim.js) ----
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } lengthSq() { return this.x*this.x+this.y*this.y+this.z*this.z; } lerpVectors(a, b, t) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; return this; } addScaledVector(v, s) { this.x += v.x*s; this.y += v.y*s; this.z += v.z*s; return this; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } setScalar(s) { this.x = this.y = this.z = s; return this; } copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; } clone() { return new V3(this.x, this.y, this.z); } add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; } sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; } multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; } divideScalar(s) { return this.multiplyScalar(1 / s); } lerp(v, a) { this.x += (v.x - this.x) * a; this.y += (v.y - this.y) * a; this.z += (v.z - this.z) * a; return this; } length() { return Math.hypot(this.x, this.y, this.z); } normalize() { const l = this.length() || 1; return this.divideScalar(l); } project() { this.x = 0; this.y = 0; this.z = 0.5; return this; } applyMatrix4() { return this; } distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); } }
class V2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } set(x, y) { this.x = x; this.y = y; return this; } clone() { return new V2(this.x, this.y); } }
class Color { constructor(h = 0) { this.setHex(typeof h === 'number' ? h : 0); } set(h) { if (typeof h === 'number') this.setHex(h); return this; } setHex(h) { this.r = (h >> 16 & 255) / 255; this.g = (h >> 8 & 255) / 255; this.b = (h & 255) / 255; return this; } getHex() { return (Math.round(this.r * 255) << 16) | (Math.round(this.g * 255) << 8) | Math.round(this.b * 255); } clone() { const c = new Color(); c.r = this.r; c.g = this.g; c.b = this.b; return c; } copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; } lerp(c, a) { this.r += (c.r - this.r) * a; this.g += (c.g - this.g) * a; this.b += (c.b - this.b) * a; return this; } multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; } offsetHSL() { return this; } }
class Rot { constructor() { this.x = 0; this.y = 0; this.z = 0; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
class Obj { constructor() { this.userData = {}; this.quaternion = { setFromUnitVectors() { return this; } }; this.position = new V3(); this.rotation = new Rot(); this.scale = new V3(1, 1, 1); this.children = []; this.visible = true; this.matrix = {}; this.parent = null; this.castShadow = false; this.receiveShadow = false; }
  add(...cs) { cs.forEach(c => { c.parent = this; this.children.push(c); }); return this; } updateMatrix() {} updateMatrixWorld() {} lookAt() {} traverse(f) { f(this); this.children.forEach(c => c.traverse(f)); }
  localToWorld(v) { let o = this; while (o) { v.x = v.x * o.scale.x + o.position.x; v.y = v.y * o.scale.y + o.position.y; v.z = v.z * o.scale.z + o.position.z; o = o.parent; } return v; }
  getWorldPosition(v) { v.set(0, 0, 0); return this.localToWorld(v); } clone() { const o = new this.constructor(this.geometry, this.material); return o; } }
class Mesh extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } }
class Inst extends Mesh { constructor(g, m, n) { super(g, m); this.count = n; this.instanceMatrix = { needsUpdate: false, setUsage() {} }; this.instanceColor = { needsUpdate: false }; } setMatrixAt() {} setColorAt() {} }
class Mat { constructor(o = {}) { this.userData = {}; Object.assign(this, o); this.color = new Color(typeof o.color === 'number' ? o.color : 0xffffff); } clone() { const m = new Mat({}); Object.assign(m, this); m.color = this.color.clone(); return m; } }
const attr = () => ({ count: 0, array: new Float32Array(0), getX: () => 0, getY: () => 0, getZ: () => 0, setX() {}, setY() {}, setZ() {}, setXYZ() {}, needsUpdate: false });
class Geo { constructor() { this.attributes = { position: attr(), normal: attr() }; } setIndex() {} rotateX() { return this; } rotateY() { return this; } rotateZ() { return this; } scale() { return this; } translate() { return this; } computeVertexNormals() {} setAttribute(k, v) { this.attributes[k] = v; } }
class Light extends Obj { constructor() { super(); this.intensity = 1; this.target = new Obj(); this.shadow = { mapSize: new V2(2048, 2048), camera: { updateProjectionMatrix() {} }, map: null }; } }
const THREE = new Proxy({
  Vector3: V3, Vector2: V2, Color, Object3D: Obj, Group: Obj, Scene: Obj, Mesh, InstancedMesh: Inst, PerspectiveCamera: class extends Obj { updateProjectionMatrix() {} },
  DirectionalLight: Light, PointLight: Light, HemisphereLight: Light, AmbientLight: Light,
  MeshStandardMaterial: Mat, MeshPhysicalMaterial: Mat, MeshBasicMaterial: Mat, MeshLambertMaterial: Mat,
  Matrix4: class { compose() { return this; } }, Quaternion: class {}, Shape: class { moveTo() {} lineTo() {} closePath() {} },
  SplineCurve: class { constructor(p) { this.p = p; } getPoints() { return this.p.map(v => v.clone()); } },
  Float32BufferAttribute: class { constructor(a) { this.array = a; } }, BufferGeometry: Geo,
  CanvasTexture: class { constructor() { this.repeat = new V2(); } }, PMREMGenerator: class { fromScene() { return { texture: {} }; } dispose() {} },
  WebGLRenderer: class { constructor() { this.shadowMap = {}; this.capabilities = { getMaxAnisotropy: () => 8 }; this.pr = 1; } setPixelRatio(p) { this.pr = p; } getPixelRatio() { return this.pr; } setSize() {} render() {} setViewport() {} setScissor() {} setScissorTest() {} },
  DoubleSide: 2, BackSide: 1, PCFSoftShadowMap: 2, RepeatWrapping: 1000, DynamicDrawUsage: 35048,
}, { get: (t, k) => k in t ? t[k] : (String(k).endsWith('Geometry') ? Geo : class extends Obj {}) });
const any = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k === Symbol.iterator ? function* () {} : any, apply: () => any, construct: () => any, set: () => true });

const errors = [];
function makeClient(n) {
  const els = {}, listeners = {};
  const mkEl = () => { const h = {}; const e = { _h: h, style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, dataset: {}, hidden: false, disabled: false, textContent: '', innerHTML: '', value: '', children: [], tabIndex: 0, attrs: {},
    querySelector: () => mkEl(), querySelectorAll: () => [], addEventListener(k, f) { (h[k] = h[k] || []).push(f); }, setAttribute(k, v) { e.attrs[k] = v; }, getAttribute: k => e.attrs[k] ?? null, appendChild() {}, closest: () => null, remove() {}, focus() {}, setPointerCapture() {}, getContext: () => any, width: 0, height: 0 }; return e; };
  const document = { addEventListener() {}, pointerLockElement: null, querySelector: s => els[s] || (els[s] = mkEl()), querySelectorAll: () => [], createElement: () => mkEl(), body: mkEl(), documentElement: mkEl() };
  let rafCb = null;
  const win = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener: (k, f) => { (listeners[k] = listeners[k] || []).push(f); }, matchMedia: () => ({ matches: false }), claude: { use: name => Promise.resolve(name === 'room' ? roomApi() : null) } };
  const ctx = vm.createContext({ THREE, document, window: win, navigator: { getGamepads: () => [] }, localStorage: { getItem: () => null, setItem() {} }, location: { protocol: 'https:', host: 'x' },
    performance, requestAnimationFrame: f => { rafCb = f; }, setTimeout, clearTimeout, setInterval, clearInterval, console, Math, btoa, atob, Audio: class { constructor() { this.volume = 0; this.paused = true; } addEventListener() {} play() { return Promise.resolve(); } pause() {} },
    matchMedia: () => ({ matches: false }), Float32Array, Uint8Array, Int8Array, Map, Set, JSON, Array, Object, Promise, Symbol, Number, String, Boolean, Error, TypeError, Proxy });
  ctx.globalThis = ctx;
  vm.runInContext(code, ctx);
  const c = {
    n, els, win,
    frame() { try { rafCb(simNow); } catch (e) { errors.push(`client ${n} frame: ` + e.stack.split('\n').slice(0, 3).join(' | ')); } },
    click(sel) { const el = document.querySelector(sel); (el._h.click || []).forEach(f => f({ target: { closest: () => null } })); },
    key(code) { (listeners.keydown || []).forEach(f => f({ code, key: code, repeat: false, preventDefault() {}, target: {} })); (listeners.keyup || []).forEach(f => f({ code })); },
    setCode(v) { document.querySelector('#codeIn').value = v; },
    d: () => win.__dbg()
  };
  return c;
}

const clients = [];
const tick = async (frames = 1) => { for (let i = 0; i < frames; i++) { simNow += 1000 / 60; clients.forEach(c => c.frame()); if (i % 6 === 0) await new Promise(r => setImmediate(r)); } await new Promise(r => setImmediate(r)); };
const secs = s => tick(Math.round(s * 60));
let fails = 0;
const check = (ok, what) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) fails++; };

(async () => {
  for (let i = 0; i < 6; i++) clients.push(makeClient(i));
  await tick(5);
  const [host, ...guests] = clients;
  host.click('#createBtn'); await tick(3);
  const code = host.d().code;
  check(/^[a-z0-9]{4}$/.test(code), `host made room ${code}`);
  guests.forEach(g => { g.setCode(code); g.click('#joinBtn'); });
  await secs(1);
  check(host.d().lobby === 6, `host sees 6 in the lobby (${host.d().lobby})`);
  check(guests.every(g => g.d().lobby === 6 && g.d().inSeat), 'every guest sees 6 and has a seat');

  console.log('Ready-up and countdown');
  clients.slice(0, 4).forEach(c => c.click('#readyBtn')); await secs(0.5);
  check(host.d().lc === -1 && guests[4].d().lc === -1, '4 ready: no countdown yet');
  guests[4].key('Enter'); await secs(0.5);
  check(host.d().lc === 60, `5th ready (Enter key): countdown starts at 60 (host ${host.d().lc})`);
  check(guests.every(g => g.d().lc === 60), 'every client shows the countdown');
  guests[4].click('#readyBtn'); await secs(0.5);
  check(host.d().lc === -1 && guests[0].d().lc === -1, 'one un-readies: countdown cancelled');
  guests[4].click('#readyBtn'); await secs(10);
  check([50, 51].includes(host.d().lc), `re-ready restarts the countdown, 10 s later it reads ${host.d().lc}`);

  console.log('Skip vote');
  clients.slice(0, 5).forEach(c => c.click('#skipBtn')); await secs(0.5);
  check(host.d().state === 'lobby', '5 of 6 voted to skip: still in the lobby');
  clients[4].click('#skipBtn'); await secs(0.5);   // takes the vote back
  check(host.d().state === 'lobby', 'a vote can be taken back');
  clients[4].click('#skipBtn'); clients[5].key('KeyK'); await secs(0.5);
  check(host.d().state !== 'lobby', `all 6 voted (the 6th with K): round starts right away (${host.d().state})`);
  check(clients.every(c => c.d().players === 6 && c.d().me >= 0), 'all 6 clients are in the round as themselves');
  const sp = host.d().spawns; check(new Set(sp).size === sp.length, 'spawn spots are all different');

  console.log('Round and victory dance');
  let t = 0; while (host.d().state !== 'over' && t < 200) { await secs(1); t++; }
  check(host.d().state === 'over', `round ended after ${t} s with ${host.d().winners} winner(s)`);
  await secs(2);
  const y0 = clients.map(c => c.d().yaw); await secs(6); const y1 = clients.map(c => c.d().yaw);
  check(y0.every((y, i) => Math.abs(y - y1[i]) < 1e-6), 'winner camera does not turn during the dance');
  check(clients.every(c => c.d().state === 'over'), 'every client is on the results');
  await secs(9);
  check(clients.every(c => c.d().state === 'lobby'), 'everyone is back in the lobby after the dance');
  check(clients.every(c => !c.d().rd) && host.d().lc === -1, 'ready flags were cleared, no countdown');

  console.log('Countdown runs out');
  clients.slice(1, 6).forEach(c => c.click('#readyBtn')); await secs(0.5);   // host sits out
  check(host.d().lc === 60, 'five guests ready: countdown at 60');
  await secs(59);
  check(host.d().state === 'lobby', 'still in the lobby at 1 s left');
  await secs(1.5);
  check(host.d().state !== 'lobby' && host.d().players === 5, `at zero the round starts with the 5 who were ready (${host.d().players})`);
  check(host.d().me === -1, 'the host, who was not ready, watches');
  t = 0; while (host.d().state !== 'over' && t < 200) { await secs(1); t++; }
  await secs(17);

  console.log('Full room');
  for (let i = 6; i < 11; i++) { const c = makeClient(i); clients.push(c); await tick(2); c.setCode(code); c.click('#joinBtn'); }
  await secs(1);
  check(host.d().lobby === 11, `host counts 11 in the room (${host.d().lobby})`);
  check(clients[9].d().inSeat && !clients[10].d().inSeat, '10th gets a seat, 11th waits');
  clients[10].click('#readyBtn'); await secs(0.3);
  check(!clients[10].d().rd, "11th can't ready up");
  clients.slice(0, 10).forEach(c => c.click('#readyBtn')); await secs(0.5);
  check(host.d().lc === 60, '10 ready: countdown at 60');
  clients.slice(0, 10).forEach(c => c.click('#skipBtn')); await secs(0.5);
  check(host.d().state !== 'lobby' && host.d().players === 10, `10 skip votes: a 10-player round starts (${host.d().players})`);
  const sp10 = host.d().spawns; check(new Set(sp10).size === 10, `10 different spawn spots (${sp10.join(' ')})`);
  check(clients[10].d().me === -1 && clients[10].d().state !== 'lobby', '11th watches the round');
  t = 0; while (host.d().state !== 'over' && t < 200) { await secs(1); t++; }
  check(host.d().state === 'over', `10-player round ended after ${t} s`);

  console.log(errors.length ? 'ERRORS:\n' + [...new Set(errors)].slice(0, 6).join('\n') : 'no runtime errors');
  console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
  process.exit(fails || errors.length ? 1 : 0);
})();
