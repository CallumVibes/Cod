/* Strat Board — offline-first strat planner with optional live rooms over Nostr. */
(function () {
  'use strict';

  var VERSION = '1.4';
  /* Write-friendly public relays. relay.nostr.band is a search aggregator and
     nostr.wine is paid, so neither accepts writes from a fresh key. */
  var DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://nostr.mom'
  ];
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
      var rq = indexedDB.open('stratboard', 1);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains('maps')) db.createObjectStore('maps', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
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
    wantTimer: null,
    rxTimer: null,
    notices: [],
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
      k: 'settings', mapId: S.mapId, boardId: S.boardId, nick: S.nick,
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

  /* ---------- selects ---------- */
  function fillSelects() {
    var ms = $('mapsel'), bs = $('boardsel');
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
          view0: { x: S.view.x, y: S.view.y, w: S.view.w, h: S.view.h }
        };
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
    try {
      m._url = URL.createObjectURL(new Blob([m.buf], { type: m.type || 'image/jpeg' }));
    } catch (e) { m._url = ''; }
    return m;
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
      S.mapId = first.id;
      var bl = boardsOf(first.id);
      S.boardId = (bl.length ? bl[0] : newBoard(first.id, 'Default')).id;
      S.undo.length = 0; S.redo.length = 0;
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
    if (!S.maps.length) { toast('Nothing to share yet'); return; }
    var pack = {
      app: 'stratboard', v: 1, made: new Date().toISOString(),
      maps: S.maps.map(function (m) {
        return { name: m.name, type: m.type || 'image/jpeg', pxw: m.pxw, pxh: m.pxh, h: m.h, img: b64FromBuf(m.buf) };
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
  function mapChunkTag(i) { return roomTag() + ':map:' + i; }

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
    if (S.mapSent && !force) return;
    S.mapSent = true;

    shareImage(m).then(function (im) {
      var parts = [];
      for (var i = 0; i < im.b64.length; i += CHUNK) parts.push(im.b64.slice(i, i + CHUNK));
      if (parts.length > MAX_CHUNKS) {
        banner('This map is too big to send over a room. Share a map pack instead.');
        return;
      }
      var meta = {
        name: m.name, n: parts.length, type: 'image/jpeg',
        pxw: im.w, pxh: im.h, h: Math.round(MAPW * im.h / im.w)
      };
      var jobs = [{ d: mapMetaTag(), body: JSON.stringify(meta) }];
      parts.forEach(function (p, i) { jobs.push({ d: mapChunkTag(i), body: p }); });

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
    var buf;
    try { buf = bufFromB64(b64); } catch (e) { return; }

    var existing = haveMapNamed(rx.meta.name);
    if (existing) { S.mapRx = { meta: null, chunks: {} }; useMapForRoom(existing); return; }

    var rec = {
      id: uid(), name: rx.meta.name || 'Room map', buf: buf, type: 'image/jpeg',
      pxw: rx.meta.pxw, pxh: rx.meta.pxh, h: rx.meta.h || MAPW, created: Date.now()
    };
    S.mapRx = { meta: null, chunks: {} };
    dbPut('maps', rec).then(function () {
      attachUrl(rec);
      S.maps.push(rec);
      useMapForRoom(rec);
      banner('');
      toast('Map received: ' + rec.name);
    });
  }

  function roomPayload() {
    var b = curBoard(), m = curMap();
    return JSON.stringify({
      v: 1, by: S.clientId, seq: ++S.seq, map: m ? m.name : '',
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
        var mine = curMap();
        if (mine && mine.name === meta.name) return;
        var known = haveMapNamed(meta.name);
        if (known) { useMapForRoom(known); return; }
        if (!S.mapRx.meta || S.mapRx.meta.name !== meta.name) S.mapRx = { meta: meta, chunks: {} };
        else S.mapRx.meta = meta;
        banner('Getting "' + meta.name + '" from the room…');

        /* Ask for exactly those parts, in small batches — relays limit how
           many values one filter may carry. */
        if (S.pool) {
          var total = Math.min(meta.n, MAX_CHUNKS), BATCH = 12;
          for (var from = 0; from < total; from += BATCH) {
            var want = [];
            for (var ci = from; ci < Math.min(from + BATCH, total); ci++) want.push(mapChunkTag(ci));
            S.pool.sub('mapdata' + from, [{ kinds: [30078], authors: [S.roomPub], '#d': want }]);
          }
        }
        watchTransfer();
        tryAssembleMap();
        return;
      }
      if (d.indexOf(roomTag() + ':map:') === 0) {
        if (curMap() && !S.mapRx.meta) return;
        var idx = parseInt(d.slice((roomTag() + ':map:').length), 10);
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
      if (d !== roomTag()) return;
    }

    var data;
    try { data = JSON.parse(ev.content); } catch (e) { return; }

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
    if (!curMap() || !curBoard()) { S.pendingState = data; return; }
    if (!isLiveBoard()) return;

    S.members[data.by] = S.members[data.by] || { n: 'Player', t: Date.now() };
    S.members[data.by].t = Date.now();

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

  function banner(txt) {
    var b = $('banner');
    if (!txt) { b.classList.remove('show'); return; }
    b.textContent = txt;
    b.classList.add('show');
    clearTimeout(banner._t);
    banner._t = setTimeout(function () { b.classList.remove('show'); }, 6000);
  }

  function prune() {
    var now = Date.now(), changed = false;
    Object.keys(S.members).forEach(function (k) {
      if (now - S.members[k].t > STALE_MS) { delete S.members[k]; changed = true; }
    });
    if (changed) renderMembers();
  }

  function renderMembers() {
    var n = Object.keys(S.members).length;
    var btn = $('livebtn');
    if (S.room) {
      btn.classList.add('on');
      $('liven').textContent = n ? String(n + 1) : '1';
    } else {
      btn.classList.remove('on');
      $('liven').textContent = 'Solo';
    }
    var box = $('members');
    box.textContent = '';
    if (!S.room) return;
    var st = S.pool ? S.pool.status() : { up: 0, total: 0 };
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0';
    var p1 = document.createElement('span');
    p1.className = 'pill' + (st.up ? ' ok' : '');
    p1.textContent = st.up + '/' + st.total + ' relays';
    wrap.appendChild(p1);
    var me = document.createElement('span');
    me.className = 'pill ok';
    me.textContent = (S.nick || 'You') + ' (you)';
    wrap.appendChild(me);
    Object.keys(S.members).forEach(function (k) {
      var s = document.createElement('span');
      s.className = 'pill';
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
      out.push('• ' + r.url.replace(/^wss?:\/\//, ''));
      out.push('    ' + r.state + ' — sent ' + r.sent + ', accepted ' + r.ok +
               ', rejected ' + r.rejected + ', received ' + r.recv);
      if (r.err) out.push('    says: ' + r.err);
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
        kinds: [20001, 20002], authors: [S.roomPub],
        since: Math.floor(Date.now() / 1000) - 60
      }]);
      S.pool.sub('mapmeta', [{ kinds: [30078], authors: [S.roomPub], '#d': [mapMetaTag()] }]);

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

    $('mapsel').addEventListener('change', function () {
      if (!this.value) return;
      S.mapId = this.value;
      var bl = boardsOf(S.mapId);
      S.boardId = (bl.length ? bl[0] : newBoard(S.mapId, 'Default')).id;
      S.undo.length = 0; S.redo.length = 0; S.objUrl = null;
      fitView(); refresh(); syncUndoButtons();
      if (S.room && isLiveBoard()) { S.mapSent = false; publishMap(); }
    });
    $('boardsel').addEventListener('change', function () {
      if (!this.value) return;
      S.boardId = this.value;
      S.undo.length = 0; S.redo.length = 0;
      refresh(); syncUndoButtons();
      if (S.room && !isLiveBoard()) banner('This setup is private. Switch to "' + liveBoardName() + '" to sync.');
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
      toast('Code ready — press Join');
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
      if (!S.room || !S.pool) { toast('Join a room first'); return; }
      if (!curMap()) { toast('No map to send'); return; }
      toast('Sending map…');
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

    window.addEventListener('resize', function () {
      var h = mapH();
      var cur = S.view;
      setView({ x: cur.x, y: cur.y, w: cur.w, h: cur.w * ($('stage').clientHeight / Math.max(1, $('stage').clientWidth)) });
      render();
    });

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
      return Promise.all([dbAll('maps'), dbAll('boards'), dbGet('meta', 'settings')]);
    }).then(function (res) {
      S.maps = res[0].sort(function (a, b) { return a.created - b.created; });
      S.boards = res[1];
      S.maps.forEach(attachUrl);

      var st = res[2];
      if (st) {
        S.nick = st.nick || '';
        S.relays = (st.relays && st.relays.length) ? st.relays : DEFAULT_RELAYS.slice();
        S.colour = st.colour || S.colour;
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
      $('relays').value = S.relays.join('\n');
      $('menusub').textContent = 'Version ' + VERSION + ' · everything saves on this phone.';
      renderDiag();
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
