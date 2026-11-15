# joiner.mjs — a programmatic witness in a live room

Joins a Strat Board room from a terminal and reports what it sees. Useful for
testing a real session: it watches the same relays the phones do, so it can
confirm whether something that went missing on a phone ever left the room.

Needs Node 22 or newer. Nothing to install — it uses the app's own `nostr.js`
for its crypto, so its signatures can never quietly differ from the app's.

    node tools/joiner.mjs <room-code>

Watching is read-only and cannot disturb a session.

| Flag | What it does |
| --- | --- |
| `--probe` | Drops a numbered mark every few seconds and times the round trip. **Others will see these.** |
| `--every <seconds>` | How often to probe. Default 8. |
| `--json` | One JSON object per line, for a script to read. |
| `--relay <url>` | Use particular relays instead of the defaults. |
| `--site <url>` | Where to fetch `nostr.js` from, if running outside the repo. |

Ctrl-C prints a summary: which relays accepted what, who was in the room, and
what was seen.

## Reading it

    7.2s  board     first copy of "Default" — 4 players, 0 arrows, 0 marks, v1
    7.7s  board     Default: marks 0→1  v2
   10.5s  ping      bomb from AR at 513,870
   12.1s  board     Default: arrows 0→1  v4

The `v` number only ever goes up. If a phone is showing something stale, its
version will be behind what the witness reports.
