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
| **Move** | Drag players around. Tap one to rename it, drag the map to pan, pinch to zoom. Hold the map to ping. |
| **Ping** | Tap anywhere to flash a marker with your name on everyone's screen for five seconds. Nothing is saved — it is just for pointing. |
| **Arrow** | Draw a rotation with your finger. |
| **Mark** | Drop an X. |
| **Text** | Place a label. Drag labels in Move mode. |
| **Erase** | Tap an arrow, mark or label to remove it. |

Top right: undo, redo, fit the map to the screen, clear the drawing, and **P**
to show or hide hardpoints.

## Playing together

1. One person opens the menu, taps **New room**, and a code appears.
2. Tap **Invite** to send the link, or just read the code out.
3. Everyone else types the same code and taps **Start**.

From then on you all see the same board. Drag a player and it moves on
everyone's screen. Change the map and the whole team follows.

The room code is the only password, so pick something nobody would guess.

**Private setups.** While in a room you are on a shared setup. Anything under
*This setup* in the menu is yours alone and does not sync.

## Hardpoints

Hardpoint locations are not built in — you place them once per map. Menu →
**Edit hardpoints**, then tap each hill in rotation order. They are named
automatically from the published rotations, saved per map, shared with your
room, and shown on every setup on that map. The **P** button toggles them.

## Maps

Six maps are built in. To add your own, menu → **Add map** and pick a
screenshot of the in-game tac map. Your own maps are sent to your room
automatically when you switch to them.

**Map packs** are for sending maps to someone outside a room: *Share map pack*
makes one file, they use *Import pack*.

## If something is wrong

- **Stuck on an old version?** Menu → **Force update**. The version is shown
  under the title in the menu.
- **Room not working?** Join the room, open the menu, scroll to *Diagnostics*
  and tap **Copy report**. It says which relays connected and what they said.
- **Nothing saves?** Everything lives on your own phone. Clearing the site's
  browser data wipes your setups.

## How it works

A static site — no server, no accounts, no tracking. Your maps and setups are
stored on your own device. Live rooms go over public [Nostr](https://nostr.com)
relays: the room code becomes a keypair, so anyone with the code can read and
write the room and nobody else can find it. You can swap the relay list in the
menu.
