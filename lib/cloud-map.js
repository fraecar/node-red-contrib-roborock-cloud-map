"use strict";

/**
 * Cloud map client for Roborock vacuums that speak the "1.0" cloud protocol
 * (S series, Qrevo, Saros...). Pure Node.js, no dependencies.
 *
 * Flow: MQTT over TLS to the Roborock broker with the account's IoT credentials
 * (rriot) -> RPC get_map_v1 (answer comes as protocol 301, AES + gzip) -> map
 * parser -> PNG.
 *
 * Ported from python-roborock and vacuum-map-parser-roborock (Apache-2.0), via
 * the JavaScript port in the saugi project (MIT, Michael Krisper).
 * Not an official Roborock product.
 */

const crypto = require("node:crypto");
const net = require("node:net");
const tls = require("node:tls");
const zlib = require("node:zlib");

// ───────────────────────────── Crypto ─────────────────────────────

const md5 = (data) => crypto.createHash('md5').update(data).digest();
const md5hex = (data) => md5(data).toString('hex');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function aesEcbEncrypt(plain, key) {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(plain), c.final()]);
}

function aesEcbDecrypt(cipher, key) {
  if (!cipher.length) return Buffer.alloc(0);
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([d.update(cipher), d.final()]);
}

function aesCbcDecryptZeroIv(cipher, key) {
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16));
  return Buffer.concat([d.update(cipher), d.final()]);
}

// ─────────────────── Protocole « 1.0 » (trames MQTT) ───────────────────
// version(3) seq(4) random(4) timestamp(4) protocol(2) len(2) payload crc32(4), big endian.
// Le payload est chiffré en AES-ECB avec md5(encodeTimestamp(ts) + localKey + SALT).

const SALT = 'TXdfu$jyZ#TZHsg4';
const RPC_REQUEST = 101;
const RPC_RESPONSE = 102;
const MAP_RESPONSE = 301;

function encodeTimestamp(ts) {
  const h = ts.toString(16).padStart(8, '0');
  return [5, 6, 3, 7, 1, 2, 0, 4].map((i) => h[i]).join('');
}

const messageKey = (ts, localKey) => md5(encodeTimestamp(ts) + localKey + SALT);

function encodeMessage({ seq, random, timestamp, protocol, payload }, localKey) {
  const enc = aesEcbEncrypt(payload, messageKey(timestamp, localKey));
  const head = Buffer.alloc(19);
  head.write('1.0', 0, 'latin1');
  head.writeUInt32BE(seq, 3);
  head.writeUInt32BE(random, 7);
  head.writeUInt32BE(timestamp, 11);
  head.writeUInt16BE(protocol, 15);
  head.writeUInt16BE(enc.length, 17);
  const body = Buffer.concat([head, enc]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([body, crc]);
}

function decodeMessage(buf, localKey) {
  buf = Buffer.from(buf);
  const version = buf.toString('latin1', 0, 3);
  if (version !== '1.0') throw new Error(`version de protocole non gérée : ${version}`);
  const msg = {
    seq: buf.readUInt32BE(3),
    random: buf.readUInt32BE(7),
    timestamp: buf.readUInt32BE(11),
    protocol: buf.readUInt16BE(15),
  };
  const len = buf.readUInt16BE(17);
  if (buf.length >= 23 + len && buf.readUInt32BE(19 + len) !== crc32(buf.subarray(0, 19 + len))) {
    throw new Error('somme de contrôle invalide');
  }
  msg.payload = len ? aesEcbDecrypt(buf.subarray(19, 19 + len), messageKey(msg.timestamp, localKey)) : null;
  return msg;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min));

// L'« endpoint » permet de distinguer les réponses de carte destinées à ce
// client de celles destinées à d'autres (ex. l'appli officielle) ; le nonce est
// la clé AES du corps de la carte.
function createSecurity(rriotK) {
  return {
    endpoint: md5(rriotK).subarray(8, 14).toString('base64'),
    nonce: crypto.randomBytes(16),
  };
}

function buildRpc(method, params, security) {
  const id = randInt(10000, 32767);
  const timestamp = nowSeconds();
  const inner = { id, method, params: params ?? [] };
  if (security) {
    inner.security = { endpoint: security.endpoint, nonce: security.nonce.toString('hex') };
  }
  const payload = Buffer.from(JSON.stringify({ dps: { 101: JSON.stringify(inner) }, t: timestamp }));
  return {
    id,
    message: { seq: randInt(100000, 999999), random: randInt(10000, 99999), timestamp, protocol: RPC_REQUEST, payload },
  };
}

function parseDps(payload) {
  return JSON.parse(payload.toString('utf8')).dps ?? {};
}

function decodeMapResponse(payload, security) {
  const endpoint = payload.toString('latin1', 0, 8);
  if (!endpoint.startsWith(security.endpoint)) return null;
  const requestId = payload[16] | (payload[17] << 8);
  const decrypted = aesCbcDecryptZeroIv(payload.subarray(24), security.nonce);
  return { requestId, data: zlib.gunzipSync(decrypted) };
}

// ─────────────────────── Client MQTT 3.1.1 minimal ───────────────────────
// QoS 0/1, une seule souscription : c'est tout ce qu'il faut. TLS sur le port 8883.

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const PUBACK = 4;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGREQ = 12;

function varint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

const mqttStr = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b]);
};
const mqttPacket = (type, flags, body) => Buffer.concat([Buffer.from([(type << 4) | flags]), varint(body.length), body]);
const u16be = (n) => Buffer.from([n >> 8, n & 0xff]);

class MqttClient {
  constructor({ host, port = 8883, secure = true, clientId, username, password, keepalive = 60 }) {
    Object.assign(this, { host, port, secure, clientId, username, password, keepalive });
    this.buf = Buffer.alloc(0);
    this.packetId = 1;
    this.pending = new Map();
    this.onmessage = null;
    this.onclose = null;
    this.connected = false;
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`connexion MQTT : délai dépassé (${this.host}:${this.port})`));
        this.socket?.destroy();
      }, timeoutMs);
      const done = (fn) => (arg) => {
        clearTimeout(timer);
        fn(arg);
      };
      this.pending.set('connack', { resolve: done(resolve), reject: done(reject) });
      const socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host })
        : net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      socket.once(this.secure ? 'secureConnect' : 'connect', () => {
        const body = Buffer.concat([
          mqttStr('MQTT'),
          Buffer.from([4, 0xc2]), // niveau 4 ; flags : utilisateur + mot de passe + clean session
          u16be(this.keepalive),
          mqttStr(this.clientId),
          mqttStr(this.username),
          mqttStr(this.password),
        ]);
        socket.write(mqttPacket(CONNECT, 0, body));
      });
      socket.on('data', (chunk) => {
        try {
          this.#feed(chunk);
        } catch (err) {
          socket.destroy(err);
        }
      });
      socket.on('error', () => {}); // 'close' suit toujours
      socket.on('close', () => {
        this.connected = false;
        clearInterval(this.pinger);
        const err = new Error('connexion MQTT fermée');
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.onclose?.(err);
      });
      this.pinger = setInterval(() => this.#send(mqttPacket(PINGREQ, 0, Buffer.alloc(0))), (this.keepalive * 1000) / 2);
      this.pinger.unref();
    });
  }

  close() {
    this.onclose = null;
    clearInterval(this.pinger);
    this.socket?.destroy();
  }

  subscribe(topic, qos = 1) {
    const id = this.#nextId();
    this.#send(mqttPacket(SUBSCRIBE, 2, Buffer.concat([u16be(id), mqttStr(topic), Buffer.from([qos])])));
    return this.#await(id);
  }

  publish(topic, payload, qos = 1) {
    if (qos === 0) {
      this.#send(mqttPacket(PUBLISH, 0, Buffer.concat([mqttStr(topic), payload])));
      return Promise.resolve();
    }
    const id = this.#nextId();
    this.#send(mqttPacket(PUBLISH, qos << 1, Buffer.concat([mqttStr(topic), u16be(id), payload])));
    return this.#await(id);
  }

  #nextId() {
    this.packetId = (this.packetId % 0xffff) + 1;
    return this.packetId;
  }

  #await(id) {
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  #send(bytes) {
    if (this.socket && !this.socket.destroyed) this.socket.write(bytes);
  }

  #feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      let len = 0;
      let mult = 1;
      let i = 1;
      for (;;) {
        if (i >= this.buf.length) return;
        const b = this.buf[i++];
        len += (b & 0x7f) * mult;
        mult *= 128;
        if (!(b & 0x80)) break;
      }
      if (this.buf.length < i + len) return;
      this.#handle(this.buf[0], this.buf.subarray(i, i + len));
      this.buf = this.buf.subarray(i + len);
    }
  }

  #handle(header, body) {
    const type = header >> 4;
    const id = body.length >= 2 ? (body[0] << 8) | body[1] : 0;
    switch (type) {
      case CONNACK: {
        const p = this.pending.get('connack');
        this.pending.delete('connack');
        if (body[1] === 0) {
          this.connected = true;
          p?.resolve();
        } else p?.reject(new Error(`connexion MQTT refusée (code ${body[1]})`));
        break;
      }
      case PUBLISH: {
        const qos = (header >> 1) & 3;
        const tlen = (body[0] << 8) | body[1];
        const topic = body.toString('utf8', 2, 2 + tlen);
        let off = 2 + tlen;
        if (qos > 0) {
          const pid = (body[off] << 8) | body[off + 1];
          off += 2;
          this.#send(mqttPacket(PUBACK, 0, u16be(pid)));
        }
        this.onmessage?.(topic, Buffer.from(body.subarray(off)));
        break;
      }
      case PUBACK:
      case SUBACK: {
        const p = this.pending.get(id);
        this.pending.delete(id);
        if (type === SUBACK && body[2] === 0x80) p?.reject(new Error('souscription refusée'));
        else p?.resolve();
        break;
      }
      default:
        break; // PINGRESP, etc.
    }
  }
}

// ───────────────────────── Session avec l'aspirateur ─────────────────────────
// Appels RPC avec appariement des identifiants de requête, et blobs de carte (protocole 301).

class Robot {
  /**
   * @param {object} rriot   identifiants IoT du compte (u, s, h, k, r)
   * @param {object} device  { duid, localKey, ... }
   * @param {object} [opts]  { mqtt: {host, port, secure} pour surcharger le broker, debug }
   */
  constructor(rriot, device, opts = {}) {
    this.rriot = rriot;
    this.device = device;
    this.opts = opts;
    this.security = createSecurity(rriot.k);
    this.pending = new Map();
    this.ondps = null;
  }

  log(...args) {
    if (this.opts.log) this.opts.log(args.join(' '));
  }

  async connect() {
    const { u, s, k, r } = this.rriot;
    const broker = new URL(r.m.replace(/^ssl:/, 'https:'));
    const user = md5hex(`${u}:${k}`).slice(2, 10);
    this.mqtt = new MqttClient({
      host: broker.hostname,
      port: Number(broker.port) || 8883,
      secure: true,
      ...this.opts.mqtt,
      clientId: user + md5hex(crypto.randomBytes(8)).slice(0, 8),
      username: user,
      password: md5hex(`${s}:${k}`).slice(16),
    });
    this.mqtt.onmessage = (_topic, payload) => {
      try {
        this.#onMessage(payload);
      } catch (e) {
        this.log('message ignoré :', e.message);
      }
    };
    this.mqtt.onclose = (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.log(`connexion à ${this.mqtt.host}:${this.mqtt.port}`);
    await this.mqtt.connect();
    await this.mqtt.subscribe(`rr/m/o/${u}/${user}/${this.device.duid}`);
    this.topic = `rr/m/i/${u}/${user}/${this.device.duid}`;
    this.log('connecté, topic', this.topic);
  }

  close() {
    // Cancel in-flight calls now instead of leaving them to time out.
    const err = new Error("connection closed");
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.mqtt?.close();
  }

  async rpc(method, params, timeoutMs = 15000) {
    const { id, message } = buildRpc(method, params, this.security);
    this.log('→', method, `id=${id}`);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`l'aspirateur ne répond pas (${method}, ${timeoutMs / 1000} s)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
        map: method === 'get_map_v1',
      });
    });
    // Promise.all observe les deux promesses : un délai dépassé pendant l'attente de
    // l'acquittement MQTT (ou une coupure) devient une erreur claire, pas un rejet orphelin.
    const [, value] = await Promise.all([
      this.mqtt.publish(this.topic, encodeMessage(message, this.device.localKey)),
      result,
    ]);
    return value;
  }

  async status() {
    const [s] = await this.rpc('get_status');
    return s;
  }

  map() {
    return this.rpc('get_map_v1', undefined, 30000);
  }

  roomMapping() {
    return this.rpc('get_room_mapping');
  }

  #onMessage(raw) {
    const msg = decodeMessage(raw, this.device.localKey);
    this.log('←', `protocole ${msg.protocol}`, msg.payload ? `${msg.payload.length} octets` : 'vide');
    if (msg.protocol === MAP_RESPONSE) {
      const res = decodeMapResponse(msg.payload, this.security);
      const p = res && this.pending.get(res.requestId);
      if (p) {
        this.pending.delete(res.requestId);
        p.resolve(res.data);
      }
      return;
    }
    if (msg.protocol !== RPC_RESPONSE || !msg.payload) return;
    const dps = parseDps(msg.payload);
    if (dps[102]) {
      const res = JSON.parse(dps[102]);
      const p = this.pending.get(res.id);
      // get_map_v1 est acquitté par ["ok"] ; la carte suit ensuite en protocole 301.
      if (!p || (p.map && !res.error)) return;
      this.pending.delete(res.id);
      if (res.error) p.reject(new Error(res.error.message ?? JSON.stringify(res.error)));
      else p.resolve(res.result);
    } else {
      this.ondps?.(dps);
    }
  }
}

// ───────────────────────── Format de carte « v1 » ─────────────────────────
// Un en-tête puis une chaîne de blocs. Les coordonnées sont en millimètres ;
// un pixel d'image = 50 mm.

const B_CHARGER = 1;
const B_IMAGE = 2;
const B_PATH = 3;
const B_ROBOT = 8;
// Type de bloc -> [champ, coordonnées par forme] : zones = 4 coins, murs = 2 extrémités.
const SHAPES = { 9: ['noGo', 8], 10: ['walls', 4], 12: ['noMop', 8] };

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

function position(data, len) {
  const p = { x: u32(data, 0), y: u32(data, 4), a: 0 };
  if (len > 8) {
    let a = u32(data, 8);
    if (a > 0xff) a = (a & 0xff) - 256;
    p.a = a;
  }
  return p;
}

function shapes(raw, pos, data, coords) {
  const count = u16(raw, pos + 8);
  return Array.from({ length: count }, (_, i) => Array.from({ length: coords }, (_, j) => u16(data, (i * coords + j) * 2)));
}

function parseMap(raw) {
  const map = { path: [], robot: null, charger: null, image: null, noGo: [], walls: [], noMop: [] };
  let pos = u16(raw, 2);
  while (pos < raw.length) {
    const type = u16(raw, pos);
    const headerLen = u16(raw, pos + 2);
    const dataLen = u32(raw, pos + 4);
    const start = pos + headerLen;
    const data = raw.subarray(start, start + dataLen);
    if (type === B_CHARGER) map.charger = position(data, dataLen);
    else if (type === B_ROBOT) map.robot = position(data, dataLen);
    else if (SHAPES[type]) map[SHAPES[type][0]] = shapes(raw, pos, data, SHAPES[type][1]);
    else if (type === B_PATH) {
      const pts = new Uint16Array(Math.floor(dataLen / 2));
      for (let i = 0; i < pts.length; i++) pts[i] = u16(raw, pos + 0x14 + i * 2);
      map.path = pts;
    } else if (type === B_IMAGE) {
      map.image = {
        top: i32(raw, start - 16),
        left: i32(raw, start - 12),
        height: i32(raw, start - 8),
        width: i32(raw, start - 4),
        pixels: data,
      };
    }
    pos = start + dataLen;
    if (headerLen === 0 && dataLen === 0) break; // garde-fou contre une boucle infinie
  }
  return map;
}

/** Millimètres -> pixel d'image (axe y inversé, origine en haut à gauche). */
function toPixel(img, x, y) {
  return [x / 50 - img.left, img.height - (y / 50 - img.top) - 1];
}

/** Valeur de pixel sous une position en mm. */
function pixelAt(img, x, y) {
  const col = Math.floor(x / 50 - img.left);
  const row = Math.floor(y / 50 - img.top);
  if (col < 0 || row < 0 || col >= img.width || row >= img.height) return 0;
  return img.pixels[row * img.width + col];
}

const hexToRgb = (h) => {
  const n = Number.parseInt(h.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};

const ROOM_RGB = [
  '#3b6ea8', '#4f8a6b', '#a8743b', '#7a5aa8', '#a84f6a', '#3b8f9a', '#8f8a3b', '#5a6aa8',
  '#6a9a4f', '#a85a4f', '#4f7aa8', '#9a4f8f', '#4f9a8a', '#a8914f', '#6a5aa8', '#8a4f4f',
].map(hexToRgb);
const WALL = hexToRgb('#cfd6de');
const FLOOR = hexToRgb('#2c333d');
const GREY = hexToRgb('#7d8590');

const isRoom = (t) => t !== 0xff && t !== 7 && (t & 7) === 7;
const roomId = (t) => (isRoom(t) ? t >> 3 : null);

function pixelColor(t, hidden) {
  if (t === 1) return WALL;
  if (t === 0xff || t === 7) return FLOOR;
  if ((t & 7) === 7) return hidden && hidden.has(t >> 3) ? FLOOR : ROOM_RGB[(t >> 3) % ROOM_RGB.length];
  return (t & 7) === 1 ? WALL : GREY;
}

// Boîte englobante de tout ce qui n'est pas « dehors » (0).
function bounds({ width: w, height: h, pixels }) {
  const b = { x0: w, y0: h, x1: -1, y1: -1 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pixels[y * w + x] === 0) continue;
      b.x0 = Math.min(b.x0, x);
      b.x1 = Math.max(b.x1, x);
      b.y0 = Math.min(b.y0, y);
      b.y1 = Math.max(b.y1, y);
    }
  }
  return b.x1 < 0 ? null : b;
}

/**
 * Bitmap rogné du plan + centres des pièces (en pixels du plan rogné).
 * `hidden` : ensemble de numéros de pièces à dessiner comme du simple sol et à ne pas lister.
 */
function rasterize(img, hidden = null) {
  const b = bounds(img);
  if (!b) return null;
  const { width: w, pixels } = img;
  const cw = b.x1 - b.x0 + 1;
  const ch = b.y1 - b.y0 + 1;
  const rgba = new Uint8ClampedArray(cw * ch * 4);
  const rooms = new Map();
  for (let y = b.y0; y <= b.y1; y++) {
    const outY = b.y1 - y; // retournement : la ligne brute 0 est en bas
    for (let x = b.x0; x <= b.x1; x++) {
      const t = pixels[y * w + x];
      if (t === 0) continue;
      const c = pixelColor(t, hidden);
      rgba.set([c[0], c[1], c[2], 255], (outY * cw + (x - b.x0)) * 4);
      if (isRoom(t) && !(hidden && hidden.has(t >> 3))) {
        const r = rooms.get(t >> 3) ?? { sx: 0, sy: 0, n: 0 };
        r.sx += x - b.x0;
        r.sy += outY;
        r.n++;
        rooms.set(t >> 3, r);
      }
    }
  }
  const centers = [...rooms].map(([id, r]) => ({ id, x: r.sx / r.n, y: r.sy / r.n }));
  return { rgba, width: cw, height: ch, ox: b.x0, oy: img.height - 1 - b.y1, centers };
}

// ───────────────────────── Rendu PNG (sans dépendance) ─────────────────────────

function encodePng(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filtre « aucun »
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

class Canvas {
  constructor(w, h, bg) {
    this.w = w;
    this.h = h;
    this.px = new Uint8ClampedArray(w * h * 4);
    if (bg) for (let i = 0; i < w * h; i++) this.px.set(bg, i * 4);
  }

  // Composition alpha « source over » d'un pixel (couleur rgb, opacité a de 0 à 1).
  blend(x, y, [r, g, b], a) {
    x = Math.round(x);
    y = Math.round(y);
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const da = this.px[i + 3] / 255;
    const oa = a + da * (1 - a);
    this.px[i] = (r * a + this.px[i] * da * (1 - a)) / oa;
    this.px[i + 1] = (g * a + this.px[i + 1] * da * (1 - a)) / oa;
    this.px[i + 2] = (b * a + this.px[i + 2] * da * (1 - a)) / oa;
    this.px[i + 3] = oa * 255;
  }

  circle(cx, cy, r, color, alpha = 1) {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const cover = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(x - cx, y - cy)));
        if (cover > 0) this.blend(x, y, color, alpha * cover);
      }
    }
  }

  line(x0, y0, x1, y1, width, color) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(0.5, width / 3)));
    for (let i = 0; i <= steps; i++) {
      this.circle(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, width / 2, color);
    }
  }

  polygon(pts, color, alpha) {
    // Remplissage par balayage, règle pair/impair.
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [, y] of pts) (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y));
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(this.h - 1, Math.ceil(y1)); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= y + 0.5 && by > y + 0.5) || (by <= y + 0.5 && ay > y + 0.5)) {
          xs.push(ax + ((y + 0.5 - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) this.blend(x, y, color, alpha);
      }
    }
  }

  outline(pts, width, color, close = true) {
    const n = close ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      this.line(ax, ay, bx, by, width, color);
    }
  }
}

const pairs = (flat) => {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};

/**
 * Dessine la carte : plan, zones interdites, murs virtuels, trajet, base, robot.
 * @returns {{ png: Buffer, width: number, height: number, scale: number, rooms: object[],
 *             project: (x:number, y:number) => [number, number] }}
 */
function renderMap(map, { scale = 4, pad = 8, transparent = false, drawPath = true, hiddenRooms = null } = {}) {
  if (!map.image) throw new Error('la carte ne contient pas de plan');
  const r = rasterize(map.image, hiddenRooms);
  if (!r) throw new Error('la carte est vide');
  const W = r.width * scale + 2 * pad;
  const H = r.height * scale + 2 * pad;
  const cv = new Canvas(W, H, transparent ? null : [27, 31, 36, 255]);

  // Plan agrandi sans lissage.
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const i = (y * r.width + x) * 4;
      if (r.rgba[i + 3] === 0) continue;
      for (let dy = 0; dy < scale; dy++) {
        const o = ((pad + y * scale + dy) * W + pad + x * scale) * 4;
        for (let dx = 0; dx < scale; dx++) cv.px.set(r.rgba.subarray(i, i + 4), o + dx * 4);
      }
    }
  }

  const project = (x, y) => {
    const [px, py] = toPixel(map.image, x, y);
    return [(px - r.ox + 0.5) * scale + pad, (py - r.oy + 0.5) * scale + pad];
  };

  const RED = [255, 93, 93];
  const PURPLE = [176, 120, 255];
  for (const [zones, color] of [[map.noGo, RED], [map.noMop, PURPLE]]) {
    for (const z of zones) {
      const pts = pairs(z).map(([x, y]) => project(x, y));
      cv.polygon(pts, color, 0.28);
      cv.outline(pts, 2, color);
    }
  }
  for (const w of map.walls) cv.outline(pairs(w).map(([x, y]) => project(x, y)), 3, RED, false);

  if (drawPath && map.path.length >= 4) {
    cv.outline(pairs(map.path).map(([x, y]) => project(x, y)), Math.max(1.5, scale * 0.6), [235, 240, 245], false);
  }
  if (map.charger) {
    const [x, y] = project(map.charger.x, map.charger.y);
    cv.circle(x, y, Math.max(6, scale * 2), [60, 207, 122]);
  }
  if (map.robot) {
    const [x, y] = project(map.robot.x, map.robot.y);
    const R = Math.max(9, scale * 3.5);
    const a = (map.robot.a * Math.PI) / 180;
    cv.circle(x, y, R + 2, [79, 157, 255]);
    cv.circle(x, y, R - 1, [255, 255, 255]);
    cv.circle(x + Math.cos(a) * R * 0.5, y - Math.sin(a) * R * 0.5, R * 0.3, [79, 157, 255]);
  }

  return {
    png: encodePng(cv.px, W, H),
    width: W,
    height: H,
    scale,
    // Centres des pièces en pixels de l'image PNG (utile pour superposer des noms).
    rooms: r.centers.map((c) => ({ id: c.id, x: Math.round((c.x + 0.5) * scale + pad), y: Math.round((c.y + 0.5) * scale + pad) })),
    project,
  };
}

// ───────────────────────────── Report ─────────────────────────────

const STATES = {
  1: "Starting", 2: "Off the dock", 3: "Idle", 4: "Remote control", 5: "Cleaning", 6: "Returning home",
  7: "Manual mode", 8: "Charging", 9: "Charging problem", 10: "Paused", 11: "Spot cleaning", 12: "Error",
  13: "Shutting down", 14: "Updating", 15: "Docking", 16: "Going to target", 17: "Zone cleaning",
  18: "Room cleaning", 22: "Emptying bin", 23: "Washing mop", 26: "Going to wash mop",
  29: "Mapping", 100: "Fully charged", 101: "Offline", 103: "Locked",
};

// Test hook: lets tests point the client at a plain-TCP fake broker.
const testing = { mqtt: null };

/**
 * Connects to the cloud broker and collects the robot status, the raw map and the
 * room mapping. Status and room mapping are best effort; the map is required.
 * @param {object} rriot   IoT credentials from the account login (u, s, k, r.m)
 * @param {object} device  { duid, localKey }
 * @param {object} [opts]  { log(msg), mqtt, onRobot(robot) }
 */
async function collect(rriot, device, opts = {}) {
  const robot = new Robot(rriot, device, { log: opts.log, mqtt: opts.mqtt || testing.mqtt || undefined });
  if (opts.onRobot) opts.onRobot(robot);
  let status = null;
  let rawMap;
  let mapping = [];
  try {
    await robot.connect();
    try {
      status = await robot.status();
    } catch (e) {
      robot.log("status unavailable:", e.message);
    }
    rawMap = await robot.map();
    try {
      mapping = (await robot.roomMapping()) || [];
    } catch (e) {
      robot.log("room mapping unavailable:", e.message);
    }
  } finally {
    robot.close();
  }
  return { status, rawMap, mapping };
}

/** segment id -> room name, from get_room_mapping ([[segmentId, roomId], ...]) and the cloud room list. */
function namesFromMapping(mapping, cloudRooms) {
  const byId = new Map((cloudRooms || []).map((r) => [String(r.id), r.name]));
  const out = {};
  for (const pair of Array.isArray(mapping) ? mapping : []) {
    if (!Array.isArray(pair)) continue;
    const name = byId.get(String(pair[1]));
    if (name) out[pair[0]] = name;
  }
  return out;
}

const normalizeName = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** "Salon, 18, Ancien bureau" ou ["Salon", 18] -> { names: Set(normalisés), ids: Set(numéros) } */
function parseHideList(input) {
  const tokens = Array.isArray(input) ? input : String(input == null ? "" : input).split(/[,;\n]/);
  const out = { names: new Set(), ids: new Set() };
  for (const raw of tokens) {
    const token = String(raw).trim();
    if (!token) continue;
    if (/^\d+$/.test(token)) out.ids.add(Number(token));
    else out.names.add(normalizeName(token));
  }
  return out;
}

/** Numéros de pièces présents dans les pixels de la carte. */
function roomIdsIn(img) {
  const ids = new Set();
  for (const t of img.pixels) if (isRoom(t)) ids.add(t >> 3);
  return ids;
}

/**
 * Quelles pièces masquer : celles de la liste (par nom ou par numéro) et, si demandé, celles sans nom.
 * Garde-fou : si AUCUNE pièce de la carte n'a de nom (noms indisponibles, par ex. cloud injoignable),
 * « sans nom » ne masque rien, sinon toute la carte disparaîtrait.
 */
function computeHiddenRooms(map, names, { hide, hideUnnamed = false } = {}) {
  const hidden = new Set();
  const details = [];
  const warnings = [];
  if (!map.image) return { hidden, details, warnings };
  const list = parseHideList(hide);
  const present = [...roomIdsIn(map.image)].sort((a, b) => a - b);
  const namesAvailable = present.some((id) => names[id]);
  if (hideUnnamed && !namesAvailable) {
    warnings.push("room names unavailable: the 'hide unnamed rooms' option was skipped");
  }
  for (const id of present) {
    const name = names[id] || null;
    let reason = null;
    if (list.ids.has(id)) reason = "id";
    else if (name && list.names.has(normalizeName(name))) reason = "name";
    else if (hideUnnamed && namesAvailable && !name) reason = "unnamed";
    if (reason) {
      hidden.add(id);
      details.push({ id, name, reason });
    }
  }
  return { hidden, details, warnings };
}

function buildReport(rawMap, { device, status, names = {}, scale = 4, drawPath = true, hide, hideUnnamed = false } = {}) {
  const map = parseMap(rawMap);
  const { hidden, details, warnings } = computeHiddenRooms(map, names, { hide, hideUnnamed });
  const img = renderMap(map, { scale, drawPath, hiddenRooms: hidden });
  const at = (x, y) => img.project(x, y).map(Math.round);
  const report = {
    fetchedAt: new Date().toISOString(),
    device: device ? { name: device.deviceName || device.name || "", model: device.model || "", duid: device.duid } : undefined,
    status: status ? {
      ...status,
      stateText: STATES[status.state] || `State ${status.state}`,
      cleanAreaM2: status.clean_area ? Math.round(status.clean_area / 1e4) / 100 : 0,
    } : null,
    robot: null,
    charger: map.charger ? { x: map.charger.x, y: map.charger.y, px: at(map.charger.x, map.charger.y)[0], py: at(map.charger.x, map.charger.y)[1] } : null,
    image: { width: img.width, height: img.height, scale: img.scale },
    rooms: img.rooms.map((c) => ({ ...c, name: names[c.id] || null })),
    zones: { noGo: map.noGo.length, noMop: map.noMop.length, walls: map.walls.length },
    pathPoints: map.path.length / 2,
  };
  if (map.robot) {
    const [px, py] = at(map.robot.x, map.robot.y);
    const id = roomId(pixelAt(map.image, map.robot.x, map.robot.y));
    report.robot = {
      x: map.robot.x,
      y: map.robot.y,
      angle: map.robot.a,
      px,
      py,
      room: id == null || hidden.has(id) ? null : { id, name: names[id] || null },
    };
  }
  report.hiddenRooms = details;
  report.warnings = warnings;
  return { report, png: img.png };
}

module.exports = {
  // protocol
  md5, md5hex, crc32, aesEcbEncrypt, aesEcbDecrypt, aesCbcDecryptZeroIv,
  RPC_REQUEST, RPC_RESPONSE, MAP_RESPONSE,
  encodeTimestamp, encodeMessage, decodeMessage, createSecurity, buildRpc, parseDps, decodeMapResponse,
  // transport
  MqttClient, Robot,
  // map
  parseMap, toPixel, pixelAt, isRoom, roomId, rasterize, encodePng, renderMap,
  // high level
  STATES, collect, namesFromMapping, buildReport, parseHideList, computeHiddenRooms,
  _testing: testing,
};
