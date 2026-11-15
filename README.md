# Strat Board

A strat board for planning 4v4 Call of Duty matches on your phone. Drop players
on the map, draw rotations, and share the board live with your team.

**Open it:** https://callumvibes.github.io/Cod/

## Install it

It works in the browser, but install it and it opens like an app and works
without signal.

- **Android:** open the link in Chrome or Brave, then menu → *Add to home screen*.
- **iPhone:** open the link in **Safari** (it has to be Safari), then share → *Add to Home Screen*.

## Using it

The six tools along the bottom:

| Tool | What it does |
| --- | --- |
| **Move** | Drag players around. Tap one to rename it. Hold the map to ping. |
| **Ping** | Tap anywhere to flash a marker with your name on everyone's screen for five seconds. Nothing is saved — it is just for pointing. |
| **Arrow** | Draw a rotation with your finger. |
| **Mark** | Drop an X. |
| **Text** | Tap where you want it, type, and tap Place. Drag labels in Move mode. |
| **Erase** | Tap an arrow, mark or label to remove it. |

Top right: undo, redo, **✕** to clear, **P** for hardpoints, and the arrows to
flip the map round when you spawn the other side. The map turns; the writing on
it stays the right way up. Each map remembers whether you had it flipped.

## Saving a setup

Arrange the players and draw whatever you want as your starting point, then tap
the flag (**⚑**). That becomes the setup's saved default.

**✕** goes back to it — players, arrows, marks and labels, exactly as you saved
them. Mid-game you can scribble all over the board and get your setup back in
one tap. Undo brings the scribbles back if you hit it by mistake.

If you have not saved anything yet, ✕ just clears the drawing and puts the four
players back on their starting line. Saving again replaces the old default, and
in a room the saved setup is shared with the team.

The map always fills the screen and stays put — there is nothing to pan or
zoom, so you cannot knock it out of place mid-game.

## Who can change things

Whoever creates the room is the host, and can turn **Others can edit** off in
the menu. Everyone else can still look around and ping, but cannot move
players or draw. It is a courtesy between teammates rather than real security:
anyone with the code shares the same key, so a determined person could ignore
it. If the host drops off, the lock releases so the room is not stuck.

## Everyone at once

Several people can move players and draw at the same time. Each person's
changes are folded together rather than the last one winning, so when the
whole team drops their player at once, all four land. Anything deliberately
erased or cleared stays gone, and undo puts it back for everybody.

If a phone loses signal, it keeps working on its own and catches up when it
comes back — and the work done while it was away is not lost either.

## Playing together

First time you open it you get **Create a room** or **Join a room**.

1. One person taps **Create a room** and gets a code.
2. They share it — the invite link, or just read it out.
3. Everyone else taps **Join a room** and types the code.

Leaving a room takes you back to that same screen.

From then on you all see the same board. Drag a player and it moves on
everyone's screen. Change the map and the whole team follows.

The room code is the only password, so pick something nobody would guess.

## Setups

A setup is one arrangement of players and drawings — "A site default",
"B rush", and so on. Setups belong to the room, so everyone has the same
list, and when one person switches setup the team switches with them. Adding,
renaming and deleting carry across too.

Each map has its own setups, so switching map keeps everything in place.

Setups you make on your own are yours and stay out of the room. Join a room
and you see the room's; leave and your own come back.

## Hardpoints

Hardpoint locations are not built in — you place them once per map. Menu →
**Edit hardpoints**, then tap each hill in rotation order. They are named
automatically from the published rotations, saved per map, shared with your
room, and shown on every setup on that map. The **P** button toggles them.

## Maps

The maps are built in. Each one has a **Shown / Hidden** toggle in the menu —
hide the ones that are out of the rotation and they drop out of the picker
without being lost.

## Backups

**Back up** writes your setups, hardpoints and preferences to one file. Keep it
somewhere safe, or use **Restore** on a new phone to pick up where you left off.

## If something is wrong

- **Stuck on an old version?** Menu → **Force update**. The version is shown
  under the title in the menu.
- **Room not working?** Join the room, open the menu, scroll to *Diagnostics*
  and tap **Copy report**. It says which relays connected and what they said.
- **Someone seeing something you have deleted?** It should sort itself out
  within about half a minute — every phone re-asks for the current board on a
  timer, so a message lost on a bad connection gets picked up again.
- **App broken after an update?** Menu → **Reset the app**, which clears
  everything the browser has stored and starts fresh. Back up first if you
  have setups worth keeping.
- **Nothing saves?** Everything lives on your own phone. Clearing the site's
  browser data wipes your setups.

## How it works

A static site — no server, no accounts, no tracking. Your maps and setups are
stored on your own device. Live rooms go over public [Nostr](https://nostr.com)
relays: the room code becomes a keypair, so anyone with the code can read and
write the room and nobody else can find it.
