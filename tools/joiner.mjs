#!/usr/bin/env node
/*
 * Strat Board room joiner — a programmatic witness in a live room.
 *
 *   node joiner.mjs <room-code>              watch, and report what arrives
 *   node joiner.mjs <room-code> --probe      also drop a numbered mark every
 *                                            few seconds and time the round trip
 *   node joiner.mjs <room-code> --json       one JSON object per line
 *   node joiner.mjs <room-code> --relay ws://127.0.0.1:8081   use your own
 *
 * Watching is read-only: it cannot disturb a session. --probe writes to the
 * board, so only use it when the others know.
 *
 * Needs Node 22+ (for built-in WebSocket) and nothing else installed.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const code = args.find((a) => !a.startsWith('--'));
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

if (!code) {
  console.error('usage: node joiner.mjs <room-code> [--probe] [--json] [--relay wss://...]');
  process.exit(2);
}

const JSONL = flag('json');
const PROBE = flag('probe');
const EVERY = Number(opt('every', 8)) * 1000;
const RELAYS = opt('relay', '').split(/[ ,]+/).filter(Boolean);
const SITE = opt('site', 'https://callumvibes.github.io/Cod');

/* The app's own crypto, so a signature can never quietly differ from it. */
const here = dirname(fileURLToPath(import.meta.url));
const local = [join(here, '..', 'nostr.js'), join(here, 'nostr.js')].find(existsSync);
let src;
if (local) {
  src = readFileSync(local, 'utf8');
} else {
  const r = await fetch(SITE + '/nostr.js');
  if (!r.ok) { console.error('could not fetch nostr.js from ' + SITE); process.exit(1); }
  src = await r.text();
}
/* nostr.js is written as a plain browser script, so hand its export back. */
globalThis.window = globalThis;
const N = new Function(src + '\n;return typeof NostrLite !== "undefined" ? NostrLite : null;')();
if (!N || !N.Pool) { console.error('nostr.js did not load as expected'); process.exit(1); }

const DEFAULT_RELAYS = [
  'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.damus.io'
];
const relays = RELAYS.length ? RELAYS : DEFAULT_RELAYS;

const started = Date.now();
const since = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6) + 's';
const out = (kind, msg, extra) => {
  if (JSONL) console.log(JSON.stringify({ t: Date.now(), kind, msg, ...(extra || {}) }));
  else console.log(since() + '  ' + kind.padEnd(9) + ' ' + msg);
};

const sk = await N.keyFromCode(code);
const pub = N.bytesToHex(N.pubkeyFromSeckey(sk));
const tag = await N.tagFromCode(code);
const roomTag = 'stratboard:' + tag;
const me = 'witness-' + Math.random().toString(36).slice(2, 8);

out('room', 'code "' + code + '" → ' + roomTag);
out('room', 'key ' + pub.slice(0, 16) + '…  (watching as ' + me + ')');

const seen = { boards: new Map(), members: new Map() };
const probes = new Map();
let counts = { board: 0, state: 0, ping: 0, presence: 0, other: 0 };

function describeBoard(d) {
  return [
    (d.name || '?'),
    (d.tokens || []).length + ' players',
    (d.arrows || []).length + ' arrows',
    (d.marks || []).length + ' marks',
    (d.labels || []).length + ' labels',
    'v' + (d.v || 0)
  ].join(', ');
}

function onEvent(ev) {
  if (ev.pubkey !== pub) return;
  let d;
  try { d = JSON.parse(ev.content); } catch (e) { return; }
  const dtag = (ev.tags.find((t) => t[0] === 'd') || [])[1] || '';

  if (ev.kind === 20001) {
    if (d.c === me) return;              // our own hello coming back
    counts.presence++;
    const was = seen.members.get(d.c);
    seen.members.set(d.c, d.n);
    if (!was) out('joined', (d.n || '?') + ' is here');
    else if (was !== d.n) out('role', was + ' is now ' + d.n);
    return;
  }
  if (ev.kind === 20003) {
    counts.ping++;
    out('ping', (d.k ? d.k + ' ' : '') + 'from ' + (d.n || '?') +
        ' at ' + Math.round(d.x) + ',' + Math.round(d.y));
    return;
  }
  if (ev.kind !== 30078) { counts.other++; return; }

  if (dtag === roomTag) {
    counts.state++;
    out('room', 'map ' + (d.map || '?') + ', on "' +
        ((d.setups || []).find((s) => s.id === d.active) || {}).name + '"' +
        (d.locked ? ', locked by ' + String(d.host).slice(0, 6) : '') +
        ', ' + (d.setups || []).length + ' setups');
    return;
  }
  if (dtag.indexOf(':b:') > 0) {
    counts.board++;
    const was = seen.boards.get(d.id);
    seen.boards.set(d.id, d);
    /* a probe of ours coming back tells us the real round trip */
    (d.marks || []).forEach((m) => {
      if (probes.has(m.id)) {
        const ms = Date.now() - probes.get(m.id);
        probes.delete(m.id);
        out('probe', 'came back in ' + ms + 'ms', { ms });
      }
    });
    if (!was) out('board', 'first copy of "' + (d.name || '?') + '" — ' + describeBoard(d));
    else {
      const diff = [];
      ['tokens', 'arrows', 'marks', 'labels'].forEach((k) => {
        const a = (was[k] || []).length, b = (d[k] || []).length;
        if (a !== b) diff.push(k + ' ' + a + '→' + b);
      });
      out('board', (d.by === me ? '(ours) ' : '') + (d.name || '?') + ': ' +
          (diff.length ? diff.join(', ') : 'moved something') + '  v' + (d.v || 0));
    }
  }
}

const pool = new N.Pool(relays, {
  onevent: onEvent,
  onstatus: () => {},
  onnotice: (url, msg) => out('relay', url.replace(/^wss?:\/\//, '') + ' says: ' + msg),
  authSign: (url, challenge) => N.finalize({
    kind: 22242, created_at: Math.floor(Date.now() / 1000),
    tags: [['relay', url], ['challenge', challenge]], content: ''
  }, sk)
});

pool.connect();

pool.sub('state', [{ kinds: [30078], authors: [pub], '#d': [roomTag], limit: 1 }]);
pool.sub('boards', [{ kinds: [30078], authors: [pub], limit: 60 }]);
pool.sub('live', [{ kinds: [20001, 20002, 20003], authors: [pub], since: Math.floor(Date.now() / 1000) }]);

/* say hello, the same way the app does, so the team sees a watcher */
async function beat() {
  const ev = await N.finalize({
    kind: 20001, created_at: Math.floor(Date.now() / 1000),
    tags: [['d', roomTag]],
    content: JSON.stringify({ c: me, n: 'Watching' })
  }, sk);
  pool.publish(ev);
}
beat();
setInterval(beat, 12000);

if (PROBE) {
  out('probe', 'writing a numbered mark every ' + (EVERY / 1000) + 's — others will see these');
  let n = 0;
  setInterval(async () => {
    const board = [...seen.boards.values()].pop();
    if (!board) { out('probe', 'no board yet, waiting'); return; }
    n++;
    const id = 'probe-' + n + '-' + Math.random().toString(36).slice(2, 7);
    const copy = JSON.parse(JSON.stringify(board));
    copy.marks = (copy.marks || []).concat([{ id, x: 700, y: 700 + n * 5, c: '#22c55e' }]);
    copy.by = me;
    copy.v = (copy.v || 0) + 1;
    probes.set(id, Date.now());
    const ev = await N.finalize({
      kind: 30078, created_at: Math.floor(Date.now() / 1000),
      tags: [['d', 'stratboard:' + tag + ':b:' + copy.id]],
      content: JSON.stringify(copy)
    }, sk);
    pool.publish(ev);
    out('probe', 'sent mark ' + n);
    setTimeout(() => {
      if (probes.has(id)) { probes.delete(id); out('probe', 'mark ' + n + ' never came back'); }
    }, 20000);
  }, EVERY);
}

function report() {
  console.log('\n--- relays ---');
  pool.report().forEach((r) => {
    console.log('  ' + r.url.replace(/^wss?:\/\//, '').padEnd(22) + r.state.padEnd(12) +
      'sent ' + r.sent + ', accepted ' + r.ok + ', rejected ' + r.rejected +
      ', received ' + r.recv + (r.muted ? '  (skipped — kept refusing us)' : '') +
      (r.err ? '\n      says: ' + r.err : ''));
  });
  console.log('\n--- seen ---');
  console.log('  ' + counts.board + ' board updates, ' + counts.state + ' room updates, ' +
    counts.ping + ' pings, ' + counts.presence + ' heartbeats');
  console.log('  people: ' + ([...seen.members.values()].join(', ') || 'nobody else'));
  console.log('  setups: ' + ([...seen.boards.values()].map((b) => b.name).join(', ') || 'none'));
}

process.on('SIGINT', () => { report(); process.exit(0); });
setTimeout(() => { out('room', 'still here — Ctrl-C for a summary'); }, 30000);
