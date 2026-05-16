# Diva's Birthday Balloon Widget 🎂🎈

One-time birthday stream widget. **Fully standalone** — has its own server,
its own EventSub subscriptions, its own SSE. Does not read from or share
state with any other widget or service. Build it, use it for one stream,
delete it.

---

## What it does

- Balloons drift up the screen in 6 colors. Chat types `!pop red` (or blue,
  green, yellow, purple, pink) to pop the highest balloon of that color.
- Anyone in chat typing `!birthday` triggers a celebration banner + confetti
  burst + balloon swarm (30-sec per-user cooldown).
- **VIP balloons** spawn from real Twitch events and roam the screen
  randomly until popped:
  - Resub / single giftsub / bits < 500 → **Regular** VIP (1 pt)
  - 2–4 giftsubs / bits ≥ 500 → **Medium** VIP (3 pts)
  - 5+ giftsubs → **Big** VIP (5 pts)
- Press `` ` `` (backtick) in OBS Interact mode to toggle the **Birthday
  Cake Podium** leaderboard.

### Where each event comes from

| Event source | Detected via |
|---|---|
| New subs, resubs, gift subs | Twitch EventSub WebSocket |
| Regular chat bit cheers | Twitch EventSub WebSocket (`channel.cheer`) |
| **Blerps (bit amount)** | **Blerp bot chat messages over IRC** (channel.bits.use is unreliable for Blerp amounts) |

The server keeps an anonymous IRC connection to your channel and parses the
Blerp bot's chat messages (format: `[viewer] played [title] [tts] Blerp for
[N] [playtype]!`) to extract the viewer name and bit amount.

---

## Project layout

```
birthday-widget/
├── server.js          ← Express + EventSub WebSocket + SSE
├── package.json
├── .env.example       ← Copy to .env, fill in tokens
├── .gitignore
├── README.md
└── public/
    └── index.html     ← The widget (served at /)
```

---

## Setup

### 1. Get a Twitch user access token

The server needs a token with these scopes:

- `channel:read:subscriptions` — for subscribe/resub/giftsub events
- `bits:read` — for cheer + bits.use events
- `user:read:chat` *(optional, only if you want to extend with chat scopes later)*

Go to [twitchtokengenerator.com](https://twitchtokengenerator.com), pick
**Custom Scope Token**, select the scopes above, generate, and copy the
**access token** (not the refresh token).

> Note: user access tokens expire (~60 days). For a one-time birthday stream
> you just need it valid on the day of. If it expires, generate a new one
> and update the `TWITCH_USER_TOKEN` env var on Render.

### 2. Create a new GitHub repo and push

```bash
cd birthday-widget
git init
git add .
git commit -m "initial"
git branch -M main
git remote add origin https://github.com/asiandiva/asiandiva-birthday-widget.git
git push -u origin main
```

### 3. Deploy to Render as a Web Service

1. https://dashboard.render.com → **New** → **Web Service**
2. Connect the GitHub repo
3. Settings:
   - **Name:** `asiandiva-birthday-widget`
   - **Region:** whichever is closest
   - **Branch:** `main`
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free (works for a one-time stream) or Starter $7
     (recommended — Free spins down after 15 min of inactivity, which would
     drop EventSub subscriptions)
4. **Environment** → add these:
   ```
   TWITCH_CLIENT_ID       = c76fsghzngwflbmg06o6c9hj2ffub2
   TWITCH_USER_TOKEN      = (paste your token)
   TWITCH_BROADCASTER_ID  = 716266770
   TWITCH_CHANNEL         = asiandiva__
   BLERP_BOT              = blerp
   ```
5. Click **Create Web Service**. First deploy takes ~3 minutes.

Once it's live, you'll have a URL like
`https://asiandiva-birthday-widget.onrender.com`.

### 4. Verify it's working

Open these in a browser, in order:

1. `https://your-service.onrender.com/health` — should return JSON like:
   ```json
   {
     "status": "ok",
     "eventsub": "connected",
     "irc": "connected",
     "sseClients": 0,
     "subscriptions": {
       "active": ["channel.subscribe", "channel.subscription.message", "channel.subscription.gift", "channel.cheer"],
       "failed": {},
       "total": 4
     },
     "watching": { "channel": "asiandiva__", "blerpBot": "blerp" },
     "uptime_sec": 12
   }
   ```
   **All 4 subs should be in `active`. If any are in `failed`, the error message tells you why** (most often: token expired or missing scopes).
2. `https://your-service.onrender.com/test/giftsub3` — fires a fake medium gift-sub event. Open the widget in another tab first and you should see a medium VIP balloon spawn.
3. `https://your-service.onrender.com/test-burst` — fires 8 different events staggered over 3 seconds. Use this to stress-test that everything renders smoothly with multiple VIPs on screen.
4. Available single-event endpoints: `/test/sub`, `/test/resub`, `/test/giftsub1`, `/test/giftsub3`, `/test/giftsub10`, `/test/cheer`, `/test/bigcheer`, `/test/blerp`.

### 5. Add to OBS

1. Add a **Browser Source** to your scene
2. URL: `https://your-service.onrender.com/`
3. Width: `1920`, Height: `1080`
4. Background already transparent — no chroma key needed
5. **Right-click the source → Interact** — required for the backtick
   leaderboard toggle and test hotkeys

---

## Chat commands

| Command | Effect | Cooldown |
|---|---|---|
| `!pop red` (or blue, green, yellow, purple, pink) | Pops highest-priority balloon of that color | 4 sec / user |
| `!birthday` | Triggers confetti + balloon swarm celebration | 30 sec / user |

VIP balloons get popped first when their color matches.

---

## Test hotkeys (with OBS Interact on, or browsing the widget directly)

| Key | Action |
|---|---|
| `T` | Spawn a regular drifting balloon |
| `P` | Simulate a random chatter doing `!pop` |
| `B` | Test `!birthday` celebration |
| `1` | Spawn VIP: resub |
| `2` | Spawn VIP: single giftsub |
| `3` | Spawn VIP: medium giftsub (3 subs) |
| `4` | Spawn VIP: big giftsub (10 subs) |
| `5` | Spawn VIP: cheer 200 bits (regular) |
| `6` | Spawn VIP: cheer 1000 bits (medium) |
| `7` | Spawn VIP: Blerp 100 bits |
| `` ` `` | Toggle the cake leaderboard |
| `Shift+R` | Wipe all scores |

These hotkeys spawn balloons **client-side only** — they don't go through
the server. To test the full pipeline (EventSub → SSE → widget) use the
`/test/:type` endpoints.

---

## Running locally (optional)

```bash
cp .env.example .env
# Edit .env with your real token
npm install
npm start
```

Then open http://localhost:3000/

---

## Configuration

All widget settings are in the `CONFIG` block at the top of `<script>` in
`public/index.html`:

```js
const CONFIG = {
  CHANNEL: 'asiandiva__',
  POP_COMMAND: '!pop',
  BIRTHDAY_COMMAND: '!birthday',
  POP_COOLDOWN_MS: 4000,
  BIRTHDAY_COOLDOWN_MS: 30000,
  BITS_TRACKER_SSE_URL: '/events',   // same-origin — don't change
  BITS_MEDIUM_THRESHOLD: 500,        // bits ≥ this → medium VIP
  GIFTSUB_MEDIUM_THRESHOLD: 2,       // giftsubs ≥ this → medium
  GIFTSUB_BIG_THRESHOLD: 5,          // giftsubs ≥ this → big
};
```

Server settings are in `.env`. Subscription list is at the top of `server.js`.

---

## Troubleshooting

**Health endpoint shows subscriptions in `failed`:**
Each failed subscription has a status code and message. The common ones:
- `401` — token expired or invalid. Generate a new token at twitchtokengenerator.com with `bits:read` + `channel:read:subscriptions` scopes, update `TWITCH_USER_TOKEN` env var on Render, save (Render auto-redeploys).
- `403` — token is valid but missing scopes. Regenerate with the scopes above.
- `409` — duplicate subscription (rare, usually resolves on next reconnect).

**Health endpoint shows `eventsub: "disconnected"`:**
The Twitch WebSocket is down or the service is restarting. Render free tier
spins down after 15 min of inactivity — bump to Starter $7 or hit the URL
right before going live.

**Test endpoints work but real events don't fire balloons:**
EventSub subscriptions failed silently. Check `/health` and the Render logs.
Look for any 4xx responses in the subscription creation output.

**Real bits fire but Blerps don't (or vice versa):**
Blerps come from chat-parsing the Blerp bot's messages, **not** from EventSub.
Check `/health` → look for `irc: "connected"`. In Render logs you should see
`[IRC] Joined #asiandiva__...`. When someone plays a Blerp on stream, the
bot posts a chat message and the Render logs will show `[BROADCAST] blerp:
...`. If the message comes through but isn't being parsed, you'll see
`[Blerp] Unrecognized message format — please share: "..."` in the logs —
paste that line and the regex can be adjusted to match.

**Bot name is different from "blerp":**
Set `BLERP_BOT` in your env to the actual chat username (lowercase).

**Widget shows but no balloons:**
The widget connects to `/events` on the same origin. Open browser DevTools
→ Network → look for the `events` request. It should be `200 OK` with type
`eventsource`. If it's failing, the server isn't running or isn't reachable.

**Stuck test scores on the leaderboard:**
Press `Shift+R` with the widget focused, or open DevTools → Application →
Local Storage → delete the `asiandiva_bday_balloon_scores_v2` key.

---

## After the birthday stream

1. Remove the OBS browser source
2. Delete the Render Web Service (Settings → Delete Service)
3. Archive the GitHub repo (Settings → Archive this repository)
4. Done. Nothing left running.
