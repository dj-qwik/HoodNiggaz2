# Hood Niggas 2

An online party game for 5 to 10 players, each on their own device. Everyone stands on a round
platform high above a pit. A low bar (a giant broom) sweeps round and gets faster and faster: jump
it. A slow high bar at chest height knocks over anyone standing: duck or dive under it. From 30
seconds in, a wedge of the platform flashes and drops out every 13 seconds until only two are left.
Shots freeze people for half a second. Last one standing wins.

- `server.js` serves the game at `/`, the songs at `/music/`, and relays online rooms at `/ws`. It
  has no dependencies.
- `public/index.html` is the whole game.
- `public/music/` holds the soundtrack. "Hood Niggaz" loops in the menus; Chronic Condition,
  Slippin, Strapped, Thugd Out and Trappin rotate through matches.
- `render.yaml` tells Render how to run it on the free plan.

## Put it online (one time)

1. In the Render dashboard choose **New → Blueprint**, connect your GitHub account if asked, pick the
   `HoodNiggaz2` repo, and choose **Apply**. Render reads `render.yaml` and creates a free web service
   called `hood-niggas-2`.
2. When the deploy finishes, Render shows a link like `https://hood-niggas-2-xxxx.onrender.com`.
   That's the game. Send it to friends.

Every push to `main` redeploys automatically in a minute or two. Anyone in a match at that moment gets
disconnected.

## Playing

1. Open the link and choose **Create a room**. You'll get a four-letter code.
2. Friends open the same link, type the code and press **Join**. A room seats 10 players.
3. Everyone presses **Ready** (Enter, or A on a controller). Once 5 players are ready, a 60-second
   countdown starts, and the round begins when it hits zero. Anyone not ready by then watches that
   round.
4. To start sooner, every player in the room presses **Skip countdown** (K, or Y on a controller).
   It only works if everyone votes.
5. After each round the winner dances, then everyone goes back to the lobby to ready up again.

The person who created the room keeps it running, so if they leave, the room closes. Nobody needs a
Claude or Render account to play.

## Good to know

- **First load can take about a minute.** On the free plan Render puts the server to sleep after 15
  minutes with nobody connected. The first visit wakes it up.
- **Limits.** Up to 14 connections per room (10 players plus a few waiting for a seat). Render's free
  plan includes 750 hours a month per workspace, shared across all your services.

## Testing without a browser

- `node tools/netsim.js public/index.html` runs up to 11 copies of the game headless (a stand-in for
  three.js and the page) joined to a pretend online room. It walks through ready-up, the countdown,
  the skip vote, full rounds of 5, 6 and 10 players, and a full room, and reports any failed check or
  runtime error. It can't show what the game looks like.
- `node tools/sim.js public/index.html` just boots one copy and runs the lobby for a while, as a
  quick crash check.
