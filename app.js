/* Strat Board — offline-first strat planner with optional live rooms over Nostr. */
(function () {
  'use strict';

  var VERSION = '5.2';
  /* Write-friendly public relays. relay.nostr.band is a search aggregator and
     nostr.wine is paid, so neither accepts writes from a fresh key. */
  var DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://nostr.mom',
    'wss://nostr.oxtr.dev',
    'wss://nostr-pub.wellorder.net'
  ];
  /* Known not to take writes from a fresh key: paid, search-only, or gated
     behind someone vouching for you — offchain.pub turns a new room key away
     with "not in our web of trust". */
  var BAD_RELAYS = ['nostr.wine', 'relay.nostr.band', 'filter.nostr.wine',
                    'purplepag.es', 'offchain.pub'];
  var MAX_PX = 1600;         // longest edge kept for stored map images
  var SEND_MS = 350;         // live broadcast throttle while dragging
  var CHUNK = 14000;         // base64 chars per event — relays commonly cap at 32-64 KB
  var MAX_CHUNKS = 48;       // hard ceiling on a shared map (~670 KB of base64)
  var SHARE_PX = 1200;       // longest edge of the copy sent to teammates
  var BEAT_MS = 12000;       // presence heartbeat
  var STALE_MS = 40000;      // drop a member after this long unheard
  var MAPW = 1000;

  /* ---------- tiny DOM helpers ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var SVGNS = 'http://www.w3.org/2000/svg';
  /* Simple shapes rather than letters: they stay readable when the map is
     turned, and at the size a phone draws them. */
  function drawUtil(g, kind, x, y, r, col, sw) {
    var w = sw * 0.5;
    if (kind === 'smoke') {
      [[-0.42, 0.12, 0.42], [0.42, 0.12, 0.42], [0, -0.22, 0.5]].forEach(function (c) {
        g.appendChild(svgEl('circle', {
          cx: x + r * c[0], cy: y + r * c[1], r: r * c[2],
          fill: 'none', stroke: col, 'stroke-width': w
        }));
      });
      return;
    }
    if (kind === 'flash') {
      var pts = [], i;
      for (i = 0; i < 8; i++) {
        var ang = (Math.PI / 4) * i, rad = i % 2 ? r * 0.26 : r * 0.72;
        pts.push((x + Math.cos(ang) * rad).toFixed(1) + ',' + (y + Math.sin(ang) * rad).toFixed(1));
      }
      g.appendChild(svgEl('polygon', { points: pts.join(' '), fill: col }));
      return;
    }
    if (kind === 'stun') {
      [0.3, 0.52, 0.74].forEach(function (f) {
        g.appendChild(svgEl('circle', {
          cx: x, cy: y, r: r * f, fill: 'none', stroke: col, 'stroke-width': w
        }));
      });
      return;
    }
    // frag
    g.appendChild(svgEl('circle', { cx: x, cy: y + r * 0.1, r: r * 0.46, fill: col }));
    g.appendChild(svgEl('rect', {
      x: x - r * 0.16, y: y - r * 0.72, width: r * 0.32, height: r * 0.34,
      rx: r * 0.08, fill: col
    }));
  }

  function svgEl(name, attrs) {
    var n = document.createElementNS(SVGNS, name);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function uid() {
    return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7);
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function esc(s) { return String(s == null ? '' : s); }

  function toast(msg, ms) {
    var box = $('toast'), d = document.createElement('div');
    d.textContent = msg;
    while (box.childNodes.length > 1) box.removeChild(box.firstChild);
    box.appendChild(d);
    setTimeout(function () {
      d.style.opacity = '0';
      d.style.transition = 'opacity .25s';
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 260);
    }, ms || 2200);
  }

  /* modal that returns a promise: {action:'ok'|'cancel'|'extra', value} */
  var modalResolve = null;
  function ask(opts) {
    var m = $('modal');
    $('mtitle').textContent = opts.title || '';
    $('mbody').textContent = opts.body || '';
    $('mbody').style.display = opts.body ? '' : 'none';
    var wrap = $('mfield'), input = $('minput');
    if (opts.field) {
      wrap.style.display = '';
      input.value = opts.value == null ? '' : opts.value;
      input.placeholder = opts.placeholder || '';
      input.maxLength = opts.maxLength || 60;
    } else {
      wrap.style.display = 'none';
    }
    $('mok').textContent = opts.okText || 'OK';
    $('mcancel').textContent = opts.cancelText || 'Cancel';
    var extra = $('mextra');
    if (opts.extraText) {
      if (!extra) {
        extra = document.createElement('button');
        extra.id = 'mextra';
        extra.className = 'danger';
        $('mcancel').parentNode.insertBefore(extra, $('mcancel'));
        extra.addEventListener('click', function () { done('extra'); });
      }
      extra.textContent = opts.extraText;
      extra.style.display = '';
    } else if (extra) {
      extra.style.display = 'none';
    }
    m.classList.add('open');
    if (opts.field) {
      /* Android only raises the keyboard for a focus it can trace back to
         the person's own tap, so take it immediately where we can. */
      try { input.focus(); input.select(); } catch (e2) {}
      setTimeout(function () {
        if (document.activeElement !== input) { try { input.focus(); input.select(); } catch (e2) {} }
      }, 60);
    }
    return new Promise(function (res) { modalResolve = res; });
  }
  function done(action) {
    var m = $('modal');
    m.classList.remove('open');
    var r = modalResolve;
    modalResolve = null;
    if (r) r({ action: action, value: $('minput').value.trim() });
  }
  function confirmBox(title, body, okText) {
    return ask({ title: title, body: body, okText: okText || 'Delete' })
      .then(function (r) { return r.action === 'ok'; });
  }

  /* ---------- IndexedDB ---------- */
  var DB = null;
  function openDb() {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open('stratboard', 2);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains('maps')) db.createObjectStore('maps', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('hills')) db.createObjectStore('hills', { keyPath: 'k' });
      };
      rq.onsuccess = function () { DB = rq.result; res(DB); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function tx(store, mode) { return DB.transaction(store, mode).objectStore(store); }
  function dbAll(store) {
    return new Promise(function (res, rej) {
      var out = [], c = tx(store, 'readonly').openCursor();
      c.onsuccess = function () {
        var cur = c.result;
        if (cur) { out.push(cur.value); cur.continue(); } else res(out);
      };
      c.onerror = function () { rej(c.error); };
    });
  }
  function dbPut(store, val) {
    return new Promise(function (res, rej) {
      var r = tx(store, 'readwrite').put(val);
      r.onsuccess = function () { res(val); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function dbDel(store, key) {
    return new Promise(function (res, rej) {
      var r = tx(store, 'readwrite').delete(key);
      r.onsuccess = function () { res(); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function dbGet(store, key) {
    return new Promise(function (res, rej) {
      var r = tx(store, 'readonly').get(key);
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  /* ---------- state ---------- */
  var S = {
    maps: [],
    boards: [],
    mapId: null,
    boardId: null,
    tool: 'move',
    markKind: 'x',
    arrowOwn: '',
    onlyOwn: false,
    colour: '#f5b708',
    view: { x: 0, y: 0, w: MAPW, h: MAPW },
    objUrl: null,
    undo: [],
    redo: [],
    nick: '',
    room: '',
    relays: DEFAULT_RELAYS.slice(),
    clientId: uid(),
    members: {},
    pool: null,
    roomSk: null,
    roomPub: null,
    seq: 0,
    lastSend: 0,
    sendTimer: null,
    pendingRemote: null,
    pendingState: null,
    mapRx: { meta: null, chunks: {} },
    mapSent: false,
    roomMapName: '',
    metaWaiting: null,
    host: '',
    locked: false,
    wantTimer: null,
    rxTimer: null,
    relayFallback: null,
    stamps: {},
    lastRx: 0,
    seenBoard: {},
    notices: [],
    hills: {},
    hillNames: {},
    flips: {},
    hidden: {},
    rots: {},
    lastSetup: {},
    showHills: true,
    hillEdit: false,
    busy: false
  };

  function curMap() {
    for (var i = 0; i < S.maps.length; i++) if (S.maps[i].id === S.mapId) return S.maps[i];
    return null;
  }
  function curBoard() {
    for (var i = 0; i < S.boards.length; i++) if (S.boards[i].id === S.boardId) return S.boards[i];
    return null;
  }
  /* A setup belongs to the room it was made in. Solo setups (room '') are
     yours; everything made in a room is shared with that room. */
  function boardsOf(mapId) {
    var scope = S.room || '';
    return S.boards.filter(function (b) {
      return b.mapId === mapId && (b.room || '') === scope;
    });
  }
  function mapH() { var m = curMap(); return m ? m.h : MAPW; }

  /* Maps can be hidden from the picker when they drop out of the rotation.
     They stay in the menu so they can be brought back. */
  function visibleMaps() {
    var shown = S.maps.filter(function (m) { return !S.hidden[m.id]; });
    return shown.length ? shown : S.maps;       // never leave the picker empty
  }

  /* Where the players sit on a brand-new setup. */
  function homeSpot(k, h) {
    return { x: MAPW * (0.32 + k * 0.12), y: (h || MAPW) * 0.82 };
  }

  /* What the clear button goes back to: whatever was saved as this setup's
     default, or the starting line-up if nothing has been saved yet. */
  function baseOf(b) {
    if (b && b.base && b.base.tokens && b.base.tokens.length) return b.base;
    var m = curMap(), h = m ? m.h : MAPW;
    return {
      tokens: (b && b.tokens ? b.tokens : []).map(function (t, k) {
        var sp = homeSpot(k, h);
        return { id: t.id, n: t.n, team: t.team, x: sp.x, y: sp.y };
      }),
      arrows: [], marks: [], labels: []
    };
  }

  function sameAsBase(b) {
    if (!b) return true;
    var base = baseOf(b);
    if (b.arrows.length !== base.arrows.length) return false;
    if (b.marks.length !== base.marks.length) return false;
    if (b.labels.length !== base.labels.length) return false;
    if (b.tokens.length !== base.tokens.length) return false;
    return b.tokens.every(function (t, k) {
      var o = b.base ? base.tokens.filter(function (x) { return x.id === t.id; })[0]
                     : base.tokens[k];
      return o && Math.abs(t.x - o.x) <= 1 && Math.abs(t.y - o.y) <= 1 && t.n === o.n;
    }) && JSON.stringify(b.arrows) === JSON.stringify(base.arrows) &&
       JSON.stringify(b.marks) === JSON.stringify(base.marks) &&
       JSON.stringify(b.labels) === JSON.stringify(base.labels);
  }

  /* One-off tidy-up for setups that gained a second copy of the team before
     the merge was fixed. Same name, same player. */
  function dedupeTokens(b) {
    if (!b || !b.tokens || b.tokens.length < 2) return false;
    var seen = {}, keep = [], dropped = [];
    b.tokens.forEach(function (t) {
      var key = (t.n || '') + '|' + (t.team || '');
      var at = seen[key];
      if (at === undefined) { seen[key] = keep.length; keep.push(t); return; }
      /* Keep whichever copy was moved last; the other is the stray. */
      if ((t.tv || 0) > (keep[at].tv || 0)) { dropped.push(keep[at].id); keep[at] = t; }
      else dropped.push(t.id);
    });
    if (!dropped.length) return false;
    b.tokens = keep;
    forget(b, dropped);
    return true;
  }

  function newBoard(mapId, name) {
    var h = MAPW, m = null, i;
    for (i = 0; i < S.maps.length; i++) if (S.maps[i].id === mapId) m = S.maps[i];
    if (m) h = m.h;
    var names = ['AR', 'Sub', 'Flex', 'Anch'];
    var id = uid();
    var b = {
      id: id, mapId: mapId, room: S.room || '',
      name: name || ('Setup ' + (boardsOf(mapId).length + 1)),
      tokens: names.map(function (n, k) {
        var sp = homeSpot(k, h);
        return { id: id + ':t' + k, n: n, x: sp.x, y: sp.y, team: 'b' };
      }),
      arrows: [], marks: [], labels: [], updated: Date.now()
    };
    S.boards.push(b);
    dbPut('boards', b);
    return b;
  }

  function saveBoard(broadcast) {
    var b = curBoard();
    if (!b) return;
    /* We have just changed this board ourselves, so an incoming copy that
       matches an earlier one is news again, not a repeat. */
    delete S.seenBoard[b.id];
    b.updated = Date.now();
    dbPut('boards', b);
    if (broadcast !== false) queueSend();
  }
  function saveMeta() {
    if (S.mapId && S.boardId) S.lastSetup[S.mapId] = S.boardId;   // where this map was left
    dbPut('meta', {
      k: 'settings', mapId: S.mapId, boardId: S.boardId, nick: S.nick, showHills: S.showHills,
      flips: S.flips, rots: S.rots, hidden: S.hidden, lastSetup: S.lastSetup,
      room: S.room, relays: S.relays, colour: S.colour, clientId: S.clientId
    });
  }

  /* ---------- undo ---------- */
  function clone(x) { return JSON.parse(JSON.stringify(x || [])); }

  /* Utility carries its own colour, because on a map a smoke being grey and
     a flash being yellow is read faster than any label. */
  var ROUTE_B = ['#60a5fa', '#a78bfa', '#34d399', '#f97316'];
  var ROUTE_R = ['#ef4444', '#e879f9', '#facc15', '#fda4af'];

  function routeColour(t, idx) {
    var pal = t && t.team === 'r' ? ROUTE_R : ROUTE_B;
    return pal[(idx || 0) % pal.length];
  }

  function tokenById(id) {
    var b = curBoard(), found = null;
    if (!b || !id) return null;
    b.tokens.forEach(function (t) { if (t.id === id) found = t; });
    return found;
  }

  function colourForOwner(id) {
    var t = tokenById(id);
    return t ? routeColour(t, teamIndex(t)) : null;
  }

  /* Position within its own team, so the four blue players get four
     different colours and the enemies get their own set. */
  function teamIndex(t) {
    var b = curBoard();
    if (!b || !t) return 0;
    var n = 0, out = 0;
    b.tokens.forEach(function (o) {
      if (o.team !== t.team) return;
      if (o.id === t.id) out = n;
      n++;
    });
    return out;
  }

  var UTIL = {
    smoke: { c: '#cbd5e1', label: 'Smoke' },
    flash: { c: '#fbbf24', label: 'Flash' },
    stun:  { c: '#38bdf8', label: 'Stun' },
    frag:  { c: '#fb7185', label: 'Frag' }
  };

  function rnd(n) { return Math.round(n * 10) / 10; }

  /* Putting players back deliberately — restoring a saved setup, or undoing —
     has to beat whatever a teammate moved a moment ago, so it is stamped
     above everything either side has seen for that board. */
  function topTv(list) {
    var top = 0;
    (list || []).forEach(function (t) { if ((t.tv || 0) > top) top = t.tv || 0; });
    return top;
  }

  function claimTokens(tokens, above) {
    var top = Math.max(above || 0, topTv(tokens));
    (tokens || []).forEach(function (t) { t.tv = top + 1; t.tb = S.clientId; });
  }

  function snapshot() {
    var b = curBoard();
    if (!b) return;
    S.undo.push(JSON.stringify({ tokens: b.tokens, arrows: b.arrows, marks: b.marks,
                                 labels: b.labels }));
    if (S.undo.length > 40) S.undo.shift();
    S.redo.length = 0;
    syncUndoButtons();
  }
  function applySnap(json) {
    var b = curBoard(), s = JSON.parse(json);
    var hadTv = topTv(b.tokens);
    b.tokens = s.tokens; b.arrows = s.arrows; b.marks = s.marks; b.labels = s.labels;
    claimTokens(b.tokens, hadTv);
    revive(b);
  }

  /* Anything restored that the room has been told was deleted comes back
     under a new name, so teammates take it as something new rather than
     quietly removing it again. */
  function revive(b) {
    var gone = {};
    (b.gone || []).forEach(function (id) { gone[id] = 1; });
    ['arrows', 'marks', 'labels', 'tokens'].forEach(function (k) {
      (b[k] || []).forEach(function (o) {
        if (o && gone[o.id]) o.id = uid();
      });
    });
  }
  function doUndo() {
    if (!canEdit()) { denyEdit(); return; }
    var b = curBoard();
    if (!b || !S.undo.length) return;
    S.redo.push(JSON.stringify({ tokens: b.tokens, arrows: b.arrows, marks: b.marks,
                                 labels: b.labels }));
    applySnap(S.undo.pop());
    render(); saveBoard(); syncUndoButtons();
  }
  function doRedo() {
    if (!canEdit()) { denyEdit(); return; }
    var b = curBoard();
    if (!b || !S.redo.length) return;
    S.undo.push(JSON.stringify({ tokens: b.tokens, arrows: b.arrows, marks: b.marks,
                                 labels: b.labels }));
    applySnap(S.redo.pop());
    render(); saveBoard(); syncUndoButtons();
  }
  function syncUndoButtons() {
    $('undo').disabled = !S.undo.length;
    $('redo').disabled = !S.redo.length;
  }

  /* ---------- rendering ---------- */
  var COLOURS = ['#f5b708', '#e9ebef', '#3b82f6', '#ef4444', '#22c55e'];

  function addMarker(id, colour) {
    var m = svgEl('marker', {
      id: id, viewBox: '0 0 10 10', refX: '7.6', refY: '5',
      markerWidth: '4.2', markerHeight: '4.2', orient: 'auto-start-reverse'
    });
    m.appendChild(svgEl('path', { d: 'M0,0.6 L10,5 L0,9.4 z', fill: colour }));
    $('defs').appendChild(m);
  }

  function ensureMarkers() {
    var defs = $('defs');
    if (defs.childNodes.length) return;
    COLOURS.forEach(function (c, i) { addMarker('ah' + i, c); });
  }

  function markerFor(c) {
    var i = COLOURS.indexOf(c);
    if (i >= 0) return 'url(#ah' + i + ')';
    /* A colour outside the palette — a player's route — gets its own head. */
    var id = 'ah_' + String(c || '').replace(/[^a-z0-9]/gi, '');
    if (!id || id === 'ah_') return 'url(#ah0)';
    if (!document.getElementById(id)) addMarker(id, c);
    return 'url(#' + id + ')';
  }

  /* Keep the centre of the viewport over the map, so it can never be panned
     off into empty space with no way back to it. */
  function clampView(v) {
    var h = mapH();
    v.x = clamp(v.x, -v.w / 2, MAPW - v.w / 2);
    v.y = clamp(v.y, -v.h / 2, h - v.h / 2);
    return v;
  }
  /* The board turns in quarter steps: twice puts your spawn at the bottom,
     once stands a wide map up so it fills a phone held upright. The map
     turns; the writing on it does not. */
  function rotOf(m) {
    m = m || curMap();
    if (!m) return 0;
    var r = S.rots[m.id];
    if (r === undefined) r = S.flips[m.id] ? 2 : 0;    // older saves
    return ((r % 4) + 4) % 4;
  }
  function isFlipped() { return rotOf() !== 0; }
  function isSideways() { return rotOf() % 2 === 1; }

  /* Turned inside the drawing rather than with CSS, so the picture still
     fills the screen instead of hanging off the sides. */
  function rotTransform() {
    var r = rotOf(), h = mapH();
    if (r === 1) return 'translate(' + h + ',0) rotate(90)';
    if (r === 2) return 'translate(' + MAPW + ',' + h + ') rotate(180)';
    if (r === 3) return 'translate(0,' + MAPW + ') rotate(270)';
    return '';
  }
  function applyFlip() {
    var r = rotOf();
    var g = $('layers');
    if (g) {
      if (r) g.setAttribute('transform', rotTransform());
      else g.removeAttribute('transform');
    }
    $('board').style.transform = '';
    var btn = $('flipbtn');
    if (btn) {
      btn.setAttribute('aria-pressed', r ? 'true' : 'false');
      btn.setAttribute('aria-label', 'Turn the map (' + (r * 90) + '°)');
    }
  }
  /* Spin every label back the right way up, about the centre of its own box.
     Pivoting on the text anchor instead threw each one off by its own height. */
  function uprightTexts(root) {
    var r = rotOf();
    if (!r || !root) return;
    var back = -r * 90;
    var ts = root.querySelectorAll('text');
    for (var i = 0; i < ts.length; i++) {
      try {
        var bb = ts[i].getBBox();
        ts[i].setAttribute('transform',
          'rotate(' + back + ' ' + (bb.x + bb.width / 2) + ' ' +
          (bb.y + bb.height / 2) + ')');
      } catch (e) {}
    }
  }

  function setView(v) {
    S.view = clampView(v);
    $('board').setAttribute('viewBox', S.view.x + ' ' + S.view.y + ' ' + S.view.w + ' ' + S.view.h);
  }

  /* Everything drawn stays on the map itself. */
  function onMap(p) {
    return { x: clamp(p.x, 0, MAPW), y: clamp(p.y, 0, mapH()) };
  }
  function fitView() {
    var h = mapH(), st = $('stage');
    var pad = 1.02;
    var sw = st.clientWidth || 360, sh = st.clientHeight || 480;
    var bw = isSideways() ? h : MAPW;        // what the turned map occupies
    var bh = isSideways() ? MAPW : h;
    var mapAR = bw / bh, stAR = sw / sh, w, hh;
    if (mapAR > stAR) { w = bw * pad; hh = w / stAR; }
    else { hh = bh * pad; w = hh * stAR; }
    setView({ x: (bw - w) / 2, y: (bh - hh) / 2, w: w, h: hh });
  }

  function toSvg(cx, cy) {
    var svg = $('board');
    var m = ($('layers') || svg).getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    var inv = m.inverse();
    if (window.DOMPoint) {
      var r = new DOMPoint(cx, cy).matrixTransform(inv);
      return { x: r.x, y: r.y };
    }
    var p = svg.createSVGPoint();
    p.x = cx; p.y = cy;
    var q = p.matrixTransform(inv);
    return { x: q.x, y: q.y };
  }

  function strokeW() { return clamp(S.view.w / 125, 2.2, 14); }

  function render() {
    var b = curBoard(), m = curMap();
    $('blank').style.display = m ? 'none' : 'flex';
    $('board').style.visibility = m ? '' : 'hidden';

    var img = $('mapimg');
    if (m) {
      img.setAttribute('width', MAPW);
      img.setAttribute('height', m.h);
      if (S.objUrl !== m._url) {
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', m._url || '');
        img.setAttribute('href', m._url || '');
        S.objUrl = m._url;
      }
    }

    applyFlip();
    ['gArrows', 'gMarks', 'gLabels', 'gTokens'].forEach(function (g) { $(g).textContent = ''; });
    renderHills();
    if (!b) return;

    var sw = strokeW();

    b.arrows.forEach(function (a) {
      /* "Only" hides everyone else's routes so a busy board can be read. */
      if (S.onlyOwn && S.arrowOwn && a.own !== S.arrowOwn) return;
      var pts = a.pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
      var hit = svgEl('polyline', {
        points: pts, fill: 'none', stroke: 'rgba(0,0,0,0)',
        'stroke-width': sw * 4, 'stroke-linecap': 'round',
        'data-kind': 'arrow', 'data-id': a.id
      });
      hit.style.pointerEvents = 'stroke';
      var line = svgEl('polyline', {
        points: pts, fill: 'none', stroke: a.c || '#f5b708',
        'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'marker-end': markerFor(a.c || '#f5b708')
      });
      line.style.pointerEvents = 'none';
      $('gArrows').appendChild(hit);
      $('gArrows').appendChild(line);

      var owner = a.own ? tokenById(a.own) : null;
      if (owner && a.pts.length) {
        /* A name at the start, so a board full of lines can be read without
           tracing each one back to a player. */
        var st = a.pts[0], col = a.c || '#f5b708';
        var tag = svgEl('text', {
          x: st[0], y: st[1] - sw * 1.4, 'text-anchor': 'middle',
          'font-size': sw * 2.3, 'font-weight': '700', fill: col,
          stroke: '#0a0c10', 'stroke-width': sw * 0.6, 'paint-order': 'stroke'
        });
        tag.textContent = (owner.n || '').slice(0, 5);
        tag.style.pointerEvents = 'none';
        $('gArrows').appendChild(tag);
      }
    });

    b.marks.forEach(function (k) {
      var r = sw * 1.9, g = svgEl('g', { 'data-kind': 'mark', 'data-id': k.id });
      var u = UTIL[k.k];
      if (u) {
        var col = k.c || u.c, rr = sw * 2.9;
        g.appendChild(svgEl('circle', {
          cx: k.x, cy: k.y, r: rr, fill: 'rgba(10,12,16,.72)',
          stroke: col, 'stroke-width': sw * 0.55
        }));
        drawUtil(g, k.k, k.x, k.y, rr, col, sw);
        var cap = svgEl('text', {
          x: k.x, y: k.y + rr * 2.05, 'text-anchor': 'middle',
          'font-size': rr * 0.8, 'font-weight': '600', fill: col,
          stroke: '#0a0c10', 'stroke-width': sw * 0.5, 'paint-order': 'stroke'
        });
        cap.textContent = u.label;
        g.appendChild(cap);
        g.appendChild(svgEl('circle', { cx: k.x, cy: k.y, r: rr * 1.5, fill: 'rgba(0,0,0,0)' }));
        $('gMarks').appendChild(g);
        return;
      }
      g.appendChild(svgEl('line', {
        x1: k.x - r, y1: k.y - r, x2: k.x + r, y2: k.y + r,
        stroke: k.c || '#ef4444', 'stroke-width': sw, 'stroke-linecap': 'round'
      }));
      g.appendChild(svgEl('line', {
        x1: k.x + r, y1: k.y - r, x2: k.x - r, y2: k.y + r,
        stroke: k.c || '#ef4444', 'stroke-width': sw, 'stroke-linecap': 'round'
      }));
      var pad = svgEl('circle', { cx: k.x, cy: k.y, r: r * 1.6, fill: 'rgba(0,0,0,0)' });
      g.appendChild(pad);
      $('gMarks').appendChild(g);
    });

    b.labels.forEach(function (l) {
      var fs = clamp(S.view.w / 26, 9, 44);
      var g = svgEl('g', { 'data-kind': 'label', 'data-id': l.id });
      var t = svgEl('text', {
        x: l.x, y: l.y, 'text-anchor': 'middle', 'font-size': fs,
        'font-weight': '600', fill: l.c || '#e9ebef',
        stroke: '#0a0c10', 'stroke-width': fs / 7, 'paint-order': 'stroke'
      });
      t.textContent = l.t;
      g.appendChild(t);
      $('gLabels').appendChild(g);
      try {
        var bb = t.getBBox(), padx = fs * 0.4, pady = fs * 0.3;
        var pad = svgEl('rect', {
          x: bb.x - padx, y: bb.y - pady,
          width: bb.width + padx * 2, height: bb.height + pady * 2,
          fill: 'rgba(0,0,0,0)'
        });
        g.insertBefore(pad, t);
      } catch (e) {}
    });

    var tr = clamp(S.view.w / 30, 11, 40);
    b.tokens.forEach(function (p) {
      var g = svgEl('g', { 'data-kind': 'token', 'data-id': p.id });
      g.appendChild(svgEl('circle', {
        cx: p.x, cy: p.y, r: tr,
        fill: p.team === 'b' ? '#3b82f6' : '#ef4444',
        stroke: '#0a0c10', 'stroke-width': tr / 7
      }));
      var t = svgEl('text', {
        x: p.x, y: p.y + tr * 0.34, 'text-anchor': 'middle',
        'font-size': tr * 0.86, 'font-weight': '600', fill: '#fff'
      });
      t.textContent = (p.n || '').slice(0, 4);
      t.style.pointerEvents = 'none';
      g.appendChild(t);
      $('gTokens').appendChild(g);
    });

    uprightTexts($('layers'));
  }

  /* ---------- hardpoints ---------- */
  /* Hills belong to the map, not to a setup, so every setup on a map shows
     the same rotation. Positions are yours to place — there is no reliable
     source of them to ship. */
  function hillsFor(mapId) { return S.hills[mapId] || []; }

  function saveHills(mapId) {
    dbPut('hills', { k: mapId, pts: hillsFor(mapId) }).catch(function () {});
    publishHills(true);
  }

  /* The button is lit only when hardpoints are actually on screen — not on a
     map that has none placed. */
  function syncHillsBtn() {
    var m = curMap();
    var on = !!(m && S.showHills && hillsFor(m.id).length);
    $('hillsbtn').setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function renderHills() {
    var g = $('gHills');
    if (!g) return;
    g.textContent = '';
    syncHillsBtn();
    var m = curMap();
    if (!m || (!S.showHills && !S.hillEdit)) return;
    var pts = hillsFor(m.id);
    var r = clamp(S.view.w / 22, 14, 52);
    pts.forEach(function (p, i) {
      var box = svgEl('g', { 'data-kind': 'hill', 'data-id': String(i) });
      box.appendChild(svgEl('rect', {
        x: p.x - r, y: p.y - r, width: r * 2, height: r * 2, rx: r * 0.28,
        fill: 'rgba(245,183,8,0.18)', stroke: '#f5b708', 'stroke-width': r * 0.12
      }));
      var t = svgEl('text', {
        x: p.x, y: p.y + r * 0.34, 'text-anchor': 'middle',
        'font-size': r * 0.95, 'font-weight': '600', fill: '#f5b708',
        stroke: '#0a0c10', 'stroke-width': r * 0.1, 'paint-order': 'stroke'
      });
      t.textContent = 'P' + (i + 1);
      t.style.pointerEvents = 'none';
      box.appendChild(t);
      if (p.n) {
        var nm = svgEl('text', {
          x: p.x, y: p.y + r * 1.5, 'text-anchor': 'middle',
          'font-size': r * 0.5, 'font-weight': '500', fill: '#f5b708',
          stroke: '#0a0c10', 'stroke-width': r * 0.09, 'paint-order': 'stroke'
        });
        nm.textContent = p.n;
        nm.style.pointerEvents = 'none';
        box.appendChild(nm);
      }
      g.appendChild(box);
    });
  }

  function hillsTag(name) { return roomTag() + ':hills:' + name; }

  function publishHills(force) {
    var m = curMap();
    if (!S.pool || !S.roomSk || !m) return;
    /* Only an explicit edit may publish an empty list; otherwise joining with
       no hills of your own would wipe everyone else's. */
    if (!force && !hillsFor(m.id).length) return;
    NostrLite.finalize({
      kind: 30078, tags: [['d', hillsTag(m.name)]],
      content: JSON.stringify({ by: S.clientId, pts: hillsFor(m.id) })
    }, S.roomSk).then(function (ev) { if (S.pool) S.pool.publish(ev); }).catch(function () {});
  }

  function subHills() {
    var m = curMap();
    if (!S.pool || !m) return;
    S.pool.sub('hills', [{ kinds: [30078], authors: [S.roomPub], '#d': [hillsTag(m.name)] }]);
  }

  function hillPrompt(m) {
    var rot = rotationFor(m.name), have = hillsFor(m.id).length;
    if (!rot.length) {
      banner('Tap to place hill ' + (have + 1) + '. Tap one to remove it.');
    } else if (have >= rot.length) {
      banner('All ' + rot.length + ' hills placed. Tap one to remove it, or press P when done.');
    } else {
      banner('Tap where P' + (have + 1) + ' is — ' + rot[have]);
    }
  }

  function setHillEdit(on) {
    S.hillEdit = on;
    if (on) {
      S.showHills = true;
      var m = curMap();
      if (m) hillPrompt(m); else banner('Tap the map to place hills in rotation order.');
    } else {
      banner('');
    }
    render();
  }

  /* ---------- selects ---------- */
  function fillSelects() {
    var ms = $('mapsel'), bs = $('boardsel');
    bs.style.display = '';
    ms.textContent = '';
    var pickable = visibleMaps();
    if (S.mapId && !pickable.some(function (m) { return m.id === S.mapId; })) {
      var cur = curMap();
      if (cur) pickable = pickable.concat([cur]);   // keep what is open selectable
    }
    if (!pickable.length) {
      ms.appendChild(new Option('No maps', ''));
    } else {
      pickable.forEach(function (m) {
        var o = new Option(m.name, m.id);
        if (m.id === S.mapId) o.selected = true;
        ms.appendChild(o);
      });
    }
    bs.textContent = '';
    var list = boardsOf(S.mapId);
    if (!list.length) {
      bs.appendChild(new Option('—', ''));
    } else {
      list.forEach(function (b) {
        var o = new Option(b.name, b.id);
        if (b.id === S.boardId) o.selected = true;
        bs.appendChild(o);
      });
    }

    var ss = $('setupsel');
    if (ss) {
      ss.textContent = '';
      if (!list.length) ss.appendChild(new Option('—', ''));
      else list.forEach(function (b) {
        var o = new Option(b.name, b.id);
        if (b.id === S.boardId) o.selected = true;
        ss.appendChild(o);
      });
    }
  }

  function refresh(broadcast) {
    fillSelects();
    var wh = $('who');
    if (wh && wh.classList.contains('show')) {
      /* A player renamed, added or removed changes the row. */
      if (S.arrowOwn && !tokenById(S.arrowOwn)) { S.arrowOwn = ''; S.onlyOwn = false; }
      buildWho();
    }
    render();
    saveMeta();
    if (broadcast) queueSend();
  }

  /* ---------- gestures ---------- */
  var ptrs = {};
  var gest = null;   // {type:'hold'|'drag'|'draw'|'draglabel'|'none', ...}

  function stageDown(e) {
    var m = curMap();
    if (!m) return;
    /* The floating controls sit inside the board, so their taps bubble here.
       Without this, pressing Undo with the Mark tool active dropped a mark. */
    if (e.target.closest && e.target.closest('#float, #banner, #blank, #swatch, #kinds, #who')) return;

    /* Locked rooms stay pannable and pingable — just not editable. */
    if (!canEdit() && S.tool !== 'ping' && S.tool !== 'move') { denyEdit(); return; }
    /* Phones sometimes never report a finger lifting — off the edge of the
       screen, a call coming in. A forgotten finger used to make every later
       tap look like a second one, so the board stopped responding until the
       app was restarted. Anything this old is gone. */
    var now = Date.now();
    Object.keys(ptrs).forEach(function (k) {
      if (now - (ptrs[k].t || 0) > 4000) delete ptrs[k];
    });
    if (!Object.keys(ptrs).length) gest = null;

    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY, t: now };
    var n = Object.keys(ptrs).length;

    if (n === 2) {
      /* Two fingers no longer zoom — it fired by accident mid-drag. Abandon
         whatever the first finger started instead. */
      if (gest && gest.type === 'draw' && gest.arrow) {
        var bb = curBoard();
        var ai = bb.arrows.indexOf(gest.arrow);
        if (ai >= 0) bb.arrows.splice(ai, 1);
        S.undo.pop();
        syncUndoButtons();
        render();
      }
      clearTimeout(S.holdTimer);
      gest = { type: 'none' };
      return;
    }
    if (n !== 1) return;

    var p = onMap(toSvg(e.clientX, e.clientY));
    var hitEl = e.target.closest ? e.target.closest('[data-kind]') : null;

    if (S.hillEdit) {
      if (!canEdit()) { denyEdit(); gest = { type: 'none' }; return; }
      var m2 = curMap();
      if (m2) {
        var hit = hitEl && hitEl.getAttribute('data-kind') === 'hill' ? hitEl : null;
        var pts = S.hills[m2.id] = hillsFor(m2.id).slice();
        if (hit) pts.splice(+hit.getAttribute('data-id'), 1);
        else if (pts.length < 9) pts.push({ x: p.x, y: p.y });
        var rot = rotationFor(m2.name);
        pts.forEach(function (pt, i) { pt.n = rot[i] || ''; });
        saveHills(m2.id);
        render();
        hillPrompt(m2);
      }
      gest = { type: 'none' };
      return;
    }

    if (S.tool === 'erase') {
      if (hitEl) {
        snapshot();
        removeById(hitEl.getAttribute('data-kind'), hitEl.getAttribute('data-id'));
        render(); saveBoard();
      }
      gest = { type: 'none' };
      return;
    }

    if (S.tool === 'move') {
      if (hitEl && !canEdit()) {
        denyEdit();
        gest = { type: 'none' };
        return;
      }
      if (hitEl && hitEl.getAttribute('data-kind') === 'token') {
        var id = hitEl.getAttribute('data-id');
        snapshot();
        gest = { type: 'drag', id: id, moved: false, start: p };
        try { $('stage').setPointerCapture(e.pointerId); } catch (err) {}
      } else if (hitEl && hitEl.getAttribute('data-kind') === 'label') {
        snapshot();
        gest = { type: 'draglabel', id: hitEl.getAttribute('data-id'), moved: false };
      } else {
        /* The board stays put. Dragging it about served no purpose once zoom
           went, and it was easy to shove the map off by accident. */
        gest = { type: 'hold', c0: { x: e.clientX, y: e.clientY }, moved: false };
        clearTimeout(S.holdTimer);
        S.holdTimer = setTimeout(function () {
          if (gest && gest.type === 'hold' && !gest.moved) {
            gest = { type: 'none' };
            sendPing(p);
          }
        }, 480);
      }
      return;
    }

    if (S.tool === 'arrow') {
      snapshot();
      var ar = {
        id: uid(),
        own: S.arrowOwn || undefined,
        c: (S.arrowOwn && colourForOwner(S.arrowOwn)) || S.colour,
        pts: [[rnd(p.x), rnd(p.y)]]
      };
      curBoard().arrows.push(ar);
      gest = { type: 'draw', arrow: ar };
      render();
      return;
    }

    if (S.tool === 'ping') {
      sendPing(p);
      gest = { type: 'none' };
      return;
    }

    if (S.tool === 'mark') {
      snapshot();
      var u = UTIL[S.markKind];
      curBoard().marks.push({
        id: uid(), x: rnd(p.x), y: rnd(p.y),
        c: u ? u.c : S.colour, k: u ? S.markKind : undefined
      });
      render(); saveBoard();
      gest = { type: 'none' };
      return;
    }

    if (S.tool === 'text') {
      gest = { type: 'text', p: p, c0: { x: e.clientX, y: e.clientY } };
    }
  }

  function stageMove(e) {
    if (!ptrs[e.pointerId]) return;
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY, t: Date.now() };
    if (!gest) return;

    if (gest.type === 'text') {
      if (Math.abs(e.clientX - gest.c0.x) + Math.abs(e.clientY - gest.c0.y) > 12) gest.moved = true;
      return;
    }

    if (gest.type === 'hold') {
      if (!gest.moved && Math.abs(e.clientX - gest.c0.x) + Math.abs(e.clientY - gest.c0.y) > 8) {
        gest.moved = true;
        clearTimeout(S.holdTimer);
      }
      return;
    }

    var p = onMap(toSvg(e.clientX, e.clientY));

    if (gest.type === 'drag') {
      var b = curBoard(), t = null;
      b.tokens.forEach(function (x) { if (x.id === gest.id) t = x; });
      if (!t) return;
      t.x = rnd(p.x); t.y = rnd(p.y);
      t.tv = (t.tv || 0) + 1;
      t.tb = S.clientId;
      gest.moved = true;
      render();
      liveSend();
      return;
    }
    if (gest.type === 'draglabel') {
      var bb = curBoard(), l = null;
      bb.labels.forEach(function (x) { if (x.id === gest.id) l = x; });
      if (!l) return;
      l.x = rnd(p.x); l.y = rnd(p.y);
      gest.moved = true;
      render();
      liveSend();
      return;
    }
    if (gest.type === 'draw' && gest.arrow) {
      var pts = gest.arrow.pts, last = pts[pts.length - 1];
      var minStep = S.view.w / 70;
      if (Math.abs(last[0] - p.x) + Math.abs(last[1] - p.y) > minStep) {
        pts.push([rnd(p.x), rnd(p.y)]);
        if (pts.length > 220) pts.shift();
        render();
      }
    }
  }

  function stageUp(e) {
    clearTimeout(S.holdTimer);
    delete ptrs[e.pointerId];
    var remaining = Object.keys(ptrs).length;
    if (!gest) return;

    if (remaining > 0) return;

    if (gest.type === 'text') {
      var at = gest.p, dropped = !gest.moved;
      gest = null;
      if (!dropped) return;
      /* Opened straight from the finger lifting, so the keyboard counts as
         asked for by the person and actually stays up. */
      ask({ title: 'Label', field: true, placeholder: 'Flash here', maxLength: 22,
            okText: 'Place' })
        .then(function (r) {
          if (r.action !== 'ok' || !r.value) return;
          snapshot();
          curBoard().labels.push({ id: uid(), x: rnd(at.x), y: rnd(at.y), t: r.value, c: S.colour });
          render(); saveBoard();
        });
      return;
    }

    if (gest.type === 'drag' && !gest.moved) {
      S.undo.pop(); syncUndoButtons();
      editToken(gest.id);
    } else if (gest.type === 'draglabel' && !gest.moved) {
      S.undo.pop(); syncUndoButtons();
      editLabel(gest.id);
    } else if (gest.type === 'draw') {
      var b = curBoard();
      if (gest.arrow && gest.arrow.pts.length < 2) {
        var i = b.arrows.indexOf(gest.arrow);
        if (i >= 0) b.arrows.splice(i, 1);
        S.undo.pop(); syncUndoButtons();
        render();
      } else {
        saveBoard();
      }
    } else if (gest.type === 'drag' || gest.type === 'draglabel') {
      saveBoard();
    }
    gest = null;
  }

  function forget(b, ids) {
    if (!b) return;
    var gone = b.gone || [];
    ids.forEach(function (id) { if (id && gone.indexOf(id) < 0) gone.push(id); });
    if (gone.length > 300) gone = gone.slice(gone.length - 300);
    b.gone = gone;
  }

  function removeById(kind, id) {
    var b = curBoard();
    var key = kind === 'arrow' ? 'arrows' : kind === 'mark' ? 'marks'
      : kind === 'label' ? 'labels' : 'tokens';
    b[key] = b[key].filter(function (o) { return o.id !== id; });
    forget(b, [id]);
  }

  function editToken(id) {
    var b = curBoard(), t = null;
    b.tokens.forEach(function (x) { if (x.id === id) t = x; });
    if (!t) return;
    ask({
      title: 'Player', field: true, value: t.n, placeholder: 'Name',
      maxLength: 4, okText: 'Save', extraText: 'Remove',
      body: 'Four characters fit on the token.'
    }).then(function (r) {
      if (r.action === 'cancel') return;
      snapshot();
      if (r.action === 'extra') removeById('token', id);
      else t.n = r.value || t.n;
      render(); saveBoard();
    });
  }
  function editLabel(id) {
    var b = curBoard(), l = null;
    b.labels.forEach(function (x) { if (x.id === id) l = x; });
    if (!l) return;
    ask({
      title: 'Label', field: true, value: l.t, maxLength: 22,
      okText: 'Save', extraText: 'Remove'
    }).then(function (r) {
      if (r.action === 'cancel') return;
      snapshot();
      if (r.action === 'extra') removeById('label', id);
      else l.t = r.value || l.t;
      render(); saveBoard();
    });
  }

  /* ---------- map import ---------- */
  function readFile(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsDataURL(file);
    });
  }

  function downscale(dataUrl) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, MAX_PX / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cv.toBlob(function (blob) {
          if (!blob) { rej(new Error('encode failed')); return; }
          blob.arrayBuffer().then(function (buf) {
            res({ buf: buf, type: 'image/jpeg', w: w, h: h });
          });
        }, 'image/jpeg', 0.82);
      };
      img.onerror = function () { rej(new Error('not an image')); };
      img.src = dataUrl;
    });
  }

  function attachUrl(m) {
    if (m._url) return m;
    if (m.src) { m._url = m.src; return m; }     // bundled: served from the site
    try {
      m._url = URL.createObjectURL(new Blob([m.buf], { type: m.type || 'image/jpeg' }));
    } catch (e) { m._url = ''; }
    return m;
  }

  /* Maps shipped with the app. They are rebuilt from maps/index.json on every
     launch rather than stored, so the list always matches the deployed build,
     and their ids are stable so setups and live rooms line up across phones. */
  function loadHillNames() {
    return fetch('maps/hardpoints.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) { S.hillNames = j || {}; })
      .catch(function () { S.hillNames = {}; });
  }

  /* Rotation names come from the published rotations; match loosely so
     "Reactor U92" and "Reactor" find the same list. */
  function rotationFor(name) {
    var key = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    var table = S.hillNames || {};
    if (table[key]) return table[key];
    var hit = null;
    Object.keys(table).forEach(function (k) {
      if (!hit && (key.indexOf(k) === 0 || k.indexOf(key) === 0)) hit = table[k];
    });
    return hit || [];
  }

  function loadBundled() {
    function get(opts) {
      return fetch('maps/index.json', opts).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      });
    }
    return get({ cache: 'no-cache' }).catch(function () {
      return get({});                       // some caches reject the no-cache hint
    }).then(function (list) {
      return (list || []).map(function (e) {
        var rec = {
          id: 'built-in:' + e.file, name: e.name || e.file, src: 'maps/' + e.file,
          bundled: true, pxw: e.w || 1000, pxh: e.h || 1000,
          h: Math.round(MAPW * (e.h || 1000) / (e.w || 1000)), created: 0
        };
        attachUrl(rec);
        return rec;
      });
    }).catch(function () {
      S.bundledFailed = true;
      return [];
    });
  }

  function addMapFromFile(file, presetName) {
    return readFile(file).then(downscale).then(function (im) {
      var name = presetName || file.name.replace(/\.[^.]+$/, '').slice(0, 28) || 'Map';
      var rec = {
        id: uid(), name: name, buf: im.buf, type: im.type,
        pxw: im.w, pxh: im.h, h: Math.round(MAPW * im.h / im.w), created: Date.now()
      };
      return dbPut('maps', rec).then(function () {
        attachUrl(rec);
        S.maps.push(rec);
        return rec;
      });
    });
  }

  function handleMapFiles(files) {
    var list = Array.prototype.slice.call(files);
    if (!list.length) return;
    S.busy = true;
    var first = null;
    var chain = list.reduce(function (pr, f) {
      return pr.then(function () {
        return addMapFromFile(f).then(function (rec) { if (!first) first = rec; });
      }).catch(function () { toast('Could not read ' + f.name); });
    }, Promise.resolve());

    chain.then(function () {
      S.busy = false;
      if (!first) return;
      S.undo.length = 0; S.redo.length = 0;

      if (S.room) {
        /* Adding a map mid-room means you want the team on it: land on the
           live setup and push it out, rather than dropping onto a private one. */
        S.objUrl = null;
        useMapForRoom(first);
        S.roomMapName = first.name;
        S.mapSent = false;
        publishRoomState();   // announce map and setups first
        sendNow();
        publishMap(true);
        fitView(); refresh(); renderMapList(); syncUndoButtons();
        toast('Map added — sending to the room');
        return;
      }

      S.mapId = first.id;
      var bl = boardsOf(first.id);
      S.boardId = (bl.length ? bl[0] : newBoard(first.id, 'Default')).id;
      fitView(); refresh(); renderMapList(); syncUndoButtons();
      toast(list.length > 1 ? list.length + ' maps added' : 'Map added');
    });
  }

  function renderMapList() {
    var box = $('maplist');
    box.textContent = '';
    if (!S.maps.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No maps yet.';
      box.appendChild(e);
      return;
    }
    S.maps.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'item';
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = m.name;
      var mt = document.createElement('span');
      mt.className = 'mt';
      mt.textContent = boardsOf(m.id).length + ' setup' + (boardsOf(m.id).length === 1 ? '' : 's');
      var vis = document.createElement('button');
      vis.textContent = S.hidden[m.id] ? 'Hidden' : 'Shown';
      vis.setAttribute('aria-pressed', S.hidden[m.id] ? 'false' : 'true');
      vis.addEventListener('click', function () {
        S.hidden[m.id] = !S.hidden[m.id];
        if (S.hidden[m.id] && S.mapId === m.id) {
          var next = visibleMaps().filter(function (x) { return x.id !== m.id; })[0];
          if (next) {
            S.mapId = next.id;
            var nb = boardsOf(next.id);
            S.boardId = (nb.length ? nb[0] : newBoard(next.id, 'Default')).id;
            S.objUrl = null;
            fitView();
          }
        }
        saveMeta();
        renderMapList();
        refresh();
        toast(S.hidden[m.id] ? m.name + ' hidden' : m.name + ' shown');
      });

      if (m.bundled) {
        row.appendChild(nm); row.appendChild(mt); row.appendChild(vis);
        box.appendChild(row);
        return;
      }
      var ren = document.createElement('button');
      ren.textContent = 'Rename';
      ren.addEventListener('click', function () {
        ask({ title: 'Map name', field: true, value: m.name, maxLength: 28, okText: 'Save' })
          .then(function (r) {
            if (r.action !== 'ok' || !r.value) return;
            m.name = r.value;
            dbPut('maps', m);
            renderMapList(); refresh();
          });
      });
      var del = document.createElement('button');
      del.className = 'danger';
      del.textContent = 'Delete';
      del.addEventListener('click', function () {
        confirmBox('Delete ' + m.name + '?', 'Its setups go too. This cannot be undone.')
          .then(function (ok) {
            if (!ok) return;
            var gone = boardsOf(m.id);
            gone.forEach(function (b) { dbDel('boards', b.id); });
            S.boards = S.boards.filter(function (b) { return b.mapId !== m.id; });
            dbDel('maps', m.id);
            if (m._url) URL.revokeObjectURL(m._url);
            S.maps = S.maps.filter(function (x) { return x.id !== m.id; });
            if (S.mapId === m.id) {
              S.mapId = S.maps.length ? S.maps[0].id : null;
              var bl = S.mapId ? boardsOf(S.mapId) : [];
              S.boardId = bl.length ? bl[0].id : (S.mapId ? newBoard(S.mapId).id : null);
              S.objUrl = null;
              fitView();
            }
            renderMapList(); refresh();
            toast('Map deleted');
          });
      });
      row.appendChild(nm); row.appendChild(mt); row.appendChild(vis);
      row.appendChild(ren); row.appendChild(del);
      box.appendChild(row);
    });
  }

  /* ---------- pack export / import ---------- */
  function b64FromBuf(buf) {
    var bytes = new Uint8Array(buf), s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }
  function bufFromB64(b64) {
    var s = atob(b64), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a.buffer;
  }

  function exportPack() {
    if (!S.boards.length && !Object.keys(S.hills).length) {
      toast('Nothing to back up yet');
      return;
    }
    var pack = {
      app: 'stratboard', kind: 'backup', v: 2, made: new Date().toISOString(),
      prefs: { nick: S.nick, hidden: S.hidden, flips: S.flips, showHills: S.showHills },
      /* Built-in maps ship with the app, so a pack only carries your own. */
      hills: S.maps.map(function (m) { return { map: m.name, pts: hillsFor(m.id) }; })
        .filter(function (h) { return h.pts.length; }),
      maps: S.maps.filter(function (m) { return !m.bundled; }).map(function (m) {
        return { name: m.name, type: m.type || 'image/jpeg', pxw: m.pxw, pxh: m.pxh, h: m.h,
                 hills: hillsFor(m.id), img: b64FromBuf(m.buf) };
      }),
      boards: S.boards.map(function (b) {
        var mn = '';
        S.maps.forEach(function (m) { if (m.id === b.mapId) mn = m.name; });
        return {
          map: mn, name: b.name, room: b.room || '', tokens: b.tokens,
          arrows: b.arrows, marks: b.marks, labels: b.labels
        };
      })
    };
    var blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
    var stamp = new Date().toISOString().slice(0, 10);
    var fname = 'stratboard-backup-' + stamp + '.json';
    var file = null;
    try { file = new File([blob], fname, { type: 'application/json' }); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Strat Board backup' }).catch(function () {});
      return;
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
    toast('Backup saved to your files');
  }

  function importPack(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var pack;
      try { pack = JSON.parse(fr.result); } catch (e) { toast('That is not a Strat Board backup'); return; }
      if (!pack || pack.app !== 'stratboard') { toast('That is not a Strat Board backup'); return; }
      pack.maps = pack.maps || [];
      if (pack.prefs) {
        if (pack.prefs.nick) { S.nick = pack.prefs.nick; $('nick').value = S.nick; }
        if (pack.prefs.hidden) S.hidden = pack.prefs.hidden;
        if (pack.prefs.flips) S.flips = pack.prefs.flips;
        if (typeof pack.prefs.showHills === 'boolean') S.showHills = pack.prefs.showHills;
        saveMeta();
      }
      var byName = {};
      S.maps.forEach(function (m) { byName[m.name] = m; });
      var added = 0, first = null;
      var jobs = pack.maps.map(function (pm) {
        if (byName[pm.name]) { if (!first) first = byName[pm.name]; return Promise.resolve(); }
        var rec = {
          id: uid(), name: pm.name, buf: bufFromB64(pm.img), type: pm.type || 'image/jpeg',
          pxw: pm.pxw, pxh: pm.pxh, h: pm.h || MAPW, created: Date.now()
        };
        return dbPut('maps', rec).then(function () {
          attachUrl(rec);
          S.maps.push(rec);
          byName[rec.name] = rec;
          added++;
          if (!first) first = rec;
        });
      });
      Promise.all(jobs).then(function () {
        (pack.hills || []).forEach(function (h) {
          var hm = byName[h.map];
          if (!hm || !h.pts || !h.pts.length || hillsFor(hm.id).length) return;
          S.hills[hm.id] = h.pts;
          dbPut('hills', { k: hm.id, pts: h.pts }).catch(function () {});
        });
        var bAdded = 0;
        (pack.boards || []).forEach(function (pb) {
          var m = byName[pb.map];
          if (!m) return;
          var exists = boardsOf(m.id).some(function (b) { return b.name === pb.name; });
          if (exists) return;
          var b = {
            id: uid(), mapId: m.id, room: pb.room || '', name: pb.name || 'Imported',
            tokens: pb.tokens || [], arrows: pb.arrows || [],
            marks: pb.marks || [], labels: pb.labels || [], updated: Date.now()
          };
          S.boards.push(b); dbPut('boards', b); bAdded++;
        });
        if (first) {
          S.mapId = first.id;
          var bl = boardsOf(first.id);
          S.boardId = (bl.length ? bl[0] : newBoard(first.id, 'Default')).id;
          S.objUrl = null;
          fitView();
        }
        renderMapList(); refresh();
        toast('Restored ' + bAdded + ' setup' + (bAdded === 1 ? '' : 's') +
              (added ? ' and ' + added + ' map' + (added === 1 ? '' : 's') : ''));
      });
    };
    fr.onerror = function () { toast('Could not read that file'); };
    fr.readAsText(file);
  }

  /* ---------- live room ---------- */
  function dTag(ev) {
    var t = (ev.tags || []).filter(function (x) { return x[0] === 'd'; })[0];
    return t ? t[1] : '';
  }
  function roomTag() { return 'stratboard:' + S.room; }
  function mapMetaTag() { return roomTag() + ':map'; }
  /* Chunk addresses carry a per-image id. Without it a second map reuses the
     first one's addresses, and a receiver reassembles a mixture of the two. */
  function mapChunkTag(xid, i) { return roomTag() + ':m:' + xid + ':' + i; }

  /* Cheap content hash (FNV-1a) — identifies an image and checks it arrived whole. */
  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }

  /* Re-encode the current map a little smaller, just for sending over relays. */
  function shareImage(m) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, SHARE_PX / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        var url = cv.toDataURL('image/jpeg', 0.72);
        res({ b64: url.slice(url.indexOf(',') + 1), w: w, h: h });
      };
      img.onerror = function () { rej(new Error('decode failed')); };
      img.src = m._url;
    });
  }

  function publishMap(force) {
    var m = curMap();
    if (!S.pool || !S.roomSk || !m) return;
    if (m.bundled) {
      /* Everyone already has it, so send a marker rather than the image. The
         marker matters: it replaces whatever map the room pointed at before,
         so an old transfer cannot keep reinstalling itself on every join. */
      S.mapSent = true;
      NostrLite.finalize({
        kind: 30078, tags: [['d', mapMetaTag()]],
        content: JSON.stringify({ name: m.name, builtin: true, n: 0, h: m.h })
      }, S.roomSk).then(function (ev) {
        if (S.pool) S.pool.publish(ev);
      }).catch(function () {});
      if (force) toast('"' + m.name + '" is built in — everyone has it');
      return;
    }
    if (S.mapSent && !force) return;
    S.mapSent = true;

    shareImage(m).then(function (im) {
      var parts = [];
      for (var i = 0; i < im.b64.length; i += CHUNK) parts.push(im.b64.slice(i, i + CHUNK));
      if (parts.length > MAX_CHUNKS) {
        banner('This map is too big to send over a room. Share a map pack instead.');
        return;
      }
      var xid = hashStr(im.b64);
      var meta = {
        name: m.name, n: parts.length, type: 'image/jpeg', xid: xid,
        len: im.b64.length, sum: xid,
        pxw: im.w, pxh: im.h, h: Math.round(MAPW * im.h / im.w)
      };
      var jobs = [{ d: mapMetaTag(), body: JSON.stringify(meta) }];
      parts.forEach(function (p, i) { jobs.push({ d: mapChunkTag(xid, i), body: p }); });

      // stagger slightly so relays do not treat the burst as flooding
      jobs.reduce(function (pr, job, i) {
        return pr.then(function () {
          return new Promise(function (go) { setTimeout(go, i ? 140 : 0); });
        }).then(function () {
          return NostrLite.finalize({ kind: 30078, tags: [['d', job.d]], content: job.body }, S.roomSk);
        }).then(function (ev) {
          if (S.pool) S.pool.publish(ev);
        });
      }, Promise.resolve()).then(function () {
        if (force) toast('Map sent to the room');
      });
    }).catch(function () { S.mapSent = false; });
  }

  /* Pings: a transient "look here" that every phone in the room sees for a
     couple of seconds. Deliberately not part of the board, so pointing at
     something never edits the plan. */
  var PING_COLOURS = ['#f5b708', '#22c55e', '#e9ebef', '#a855f7', '#38bdf8'];
  function colourFor(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return PING_COLOURS[h % PING_COLOURS.length];
  }

  var PING_PER_PERSON = 3;    // rings one person can have up at once
  var PING_ON_SCREEN = 10;    // rings on the board from everyone

  /* Without a cap a single excited teammate can bury the map under rings. */
  function trimPings(who) {
    var box = $('gPings');
    if (!box) return;
    var mine = [], all = box.childNodes;
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute && all[i].getAttribute('data-who') === who) mine.push(all[i]);
    }
    while (mine.length > PING_PER_PERSON) box.removeChild(mine.shift());
    while (box.childNodes.length > PING_ON_SCREEN) box.removeChild(box.firstChild);
  }

  function showPing(x, y, name, colour, who) {
    var r0 = clamp(S.view.w / 26, 10, 46);
    /* Everything sits in a translated group so the ring can scale about its
       own centre, and each ping animates from the moment it is added. */
    var g = svgEl('g', { transform: 'translate(' + x + ',' + y + ')' });
    var ring = svgEl('circle', {
      cx: 0, cy: 0, r: r0, fill: 'none', stroke: colour, 'stroke-width': r0 / 5
    });
    ring.setAttribute('class', 'sb-ring');
    var body = svgEl('g', {});
    body.setAttribute('class', 'sb-hold');
    body.appendChild(svgEl('circle', { cx: 0, cy: 0, r: r0 * 0.22, fill: colour }));
    if (name) {
      var t = svgEl('text', {
        x: 0, y: -r0 * 0.75, 'text-anchor': 'middle',
        'font-size': r0 * 0.62, 'font-weight': '600', fill: colour,
        stroke: '#0a0c10', 'stroke-width': r0 / 9, 'paint-order': 'stroke'
      });
      t.textContent = name;
      body.appendChild(t);
    }
    g.appendChild(ring);
    g.appendChild(body);
    g.setAttribute('data-who', who || name || '?');
    $('gPings').appendChild(g);
    trimPings(g.getAttribute('data-who'));
    uprightTexts(g);
    setTimeout(function () { if (g.parentNode) g.parentNode.removeChild(g); }, 5000);
  }

  function sendPing(p) {
    var m = curMap(), now = Date.now();
    /* A ping is for pointing at something, not for drumming on the screen. */
    function easeOff() {
      if (now - (S.pingNag || 0) > 4000) { S.pingNag = now; toast('Easy with the pings'); }
    }
    if (now - (S.pingAt || 0) < 600) { easeOff(); return; }
    S.pingBurst = (S.pingBurst || []).filter(function (t) { return now - t < 4000; });
    if (S.pingBurst.length >= 4) { easeOff(); return; }
    S.pingBurst.push(now);
    S.pingAt = now;
    showPing(p.x, p.y, S.nick || 'You', colourFor(S.clientId), S.clientId);
    if (!S.pool || !S.roomSk) return;
    NostrLite.finalize({
      kind: 20003, tags: [['d', roomTag()]],
      content: JSON.stringify({
        c: S.clientId, n: S.nick || 'Player',
        x: Math.round(p.x), y: Math.round(p.y), map: m ? m.name : ''
      })
    }, S.roomSk).then(function (ev) { if (S.pool) S.pool.publish(ev); }).catch(function () {});
  }

  function askForMap() {
    if (!S.pool || !S.roomSk) return;
    NostrLite.finalize({
      kind: 20002, tags: [['d', roomTag()]],
      content: JSON.stringify({ c: S.clientId })
    }, S.roomSk).then(function (ev) { if (S.pool) S.pool.publish(ev); }).catch(function () {});
  }

  function haveMapNamed(name) {
    for (var i = 0; i < S.maps.length; i++) if (S.maps[i].name === name) return S.maps[i];
    return null;
  }

  function pickBoardFor(mapId) {
    var list = boardsOf(mapId);
    var want = S.lastSetup[mapId];
    if (want) {
      for (var i = 0; i < list.length; i++) if (list[i].id === want) return list[i];
    }
    return list.length ? list[0] : newBoard(mapId, 'Default');
  }

  function useMapForRoom(m) {
    S.mapId = m.id;
    S.objUrl = null;
    S.boardId = pickBoardFor(m.id).id;
    fitView();
    fillSelects();
    render();
    if (S.pendingState) {
      var held2 = S.pendingState;
      S.pendingState = null;
      reconcileSetups(held2);
    }
    renderMapList();
    saveMeta();
    subHills();
    publishHills();
  }

  /* If parts stop arriving, say so with numbers rather than spinning forever. */
  function watchTransfer() {
    if (S.rxTimer) clearTimeout(S.rxTimer);
    S.rxTimer = setTimeout(function () {
      S.rxTimer = null;
      var rx = S.mapRx;
      if (!rx.meta || curMap()) return;
      var have = Object.keys(rx.chunks).length;
      if (have >= rx.meta.n) return;
      banner('Map stalled at ' + have + ' of ' + rx.meta.n +
             ' parts. Check Diagnostics, or use a map pack.');
    }, 20000);
  }

  function tryAssembleMap() {
    var rx = S.mapRx;
    if (!rx.meta) return;
    for (var i = 0; i < rx.meta.n; i++) if (rx.chunks[i] == null) return;

    var b64 = '';
    for (var j = 0; j < rx.meta.n; j++) b64 += rx.chunks[j];

    /* Verify before trusting it. A mismatch means parts from another image or
       a truncated part, which would otherwise render as a torn, garish mess. */
    if ((rx.meta.len && b64.length !== rx.meta.len) ||
        (rx.meta.sum && hashStr(b64) !== rx.meta.sum)) {
      S.mapRx = { meta: null, chunks: {} };
      banner('Map arrived damaged — asking for it again.');
      setTimeout(askForMap, 900);
      return;
    }

    var buf;
    try { buf = bufFromB64(b64); } catch (e) { return; }

    var meta = rx.meta;
    var existing = haveMapNamed(meta.name);
    if (existing && (existing.rxid === undefined || existing.rxid === meta.xid)) {
      S.mapRx = { meta: null, chunks: {} };
      useMapForRoom(existing);
      return;
    }
    if (existing) {
      /* Same name, different image — replace it in place so a damaged copy
         from an earlier transfer gets repaired instead of lingering. */
      if (existing._url) { try { URL.revokeObjectURL(existing._url); } catch (e) {} }
      existing.buf = buf;
      existing.pxw = meta.pxw; existing.pxh = meta.pxh;
      existing.h = meta.h || MAPW;
      existing.rxid = meta.xid;
      existing._url = '';
      attachUrl(existing);
      S.mapRx = { meta: null, chunks: {} };
      S.objUrl = null;
      useMapForRoom(existing);
      banner('');
      toast('Map updated: ' + existing.name);
      dbPut('maps', existing).catch(function () {});
      return;
    }

    var rec = {
      id: uid(), name: meta.name || 'Room map', buf: buf, type: 'image/jpeg',
      pxw: meta.pxw, pxh: meta.pxh, h: meta.h || MAPW,
      rxid: meta.xid, created: Date.now()
    };
    S.mapRx = { meta: null, chunks: {} };

    /* Register it synchronously. Waiting on the database let a second copy of
       the same transfer assemble alongside this one and land as a duplicate,
       which then opened a fresh live board and discarded the synced state. */
    attachUrl(rec);
    S.maps.push(rec);
    useMapForRoom(rec);
    banner('');
    toast('Map received: ' + rec.name);
    dbPut('maps', rec).catch(function () { toast('Map received but could not be saved'); });
  }

  function isHost() { return !S.room || S.host === S.clientId; }

  /* The host can lock the room so only they make changes. Everyone shares the
     room key, so this is a courtesy between teammates, not security — and if
     the host drops off we release it rather than leave the room stuck. */
  function hostAway() {
    if (!S.host || S.host === S.clientId) return false;
    var seen = S.members[S.host];
    return !seen || (Date.now() - seen.t) > 90000;
  }
  function canEdit() {
    if (!S.room || !S.locked) return true;
    return isHost() || hostAway();
  }
  function denyEdit() {
    var who = S.members[S.host] ? S.members[S.host].n : 'the host';
    banner('View only — ' + who + ' has locked changes.', 2500);
  }

  function boardTag(id) { return roomTag() + ':b:' + id; }

  /* The room's shape: which map, which setup is open, and the setup list.
     Each setup's contents travel separately so one board's arrows never
     push the whole room over a relay's size limit. */
  function roomStatePayload() {
    var m = curMap();
    return JSON.stringify({
      v: 2, by: S.clientId, n: S.nick || 'Player', map: m ? m.name : '',
      host: S.host || S.clientId, locked: !!S.locked,
      flip: rotOf() === 2, rot: rotOf(),
      active: S.boardId,
      setups: m ? boardsOf(m.id).map(function (b) { return { id: b.id, name: b.name }; }) : []
    });
  }

  function publishRoomState() {
    if (!S.pool || !S.roomSk || !S.room) return;
    NostrLite.finalize({
      kind: 30078, created_at: stampFor('state'), tags: [['d', roomTag()]], content: roomStatePayload()
    }, S.roomSk).then(function (ev) { if (S.pool) S.pool.publish(ev); }).catch(function () {});
  }

  /* Relay timestamps are whole seconds, and when two copies share a second
     the relay keeps whichever it likes — which meant a replay could hand
     back a half-finished board and rub out live work. Our own stamps are
     forced upwards so the relay always holds the newest, and the counter
     below settles it for good. */
  function stampFor(key) {
    var now = Math.floor(Date.now() / 1000);
    var last = S.stamps[key] || 0;
    S.stamps[key] = now > last ? now : last + 1;
    return S.stamps[key];
  }

  function publishBoard(b) {
    if (!S.pool || !S.roomSk || !S.room || !b) return;
    if ((b.room || '') !== S.room) return;
    b.v = (b.v || 0) + 1;
    NostrLite.finalize({
      kind: 30078, created_at: stampFor('b:' + b.id), tags: [['d', boardTag(b.id)]],
      content: JSON.stringify({
        by: S.clientId, id: b.id, name: b.name, tokens: b.tokens,
        arrows: b.arrows, marks: b.marks, labels: b.labels, base: b.base || null,
        gone: b.gone || [], v: b.v || 0
      })
    }, S.roomSk).then(function (ev) { if (S.pool) S.pool.publish(ev); }).catch(function () {});
  }

  /* We hold the newer copy, so send it again rather than leave the other
     phone showing something nobody else can see. Rate-limited: a room full
     of phones must not answer each other in circles. */
  function nudge(b) {
    if (!b || !S.room || !S.pool) return;
    var now = Date.now();
    if (now - (S.lastNudge || 0) < 900) return;
    S.lastNudge = now;
    clearTimeout(S.nudgeTimer);
    S.nudgeTimer = setTimeout(function () { publishBoard(b); dbPut('boards', b); }, 250);
  }

  function inRoomBoard() {
    var b = curBoard();
    return !!(S.room && b && (b.room || '') === S.room);
  }

  function queueSend() {
    if (!S.pool || !inRoomBoard()) return;
    if (S.sendTimer) return;
    var wait = Math.max(0, SEND_MS - (Date.now() - S.lastSend));
    S.sendTimer = setTimeout(function () {
      S.sendTimer = null;
      sendNow();
    }, wait);
  }
  function liveSend() { queueSend(); }

  function sendNow() {
    if (!S.pool || !S.roomSk || !inRoomBoard()) return;
    S.lastSend = Date.now();
    publishBoard(curBoard());
  }

  function subBoards() {
    var m = curMap();
    if (!S.pool || !m || !S.room) return;
    var ids = boardsOf(m.id).map(function (b) { return boardTag(b.id); });
    for (var from = 0; from < ids.length; from += 12) {
      S.pool.sub('b' + from, [{
        kinds: [30078], authors: [S.roomPub], '#d': ids.slice(from, from + 12)
      }]);
    }
  }

  /* Relays keep only the newest copy of the board and of the room state, so
     re-asking for them is cheap and repairs anything a flaky phone missed.
     Without this a single dropped message leaves a device stale for good. */
  function resync() {
    if (!S.pool || !S.room || !S.roomPub) return;
    S.pool.sub('state', [{ kinds: [30078], authors: [S.roomPub], '#d': [roomTag()], limit: 1 }]);
    subBoards();
    subHills();
  }

  /* Rebuild the connection and nothing else: same room, same setup, same
     undo history. */
  function reopen() {
    if (!S.pool || !S.room) return;
    var now = Date.now();
    if (now - (S.lastReopen || 0) < 20000) return;
    S.lastReopen = now;
    S.lastRx = now;
    try { S.pool.reconnect(); } catch (e) {}
    resync();
  }

  function sendBeat() {
    if (!S.pool || !S.roomSk) return;
    var ev = {
      kind: 20001,
      tags: [['d', 'stratboard:' + S.room]],
      content: JSON.stringify({ c: S.clientId, n: S.nick || 'Player' })
    };
    NostrLite.finalize(ev, S.roomSk).then(function (signed) {
      S.pool.publish(signed);
    }).catch(function () {});
  }

  /* Bring the local setup list for this map into line with the room's. */
  function reconcileSetups(data) {
    var m = curMap();
    if (!m || !data.setups) return;
    var wanted = {}, changed = false;
    data.setups.forEach(function (e) {
      wanted[e.id] = e.name;
      var local = null;
      S.boards.forEach(function (b) { if (b.id === e.id) local = b; });
      if (!local) {
        local = {
          id: e.id, mapId: m.id, room: S.room, name: e.name,
          tokens: ['AR', 'Sub', 'Flex', 'Anch'].map(function (n, k) {
            var sp = homeSpot(k, m.h);
            return { id: e.id + ':t' + k, n: n, x: sp.x, y: sp.y, team: 'b' };
          }),
          arrows: [], marks: [], labels: [], v: 0, updated: Date.now()
        };
        S.boards.push(local);
        dbPut('boards', local);
        changed = true;
      } else if (local.name !== e.name) {
        local.name = e.name;
        dbPut('boards', local);
        changed = true;
      }
    });
    /* Someone deleted a setup: drop it here too. */
    boardsOf(m.id).forEach(function (b) {
      if (!wanted[b.id]) {
        dbDel('boards', b.id);
        S.boards = S.boards.filter(function (x) { return x.id !== b.id; });
        changed = true;
      }
    });
    if (data.active) {
      var has = S.boards.some(function (b) { return b.id === data.active; });
      if (has && S.boardId !== data.active) {
        S.boardId = data.active;
        S.undo.length = 0; S.redo.length = 0;
        syncUndoButtons();
        changed = true;
      }
    }
    if (!curBoard()) {
      var list = boardsOf(m.id);
      S.boardId = list.length ? list[0].id : newBoard(m.id, 'Default').id;
      changed = true;
    }
    subBoards();
    if (changed) { fillSelects(); render(); saveMeta(); }
  }

  /* Two phones changing the same setup at the same moment used to mean one
     of them simply lost — everyone drops a player at once during setup, and
     only the last one to land survived. Both sides are now folded together:
     a player carries its own little count so whoever moved it last wins that
     player alone, drawings are pooled by id, and anything deliberately
     removed stays removed. */
  function mergeLists(winner, loser, gone) {
    var out = [], seen = {};
    (winner || []).forEach(function (o) {
      if (!o || !o.id || seen[o.id] || gone[o.id]) return;
      seen[o.id] = 1; out.push(o);
    });
    (loser || []).forEach(function (o) {
      if (!o || !o.id || seen[o.id] || gone[o.id]) return;
      seen[o.id] = 1; out.push(o);
    });
    return out;
  }

  function mergeTokens(winner, loser, gone) {
    var ours = {};
    (loser || []).forEach(function (t) { if (t && t.id) ours[t.id] = t; });
    return (winner || []).filter(function (t) {
      return t && t.id && !gone[t.id];
    }).map(function (t) {
      var mine = ours[t.id];
      /* We moved this player more recently than they did, so keep him where
         we put him — everything else about the team comes from them. */
      if (mine && (mine.tv || 0) > (t.tv || 0)) return mine;
      return t;
    });
  }

  function applyBoard(data) {
    var target = null;
    S.boards.forEach(function (b) { if (b.id === data.id) target = b; });
    if (!target) return;
    /* Older than what we already have — a replay of something we have moved
       on from. Dropping it is what stops the board jumping backwards while
       everyone is setting up. */
    /* Strictly older only. Two people editing at the same moment can land on
       the same count, and there the newest arrival should win as it always
       did — rejecting those left a joiner staring at an empty board. */
    /* Nothing is ever thrown away for being old: the two boards are folded
       together instead. An older copy coming round again can only repeat
       what we already have, and a removal is remembered, so a replay cannot
       undo anything. The count only decides who wins when both sides changed
       the very same thing. */
    var mine = target.v || 0, theirs = data.v || 0;
    var theirsWins = theirs > mine ||
      (theirs === mine && String(data.by || '') > String(S.clientId));
    target.v = theirs > mine ? theirs : mine;
    /* Everything either side has thrown away stays thrown away. */
    var goneList = (target.gone || []).concat(data.gone || []);
    if (goneList.length > 300) goneList = goneList.slice(goneList.length - 300);
    target.gone = goneList;
    var gone = {};
    goneList.forEach(function (id) { gone[id] = 1; });

    var win = theirsWins ? data : target, lose = theirsWins ? target : data;
    var before = (data.arrows || []).length + (data.marks || []).length +
                 (data.labels || []).length + (data.tokens || []).length;
    target.tokens = mergeTokens(win.tokens || [], lose.tokens || [], gone);
    target.arrows = mergeLists(win.arrows || [], lose.arrows || [], gone);
    target.marks = mergeLists(win.marks || [], lose.marks || [], gone);
    target.labels = mergeLists(win.labels || [], lose.labels || [], gone);
    /* We are holding something they have not got — hand it back, or their
       screen quietly stays short of an idea somebody drew. */
    if (target.arrows.length + target.marks.length + target.labels.length +
        target.tokens.length !== before) {
      nudge(target);
    }
    if (data.name && data.name !== target.name) target.name = data.name;
    if (data.base) target.base = data.base;
    target.updated = Date.now();
    dbPut('boards', target);
    if (target.id === S.boardId) {
      S.undo.length = 0; S.redo.length = 0;
      syncUndoButtons();
      render();
    }
  }

  function onEvent(ev) {
    if (!S.roomPub || ev.pubkey !== S.roomPub) return;
    S.lastRx = Date.now();

    /* map transfer: chunks are raw base64, not JSON, so handle them first */
    if (ev.kind === 30078) {
      var d = dTag(ev);
      if (d === mapMetaTag()) {
        var meta;
        try { meta = JSON.parse(ev.content); } catch (e) { return; }
        if (!meta || !meta.n) return;
        /* A local map of our own always wins. A previously received one only
           matches if it is the same image — otherwise it is stale or damaged
           and we fetch it again. */
        var known = haveMapNamed(meta.name);
        if (known && (known.rxid === undefined || known.rxid === meta.xid)) {
          if (curMap() !== known) useMapForRoom(known);
          return;
        }
        /* A marker for a map everyone already has: just follow it. */
        if (meta.builtin || !meta.n) {
          var have = haveMapNamed(meta.name);
          if (have && curMap() !== have) useMapForRoom(have);
          return;
        }
        if (!meta.xid) { banner('Sender is on an older version — ask them to update.'); return; }

        /* Only take a transfer for the map the room is actually on. The
           record is per-room and sticks around, so an old one would
           otherwise reinstall a map you deleted every time you rejoin. */
        if (S.roomMapName && meta.name !== S.roomMapName) return;
        if (!S.roomMapName && curMap()) { S.metaWaiting = meta; return; }
        if (!S.mapRx.meta || S.mapRx.meta.xid !== meta.xid) S.mapRx = { meta: meta, chunks: {} };
        else S.mapRx.meta = meta;
        banner('Getting "' + meta.name + '" from the room…');

        /* Ask for exactly those parts, in small batches — relays limit how
           many values one filter may carry. */
        if (S.pool) {
          var total = Math.min(meta.n, MAX_CHUNKS), BATCH = 12;
          for (var from = 0; from < total; from += BATCH) {
            var want = [];
            for (var ci = from; ci < Math.min(from + BATCH, total); ci++) {
              want.push(mapChunkTag(meta.xid, ci));
            }
            S.pool.sub('mapdata' + from, [{ kinds: [30078], authors: [S.roomPub], '#d': want }]);
          }
        }
        watchTransfer();
        tryAssembleMap();
        return;
      }
      if (d.indexOf(roomTag() + ':m:') === 0) {
        if (!S.mapRx.meta) return;
        var rest = d.slice((roomTag() + ':m:').length);
        var cut = rest.lastIndexOf(':');
        if (cut < 0) return;
        if (rest.slice(0, cut) !== S.mapRx.meta.xid) return;   // part of another image
        var idx = parseInt(rest.slice(cut + 1), 10);
        if (isNaN(idx)) return;
        S.mapRx.chunks[idx] = ev.content;
        if (S.mapRx.meta) {
          banner('Getting "' + S.mapRx.meta.name + '" — ' +
                 Object.keys(S.mapRx.chunks).length + ' of ' + S.mapRx.meta.n + ' parts');
        }
        watchTransfer();
        tryAssembleMap();
        return;
      }
      if (d.indexOf(roomTag() + ':hills:') === 0) {
        var hm = null, hname = d.slice((roomTag() + ':hills:').length);
        S.maps.forEach(function (x) { if (x.name === hname) hm = x; });
        if (!hm) return;
        var hp;
        try { hp = JSON.parse(ev.content); } catch (e) { return; }
        if (!hp || hp.by === S.clientId || !hp.pts) return;
        S.hills[hm.id] = hp.pts;
        dbPut('hills', { k: hm.id, pts: hp.pts }).catch(function () {});
        if (curMap() === hm) render();
        return;
      }
      if (d.indexOf(roomTag() + ':b:') === 0) {
        var bd;
        try { bd = JSON.parse(ev.content); } catch (e) { return; }
        if (!bd || bd.by === S.clientId) return;
        if (S.locked && isHost() && bd.by !== S.host) return;
        if (S.seenBoard[bd.id] === ev.content) return;   // a repeat of what we show
        S.seenBoard[bd.id] = ev.content;
        if (gest && bd.id === S.boardId &&
            (gest.type === 'drag' || gest.type === 'draw' || gest.type === 'draglabel')) {
          S.pendingRemote = bd;      // never yank the board out from under a finger
          return;
        }
        applyBoard(bd);
        return;
      }
      if (d !== roomTag()) return;
    }

    var data;
    try { data = JSON.parse(ev.content); } catch (e) { return; }

    if (ev.kind === 20003) {
      if (!data.c || data.c === S.clientId) return;
      var m = curMap();
      if (data.map && m && data.map !== m.name) return;   // pointing at another map
      S.members[data.c] = { n: data.n || 'Player', t: Date.now() };
      showPing(data.x, data.y, data.n || 'Player', colourFor(data.c), data.c || data.n);
      renderMembers();
      return;
    }
    if (ev.kind === 20002) {
      if (!data.c || data.c === S.clientId) return;
      if (curMap()) publishMap(true);
      return;
    }
    if (ev.kind === 20001) {
      if (!data.c || data.c === S.clientId) return;
      var isNew = !S.members[data.c];
      S.members[data.c] = { n: data.n || 'Player', t: Date.now() };
      renderMembers();
      /* someone just turned up: make sure the map is on the relay for them */
      if (isNew && curMap()) setTimeout(function () { publishMap(true); }, 700);
      return;
    }
    if (ev.kind !== 30078) return;
    if (data.by === S.clientId) return;

    /* Every state message names its sender, so a teammate is identified
       straight away instead of waiting on the next heartbeat. */
    if (data.by) {
      var seen = S.members[data.by];
      var fresh = !seen;
      S.members[data.by] = { n: data.n || (seen && seen.n) || 'Player', t: Date.now() };
      if (fresh) { renderMembers(); sendBeat(); }
    }

    /* Land on the right map before touching any setups. */
    if (data.map) {
      S.roomMapName = data.map;
      if (S.metaWaiting) {
        var held = S.metaWaiting;
        S.metaWaiting = null;
        if (held.name === data.map) onEvent({
          pubkey: S.roomPub, kind: 30078,
          tags: [['d', mapMetaTag()]], content: JSON.stringify(held)
        });
      }
      var known = haveMapNamed(data.map);
      if (!known) {
        S.pendingState = data;
        if (!S.mapRx.meta) { banner('Room is on "' + data.map + '" — fetching it…'); askForMap(); }
        return;
      }
      if (curMap() !== known) {
        S.pendingState = data;
        useMapForRoom(known);
        fitView();
        var who = S.members[data.by] ? S.members[data.by].n : 'Someone';
        banner(who + ' switched to ' + known.name);
        renderMembers();
        return;
      }
    }
    if (!curMap()) { S.pendingState = data; return; }

    var fm = curMap();
    var wantRot = typeof data.rot === 'number' ? ((data.rot % 4) + 4) % 4
                : typeof data.flip === 'boolean' ? (data.flip ? 2 : 0) : null;
    if (fm && wantRot !== null && rotOf(fm) !== wantRot) {
      S.rots[fm.id] = wantRot;
      delete S.flips[fm.id];
      saveMeta();
      fitView();
      render();
      banner(wantRot ? 'Map turned by the room' : 'Map back to normal', 2500);
    }
    if (data.host) S.host = data.host;
    if (typeof data.locked === 'boolean' && data.locked !== S.locked) {
      S.locked = data.locked;
      if (!isHost()) {
        banner(S.locked ? 'The host has locked changes — view only.'
                        : 'Changes unlocked — you can edit again.', 4000);
      }
    }
    renderLock();

    reconcileSetups(data);
    renderMembers();
  }

  function banner(txt, ms) {
    var b = $('banner');
    clearTimeout(banner._t);
    if (!txt) { b.classList.remove('show'); return; }
    b.textContent = txt;
    b.classList.add('show');
    banner._t = setTimeout(function () { b.classList.remove('show'); }, ms || 6000);
  }

  function prune() {
    var now = Date.now(), changed = false;
    Object.keys(S.members).forEach(function (k) {
      if (now - S.members[k].t > STALE_MS) { delete S.members[k]; changed = true; }
    });
    if (changed) renderMembers();
  }

  function renderLock() {
    var row = $('lockrow'), btn = $('locktoggle'), note = $('locknote');
    if (!row) return;
    if (!S.room) { row.style.display = 'none'; note.style.display = 'none'; return; }
    if (isHost()) {
      row.style.display = '';
      btn.textContent = S.locked ? 'Others can edit: off' : 'Others can edit: on';
      btn.setAttribute('aria-pressed', S.locked ? 'true' : 'false');
      note.style.display = '';
      note.textContent = S.locked
        ? 'Only you can make changes. Everyone can still ping and look around.'
        : 'Everyone in the room can make changes.';
    } else {
      row.style.display = 'none';
      note.style.display = S.locked ? '' : 'none';
      note.textContent = 'The host has locked changes — you can ping and look around.';
    }
    $('viewonly').classList.toggle('show', !!(S.room && S.locked && !canEdit()));
  }

  function renderRoomState() {
    var el = $('roomstate');
    if (!el) return;
    if (!S.room) {
      el.textContent = 'Not in a room';
      el.className = 'pill';
      return;
    }
    var n = Object.keys(S.members).length;
    var st = S.pool ? S.pool.status() : { up: 0, total: 0 };
    el.textContent = 'In "' + S.room + '" · ' + (n ? n + ' other' + (n === 1 ? '' : 's') : 'on your own') +
                     ' · ' + st.up + '/' + st.total + ' relays';
    el.className = 'pill' + (st.up ? ' ok' : '');
  }

  function renderMembers() {
    renderRoomState();
    renderLock();
    var n = Object.keys(S.members).length;
    var btn = $('livebtn');
    /* Just a dot and a headcount — the word "Live" was eating a third of the
       bar and truncating the setup name. Hidden entirely when on your own. */
    if (S.room) {
      btn.classList.add('on');
      btn.style.display = '';
      $('liven').textContent = String(n + 1);
      btn.setAttribute('aria-label', 'Live room, ' + (n + 1) + ' here');
    } else {
      btn.classList.remove('on');
      btn.style.display = 'none';
    }
    var box = $('members');
    box.textContent = '';
    if (!S.room) return;
    /* The status line above already covers the room, headcount and relays —
       this is only who else is here. */
    var others = Object.keys(S.members);
    if (!others.length) return;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0';
    others.forEach(function (k) {
      var s = document.createElement('span');
      s.className = 'pill ok';
      s.textContent = S.members[k].n;
      wrap.appendChild(s);
    });
    box.appendChild(wrap);
  }

  function diagLines() {
    var out = [];
    out.push('Strat Board v' + VERSION);
    out.push('room: ' + (S.room || 'none') + '   you: ' + (S.nick || 'unnamed'));
    out.push('others seen: ' + Object.keys(S.members).length);
    var m = curMap(), b = curBoard();
    out.push('map: ' + (m ? m.name : 'none') + '   setup: ' + (b ? b.name : 'none') +
             (S.room ? ' (shared with the room)' : ''));
    if (S.mapRx.meta) {
      out.push('incoming map: ' + Object.keys(S.mapRx.chunks).length + '/' + S.mapRx.meta.n + ' parts');
    }
    if (!S.room) {
      out.push('not in a room — type a code and press Join');
      return out;
    }
    if (!S.pool) { out.push('not connected to any relay'); return out; }
    var rep = S.pool.report();
    var carrying = rep.filter(function (r) {
      return r.state === 'connected' && !r.muted && (r.ok > 0 || r.sent === 0);
    }).length;
    out.push(carrying >= 2 ? 'sharing fine — ' + carrying + ' relays carrying the room'
      : carrying === 1 ? 'working, but only one relay is carrying the room'
      : 'nothing is carrying the room right now');
    out.push('');
    rep.forEach(function (r) {
      out.push('• ' + r.url.replace(/^wss?:\/\//, '') + (r.authed ? ' [authed]' : ''));
      out.push('    ' + r.state + ' — sent ' + r.sent + ', accepted ' + r.ok +
               ', rejected ' + r.rejected + ', received ' + r.recv);
      if (r.err) out.push('    says: ' + r.err);
      if (r.muted) out.push('    (kept turning us away — skipped, the others carry the room)');
      if (r.state === 'connected' && r.sent > 0 && r.ok === 0 && r.rejected === 0 && !r.authed) {
        out.push('    (took events but never acknowledged any)');
      }
    });
    return out;
  }

  function renderDiag() {
    var box = $('diag');
    if (!box) return;
    box.textContent = '';
    var pre = document.createElement('div');
    pre.style.cssText = 'font:12px/1.55 ui-monospace,Menlo,Consolas,monospace;' +
      'white-space:pre-wrap;word-break:break-word;color:var(--dim);' +
      'background:var(--surface2);border:1px solid var(--line);' +
      'border-radius:var(--r);padding:11px';
    pre.textContent = diagLines().join('\n');
    box.appendChild(pre);
  }

  function joinRoom(code, quiet) {
    code = (code || '').trim();
    if (!code) { toast('Enter a room code'); return; }
    leaveRoom(true);
    S.room = code;
    S.mapSent = false;
    S.mapRx = { meta: null, chunks: {} };
    S.pendingState = null;
    S.roomMapName = '';
    S.metaWaiting = null;
    S.host = S.clientId;      // replaced by the room's own host if one exists
    S.locked = false;
    $('roomcode').value = code;

    if (S.mapId) {
      S.boardId = pickBoardFor(S.mapId).id;   // already scoped to the new room
    }
    S.undo.length = 0; S.redo.length = 0;

    NostrLite.keyFromCode(code).then(function (sk) {
      S.roomSk = sk;
      S.roomPub = NostrLite.bytesToHex(NostrLite.pubkeyFromSeckey(sk));
      S.pool = new NostrLite.Pool(S.relays, {
        onevent: onEvent,
        /* NIP-42 challenge: sign it with the room key so write-gated
           relays will take our events. */
        authSign: function (url, challenge) {
          return NostrLite.finalize({
            kind: 22242,
            tags: [['relay', url], ['challenge', challenge]],
            content: ''
          }, S.roomSk);
        },
        onauth: function () {
          sendBeat();
          if (curMap()) { sendNow(); S.mapSent = false; publishMap(); }
          else askForMap();
          renderDiag();
        },
        onstatus: function () { renderMembers(); renderDiag(); },
        onnotice: function (url, msg) {
          S.notices.push(url.replace(/^wss?:\/\//, '') + ': ' + msg);
          if (S.notices.length > 8) S.notices.shift();
          renderDiag();
        }
      });
      S.pool.connect();

      /* Three small subscriptions rather than one fat one: a relay that
         refuses an oversized filter would otherwise kill the lot. */
      S.pool.sub('state', [{ kinds: [30078], authors: [S.roomPub], '#d': [roomTag()], limit: 1 }]);
      S.pool.sub('live', [{
        kinds: [20001, 20002, 20003], authors: [S.roomPub],
        since: Math.floor(Date.now() / 1000) - 60
      }]);
      S.pool.sub('mapmeta', [{ kinds: [30078], authors: [S.roomPub], '#d': [mapMetaTag()] }]);
      subHills();
      setTimeout(function () { publishHills(); }, 1900);

      /* Nothing in the UI sets relays any more, so recover by hand here: if
         a non-default list reaches nothing, fall back and reconnect once. */
      if (S.relayFallback) clearTimeout(S.relayFallback);
      S.relayFallback = setTimeout(function () {
        S.relayFallback = null;
        if (!S.pool || !S.room) return;
        if (S.pool.status().up > 0) return;
        var isDefault = S.relays.length === DEFAULT_RELAYS.length &&
          S.relays.every(function (u, i) { return u === DEFAULT_RELAYS[i]; });
        if (isDefault) return;
        S.relays = DEFAULT_RELAYS.slice();
        saveMeta();
        toast('Reconnecting…');
        joinRoom(S.room, true);
      }, 20000);

      S.lastRx = Date.now();
      S.beat = setInterval(function () {
        sendBeat();
        prune();
        S.beats = (S.beats || 0) + 1;
        if (S.beats % 4 === 0) resync();      // every ~48s; it is only a repair
        /* Phones hand back sockets that look open but deliver nothing. If
           others are in the room we should hear their heartbeats; silence
           for this long means the connection is dead, so rebuild it. */
        if (S.room && Object.keys(S.members).length &&
            Date.now() - S.lastRx > 45000) {
          reopen();
        }
      }, BEAT_MS);
      setTimeout(sendBeat, 900);

      if (curMap()) {
        setTimeout(function () {
          publishRoomState(); sendNow(); publishMap(); subBoards();
        }, 1600);
        banner('In room "' + S.room + '" — these setups are shared.');
      } else {
        banner('Waiting for the map from the room…');
        var tries = 0;
        S.wantTimer = setInterval(function () {
          if (curMap() || tries++ > 8) {
            clearInterval(S.wantTimer); S.wantTimer = null;
            if (!curMap()) banner('Nobody in the room has sent a map yet.');
            return;
          }
          askForMap();
        }, 3500);
        setTimeout(askForMap, 1200);
      }

      refresh();
      renderMembers();
      renderDiag();
      syncUndoButtons();
      toast(quiet ? 'Back in ' + S.room : 'Joined ' + S.room);
    }).catch(function () { toast('Could not start the room'); });
  }

  function leaveRoom(quiet) {
    if (S.pool) { S.pool.close(); S.pool = null; }
    if (S.beat) { clearInterval(S.beat); S.beat = null; }
    if (S.sendTimer) { clearTimeout(S.sendTimer); S.sendTimer = null; }
    if (S.wantTimer) { clearInterval(S.wantTimer); S.wantTimer = null; }
    if (S.rxTimer) { clearTimeout(S.rxTimer); S.rxTimer = null; }
    if (S.relayFallback) { clearTimeout(S.relayFallback); S.relayFallback = null; }
    S.room = ''; S.roomSk = null; S.roomPub = null; S.members = {};
    if (S.mapId) {
      var own = boardsOf(S.mapId);
      S.boardId = (own.length ? own[0] : newBoard(S.mapId, 'Default')).id;
      S.undo.length = 0; S.redo.length = 0;
      fillSelects(); render(); syncUndoButtons();
    }
    S.mapSent = false; S.mapRx = { meta: null, chunks: {} }; S.pendingState = null;
    S.roomMapName = ''; S.metaWaiting = null; S.host = ''; S.locked = false;
    renderMembers();
    saveMeta();
    if (!quiet) {
      toast('Left the room');
      banner('');
      closeSheet('menu');
      showStart();          // back to the choice, rather than a dead board
    }
  }

  /* ---------- wiring ---------- */
  /* Rebuilt from the board, so renaming a player renames their chip and a
     deleted player stops being offered. */
  function buildWho() {
    var box = $('who');
    if (!box) return;
    var b = curBoard();
    box.textContent = '';
    if (!b) return;
    var any = document.createElement('button');
    any.textContent = 'Any';
    any.setAttribute('aria-pressed', S.arrowOwn ? 'false' : 'true');
    any.addEventListener('click', function () { pickOwner(''); });
    box.appendChild(any);

    b.tokens.forEach(function (t) {
      var col = routeColour(t, teamIndex(t));
      var btn = document.createElement('button');
      btn.textContent = (t.n || '?').slice(0, 5);
      btn.style.borderColor = col;
      btn.style.color = S.arrowOwn === t.id ? '#fff' : col;
      btn.className = S.arrowOwn === t.id ? 'on' : '';
      btn.setAttribute('aria-pressed', S.arrowOwn === t.id ? 'true' : 'false');
      if (S.arrowOwn === t.id) btn.style.background = col;
      btn.addEventListener('click', function () { pickOwner(t.id); });
      box.appendChild(btn);
    });

    var only = document.createElement('button');
    only.className = 'only';
    only.textContent = 'Only';
    only.setAttribute('aria-pressed', S.onlyOwn ? 'true' : 'false');
    only.disabled = !S.arrowOwn;
    only.addEventListener('click', function () {
      if (!S.arrowOwn) { toast('Pick a player first'); return; }
      S.onlyOwn = !S.onlyOwn;
      buildWho();
      render();
    });
    box.appendChild(only);
  }

  function pickOwner(id) {
    S.arrowOwn = id;
    if (!id) S.onlyOwn = false;
    buildWho();
    var sw = $('swatch');
    if (sw) sw.classList.toggle('show', S.tool === 'arrow' && !id);
    render();
  }

  function setTool(t) {
    S.tool = t;
    var btns = document.querySelectorAll('#tools button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-tool') === t ? 'true' : 'false');
    }
    var sw = $('swatch'), kd = $('kinds'), wh = $('who');
    if (wh) {
      var showWho = t === 'arrow';
      /* Showing one player alone is a way of reading the board while you
         draw, not a setting — leaving the tool must not strand the rest of
         the routes hidden with no button in sight to bring them back. */
      if (!showWho && S.onlyOwn) { S.onlyOwn = false; setTimeout(render, 0); }
      if (showWho) buildWho();
      wh.classList.toggle('show', showWho);
    }
    if (kd) {
      /* Colours only matter for a plain mark — utility brings its own. */
      var showKinds = t === 'mark';
      kd.classList.toggle('show', showKinds);
      kd.classList.toggle('under', showKinds && S.markKind === 'x');
      sw.classList.toggle('plainmark', showKinds);
    }
    if (t === 'ping') {
      sw.classList.remove('show');
      banner('Tap the map to ping, or hold the map in Move.', 3000);
      return;
    }
    if ((t === 'arrow' && !S.arrowOwn) || t === 'text' ||
        (t === 'mark' && S.markKind === 'x')) {
      sw.classList.add('show');
    } else {
      sw.classList.remove('show');
    }
  }

  function openSheet(id) { $(id).classList.add('open'); }
  function closeSheet(id) { $(id).classList.remove('open'); }

  function wire() {
    var stage = $('stage');
    stage.addEventListener('pointerdown', stageDown);
    stage.addEventListener('pointermove', stageMove);
    stage.addEventListener('pointerup', stageUp);
    stage.addEventListener('pointercancel', stageUp);

    var tb = document.querySelectorAll('#tools button');
    for (var i = 0; i < tb.length; i++) {
      tb[i].addEventListener('click', function () { setTool(this.getAttribute('data-tool')); });
    }
    var sws = document.querySelectorAll('.sw');
    for (var j = 0; j < sws.length; j++) {
      sws[j].addEventListener('click', function () {
        S.colour = this.getAttribute('data-col');
        var all = document.querySelectorAll('.sw');
        for (var k = 0; k < all.length; k++) {
          all[k].setAttribute('aria-pressed', all[k] === this ? 'true' : 'false');
        }
        saveMeta();
      });
    }

    $('undo').addEventListener('click', doUndo);
    $('redo').addEventListener('click', doRedo);
    $('hillsbtn').addEventListener('click', function () {
      if (S.hillEdit) { setHillEdit(false); toast('Hardpoints saved'); return; }
      var m = curMap();
      if (!m) { toast('Pick a map first'); return; }
      /* Nothing to show means nothing has been placed on this map yet, so
         start placing rather than claiming to have shown something. */
      if (!hillsFor(m.id).length) {
        setHillEdit(true);
        toast('No hardpoints on ' + m.name + ' yet — place them');
        return;
      }
      S.showHills = !S.showHills;
      render(); saveMeta();
      toast(S.showHills ? 'Hardpoints shown' : 'Hardpoints hidden');
    });

    $('edithills').addEventListener('click', function () {
      if (!canEdit()) { denyEdit(); toast('Only the host can change things'); return; }
      if (!curMap()) { toast('Pick a map first'); return; }
      closeSheet('menu');
      setHillEdit(true);
    });

    /* One setup per hill in this map's published rotation, so the team can
       flick through the rotation in order instead of making them mid-match.
       They start on the normal line-up — where the players go is yours to
       decide, not something to guess at. */
    $('hpsetups').addEventListener('click', function () {
      var m = curMap();
      if (!m) { toast('Pick a map first'); return; }
      if (!canEdit()) { denyEdit(); return; }
      var hills = rotationFor(m.name);
      if (!hills.length) { toast('No published rotation for ' + m.name); return; }
      var have = {};
      boardsOf(m.id).forEach(function (b) { have[b.name.toLowerCase()] = 1; });
      var made = 0, first = null;
      hills.forEach(function (h, i) {
        var name = 'HP' + (i + 1) + ' ' + h;
        if (have[name.toLowerCase()]) return;
        var nb = newBoard(m.id, name);
        if (!first) first = nb;
        made++;
      });
      if (!made) { toast('Already there — ' + hills.length + ' hills'); return; }
      S.boards.forEach(function (b) { dbPut('boards', b); });
      if (first) S.boardId = first.id;
      refresh(); saveMeta();
      if (S.room) { publishRoomState(); boardsOf(m.id).forEach(publishBoard); }
      toast('Added ' + made + ' setup' + (made === 1 ? '' : 's') + ' for ' + m.name);
    });

    Array.prototype.forEach.call(document.querySelectorAll('#kinds .kd'), function (btn) {
      btn.addEventListener('click', function () {
        S.markKind = btn.getAttribute('data-kind');
        Array.prototype.forEach.call(document.querySelectorAll('#kinds .kd'), function (o) {
          o.setAttribute('aria-pressed', o === btn ? 'true' : 'false');
        });
        setTool('mark');
      });
    });

    $('flipbtn').addEventListener('click', function () {
      var m = curMap();
      if (!m) { toast('Pick a map first'); return; }
      if (!canEdit()) { denyEdit(); return; }
      var r = (rotOf(m) + 1) % 4;
      S.rots[m.id] = r;
      delete S.flips[m.id];               // the turn supersedes the old flip
      fitView();                          // a sideways map needs refitting
      render();
      saveMeta();
      if (S.room) publishRoomState();     // everyone turns the board together
      toast(r === 0 ? 'Map back to normal' : 'Map turned ' + (r * 90) + '°');
    });

    $('wipe').addEventListener('click', function () {
      if (!canEdit()) { denyEdit(); return; }
      var b = curBoard();
      if (!b) return;
      if (sameAsBase(b)) { toast('Already on the saved setup'); return; }
      var base = baseOf(b);
      var hadTv = topTv(b.tokens);        // beat whatever is on the board now
      snapshot();
      var dropped = [];
      ['arrows', 'marks', 'labels'].forEach(function (k) {
        b[k].forEach(function (o) { dropped.push(o.id); });
      });
      if (b.base) {
        var keep = {};
        base.tokens.forEach(function (t) { keep[t.id] = 1; });
        b.tokens.forEach(function (t) { if (!keep[t.id]) dropped.push(t.id); });
      }
      b.arrows = clone(base.arrows);
      b.marks = clone(base.marks);
      b.labels = clone(base.labels);
      if (b.base) {
        b.tokens = clone(base.tokens);          // exactly the setup you saved
      } else {
        b.tokens.forEach(function (t, k) {      // never saved: starting line
          var o = base.tokens[k];
          if (o) { t.x = o.x; t.y = o.y; }
        });
      }
      forget(b, dropped);
      claimTokens(b.tokens, hadTv);
      revive(b);
      render(); saveBoard();
      toast((b.base ? 'Back to the saved setup' : 'Board reset') + ' — undo is top right');
    });

    $('savebase').addEventListener('click', function () {
      if (!canEdit()) { denyEdit(); return; }
      var b = curBoard();
      if (!b) { toast('Pick a map first'); return; }
      b.base = {
        tokens: b.tokens.map(function (t) {
          return { id: t.id, n: t.n, team: t.team, x: t.x, y: t.y };
        }),
        arrows: clone(b.arrows), marks: clone(b.marks), labels: clone(b.labels)
      };
      saveBoard();
      toast('Saved "' + b.name + '" — ✕ comes back here');
    });

    $('mapsel').addEventListener('change', function () {
      if (!this.value) return;
      if (!canEdit()) { denyEdit(); fillSelects(); return; }
      var m = null;
      S.maps.forEach(function (x) { if (x.id === this.value) m = x; }, this);
      S.undo.length = 0; S.redo.length = 0; S.objUrl = null;

      if (S.room && m) {
        /* In a room, changing the map takes the whole team with you. */
        useMapForRoom(m);
        fitView(); refresh(); syncUndoButtons();
        S.roomMapName = m.name;
        S.mapSent = false;
        publishRoomState();   // announce map and setups first
        sendNow();
        publishMap();
        toast('Everyone moved to ' + m.name);
        return;
      }

      saveMeta();                      // remember where we are leaving
      S.mapId = this.value;
      S.boardId = pickBoardFor(S.mapId).id;
      fitView(); refresh(); syncUndoButtons();
    });
    $('boardsel').addEventListener('change', function () {
      if (!this.value) return;
      if (!canEdit()) { denyEdit(); fillSelects(); return; }
      S.boardId = this.value;
      S.undo.length = 0; S.redo.length = 0;
      refresh(); syncUndoButtons();
      if (S.room) { publishRoomState(); toast('Everyone moved to this setup'); }
    });

    $('setupsel').addEventListener('change', function () {
      if (!this.value) return;
      if (!canEdit()) { denyEdit(); fillSelects(); return; }
      S.boardId = this.value;
      S.undo.length = 0; S.redo.length = 0;
      refresh(); syncUndoButtons();
      if (S.room) { publishRoomState(); toast('Everyone moved to this setup'); }
    });

    $('menubtn').addEventListener('click', function () {
      renderMapList(); renderMembers(); renderDiag(); openSheet('menu');
    });
    $('refreshdiag').addEventListener('click', function () { renderDiag(); toast('Refreshed'); });
    $('copydiag').addEventListener('click', function () {
      var txt = diagLines().concat(S.notices.length ? ['', 'relay messages:'].concat(S.notices) : []).join('\n');
      if (navigator.clipboard) {
        navigator.clipboard.writeText(txt).then(function () { toast('Report copied'); },
          function () { ask({ title: 'Report', body: txt, okText: 'Done' }); });
      } else {
        ask({ title: 'Report', body: txt, okText: 'Done' });
      }
    });
    $('closemenu').addEventListener('click', function () { closeSheet('menu'); });
    $('livebtn').addEventListener('click', function () {
      renderMapList(); renderMembers(); openSheet('menu');
      setTimeout(function () { $('roomcode').scrollIntoView({ block: 'center' }); }, 60);
    });
    var closers = document.querySelectorAll('[data-close]');
    for (var c = 0; c < closers.length; c++) {
      closers[c].addEventListener('click', function () {
        var sh = this.closest('.sheet');
        if (sh.id === 'modal') done('cancel'); else sh.classList.remove('open');
      });
    }
    $('mok').addEventListener('click', function () { done('ok'); });
    $('mcancel').addEventListener('click', function () { done('cancel'); });
    $('minput').addEventListener('keydown', function (e) { if (e.key === 'Enter') done('ok'); });
    var mback = document.querySelector('#modal .back');
    if (mback) mback.addEventListener('pointerdown', function (e) { e.preventDefault(); });

    $('blankadd').addEventListener('change', function () { handleMapFiles(this.files); this.value = ''; });
    $('restore').addEventListener('change', function () {
      if (this.files[0]) importPack(this.files[0]);
      this.value = '';
    });
    $('backup').addEventListener('click', exportPack);

    $('addblue').addEventListener('click', function () {
      if (!canEdit()) { denyEdit(); toast('Only the host can change things'); return; } addToken('b'); });
    $('addred').addEventListener('click', function () {
      if (!canEdit()) { denyEdit(); toast('Only the host can change things'); return; } addToken('r'); });
    $('clearmarks').addEventListener('click', function () {
      if (!canEdit()) { denyEdit(); toast('Only the host can change things'); return; }
      var b = curBoard(); if (!b) return;
      snapshot();
      b.arrows = []; b.marks = []; b.labels = [];
      render(); saveBoard(); toast('Drawing cleared');
    });
    $('resetpos').addEventListener('click', function () {
      if (!canEdit()) { denyEdit(); toast('Only the host can change things'); return; }
      var b = curBoard(); if (!b) return;
      snapshot();
      var h = mapH();
      b.tokens.forEach(function (t, i) {
        t.x = MAPW * (0.3 + (i % 5) * 0.1);
        t.y = h * (t.team === 'b' ? 0.84 : 0.16) + (Math.floor(i / 5) * h * 0.06);
      });
      render(); saveBoard(); toast('Players reset');
    });

    $('newboard').addEventListener('click', function () {
      if (!canEdit()) { denyEdit(); toast('Only the host can change things'); return; }
      if (!S.mapId) { toast('Add a map first'); return; }
      ask({ title: 'New setup', field: true, placeholder: 'A site default', maxLength: 28, okText: 'Create' })
        .then(function (r) {
          if (r.action !== 'ok') return;
          var nb2 = newBoard(S.mapId, r.value || null);
          S.boardId = nb2.id;
          S.undo.length = 0; S.redo.length = 0;
          refresh(); syncUndoButtons();
          if (S.room) { publishRoomState(); publishBoard(nb2); subBoards(); }
        });
    });
    $('dupboard').addEventListener('click', function () {
      if (!canEdit()) { denyEdit(); toast('Only the host can change things'); return; }
      var b = curBoard(); if (!b) return;
      var copy = JSON.parse(JSON.stringify({
        tokens: b.tokens, arrows: b.arrows, marks: b.marks, labels: b.labels
      }));
      var nb = {
        id: uid(), mapId: b.mapId, name: (b.name + ' copy').slice(0, 30),
        tokens: copy.tokens, arrows: copy.arrows, marks: copy.marks, labels: copy.labels,
        updated: Date.now()
      };
      nb.room = S.room || '';
      S.boards.push(nb); dbPut('boards', nb);
      S.boardId = nb.id;
      refresh(); toast('Duplicated');
      if (S.room) { publishRoomState(); publishBoard(nb); subBoards(); }
    });
    $('renboard').addEventListener('click', function () {
      if (!canEdit()) { denyEdit(); toast('Only the host can change things'); return; }
      var b = curBoard(); if (!b) return;
      ask({ title: 'Setup name', field: true, value: b.name, maxLength: 28, okText: 'Save' })
        .then(function (r) {
          if (r.action !== 'ok' || !r.value) return;
          b.name = r.value; dbPut('boards', b); refresh();
          if (S.room) publishRoomState();
        });
    });
    $('delboard').addEventListener('click', function () {
      if (!canEdit()) { denyEdit(); toast('Only the host can change things'); return; }
      var b = curBoard(); if (!b) return;
      confirmBox('Delete ' + b.name + '?', 'This cannot be undone.').then(function (ok) {
        if (!ok) return;
        dbDel('boards', b.id);
        S.boards = S.boards.filter(function (x) { return x.id !== b.id; });
        var bl = boardsOf(S.mapId);
        S.boardId = (bl.length ? bl[0] : newBoard(S.mapId, 'Default')).id;
        S.undo.length = 0; S.redo.length = 0;
        refresh(); renderMapList(); syncUndoButtons();
        if (S.room) publishRoomState();
      });
    });

    $('nick').addEventListener('change', function () {
      S.nick = this.value.trim().slice(0, 14);
      saveMeta(); renderMembers();
      if (S.pool) sendBeat();
    });
    $('joinroom').addEventListener('click', function () { joinRoom($('roomcode').value); });
    $('roomcode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { this.blur(); joinRoom(this.value); }
    });
    $('randroom').addEventListener('click', function () {
      var words = ['hill', 'site', 'rush', 'flank', 'smoke', 'push', 'hold', 'spawn', 'rotate', 'anchor'];
      var code = words[Math.floor(Math.random() * words.length)] + '-' +
                 words[Math.floor(Math.random() * words.length)] + '-' +
                 Math.floor(1000 + Math.random() * 9000);
      $('roomcode').value = code;
      joinRoom(code);          // making a room and joining one are the same act
    });
    $('sharroom').addEventListener('click', function () {
      var code = $('roomcode').value.trim();
      if (!code) { toast('No code to share'); return; }
      var url = location.origin + location.pathname + '#room=' + encodeURIComponent(code);
      if (navigator.share) {
        navigator.share({ title: 'Strat Board room', text: 'Room code: ' + code, url: url }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () { toast('Invite link copied'); });
      } else {
        ask({ title: 'Invite link', field: true, value: url, okText: 'Done' });
      }
    });
    $('locktoggle').addEventListener('click', function () {
      if (!isHost()) return;
      S.locked = !S.locked;
      renderLock();
      publishRoomState();
      toast(S.locked ? 'Only you can make changes now' : 'Everyone can make changes');
    });

    $('leaveroom').addEventListener('click', function () { leaveRoom(); });


    $('resetapp').addEventListener('click', function () {
      ask({
        title: 'Reset the app?',
        body: 'This clears everything on this phone — setups, hardpoints and ' +
              'your name — and reinstalls the app fresh. Back up first if you ' +
              'want to keep your setups.',
        okText: 'Reset', cancelText: 'Cancel'
      }).then(function (r) {
        if (r.action !== 'ok') return;
        toast('Resetting…');
        wipeEverything().then(function () {
          setTimeout(function () { location.replace(location.pathname); }, 300);
        });
      });
    });

    /* Escape hatch: wipe the caches and the worker, then reload from the
       network. A phone stuck on an old build has no other way back. */
    $('forceupdate').addEventListener('click', function () {
      toast('Fetching the latest build…');
      var step = Promise.resolve();
      if (window.caches && caches.keys) {
        step = caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return caches.delete(k); }));
        }).catch(function () {});
      }
      step.then(function () {
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
          return navigator.serviceWorker.getRegistrations().then(function (regs) {
            return Promise.all(regs.map(function (r) { return r.unregister(); }));
          }).catch(function () {});
        }
      }).then(function () {
        setTimeout(function () { location.reload(); }, 400);
      });
    });

    $('aboutstore').addEventListener('click', function () {
      if (!navigator.storage || !navigator.storage.estimate) {
        ask({ title: 'Storage', body: S.maps.length + ' maps, ' + S.boards.length + ' setups.', okText: 'Done' });
        return;
      }
      navigator.storage.estimate().then(function (e) {
        var used = (e.usage || 0) / 1048576, quota = (e.quota || 0) / 1048576;
        ask({
          title: 'Storage',
          body: S.maps.length + ' maps, ' + S.boards.length + ' setups — ' +
                used.toFixed(1) + ' MB used of about ' + Math.round(quota) + ' MB available.',
          okText: 'Done'
        });
      });
    });

    /* Keep what is on screen steady when the board's box changes — rotation,
       the browser's address bar, anything. Matching the viewBox aspect to the
       element's is what stops the map jumping about. */
    function reflow() {
      var st = $('stage');
      if (!st.clientWidth || !st.clientHeight) return;
      fitView();
      render();
    }
    window.addEventListener('resize', reflow);
    /* A quarter turn is not a resize to be preserved — refit instead, or the
       map ends up taller than the screen. */
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { fitView(); render(); }, 280);
    });
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { reflow(); });
      ro.observe($('stage'));
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !S.pool) return;
      ptrs = {};                 // any gesture is long over by now
      gest = null;
      sendBeat();
      prune();
      resync();
      if (S.room && Date.now() - S.lastRx > 45000) reopen();
    });
  }

  function addToken(team) {
    var b = curBoard();
    if (!b) { toast('Add a map first'); return; }
    snapshot();
    var c = onMap({ x: S.view.x + S.view.w / 2, y: S.view.y + S.view.h / 2 });
    var cx = c.x, cy = c.y;
    var n = team === 'b' ? 'P' + (b.tokens.filter(function (t) { return t.team === 'b'; }).length + 1)
                         : 'E' + (b.tokens.filter(function (t) { return t.team === 'r'; }).length + 1);
    b.tokens.push({ id: uid(), n: n, x: cx, y: cy, team: team });
    render(); saveBoard();
    toast(team === 'b' ? 'Player added' : 'Enemy added');
  }

  /* ---------- install prompt ---------- */
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
  });
  function wireInstall() {
    $('installbtn').addEventListener('click', function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice && deferredPrompt.userChoice.then(function () { deferredPrompt = null; });
        return;
      }
      var iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      ask({
        title: 'Install',
        body: iOS
          ? 'In Safari, tap the share button, then "Add to Home Screen". It has to be Safari — other iOS browsers cannot install it.'
          : 'In Chrome, open the browser menu and choose "Add to home screen" or "Install app".',
        okText: 'Got it'
      });
    });
  }

    /* The big hammer: everything a browser's "clear site data" would remove,
     so a stuck phone can be fixed without explaining browser settings. */
  function wipeEverything() {
    function guard(p, ms) {
      return Promise.race([
        p.catch(function () {}),
        new Promise(function (res) { setTimeout(res, ms || 3000); })
      ]);
    }
    var jobs = [];

    if (window.caches && caches.keys) {
      jobs.push(guard(caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      })));
    }
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      jobs.push(guard(navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister(); }));
      })));
    }
    try { localStorage.clear(); } catch (e) {}
    try { sessionStorage.clear(); } catch (e) {}

    /* The database will not drop while this page still holds it open, and
       deleteDatabase simply blocks rather than failing, so close first and
       never wait on it indefinitely. */
    jobs.push(guard(new Promise(function (res) {
      try { if (DB) { DB.close(); DB = null; } } catch (e) {}
      var rq;
      try { rq = indexedDB.deleteDatabase('stratboard'); } catch (e) { res(); return; }
      rq.onsuccess = function () { res(); };
      rq.onerror = function () { res(); };
      rq.onblocked = function () { res(); };
    }), 4000));

    return Promise.all(jobs);
  }


  /* ---------- entry screen ---------- */
  function showStart() { $('start').classList.add('open'); }
  function hideStart() {
    $('start').classList.remove('open');
    dbPut('meta', { k: 'seenstart', v: 1 }).catch(function () {});
  }

  function wireStart() {
    $('startcreate').addEventListener('click', function () {
      var words = ['hill', 'site', 'rush', 'flank', 'smoke', 'push', 'hold', 'spawn', 'rotate', 'anchor'];
      var code = words[Math.floor(Math.random() * words.length)] + '-' +
                 words[Math.floor(Math.random() * words.length)] + '-' +
                 Math.floor(1000 + Math.random() * 9000);
      hideStart();
      joinRoom(code);
      setTimeout(function () {
        ask({
          title: 'Room created', body: 'Your code is "' + code + '". Send it to your team.',
          okText: 'Share', cancelText: 'Done'
        }).then(function (r) { if (r.action === 'ok') $('sharroom').click(); });
      }, 700);
    });
    $('startjoin').addEventListener('click', function () {
      $('startjoinrow').style.display = 'flex';
      $('startcode').focus();
    });
    function go() {
      var code = $('startcode').value.trim();
      if (!code) { toast('Enter the code your mate sent'); return; }
      hideStart();
      joinRoom(code);
    }
    $('startgo').addEventListener('click', go);
    $('startcode').addEventListener('keydown', function (e) { if (e.key === 'Enter') { this.blur(); go(); } });
    $('startsolo').addEventListener('click', function () {
      hideStart();
      toast('You can start a room any time from the menu');
    });
  }

  /* ---------- boot ---------- */
  function boot() {
    /* Runs before anything touches storage, so this still works when the app
       is too broken to start — the link is the fix you can send someone. */
    if (/[?&]reset=1/.test(location.search)) {
      document.body.innerHTML =
        '<div style="display:flex;height:100vh;align-items:center;justify-content:center;' +
        'font:16px -apple-system,Roboto,sans-serif;color:#99a1b0;padding:24px;text-align:center">' +
        'Resetting Strat Board…</div>';
      wipeEverything().then(function () {
        setTimeout(function () { location.replace(location.pathname); }, 400);
      });
      return;
    }

    ensureMarkers();
    wire();
    wireInstall();
    wireStart();

    openDb().then(function () {
      return Promise.all([dbAll('maps'), dbAll('boards'), dbGet('meta', 'settings'),
                          loadBundled(), dbAll('hills'), loadHillNames(),
                          dbGet('meta', 'seenstart')]);
    }).then(function (res) {
      (res[4] || []).forEach(function (row) { S.hills[row.k] = row.pts || []; });
      S.maps = res[0].sort(function (a, b) { return a.created - b.created; });
      S.boards = res[1];
      S.boards.forEach(function (b) {
        if (dedupeTokens(b)) dbPut('boards', b);   // tidy a doubled-up team
      });
      var bundled = res[3] || [];

      /* Clear up duplicate maps left by the transfer race: same name, same
         image. Keep the oldest and move its setups across. */
      var seen = {}, dupes = [];
      S.maps.forEach(function (m) {
        var key = m.name + '|' + (m.buf ? m.buf.byteLength : 0);
        if (seen[key]) dupes.push({ dupe: m, keep: seen[key] });
        else seen[key] = m;
      });
      dupes.forEach(function (d) {
        S.boards.forEach(function (b) {
          if (b.mapId !== d.dupe.id) return;
          var clash = S.boards.some(function (o) {
            return o.mapId === d.keep.id && o.name === b.name;
          });
          if (clash) { dbDel('boards', b.id); b._drop = true; return; }
          b.mapId = d.keep.id;
          dbPut('boards', b);
        });
        dbDel('maps', d.dupe.id);
        S.maps = S.maps.filter(function (x) { return x.id !== d.dupe.id; });
      });
      S.boards = S.boards.filter(function (b) { return !b._drop; });

      S.maps.forEach(attachUrl);
      /* Built-in maps first, and a user copy of the same name gives way. */
      var builtNames = {};
      bundled.forEach(function (m) { builtNames[m.name] = true; });
      S.maps = bundled.concat(S.maps.filter(function (m) {
        if (!builtNames[m.name]) return true;
        if (m._url) { try { URL.revokeObjectURL(m._url); } catch (e) {} }
        S.boards.forEach(function (b) {
          if (b.mapId === m.id) { b.mapId = 'built-in:' + m.name.toLowerCase() + '.jpg'; }
        });
        dbDel('maps', m.id);
        return false;
      }));
      /* Repoint any board whose remapped id does not exist to the right one. */
      var byId = {};
      S.maps.forEach(function (m) { byId[m.id] = true; });
      bundled.forEach(function (bm) {
        S.boards.forEach(function (b) {
          if (!byId[b.mapId] && b.mapId.indexOf('built-in:') === 0 &&
              b.mapId.toLowerCase().indexOf(bm.name.toLowerCase()) >= 0) {
            b.mapId = bm.id;
            dbPut('boards', b);
          }
        });
      });

      var st = res[2];
      var dropped = [];
      if (st) {
        S.nick = st.nick || '';
        S.relays = (st.relays && st.relays.length) ? st.relays : DEFAULT_RELAYS.slice();
        /* Drop relays that refuse writes, and top the list back up. */
        S.relays = S.relays.filter(function (u) {
          var bad = BAD_RELAYS.some(function (b) { return u.indexOf(b) >= 0; });
          if (bad) dropped.push(u.replace(/^wss?:\/\//, ''));
          return !bad;
        });
        /* Only top the list up when we removed something — never second-guess
           a list the user set deliberately. */
        if (dropped.length && S.relays.length < 3) {
          DEFAULT_RELAYS.forEach(function (u) {
            if (S.relays.indexOf(u) < 0) S.relays.push(u);
          });
        }
        if (!S.relays.length) S.relays = DEFAULT_RELAYS.slice();
        S.colour = st.colour || S.colour;
        if (st.showHills === false) S.showHills = false;
        if (st.flips) S.flips = st.flips;
        if (st.rots) S.rots = st.rots;
        if (st.hidden) S.hidden = st.hidden;
        if (st.lastSetup) S.lastSetup = st.lastSetup;
        S.clientId = st.clientId || S.clientId;
        if (st.mapId && S.maps.some(function (m) { return m.id === st.mapId; })) S.mapId = st.mapId;
        if (st.boardId && S.boards.some(function (b) { return b.id === st.boardId; })) S.boardId = st.boardId;
      }
      try {
        var over = localStorage.getItem('sb-test-relay');   // used by the test harness
        if (over) S.relays = over.split(/[\s,]+/).filter(Boolean);
      } catch (e) {}

      if (!S.mapId && S.maps.length) S.mapId = S.maps[0].id;
      if (S.mapId) {
        var bl = boardsOf(S.mapId);
        if (!S.boardId || !bl.some(function (b) { return b.id === S.boardId; })) {
          S.boardId = pickBoardFor(S.mapId).id;
        }
      }

      $('nick').value = S.nick;
      $('menusub').textContent = 'Version ' + VERSION + ' · everything saves on this phone.';
      renderDiag();
      if (S.bundledFailed && navigator.onLine !== false) {
        setTimeout(function () {
          banner('Built-in maps did not load — try Force update in the menu.');
        }, 1200);
      }
      if (dropped.length) {
        saveMeta();
        setTimeout(function () {
          toast('Dropped ' + dropped.join(', ') + ' — they refuse writes');
        }, 1400);
      }
      var sws = document.querySelectorAll('.sw');
      for (var i = 0; i < sws.length; i++) {
        sws[i].setAttribute('aria-pressed', sws[i].getAttribute('data-col') === S.colour ? 'true' : 'false');
      }

      fitView();
      fillSelects();
      render();
      renderMapList();
      renderMembers();
      syncUndoButtons();
      setTool('move');

      /* First run with no room to rejoin: ask how they want to start. */
      if (!res[6] && !(st && st.room) && !/#room=/.test(location.hash)) showStart();

      var m = /#room=([^&]+)/.exec(location.hash);
      if (m) {
        var code = decodeURIComponent(m[1]);
        history.replaceState(null, '', location.pathname);
        $('roomcode').value = code;
        ask({
          title: 'Join room?',
          body: 'Room code "' + code + '". Your board will sync with whoever else is in it.',
          okText: 'Join'
        }).then(function (r) { if (r.action === 'ok') joinRoom(code); });
      } else if (st && st.room) {
        /* Rejoin the room the app was last in. Without this a reload drops you
           out silently while the code still sits in the box. */
        $('roomcode').value = st.room;
        setTimeout(function () { joinRoom(st.room, true); }, 350);
      }
    }).catch(function (err) {
      /* If the database will not open, nothing else will work either — point
         at the one button that fixes it rather than failing silently. */
      banner('Storage problem. Open the menu and tap "Reset the app".', 20000);
      toast('Storage unavailable — nothing will save');
      fitView(); render();
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }

    setInterval(function () {
      if (!S.pendingRemote) return;
      /* Updates are held while a finger is down so the board is not yanked
         mid-drag. A missed pointerup used to leave that hold on for good,
         freezing the board on whatever it last showed — so the real test is
         whether anything is actually touching the screen. */
      var touching = Object.keys(ptrs).length > 0;
      if (touching && gest &&
          (gest.type === 'drag' || gest.type === 'draw' || gest.type === 'draglabel')) return;
      if (!touching) gest = null;
      applyBoard(S.pendingRemote);
      S.pendingRemote = null;
    }, 400);
  }

  /* Small read-only hook so a problem can be inspected from the console. */
  window.__sbRender = function () { render(); };
  window.__sbBoardRef = function () { return curBoard(); };
  window.__sbUndoLen = function () { return S.undo.length + '/' + S.redo.length; };
  window.__stratboard = function () {
    return {
      version: VERSION, room: S.room, maps: S.maps.length,
      mapList: S.maps.map(function (m) {
        return { name: m.name, bytes: m.buf ? m.buf.byteLength : 0, px: m.pxw + 'x' + m.pxh, rxid: m.rxid || null };
      }),
      mapId: S.mapId, boardId: S.boardId,
      v: (function () { var c = null; S.boards.forEach(function (x) { if (x.id === S.boardId) c = x; }); return c ? c.v : null; })(),
      gone: (function () { var c = null; S.boards.forEach(function (x) { if (x.id === S.boardId) c = x; }); return c ? (c.gone || []).length : null; })(),
      rxMeta: S.mapRx.meta, rxParts: Object.keys(S.mapRx.chunks).length,
      pendingState: !!S.pendingState,
      subs: S.pool ? Object.keys(S.pool.subs) : [],
      relays: S.pool ? S.pool.report() : []
    };
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
