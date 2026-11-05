// Headless smoke test for the game page. Runs the game's script in Node against a stand-in for
// three.js and the DOM, runs the lobby for a while, and reports any runtime errors. The game is
// online-only, so for rounds and the lobby flow use tools/netsim.js.
// It can't show you what the game looks like; it catches crashes and lets you assert on state.
//
//   node tools/sim.js public/index.html            # play ~40 s, print a status line every 4 s
//
// To test something specific, expose what you need right before the game boots: the script
// replaces "toLobby();\nrequestAnimationFrame(frame);" with a window.__dbg getter (see below), so
// add fields there, then drive input with fire('keydown', ...) and step(frames).
// Headless smoke test: runs the game's script with a stand-in THREE and DOM, plays a round, reports.
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(process.argv[2], 'utf8');
let code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
code = code.replace(/\ntoLobby\(\);\nrequestAnimationFrame\(frame\);/, "\nwindow.__dbg = () => ({ state, round: +roundT.toFixed(1), alive: players.filter(p => p.alive).length, players: players.length, segs: segs.map(s => s.state).join(''), wL: +bars.wL.toFixed(2) });\ntoLobby();\nrequestAnimationFrame(frame);");
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
class Mat { constructor(o = {}) { Object.assign(this, o); this.color = new Color(typeof o.color === 'number' ? o.color : 0xffffff); } clone() { const m = new Mat({}); Object.assign(m, this); m.color = this.color.clone(); return m; } }
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
const els = {}, listeners = {};
const mkEl = () => { const e = { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, dataset: {}, hidden: false, textContent: '', innerHTML: '', value: '', children: [], tabIndex: 0,
  querySelector: () => mkEl(), querySelectorAll: () => [], addEventListener() {}, setAttribute() {}, getAttribute: () => null, appendChild() {}, closest: () => null, remove() {}, focus() {}, setPointerCapture() {}, getContext: () => any, width: 0, height: 0 }; return e; };
const document = { addEventListener() {}, pointerLockElement: null, querySelector: s => els[s] || (els[s] = mkEl()), querySelectorAll: () => [], createElement: () => mkEl(), body: mkEl(), documentElement: mkEl() };
const errors = [];
let rafCb = null;
const win = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener: (k, f) => { (listeners[k] = listeners[k] || []).push(f); }, matchMedia: () => ({ matches: false }) };
const ctx = vm.createContext({ THREE, document, window: win, navigator: { getGamepads: () => [] }, localStorage: { getItem: () => null, setItem() {} }, location: { protocol: 'file:', host: '' },
  performance, requestAnimationFrame: f => { rafCb = f; }, setTimeout, clearTimeout, setInterval, clearInterval, console, Math, btoa, atob, Audio: class { constructor() { this.volume = 0; this.paused = true; } addEventListener() {} play() { return Promise.resolve(); } pause() {} },
  matchMedia: () => ({ matches: false }), Float32Array, Uint8Array, Int8Array, Map, Set, JSON, Array, Object, Promise, Symbol, Number, String, Boolean, Error, TypeError, Proxy });
win.claude = undefined; ctx.globalThis = ctx;
try { vm.runInContext(code, ctx); } catch (e) { console.log('LOAD ERROR', e.stack.split('\n').slice(0, 4).join('\n')); process.exit(1); }
const fire = (type, ev) => (listeners[type] || []).forEach(f => { try { f(ev); } catch (e) { errors.push(type + ': ' + e.message); } });
let now = 0; const step = n => { for (let i = 0; i < n; i++) { now += 1000 / 60; try { rafCb(now); } catch (e) { errors.push('frame: ' + e.stack.split('\n').slice(0, 3).join(' | ')); if (errors.length > 5) return; } } };
step(30);
fire('keydown', { code: 'Space', key: ' ', repeat: false, preventDefault() {}, target: {} }); fire('keyup', { code: 'Space' });
fire('keydown', { code: 'Enter', key: 'Enter', repeat: false, preventDefault() {}, target: {} }); fire('keyup', { code: 'Enter' });
for (let s = 0; s < 40; s++) { step(60); const d = win.__dbg(); if (s % 4 === 0) console.log(`t=${s + 1}s`, JSON.stringify(d)); if (errors.length) break; }
console.log(errors.length ? 'ERRORS:\n' + [...new Set(errors)].slice(0, 6).join('\n') : 'no runtime errors');
process.exit(0);
