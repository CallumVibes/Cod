/* Minimal Nostr client: BIP340 schnorr over secp256k1, no dependencies. */
var NostrLite = (function () {
  'use strict';

  var P = BigInt('0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f');
  var N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  var GX = BigInt('0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  var GY = BigInt('0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8');
  var ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2), THREE = BigInt(3),
      FOUR = BigInt(4), EIGHT = BigInt(8), SEVEN = BigInt(7);

  function mod(a, m) { var r = a % m; return r >= ZERO ? r : r + m; }
  function pow(b, e, m) {
    var r = ONE; b = mod(b, m);
    while (e > ZERO) { if (e & ONE) r = r * b % m; b = b * b % m; e >>= ONE; }
    return r;
  }
  function inv(a, m) { return pow(a, m - TWO, m); }

  /* Jacobian point arithmetic: {x, y, z}, identity has z === 0n */
  var I = { x: ZERO, y: ONE, z: ZERO };

  function dbl(p) {
    if (p.z === ZERO) return I;
    var A = p.x * p.x % P, B = p.y * p.y % P, C = B * B % P;
    var D = mod(TWO * ((p.x + B) * (p.x + B) % P - A - C), P);
    var E = THREE * A % P, F = E * E % P;
    var x = mod(F - TWO * D, P);
    var y = mod(E * (D - x) - EIGHT * C, P);
    var z = mod(TWO * p.y * p.z, P);
    return { x: x, y: y, z: z };
  }

  function add(p, q) {
    if (p.z === ZERO) return q;
    if (q.z === ZERO) return p;
    var z1 = p.z * p.z % P, z2 = q.z * q.z % P;
    var u1 = p.x * z2 % P, u2 = q.x * z1 % P;
    var s1 = p.y * z2 % P * q.z % P, s2 = q.y * z1 % P * p.z % P;
    var h = mod(u2 - u1, P), r = mod(TWO * (s2 - s1), P);
    if (h === ZERO) { return r === ZERO ? dbl(p) : I; }
    var h2 = h * h % P, i = FOUR * h2 % P, j = h * i % P;
    var v = u1 * i % P;
    var x = mod(r * r - j - TWO * v, P);
    var y = mod(r * (v - x) - TWO * s1 % P * j, P);
    var z = mod(((p.z + q.z) * (p.z + q.z) % P - z1 - z2) * h, P);
    return { x: x, y: y, z: z };
  }

  function mul(k, p) {
    var r = I, q = p;
    while (k > ZERO) {
      if (k & ONE) r = add(r, q);
      q = dbl(q);
      k >>= ONE;
    }
    return r;
  }

  function affine(p) {
    if (p.z === ZERO) return null;
    var zi = inv(p.z, P), zi2 = zi * zi % P;
    return { x: p.x * zi2 % P, y: p.y * zi2 % P * zi % P };
  }

  var G = { x: GX, y: GY, z: ONE };

  function liftX(x) {
    if (x <= ZERO || x >= P) return null;
    var c = mod(x * x % P * x + SEVEN, P);
    var y = pow(c, (P + ONE) / FOUR, P);
    if (y * y % P !== c) return null;
    return { x: x, y: (y & ONE) === ZERO ? y : P - y, z: ONE };
  }

  /* byte helpers */
  function hexToBytes(h) {
    if (h.length % 2) throw new Error('bad hex');
    var a = new Uint8Array(h.length / 2);
    for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
    return a;
  }
  function bytesToHex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function numToBytes(v) {
    var a = new Uint8Array(32);
    for (var i = 31; i >= 0; i--) { a[i] = Number(v & BigInt(255)); v >>= EIGHT; }
    return a;
  }
  function bytesToNum(b) {
    var v = ZERO;
    for (var i = 0; i < b.length; i++) v = (v << EIGHT) | BigInt(b[i]);
    return v;
  }
  function cat() {
    var n = 0, i;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
    return out;
  }

  function sha256(bytes) {
    return crypto.subtle.digest('SHA-256', bytes).then(function (b) {
      return new Uint8Array(b);
    });
  }

  var tagCache = {};
  function taggedHash(tag, data) {
    var pre = tagCache[tag];
    var start = pre ? Promise.resolve(pre) : sha256(new TextEncoder().encode(tag)).then(function (h) {
      tagCache[tag] = h; return h;
    });
    return start.then(function (h) { return sha256(cat(h, h, data)); });
  }

  function pubkeyFromSeckey(skBytes) {
    var d = bytesToNum(skBytes);
    if (d === ZERO || d >= N) throw new Error('bad secret key');
    var pt = affine(mul(d, G));
    return numToBytes(pt.x);
  }

  function sign(msg32, sk32, aux32) {
    var d0 = bytesToNum(sk32);
    if (d0 === ZERO || d0 >= N) return Promise.reject(new Error('bad secret key'));
    var pt = affine(mul(d0, G));
    var d = (pt.y & ONE) === ZERO ? d0 : N - d0;
    var px = numToBytes(pt.x);
    var aux = aux32 || new Uint8Array(32);
    return taggedHash('BIP0340/aux', aux).then(function (t0) {
      var dB = numToBytes(d), t = new Uint8Array(32);
      for (var i = 0; i < 32; i++) t[i] = dB[i] ^ t0[i];
      return taggedHash('BIP0340/nonce', cat(t, px, msg32));
    }).then(function (rand) {
      var k0 = mod(bytesToNum(rand), N);
      if (k0 === ZERO) throw new Error('nonce zero');
      var R = affine(mul(k0, G));
      var k = (R.y & ONE) === ZERO ? k0 : N - k0;
      var rx = numToBytes(R.x);
      return taggedHash('BIP0340/challenge', cat(rx, px, msg32)).then(function (ch) {
        var e = mod(bytesToNum(ch), N);
        var s = mod(k + e * d, N);
        return cat(rx, numToBytes(s));
      });
    });
  }

  function verify(msg32, px32, sig64) {
    var Px = bytesToNum(px32);
    var Pp = liftX(Px);
    if (!Pp) return Promise.resolve(false);
    var r = bytesToNum(sig64.slice(0, 32)), s = bytesToNum(sig64.slice(32, 64));
    if (r >= P || s >= N) return Promise.resolve(false);
    return taggedHash('BIP0340/challenge', cat(sig64.slice(0, 32), px32, msg32)).then(function (ch) {
      var e = mod(bytesToNum(ch), N);
      var R = add(mul(s, G), mul(N - e, Pp));
      var Ra = affine(R);
      if (!Ra) return false;
      return (Ra.y & ONE) === ZERO && Ra.x === r;
    });
  }

  /* ---- Nostr event plumbing ---- */

  function serialize(ev) {
    return JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  }

  function finalize(ev, sk) {
    ev.pubkey = bytesToHex(pubkeyFromSeckey(sk));
    ev.created_at = ev.created_at || Math.floor(Date.now() / 1000);
    ev.tags = ev.tags || [];
    ev.content = ev.content || '';
    var bytes = new TextEncoder().encode(serialize(ev));
    return sha256(bytes).then(function (id) {
      ev.id = bytesToHex(id);
      var aux = new Uint8Array(32);
      crypto.getRandomValues(aux);
      return sign(id, sk, aux);
    }).then(function (sig) {
      ev.sig = bytesToHex(sig);
      return ev;
    });
  }

  /* Derive a room keypair from a human room code, so everyone who knows the
     code can read and write the room without any account. */
  function keyFromCode(code) {
    var data = new TextEncoder().encode('stratboard:room:v1:' + code.trim().toLowerCase());
    return sha256(data).then(function (h) {
      var v = mod(bytesToNum(h), N - ONE) + ONE;
      return numToBytes(v);
    });
  }

  /* ---- Relay pool ---- */

  function Pool(urls, opts) {
    this.urls = urls.slice();
    this.socks = {};
    this.onevent = (opts && opts.onevent) || function () {};
    this.onstatus = (opts && opts.onstatus) || function () {};
    this.onnotice = (opts && opts.onnotice) || function () {};
    this.authSign = (opts && opts.authSign) || null;
    this.onauth = (opts && opts.onauth) || function () {};
    this.subs = {};                 // name -> filters
    this.tag = Math.random().toString(36).slice(2, 7);
    this.closed = false;
    this.stats = {};                // url -> {sent, ok, rejected, recv, err}
  }

  Pool.prototype._stat = function (url) {
    if (!this.stats[url]) {
      this.stats[url] = { sent: 0, ok: 0, rejected: 0, recv: 0, err: '' };
    }
    return this.stats[url];
  };
  Pool.prototype.report = function () {
    var self = this;
    return this.urls.map(function (u) {
      var r = self.socks[u], s = self._stat(u);
      var state = !r ? 'idle'
        : r.ws.readyState === 0 ? 'connecting'
        : r.ws.readyState === 1 ? 'connected'
        : 'closed';
      return {
        url: u, state: state, sent: s.sent, ok: s.ok,
        rejected: s.rejected, recv: s.recv, err: s.err, authed: !!s.authed
      };
    });
  };

  Pool.prototype.connect = function () {
    var self = this;
    this.closed = false;
    this.urls.forEach(function (u) { self._open(u); });
  };

  Pool.prototype._open = function (url) {
    var self = this;
    if (this.closed) return;
    var existing = this.socks[url];
    if (existing && (existing.ws.readyState === 0 || existing.ws.readyState === 1)) return;
    var ws;
    try { ws = new WebSocket(url); } catch (e) { return; }
    var rec = { ws: ws, ok: false, tries: (existing && existing.tries) || 0 };
    this.socks[url] = rec;

    ws.onopen = function () {
      rec.ok = true;
      rec.tries = 0;
      self._stat(url).err = '';
      self.onstatus(self.status());
      Object.keys(self.subs).forEach(function (name) {
        try {
          ws.send(JSON.stringify(['REQ', self.tag + name].concat(self.subs[name])));
        } catch (e) {}
      });
    };
    ws.onmessage = function (m) {
      var d;
      try { d = JSON.parse(m.data); } catch (e) { return; }
      var st = self._stat(url);
      if (d[0] === 'EVENT' && d[2]) { st.recv++; self.onevent(d[2], url); return; }

      /* NIP-42: relay wants us to prove we hold the key before it takes writes */
      if (d[0] === 'AUTH' && d[1] && self.authSign) {
        st.err = 'authenticating…';
        self.onstatus(self.status());
        self.authSign(url, d[1]).then(function (ev) {
          rec.authId = ev.id;
          try { ws.send(JSON.stringify(['AUTH', ev])); } catch (e) {}
        }).catch(function () {});
        return;
      }

      if (d[0] === 'OK') {
        if (rec.authId && d[1] === rec.authId) {
          rec.authId = null;
          if (d[2]) {
            st.authed = true;
            st.err = '';
            Object.keys(self.subs).forEach(function (name) {
              try { ws.send(JSON.stringify(['REQ', self.tag + name].concat(self.subs[name]))); } catch (e) {}
            });
            self.onauth(url);
          } else {
            st.err = 'auth refused: ' + String(d[3] || '').slice(0, 70);
          }
          self.onstatus(self.status());
          return;
        }
        if (d[2]) st.ok++;
        else { st.rejected++; st.err = String(d[3] || 'rejected').slice(0, 90); self.onstatus(self.status()); }
        return;
      }
      if (d[0] === 'CLOSED') {
        st.err = 'sub closed: ' + String(d[2] || '').slice(0, 80);
        self.onnotice(url, st.err);
        self.onstatus(self.status());
        return;
      }
      if (d[0] === 'NOTICE') {
        st.err = String(d[1] || '').slice(0, 90);
        self.onnotice(url, st.err);
        self.onstatus(self.status());
      }
    };
    ws.onclose = function () {
      rec.ok = false;
      self.onstatus(self.status());
      if (self.closed) return;
      rec.tries++;
      var wait = Math.min(30000, 1000 * Math.pow(2, Math.min(rec.tries, 5)));
      setTimeout(function () { self._open(url); }, wait + Math.random() * 500);
    };
    ws.onerror = function () { rec.ok = false; self.onstatus(self.status()); };
  };

  Pool.prototype.status = function () {
    var up = 0, total = this.urls.length, self = this;
    this.urls.forEach(function (u) {
      var r = self.socks[u];
      if (r && r.ok && r.ws.readyState === 1) up++;
    });
    return { up: up, total: total };
  };

  /* Each subscription goes out as its own REQ. Relays cap how big a single
     filter may be, and one oversized REQ can take the whole socket down. */
  Pool.prototype.sub = function (name, filters) {
    this.subs[name] = filters;
    var msg = JSON.stringify(['REQ', this.tag + name].concat(filters)), self = this;
    this.urls.forEach(function (u) {
      var r = self.socks[u];
      if (r && r.ws.readyState === 1) { try { r.ws.send(msg); } catch (e) {} }
    });
  };

  Pool.prototype.publish = function (ev) {
    var msg = JSON.stringify(['EVENT', ev]), sent = 0, self = this;
    this.urls.forEach(function (u) {
      var r = self.socks[u];
      if (r && r.ws.readyState === 1) {
        try { r.ws.send(msg); self._stat(u).sent++; sent++; } catch (e) {}
      }
    });
    return sent;
  };

  Pool.prototype.close = function () {
    this.closed = true;
    var self = this;
    this.urls.forEach(function (u) {
      var r = self.socks[u];
      if (r) { try { r.ws.close(); } catch (e) {} }
    });
    this.socks = {};
  };

  return {
    hexToBytes: hexToBytes,
    bytesToHex: bytesToHex,
    pubkeyFromSeckey: pubkeyFromSeckey,
    sign: sign,
    verify: verify,
    finalize: finalize,
    keyFromCode: keyFromCode,
    Pool: Pool
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NostrLite;
