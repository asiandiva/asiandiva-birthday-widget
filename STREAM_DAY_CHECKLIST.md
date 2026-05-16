# 🎂 Stream Day Checklist

Print this or keep it open in a tab. Walk through it 30 min before going live.

---

## 1. Wake up Render (~30 sec)

Open this in any tab — wait until it loads, then close:

```
https://your-service.onrender.com/health
```

(Free tier spins down after 15 min inactivity. This wakes it back up. If you upgraded to Starter $7/mo, skip this step.)

---

## 2. Confirm health JSON is green

The page from step 1 should show:

```json
{
  "status": "ok",
  "eventsub": "connected",      ← must be "connected"
  "irc": "connected",            ← must be "connected"
  "subscriptions": {
    "active": [
      "channel.subscribe",
      "channel.subscription.message",
      "channel.subscription.gift",
      "channel.cheer"
    ],                           ← all 4 should be in "active"
    "failed": {},                ← should be empty {}
    "total": 4
  },
  ...
}
```

**Red flags:**

| What you see | What to do |
|---|---|
| `eventsub: "disconnected"` | Wait 30s and refresh — it auto-reconnects |
| `irc: "disconnected"` | Same — auto-reconnects every 5s |
| `failed: { ... 401 ... }` | Token expired. See "Token refresh" below |
| `failed: { ... 403 ... }` | Token missing scopes. See "Token refresh" below |

---

## 3. Fire a test burst before going live

Open this URL — it spawns 8 different VIP balloons on screen so you can verify the widget looks right:

```
https://your-service.onrender.com/test-burst
```

You should see a mix of subs/giftsubs/cheers/Blerps appear over ~3 seconds, all roaming around the screen. Pop a few with hotkeys (open the OBS Interact window on the browser source, press `P` a couple times).

---

## 4. Wipe test scores

Before going live, clear the leaderboard so the squad starts fresh:

1. Open OBS Interact on the browser source
2. Click on the widget area
3. Press **Shift + R**

Press `` ` `` to confirm the cake leaderboard is empty.

---

## 5. Final OBS check

- Browser source URL = `https://your-service.onrender.com/`
- Width 1920, Height 1080
- Background transparent ✓
- **Interact enabled** (right-click source → Interact)
- Source is positioned above your gameplay but below your camera (so balloons don't cover your face)

---

## 6. Last thing — keep the Render logs tab open

Open `https://dashboard.render.com` → your service → **Logs** tab. Leave it visible on a second monitor. During the stream you'll see:

```
[BROADCAST] cheer: Teresa (200 bits)
[BROADCAST] giftsub: Luke (×5)
[BROADCAST] blerp: BubbleTeaQ (100 bits)
[Blerp] blerp: Teresa played airhorn AIR HORN Blerp for 100 once!
```

If something doesn't show up in chat the way you expect, the logs tell you immediately whether the event arrived at the server.

---

## Token refresh (if step 2 shows 401/403)

1. Go to https://twitchtokengenerator.com
2. Click **Custom Scope Token**
3. Check these scopes:
   - `channel:read:subscriptions`
   - `bits:read`
4. Generate, copy the **ACCESS TOKEN** (not refresh token)
5. Open Render dashboard → your service → **Environment**
6. Update `TWITCH_USER_TOKEN` with the new token, save
7. Render auto-redeploys (~1 minute)
8. Go back to step 1

---

## During stream

Nothing to do. The widget runs itself.

If you ever see balloons stop appearing, hit your /health URL. If the EventSub state ever drops to `disconnected` and doesn't come back within ~30 seconds, the Render service may have died — go to Render dashboard and click **Manual Deploy → Deploy latest commit**.

---

## After stream

1. Right-click the OBS browser source → Remove
2. Render dashboard → your service → Settings → Delete Service
3. GitHub → repo → Settings → scroll to bottom → Archive this repository

Clean shutdown. None of your other widgets were touched.
