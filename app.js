/* Strat Board — offline-first strat planner with optional live rooms over Nostr. */
(function () {
  'use strict';

  var VERSION = '3.0';
  /* Write-friendly public relays. relay.nostr.band is a search aggregator and
     nostr.wine is paid, so neither accepts writes from a fresh key. */
  var DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://nostr.mom',
    'wss://offchain.pub'
  ];
  /* Known not to take writes from a fresh key: paid, or search-only. */
  var BAD_RELAYS = ['nostr.wine', 'relay.nostr.band', 'filter.nostr.wine', 'purplepag.es'];
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
    if (opts.field) setTimeout(function () { input.focus(); input.select(); }, 60);
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
    wantTimer: null,
    rxTimer: null,
    notices: [],
    hills: {},
    hillNames: {},
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
  function boardsOf(mapId) {
    return S.boards.filter(function (b) { return b.mapId === mapId; });
  }
  function mapH() { var m = curMap(); return m ? m.h : MAPW; }

  function newBoard(mapId, name) {
    var h = MAPW, m = null, i;
    for (i = 0; i < S.maps.length; i++) if (S.maps[i].id === mapId) m = S.maps[i];
    if (m) h = m.h;
    var cy = h * 0.82, names = ['AR', 'Sub', 'Flex', 'Anch'];
    var b = {
      id: uid(), mapId: mapId, name: name || ('Setup ' + (boardsOf(mapId).length + 1)),
      tokens: names.map(function (n, k) {
        return { id: uid(), n: n, x: MAPW * (0.32 + k * 0.12), y: cy, team: 'b' };
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
    b.updated = Date.now();
    dbPut('boards', b);
    if (broadcast !== false) queueSend();
  }
  function saveMeta() {
    dbPut('meta', {
      k: 'settings', mapId: S.mapId, boardId: S.boardId, nick: S.nick, showHills: S.showHills,
      room: S.room, relays: S.relays, colour: S.colour, clientId: S.clientId
    });
  }

  /* ---------- undo ---------- */
  function snapshot() {
    var b = curBoard();
    if (!b) return;
    S.undo.push(JSON.stringify({ tokens: b.tokens, arrows: b.arrows, marks: b.marks, labels: b.labels }));
    if (S.undo.length > 40) S.undo.shift();
    S.redo.length = 0;
    syncUndoButtons();
  }
  function applySnap(json) {
    var b = curBoard(), s = JSON.parse(json);
    b.tokens = s.tokens; b.arrows = s.arrows; b.marks = s.marks; b.labels = s.labels;
  }
  function doUndo() {
    var b = curBoard();
    if (!b || !S.undo.length) return;
    S.redo.push(JSON.stringify({ tokens: b.tokens, arrows: b.arrows, marks: b.marks, labels: b.labels }));
    applySnap(S.undo.pop());
    render(); saveBoard(); syncUndoButtons();
  }
  function doRedo() {
    var b = curBoard();
    if (!b || !S.redo.length) return;
    S.undo.push(JSON.stringify({ tokens: b.tokens, arrows: b.arrows, marks: b.marks, labels: b.labels }));
    applySnap(S.redo.pop());
    render(); saveBoard(); syncUndoButtons();
  }
  function syncUndoButtons() {
    $('undo').disabled = !S.undo.length;
    $('redo').disabled = !S.redo.length;
  }

  /* ---------- rendering ---------- */
  var COLOURS = ['#f5b708', '#e9ebef', '#3b82f6', '#ef4444', '#22c55e'];

  function ensureMarkers() {
    var defs = $('defs');
    if (defs.childNodes.length) return;
    COLOURS.forEach(function (c, i) {
      var m = svgEl('marker', {
        id: 'ah' + i, viewBox: '0 0 10 10', refX: '7.6', refY: '5',
        markerWidth: '4.2', markerHeight: '4.2', orient: 'auto-start-reverse'
      });
      m.appendChild(svgEl('path', { d: 'M0,0.6 L10,5 L0,9.4 z', fill: c }));
      defs.appendChild(m);
    });
  }
  function markerFor(c) {
    var i = COLOURS.indexOf(c);
    return 'url(#ah' + (i < 0 ? 0 : i) + ')';
  }

  /* Keep the centre of the viewport over the map, so it can never be panned
     off into empty space with nothing to pinch back to. */
  function clampView(v) {
    var h = mapH();
    v.x = clamp(v.x, -v.w / 2, MAPW - v.w / 2);
    v.y = clamp(v.y, -v.h / 2, h - v.h / 2);
    return v;
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
    var mapAR = MAPW / h, stAR = sw / sh, w, hh;
    if (mapAR > stAR) { w = MAPW * pad; hh = w / stAR; }
    else { hh = h * pad; w = hh * stAR; }
    setView({ x: (MAPW - w) / 2, y: (h - hh) / 2, w: w, h: hh });
  }

  function toSvg(cx, cy) {
    var m = $('board').getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    return { x: (cx - m.e) / m.a, y: (cy - m.f) / m.d };
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

    ['gArrows', 'gMarks', 'gLabels', 'gTokens'].forEach(function (g) { $(g).textContent = ''; });
    renderHills();
    if (!b) return;

    var sw = strokeW();

    b.arrows.forEach(function (a) {
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
    });

    b.marks.forEach(function (k) {
      var r = sw * 1.9, g = svgEl('g', { 'data-kind': 'mark', 'data-id': k.id });
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

  function renderHills() {
    var g = $('gHills');
    if (!g) return;
    g.textContent = '';
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
    $('hillsbtn').setAttribute('aria-pressed', S.showHills ? 'true' : 'false');
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
    /* In a live room the setup is decided for you, so the picker just adds
       noise to the bar — the live indicator takes its place instead. */
    var inRoom = !!S.room;
    bs.style.display = inRoom ? 'none' : '';
    $('livebtn').style.flex = inRoom ? '1' : '';
    ms.textContent = '';
    if (!S.maps.length) {
      ms.appendChild(new Option('No maps', ''));
    } else {
      S.maps.forEach(function (m) {
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
    render();
    saveMeta();
    if (broadcast) queueSend();
  }

  /* ---------- gestures ---------- */
  var ptrs = {};
  var gest = null;   // {type:'pan'|'drag'|'draw'|'pinch', ...}

  function stageDown(e) {
    var m = curMap();
    if (!m) return;
    /* The floating controls sit inside the board, so their taps bubble here.
       Without this, pressing Undo with the Mark tool active dropped a mark. */
    if (e.target.closest && e.target.closest('#float, #banner, #blank, #swatch')) return;
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    var n = Object.keys(ptrs).length;

    if (n === 2) {
      if (gest && gest.type === 'draw' && gest.arrow) {
        // two fingers mid-draw: abandon the stroke, treat as zoom
        var b = curBoard();
        var idx = b.arrows.indexOf(gest.arrow);
        if (idx >= 0) b.arrows.splice(idx, 1);
        S.undo.pop();
        syncUndoButtons();
        render();
      }
      var ids = Object.keys(ptrs);
      var a = ptrs[ids[0]], c = ptrs[ids[1]];
      gest = {
        type: 'pinch',
        d0: Math.hypot(a.x - c.x, a.y - c.y) || 1,
        mid0: toSvg((a.x + c.x) / 2, (a.y + c.y) / 2),
        view0: { x: S.view.x, y: S.view.y, w: S.view.w, h: S.view.h }
      };
      return;
    }
    if (n !== 1) return;

    var p = onMap(toSvg(e.clientX, e.clientY));
    var hitEl = e.target.closest ? e.target.closest('[data-kind]') : null;

    if (S.hillEdit) {
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
      if (hitEl && hitEl.getAttribute('data-kind') === 'token') {
        var id = hitEl.getAttribute('data-id');
        snapshot();
        gest = { type: 'drag', id: id, moved: false, start: p };
        try { $('stage').setPointerCapture(e.pointerId); } catch (err) {}
      } else if (hitEl && hitEl.getAttribute('data-kind') === 'label') {
        snapshot();
        gest = { type: 'draglabel', id: hitEl.getAttribute('data-id'), moved: false };
      } else {
        gest = {
          type: 'pan', c0: { x: e.clientX, y: e.clientY },
          view0: { x: S.view.x, y: S.view.y, w: S.view.w, h: S.view.h },
          at: p, moved: false
        };
        clearTimeout(S.holdTimer);
        S.holdTimer = setTimeout(function () {
          if (gest && gest.type === 'pan' && !gest.moved) {
            gest = { type: 'none' };
            sendPing(p);
          }
        }, 480);
      }
      return;
    }

    if (S.tool === 'arrow') {
      snapshot();
      var ar = { id: uid(), c: S.colour, pts: [[p.x, p.y]] };
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
      curBoard().marks.push({ id: uid(), x: p.x, y: p.y, c: S.colour });
      render(); saveBoard();
      gest = { type: 'none' };
      return;
    }

    if (S.tool === 'text') {
      gest = { type: 'none' };
      ask({ title: 'Label', field: true, placeholder: 'Flash here', maxLength: 22, okText: 'Place' })
        .then(function (r) {
          if (r.action !== 'ok' || !r.value) return;
          snapshot();
          curBoard().labels.push({ id: uid(), x: p.x, y: p.y, t: r.value, c: S.colour });
          render(); saveBoard();
        });
    }
  }

  function stageMove(e) {
    if (!ptrs[e.pointerId]) return;
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (!gest) return;

    if (gest.type === 'pinch') {
      var ids = Object.keys(ptrs);
      if (ids.length < 2) return;
      var a = ptrs[ids[0]], c = ptrs[ids[1]];
      var d = Math.hypot(a.x - c.x, a.y - c.y) || 1;
      var scale = gest.d0 / d;
      var h = mapH();
      var w = clamp(gest.view0.w * scale, 110, MAPW * 2.2);
      var hh = w * (gest.view0.h / gest.view0.w);
      var st = $('stage');
      var mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
      var r = st.getBoundingClientRect();
      var fx = (mid.x - r.left) / r.width, fy = (mid.y - r.top) / r.height;
      setView({ x: gest.mid0.x - w * fx, y: gest.mid0.y - hh * fy, w: w, h: hh });
      render();
      return;
    }

    if (gest.type === 'pan') {
      var m2 = $('board').getScreenCTM();
      if (!m2) return;
      var dx = (e.clientX - gest.c0.x) / m2.a, dy = (e.clientY - gest.c0.y) / m2.d;
      if (!gest.moved && Math.abs(e.clientX - gest.c0.x) + Math.abs(e.clientY - gest.c0.y) > 8) {
        gest.moved = true;
        clearTimeout(S.holdTimer);
      }
      setView({ x: gest.view0.x - dx, y: gest.view0.y - dy, w: gest.view0.w, h: gest.view0.h });
      return;
    }

    var p = onMap(toSvg(e.clientX, e.clientY));

    if (gest.type === 'drag') {
      var b = curBoard(), t = null;
      b.tokens.forEach(function (x) { if (x.id === gest.id) t = x; });
      if (!t) return;
      t.x = p.x; t.y = p.y;
      gest.moved = true;
      render();
      liveSend();
      return;
    }
    if (gest.type === 'draglabel') {
      var bb = curBoard(), l = null;
      bb.labels.forEach(function (x) { if (x.id === gest.id) l = x; });
      if (!l) return;
      l.x = p.x; l.y = p.y;
      gest.moved = true;
      render();
      liveSend();
      return;
    }
    if (gest.type === 'draw' && gest.arrow) {
      var pts = gest.arrow.pts, last = pts[pts.length - 1];
      var minStep = S.view.w / 70;
      if (Math.abs(last[0] - p.x) + Math.abs(last[1] - p.y) > minStep) {
        pts.push([p.x, p.y]);
        if (pts.length > 400) pts.shift();
        render();
      }
    }
  }

  function stageUp(e) {
    clearTimeout(S.holdTimer);
    delete ptrs[e.pointerId];
    var remaining = Object.keys(ptrs).length;
    if (!gest) return;

    if (gest.type === 'pinch') {
      if (remaining === 0) gest = null;
      else gest = { type: 'none' };
      return;
    }
    if (remaining > 0) return;

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

  function removeById(kind, id) {
    var b = curBoard();
    var key = kind === 'arrow' ? 'arrows' : kind === 'mark' ? 'marks'
      : kind === 'label' ? 'labels' : 'tokens';
    b[key] = b[key].filter(function (o) { return o.id !== id; });
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
        sendNow();          // announce the map first, so peers accept what follows
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
      if (m.bundled) {
        var tag = document.createElement('span');
        tag.className = 'pill';
        tag.textContent = 'built in';
        row.appendChild(nm); row.appendChild(mt); row.appendChild(tag);
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
      row.appendChild(nm); row.appendChild(mt); row.appendChild(ren); row.appendChild(del);
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
    var own = S.maps.filter(function (m) { return !m.bundled; });
    if (!own.length && !S.boards.length) { toast('Nothing to share yet'); return; }
    var pack = {
      app: 'stratboard', v: 1, made: new Date().toISOString(),
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
          map: mn, name: b.name, tokens: b.tokens, arrows: b.arrows,
          marks: b.marks, labels: b.labels
        };
      })
    };
    var blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
    var fname = 'stratboard-pack.json';
    var file = null;
    try { file = new File([blob], fname, { type: 'application/json' }); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Strat Board pack' }).catch(function () {});
      return;
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
    toast('Pack saved to your files');
  }

  function importPack(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var pack;
      try { pack = JSON.parse(fr.result); } catch (e) { toast('That is not a pack file'); return; }
      if (!pack || pack.app !== 'stratboard' || !pack.maps) { toast('That is not a pack file'); return; }
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
            id: uid(), mapId: m.id, name: pb.name || 'Imported',
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
        toast('Imported ' + added + ' map' + (added === 1 ? '' : 's') + ', ' + bAdded + ' setups');
      });
    };
    fr.onerror = function () { toast('Could not read that file'); };
    fr.readAsText(file);
  }

  /* ---------- live room ---------- */
  function liveBoardName() { return 'Live · ' + S.room; }

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

  function showPing(x, y, name, colour) {
    var g = svgEl('g', {});
    var r0 = clamp(S.view.w / 26, 10, 46);
    var ring = svgEl('circle', {
      cx: x, cy: y, r: r0 * 0.35, fill: 'none',
      stroke: colour, 'stroke-width': r0 / 5
    });
    ring.appendChild(svgEl('animate', {
      attributeName: 'r', from: r0 * 0.35, to: r0 * 1.5, dur: '1.2s',
      repeatCount: '4', fill: 'freeze'
    }));
    ring.appendChild(svgEl('animate', {
      attributeName: 'opacity', from: '1', to: '0', dur: '1.2s',
      repeatCount: '4', fill: 'freeze'
    }));
    var dot = svgEl('circle', { cx: x, cy: y, r: r0 * 0.22, fill: colour });
    /* The marker holds steady while the ring pulses, then fades at the end,
       so it stays readable long enough to talk about. */
    dot.appendChild(svgEl('animate', {
      attributeName: 'opacity', from: '1', to: '0', begin: '4.1s',
      dur: '0.8s', fill: 'freeze'
    }));
    g.appendChild(ring); g.appendChild(dot);
    if (name) {
      var t = svgEl('text', {
        x: x, y: y - r0 * 0.75, 'text-anchor': 'middle',
        'font-size': r0 * 0.62, 'font-weight': '600', fill: colour,
        stroke: '#0a0c10', 'stroke-width': r0 / 9, 'paint-order': 'stroke'
      });
      t.textContent = name;
      t.appendChild(svgEl('animate', {
        attributeName: 'opacity', from: '1', to: '0', begin: '4.1s',
        dur: '0.8s', fill: 'freeze'
      }));
      g.appendChild(t);
    }
    $('gPings').appendChild(g);
    setTimeout(function () { if (g.parentNode) g.parentNode.removeChild(g); }, 5000);
  }

  function sendPing(p) {
    var m = curMap();
    showPing(p.x, p.y, S.nick || 'You', colourFor(S.clientId));
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

  function useMapForRoom(m) {
    S.mapId = m.id;
    S.objUrl = null;
    var live = null;
    boardsOf(m.id).forEach(function (b) { if (b.name === liveBoardName()) live = b; });
    S.boardId = (live || newBoard(m.id, liveBoardName())).id;
    fitView();
    fillSelects();
    render();
    if (S.pendingState) {
      applyRemote(S.pendingState);
      S.pendingState = null;
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

  function roomPayload() {
    var b = curBoard(), m = curMap();
    return JSON.stringify({
      v: 1, by: S.clientId, n: S.nick || 'Player', seq: ++S.seq, map: m ? m.name : '',
      name: b ? b.name : '', tokens: b ? b.tokens : [], arrows: b ? b.arrows : [],
      marks: b ? b.marks : [], labels: b ? b.labels : []
    });
  }

  function isLiveBoard() {
    var b = curBoard();
    return !!(S.room && b && b.name === liveBoardName());
  }

  function queueSend() {
    if (!S.pool || !isLiveBoard()) return;
    if (S.sendTimer) return;
    var wait = Math.max(0, SEND_MS - (Date.now() - S.lastSend));
    S.sendTimer = setTimeout(function () {
      S.sendTimer = null;
      sendNow();
    }, wait);
  }
  function liveSend() { queueSend(); }

  function sendNow() {
    if (!S.pool || !S.roomSk || !isLiveBoard()) return;
    S.lastSend = Date.now();
    var ev = {
      kind: 30078,
      tags: [['d', 'stratboard:' + S.room]],
      content: roomPayload()
    };
    NostrLite.finalize(ev, S.roomSk).then(function (signed) {
      S.pool.publish(signed);
    }).catch(function () {});
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

  function applyRemote(data) {
    var b = curBoard();
    if (!b) return;
    b.tokens = data.tokens || [];
    b.arrows = data.arrows || [];
    b.marks = data.marks || [];
    b.labels = data.labels || [];
    b.updated = Date.now();
    dbPut('boards', b);
    S.undo.length = 0; S.redo.length = 0;
    syncUndoButtons();
    render();
  }

  function onEvent(ev) {
    if (!S.roomPub || ev.pubkey !== S.roomPub) return;

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
      if (d !== roomTag()) return;
    }

    var data;
    try { data = JSON.parse(ev.content); } catch (e) { return; }

    if (ev.kind === 20003) {
      if (!data.c || data.c === S.clientId) return;
      var m = curMap();
      if (data.map && m && data.map !== m.name) return;   // pointing at another map
      S.members[data.c] = { n: data.n || 'Player', t: Date.now() };
      showPing(data.x, data.y, data.n || 'Player', colourFor(data.c));
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

    /* Land the state on the right map. Applying it to whatever happens to be
       open would scribble one team's positions onto another map, and the
       state would then be lost when the correct map arrived. */
    if (data.map) {
      S.roomMapName = data.map;
      /* A transfer we held back can now be judged against the room's map. */
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
        render();
        var who = S.members[data.by] ? S.members[data.by].n : 'Someone';
        banner(who + ' switched to ' + known.name);
        renderMembers();
        return;
      }
    }
    if (!curMap() || !curBoard()) { S.pendingState = data; return; }
    if (!isLiveBoard()) return;

    if (gest && (gest.type === 'drag' || gest.type === 'draw' || gest.type === 'draglabel')) {
      S.pendingRemote = data;     // do not yank the board out from under a finger
      return;
    }
    applyRemote(data);
    var m = curMap();
    if (data.map && m && data.map !== m.name) {
      var known = haveMapNamed(data.map);
      if (known) useMapForRoom(known);
      else if (!S.mapRx.meta) { banner('Room is on map "' + data.map + '" — fetching it…'); askForMap(); }
    }
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
    var n = Object.keys(S.members).length;
    var btn = $('livebtn');
    if (S.room) {
      btn.classList.add('on');
      $('liven').textContent = 'Live · ' + (n + 1);
    } else {
      btn.classList.remove('on');
      $('liven').textContent = 'Solo';
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
             (S.room ? (isLiveBoard() ? ' (live)' : ' (private — not syncing)') : ''));
    if (S.mapRx.meta) {
      out.push('incoming map: ' + Object.keys(S.mapRx.chunks).length + '/' + S.mapRx.meta.n + ' parts');
    }
    if (!S.room) {
      out.push('not in a room — type a code and press Join');
      return out;
    }
    if (!S.pool) { out.push('not connected to any relay'); return out; }
    S.pool.report().forEach(function (r) {
      out.push('• ' + r.url.replace(/^wss?:\/\//, '') + (r.authed ? ' [authed]' : ''));
      out.push('    ' + r.state + ' — sent ' + r.sent + ', accepted ' + r.ok +
               ', rejected ' + r.rejected + ', received ' + r.recv);
      if (r.err) out.push('    says: ' + r.err);
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
    $('roomcode').value = code;

    if (S.mapId) {
      var exists = null;
      boardsOf(S.mapId).forEach(function (b) { if (b.name === liveBoardName()) exists = b; });
      S.boardId = (exists || newBoard(S.mapId, liveBoardName())).id;
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

      S.beat = setInterval(function () { sendBeat(); prune(); }, BEAT_MS);
      setTimeout(sendBeat, 900);

      if (curMap()) {
        setTimeout(function () { sendNow(); publishMap(); }, 1600);
        banner('Live room "' + S.room + '" — this setup syncs. Your other setups do not.');
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
    S.room = ''; S.roomSk = null; S.roomPub = null; S.members = {};
    S.mapSent = false; S.mapRx = { meta: null, chunks: {} }; S.pendingState = null;
    S.roomMapName = ''; S.metaWaiting = null;
    renderMembers();
    saveMeta();
    if (!quiet) { toast('Left the room'); banner(''); }
  }

  /* ---------- wiring ---------- */
  function setTool(t) {
    S.tool = t;
    var btns = document.querySelectorAll('#tools button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-tool') === t ? 'true' : 'false');
    }
    var sw = $('swatch');
    if (t === 'ping') {
      sw.classList.remove('show');
      banner('Tap the map to ping, or hold the map in Move.', 3000);
      return;
    }
    if (t === 'arrow' || t === 'mark' || t === 'text') {
      sw.classList.add('show');
      $('swlab').textContent = t === 'arrow' ? 'Arrow colour' : t === 'mark' ? 'Mark colour' : 'Text colour';
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
    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      var f = e.deltaY > 0 ? 1.12 : 0.89;
      var w = clamp(S.view.w * f, 110, MAPW * 2.2);
      var hh = w * (S.view.h / S.view.w);
      var p = toSvg(e.clientX, e.clientY);
      var r = stage.getBoundingClientRect();
      var fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      setView({ x: p.x - w * fx, y: p.y - hh * fy, w: w, h: hh });
      render();
    }, { passive: false });

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
    $('fit').addEventListener('click', function () { fitView(); render(); });
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
      this.setAttribute('aria-pressed', S.showHills ? 'true' : 'false');
      render(); saveMeta();
      toast(S.showHills ? 'Hardpoints shown' : 'Hardpoints hidden');
    });

    $('edithills').addEventListener('click', function () {
      if (!curMap()) { toast('Pick a map first'); return; }
      closeSheet('menu');
      setHillEdit(true);
    });

    $('wipe').addEventListener('click', function () {
      var b = curBoard();
      if (!b) return;
      if (!b.arrows.length && !b.marks.length && !b.labels.length) {
        toast('Nothing drawn to clear');
        return;
      }
      snapshot();
      b.arrows = []; b.marks = []; b.labels = [];
      render(); saveBoard();
      toast('Drawing cleared — undo is top right');
    });

    $('mapsel').addEventListener('change', function () {
      if (!this.value) return;
      var m = null;
      S.maps.forEach(function (x) { if (x.id === this.value) m = x; }, this);
      S.undo.length = 0; S.redo.length = 0; S.objUrl = null;

      if (S.room && m) {
        /* In a room, changing the map takes the whole team with you. */
        useMapForRoom(m);
        fitView(); refresh(); syncUndoButtons();
        S.roomMapName = m.name;
        S.mapSent = false;
        sendNow();          // announce the map first, so peers accept what follows
        publishMap();
        toast('Everyone moved to ' + m.name);
        return;
      }

      S.mapId = this.value;
      var bl = boardsOf(S.mapId);
      S.boardId = (bl.length ? bl[0] : newBoard(S.mapId, 'Default')).id;
      fitView(); refresh(); syncUndoButtons();
    });
    $('boardsel').addEventListener('change', function () {
      if (!this.value) return;
      S.boardId = this.value;
      S.undo.length = 0; S.redo.length = 0;
      refresh(); syncUndoButtons();
      if (S.room && !isLiveBoard()) banner('This setup is private. Switch to "' + liveBoardName() + '" to sync.');
    });

    $('setupsel').addEventListener('change', function () {
      if (!this.value) return;
      S.boardId = this.value;
      S.undo.length = 0; S.redo.length = 0;
      refresh(); syncUndoButtons();
      if (S.room && !isLiveBoard()) banner('This setup is private — it does not sync.');
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

    $('addmap').addEventListener('change', function () { handleMapFiles(this.files); this.value = ''; });
    $('blankadd').addEventListener('change', function () { handleMapFiles(this.files); this.value = ''; });
    $('importpack').addEventListener('change', function () {
      if (this.files[0]) importPack(this.files[0]);
      this.value = '';
    });
    $('exportpack').addEventListener('click', exportPack);

    $('addblue').addEventListener('click', function () { addToken('b'); });
    $('addred').addEventListener('click', function () { addToken('r'); });
    $('clearmarks').addEventListener('click', function () {
      var b = curBoard(); if (!b) return;
      snapshot();
      b.arrows = []; b.marks = []; b.labels = [];
      render(); saveBoard(); toast('Drawing cleared');
    });
    $('resetpos').addEventListener('click', function () {
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
      if (!S.mapId) { toast('Add a map first'); return; }
      ask({ title: 'New setup', field: true, placeholder: 'A site default', maxLength: 28, okText: 'Create' })
        .then(function (r) {
          if (r.action !== 'ok') return;
          S.boardId = newBoard(S.mapId, r.value || null).id;
          S.undo.length = 0; S.redo.length = 0;
          refresh(); syncUndoButtons();
        });
    });
    $('dupboard').addEventListener('click', function () {
      var b = curBoard(); if (!b) return;
      var copy = JSON.parse(JSON.stringify({
        tokens: b.tokens, arrows: b.arrows, marks: b.marks, labels: b.labels
      }));
      var nb = {
        id: uid(), mapId: b.mapId, name: (b.name + ' copy').slice(0, 30),
        tokens: copy.tokens, arrows: copy.arrows, marks: copy.marks, labels: copy.labels,
        updated: Date.now()
      };
      S.boards.push(nb); dbPut('boards', nb);
      S.boardId = nb.id;
      refresh(); toast('Duplicated');
    });
    $('renboard').addEventListener('click', function () {
      var b = curBoard(); if (!b) return;
      ask({ title: 'Setup name', field: true, value: b.name, maxLength: 28, okText: 'Save' })
        .then(function (r) {
          if (r.action !== 'ok' || !r.value) return;
          b.name = r.value; dbPut('boards', b); refresh();
        });
    });
    $('delboard').addEventListener('click', function () {
      var b = curBoard(); if (!b) return;
      confirmBox('Delete ' + b.name + '?', 'This cannot be undone.').then(function (ok) {
        if (!ok) return;
        dbDel('boards', b.id);
        S.boards = S.boards.filter(function (x) { return x.id !== b.id; });
        var bl = boardsOf(S.mapId);
        S.boardId = (bl.length ? bl[0] : newBoard(S.mapId, 'Default')).id;
        S.undo.length = 0; S.redo.length = 0;
        refresh(); renderMapList(); syncUndoButtons();
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
    $('leaveroom').addEventListener('click', function () { leaveRoom(); });
    $('sendmap').addEventListener('click', function () {
      if (!curMap()) { toast('No map to send'); return; }
      if (!S.room || !S.pool) {
        var typed = $('roomcode').value.trim();
        if (!typed) { toast('Type a room code first'); return; }
        ask({
          title: 'Start the room?',
          body: 'You are not in "' + typed + '" yet. Start it and send the map?',
          okText: 'Start and send'
        }).then(function (r) {
          if (r.action !== 'ok') return;
          joinRoom(typed);
          setTimeout(function () { publishMap(true); }, 2200);
        });
        return;
      }
      if (!curMap().bundled) toast('Sending map…');
      publishMap(true);
    });

    $('relays').addEventListener('focus', function () { this.select && 0; });
    $('saverelays').addEventListener('click', function () {
      var list = $('relays').value.split(/[\s,]+/).map(function (s) { return s.trim(); })
        .filter(function (s) { return /^wss?:\/\//.test(s); });
      if (!list.length) { toast('Need at least one wss:// relay'); return; }
      S.relays = list; saveMeta();
      $('relays').value = list.join('\n');
      toast('Relays saved');
      if (S.room) joinRoom(S.room);
    });
    $('defrelays').addEventListener('click', function () {
      S.relays = DEFAULT_RELAYS.slice();
      $('relays').value = S.relays.join('\n');
      saveMeta(); toast('Defaults restored');
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
      var cur = S.view;
      var cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;
      var h = cur.w * (st.clientHeight / st.clientWidth);
      setView({ x: cx - cur.w / 2, y: cy - h / 2, w: cur.w, h: h });
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
      if (!document.hidden && S.pool) { sendBeat(); prune(); }
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

  /* ---------- boot ---------- */
  function boot() {
    ensureMarkers();
    wire();
    wireInstall();

    openDb().then(function () {
      return Promise.all([dbAll('maps'), dbAll('boards'), dbGet('meta', 'settings'),
                          loadBundled(), dbAll('hills'), loadHillNames()]);
    }).then(function (res) {
      (res[4] || []).forEach(function (row) { S.hills[row.k] = row.pts || []; });
      S.maps = res[0].sort(function (a, b) { return a.created - b.created; });
      S.boards = res[1];
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
        S.clientId = st.clientId || S.clientId;
        if (st.mapId && S.maps.some(function (m) { return m.id === st.mapId; })) S.mapId = st.mapId;
        if (st.boardId && S.boards.some(function (b) { return b.id === st.boardId; })) S.boardId = st.boardId;
      }
      if (!S.mapId && S.maps.length) S.mapId = S.maps[0].id;
      if (S.mapId) {
        var bl = boardsOf(S.mapId);
        if (!S.boardId || !bl.some(function (b) { return b.id === S.boardId; })) {
          S.boardId = (bl.length ? bl[0] : newBoard(S.mapId, 'Default')).id;
        }
      }

      $('nick').value = S.nick;
      $('hillsbtn').setAttribute('aria-pressed', S.showHills ? 'true' : 'false');
      $('relays').value = S.relays.join('\n');
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
      toast('Storage unavailable — nothing will save');
      fitView(); render();
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }

    setInterval(function () {
      if (S.pendingRemote && (!gest || gest.type === 'none')) {
        applyRemote(S.pendingRemote);
        S.pendingRemote = null;
      }
    }, 400);
  }

  /* Small read-only hook so a problem can be inspected from the console. */
  window.__stratboard = function () {
    return {
      version: VERSION, room: S.room, maps: S.maps.length,
      mapList: S.maps.map(function (m) {
        return { name: m.name, bytes: m.buf ? m.buf.byteLength : 0, px: m.pxw + 'x' + m.pxh, rxid: m.rxid || null };
      }),
      mapId: S.mapId, boardId: S.boardId,
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
