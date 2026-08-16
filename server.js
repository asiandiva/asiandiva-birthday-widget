// ============================================================================
// Diva's Birthday Balloon Widget — Standalone Server
//
// This server:
//   1. Serves the widget (public/index.html) at /
//   2. Subscribes to Twitch EventSub via WebSocket for sub/resub/giftsub/cheer/bits.use events
//   3. Pushes every received event to connected widgets via Server-Sent Events at /events
//
// It is fully independent. It does NOT read from any other service. Once the
// birthday stream is done, you can shut down the Render service and delete the
// repo without affecting any of your other widgets.
// ============================================================================

require('dotenv').config();
const express = require('express');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const USER_TOKEN = process.env.TWITCH_USER_TOKEN;
const REFRESH_TOKEN = process.env.TWITCH_REFRESH_TOKEN;  // optional — enables auto-refresh
const BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID;
const CHANNEL_NAME = (process.env.TWITCH_CHANNEL || 'asiandiva__').toLowerCase();
const BLERP_BOT = (process.env.BLERP_BOT || 'blerp').toLowerCase();

// The Client-Id sent to Twitch MUST belong to the same app the token was
// issued for, or every call fails with "Client ID and OAuth token do not
// match". Instead of trusting the env var, we ask Twitch which client_id the
// token actually belongs to (see validateToken) and use that. The env value is
// only a fallback if validation can't run.
let effectiveClientId = CLIENT_ID;
let tokenInfo = { valid: null };

// Live token state. The access token can be swapped out at runtime by the
// auto-refresh flow, so everything reads `currentToken` rather than the env var.
let currentToken = USER_TOKEN;
let currentRefresh = REFRESH_TOKEN;
let refreshTimer = null;

if (!CLIENT_ID || !USER_TOKEN || !BROADCASTER_ID) {
  console.error('[FATAL] Missing required env vars: TWITCH_CLIENT_ID, TWITCH_USER_TOKEN, TWITCH_BROADCASTER_ID');
  process.exit(1);
}

const app = express();

// ============================================================================
// Static widget
// ============================================================================
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// SSE — Server-Sent Events stream the widget subscribes to
// ============================================================================
const sseClients = new Set();

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });
  res.write(': connected\n\n');

  sseClients.add(res);
  console.log(`[SSE] Client connected (${sseClients.size} total)`);

  // Keep-alive comment every 25s so proxies don't timeout
  const keepAlive = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
    console.log(`[SSE] Client disconnected (${sseClients.size} remain)`);
  });
});

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); }
    catch (e) { sseClients.delete(client); }
  }
  console.log(`[BROADCAST] ${event.type}: ${event.displayName}${event.bits ? ` (${event.bits} bits)` : ''}${event.count ? ` (×${event.count})` : ''}`);
}

// ============================================================================
// Health check
// ============================================================================
app.get('/health', (req, res) => {
  const failures = {};
  for (const [type, info] of failedSubscriptions) failures[type] = info;
  res.json({
    status: 'ok',
    eventsub: eventSubState,
    irc: ircState,
    sseClients: sseClients.size,
    token: tokenInfo,
    subscriptions: {
      active: [...activeSubscriptions],
      failed: failures,
      total: SUBSCRIPTIONS.length
    },
    watching: { channel: CHANNEL_NAME, blerpBot: BLERP_BOT },
    uptime_sec: Math.round(process.uptime())
  });
});

// Test endpoint — manually fire a fake event to verify wiring
app.get('/test/:type', (req, res) => {
  const samples = {
    resub: { type: 'resub', displayName: 'TestUser', user: 'testuser', months: 5 },
    sub: { type: 'sub', displayName: 'TestUser', user: 'testuser' },
    giftsub1: { type: 'giftsub', displayName: 'TestUser', user: 'testuser', count: 1 },
    giftsub3: { type: 'giftsub', displayName: 'TestUser', user: 'testuser', count: 3 },
    giftsub10: { type: 'giftsub', displayName: 'TestUser', user: 'testuser', count: 10 },
    cheer: { type: 'cheer', displayName: 'TestUser', user: 'testuser', bits: 200 },
    bigcheer: { type: 'cheer', displayName: 'TestUser', user: 'testuser', bits: 1000 },
    blerp: { type: 'blerp', displayName: 'TestUser', user: 'testuser', bits: 100 }
  };
  const event = samples[req.params.type];
  if (!event) return res.status(404).json({ error: 'unknown test type', available: Object.keys(samples) });
  event.id = `test-${Date.now()}`;
  broadcast(event);
  res.json({ fired: event });
});

// Stress test — fires a mixed burst of every event type with random names
app.get('/test-burst', (req, res) => {
  const names = ['Teresa', 'Luke', 'Awkward', 'Jax', 'BubbleTeaQ', 'Doc', 'Vino', 'Suze', 'VanishArmy'];
  const pick = () => names[Math.floor(Math.random() * names.length)];
  const events = [
    { type: 'resub',   displayName: pick(), user: pick().toLowerCase(), months: 12 },
    { type: 'giftsub', displayName: pick(), user: pick().toLowerCase(), count: 1 },
    { type: 'giftsub', displayName: pick(), user: pick().toLowerCase(), count: 3 },
    { type: 'giftsub', displayName: pick(), user: pick().toLowerCase(), count: 10 },
    { type: 'cheer',   displayName: pick(), user: pick().toLowerCase(), bits: 150 },
    { type: 'cheer',   displayName: pick(), user: pick().toLowerCase(), bits: 1000 },
    { type: 'blerp',   displayName: pick(), user: pick().toLowerCase(), bits: 50 },
    { type: 'blerp',   displayName: pick(), user: pick().toLowerCase(), bits: 750 }
  ];
  events.forEach((e, i) => {
    e.id = `burst-${Date.now()}-${i}`;
    setTimeout(() => broadcast(e), i * 400); // stagger so the widget doesn't blur them
  });
  res.json({ fired: events.length, note: 'staggered over ~3 seconds' });
});

// ============================================================================
// Twitch EventSub WebSocket
// ============================================================================
let twitchWs;
let sessionId;
let eventSubState = 'disconnected';
let reconnectTimer;
const activeSubscriptions = new Set();
const failedSubscriptions = new Map(); // type → { status, message, at }
const seenEventIds = new Set();

const SUBSCRIPTIONS = [
  { type: 'channel.subscribe',             version: '1' },
  { type: 'channel.subscription.message',  version: '1' },  // resubs
  { type: 'channel.subscription.gift',     version: '1' },
  { type: 'channel.cheer',                 version: '1' }
  // Blerps are NOT in EventSub — they come from the Blerp bot's chat
  // messages via the IRC parser below. channel.bits.use was unreliable
  // for Blerp bit amounts last time.
];

// Ask Twitch which client_id / scopes / account this token belongs to, then use
// that client_id for all API calls so it always matches the token. Also surfaces
// missing scopes and expiry in the logs and /health so problems are obvious.
async function validateToken() {
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${currentToken}` }
    });

    if (res.status !== 200) {
      const txt = await res.text().catch(() => '');
      console.error(`[Token] ❌ Validation failed (${res.status}) — token is invalid or expired. Generate a new TWITCH_USER_TOKEN. ${txt}`);
      tokenInfo = { valid: false, status: res.status, checkedAt: new Date().toISOString() };
      return;
    }

    const data = await res.json();
    effectiveClientId = data.client_id || CLIENT_ID;

    const scopes = data.scopes || [];
    // Twitch returns expires_in: 0 for tokens that never expire. Treating that
    // as "expired" would send us into a refresh loop, and every refresh
    // invalidates the token that created our EventSub subscriptions — which
    // makes Twitch silently drop them. So track "never expires" explicitly.
    const neverExpires = !data.expires_in;
    const days = Math.round((data.expires_in || 0) / 86400);
    tokenInfo = {
      valid: true,
      login: data.login,
      clientId: data.client_id,
      scopes,
      expiresInSec: data.expires_in,
      neverExpires,
      checkedAt: new Date().toISOString()
    };

    console.log(`[Token] ✅ Valid — account: ${data.login}, client_id: ${data.client_id}`);
    console.log(`[Token]    scopes: ${scopes.join(', ') || '(none)'}`);
    console.log(`[Token]    ${neverExpires ? 'does not expire' : `expires in ~${days} day(s)`}`);

    if (CLIENT_ID && data.client_id && data.client_id !== CLIENT_ID) {
      console.warn(`[Token] ⚠️  Token's client_id (${data.client_id}) differs from TWITCH_CLIENT_ID env (${CLIENT_ID}). Using the token's client_id so they match.`);
    }

    const needed = ['bits:read', 'channel:read:subscriptions'];
    const missing = needed.filter(s => !scopes.includes(s));
    if (missing.length) {
      console.warn(`[Token] ⚠️  Missing scope(s): ${missing.join(', ')}. Regenerate the token with these enabled or those events won't fire.`);
    }
  } catch (e) {
    console.error('[Token] ❌ Validation error:', e.message);
    tokenInfo = { valid: false, error: e.message, checkedAt: new Date().toISOString() };
  }
}

// Exchange the refresh token for a fresh access token via twitchtokengenerator's
// refresh API (it holds the client secret, so we don't need it here). Tokens not
// generated on that site won't refresh this way — see TWITCH_REFRESH_TOKEN notes
// in the README. Returns true if a new access token was obtained.
async function refreshAccessToken(reason) {
  if (!currentRefresh) {
    console.warn('[Token] No TWITCH_REFRESH_TOKEN set — cannot auto-refresh. Add it in Render to enable hands-off renewal.');
    return false;
  }
  try {
    console.log(`[Token] 🔄 Refreshing access token (${reason})...`);
    const res = await fetch(`https://twitchtokengenerator.com/api/refresh/${encodeURIComponent(currentRefresh)}`);
    const data = await res.json().catch(() => ({}));

    const newAccess = data.token || data.access_token;
    const newRefresh = data.refresh || data.refresh_token;

    if (res.status === 200 && data.success !== false && newAccess) {
      currentToken = newAccess;
      if (newRefresh) currentRefresh = newRefresh;  // use rotated refresh token if returned
      console.log('[Token] ✅ Access token refreshed.');
      return true;
    }

    console.error('[Token] ❌ Refresh failed:', data.message || data.error || JSON.stringify(data).slice(0, 200));
    return false;
  } catch (e) {
    console.error('[Token] ❌ Refresh error:', e.message);
    return false;
  }
}

// Self-rescheduling token renewal. Each run refreshes the access token and then
// schedules the next run a bit before the new token's expiry — so it works
// whether the token lasts a few hours (twitchtokengenerator's default) or weeks.
// Refreshing slightly early is harmless; we just always get a fresh token.
function scheduleTokenMaintenance() {
  if (!currentRefresh) return;  // no refresh token → nothing to schedule (manual mode)
  if (refreshTimer) clearTimeout(refreshTimer);

  // A non-expiring token must never be refreshed on a timer: refreshing
  // invalidates the old token, and Twitch drops every EventSub subscription
  // created with it. Just re-validate daily to catch manual revocation.
  if (tokenInfo.valid && tokenInfo.neverExpires) {
    console.log('[Token] ⏰ Token does not expire — no auto-refresh needed. Re-checking daily.');
    refreshTimer = setTimeout(async () => {
      await validateToken();
      if (!tokenInfo.valid) await renewAndResubscribe('token no longer valid');
      scheduleTokenMaintenance();
    }, 24 * 60 * 60 * 1000);
    return;
  }

  const BUFFER_SEC = 30 * 60;        // renew ~30 min before expiry
  const MIN_SEC = 5 * 60;            // never sooner than 5 min (avoids tight loops)
  const MAX_SEC = 24 * 60 * 60;      // and at least once a day (setTimeout-safe)

  let delaySec = MAX_SEC;
  if (tokenInfo.valid && tokenInfo.expiresInSec) {
    delaySec = Math.min(Math.max(tokenInfo.expiresInSec - BUFFER_SEC, MIN_SEC), MAX_SEC);
  } else if (!tokenInfo.valid) {
    delaySec = MIN_SEC;              // token already dead — retry soon
  }

  console.log(`[Token] ⏰ Next auto-refresh in ~${Math.round(delaySec / 60)} min`);
  refreshTimer = setTimeout(async () => {
    await renewAndResubscribe('scheduled renewal');
    scheduleTokenMaintenance();     // reschedule based on the new token's expiry
  }, delaySec * 1000);
}

// Refreshing swaps in a new access token, and Twitch drops the EventSub
// subscriptions that were created with the previous one. So any successful
// refresh must be followed by reconnecting EventSub to recreate them.
async function renewAndResubscribe(reason) {
  const ok = await refreshAccessToken(reason);
  if (!ok) return false;
  await validateToken();
  console.log('[Token] ↻ Reconnecting EventSub to recreate subscriptions with the new token...');
  activeSubscriptions.clear();
  try { twitchWs && twitchWs.close(); } catch {}   // 'close' handler reconnects + re-subscribes
  return true;
}

function connectEventSub(url = 'wss://eventsub.wss.twitch.tv/ws') {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  eventSubState = 'connecting';
  console.log(`[EventSub] Connecting to ${url}`);

  twitchWs = new WebSocket(url);

  twitchWs.on('open', () => {
    eventSubState = 'connected';
    console.log('[EventSub] WebSocket open');
  });

  twitchWs.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch (e) { console.error('[EventSub] Bad JSON:', e); return; }

    const messageType = msg.metadata?.message_type;

    if (messageType === 'session_welcome') {
      sessionId = msg.payload.session.id;
      console.log(`[EventSub] Session welcome — id: ${sessionId}`);
      await subscribeAll();
      return;
    }

    if (messageType === 'session_reconnect') {
      const newUrl = msg.payload.session.reconnect_url;
      console.log('[EventSub] Reconnect requested → switching to', newUrl);
      try { twitchWs.close(); } catch {}
      activeSubscriptions.clear();
      connectEventSub(newUrl);
      return;
    }

    if (messageType === 'session_keepalive') {
      return; // No-op
    }

    if (messageType === 'notification') {
      handleNotification(msg.payload, msg.metadata.message_id);
      return;
    }

    if (messageType === 'revocation') {
      console.warn('[EventSub] Subscription revoked:', msg.payload.subscription.type, msg.payload.subscription.status);
      return;
    }
  });

  twitchWs.on('close', (code, reason) => {
    eventSubState = 'disconnected';
    console.warn(`[EventSub] Closed (code=${code}, reason=${reason}). Reconnecting in 5s.`);
    activeSubscriptions.clear();
    reconnectTimer = setTimeout(() => connectEventSub(), 5000);
  });

  twitchWs.on('error', (err) => {
    console.error('[EventSub] WebSocket error:', err.message);
  });
}

async function subscribeAll(isRetry = false) {
  console.log(`[EventSub] Creating ${SUBSCRIPTIONS.length} subscriptions...`);
  let saw401 = false;
  for (const sub of SUBSCRIPTIONS) {
    try {
      const body = {
        type: sub.type,
        version: sub.version,
        condition: { broadcaster_user_id: BROADCASTER_ID },
        transport: { method: 'websocket', session_id: sessionId }
      };

      const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: {
          'Client-Id': effectiveClientId,
          'Authorization': `Bearer ${currentToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const json = await res.json().catch(() => ({}));
      if (res.status === 202) {
        activeSubscriptions.add(sub.type);
        failedSubscriptions.delete(sub.type);
        console.log(`  ✅ ${sub.type}`);
      } else {
        failedSubscriptions.set(sub.type, {
          status: res.status,
          message: json.message || JSON.stringify(json).slice(0, 200),
          at: new Date().toISOString()
        });
        console.error(`  ❌ ${sub.type} → ${res.status}:`, json.message || json);
        if (res.status === 401) {
          saw401 = true;
          console.error('  ⚠️  TOKEN INVALID OR EXPIRED.');
        } else if (res.status === 403) {
          console.error('  ⚠️  Token lacks required scope for this event. Regenerate with bits:read + channel:read:subscriptions.');
        }
      }
    } catch (e) {
      failedSubscriptions.set(sub.type, { status: 'exception', message: e.message, at: new Date().toISOString() });
      console.error(`  ❌ ${sub.type} → exception:`, e.message);
    }
  }

  // A 401 means the access token died — try a refresh and re-subscribe once.
  if (saw401 && !isRetry && currentRefresh) {
    const ok = await refreshAccessToken('401 during subscribe');
    if (ok) {
      await validateToken();
      activeSubscriptions.clear();
      return subscribeAll(true);
    }
  }

  // Summary log
  if (failedSubscriptions.size > 0) {
    console.error(`[EventSub] ⚠️  ${failedSubscriptions.size} of ${SUBSCRIPTIONS.length} subscriptions failed. Check /health for details.`);
  } else {
    console.log(`[EventSub] ✨ All ${SUBSCRIPTIONS.length} subscriptions active.`);
  }
}

function handleNotification(payload, messageId) {
  // Twitch dedupe — Twitch may resend messages, so we drop already-seen IDs
  if (seenEventIds.has(messageId)) return;
  seenEventIds.add(messageId);
  if (seenEventIds.size > 1000) {
    const arr = [...seenEventIds];
    for (let i = 0; i < 200; i++) seenEventIds.delete(arr[i]);
  }

  const subType = payload.subscription.type;
  const event = payload.event;
  const baseId = `${subType}:${messageId}`;

  switch (subType) {
    case 'channel.subscribe':
      // Skip gifted subs here — channel.subscription.gift handles those separately
      if (event.is_gift) return;
      broadcast({
        type: 'sub',
        id: baseId,
        displayName: event.user_name || event.user_login,
        user: event.user_login,
        tier: event.tier
      });
      break;

    case 'channel.subscription.message':
      broadcast({
        type: 'resub',
        id: baseId,
        displayName: event.user_name || event.user_login,
        user: event.user_login,
        months: event.cumulative_months || 1,
        tier: event.tier
      });
      break;

    case 'channel.subscription.gift':
      broadcast({
        type: 'giftsub',
        id: baseId,
        displayName: event.is_anonymous ? 'Anonymous' : (event.user_name || event.user_login || 'Anonymous'),
        user: event.user_login || 'anonymous',
        count: event.total || 1,
        tier: event.tier
      });
      break;

    case 'channel.cheer':
      broadcast({
        type: 'cheer',
        id: baseId,
        displayName: event.is_anonymous ? 'Anonymous' : (event.user_name || event.user_login),
        user: event.user_login,
        bits: event.bits
      });
      break;

    default:
      console.log('[EventSub] Unhandled notification type:', subType);
  }
}

// ============================================================================
// Blerp bot IRC parser (matches the working pattern from asiandiva-bits-tracker)
//
// Connects to Twitch IRC over raw TCP (irc.chat.twitch.tv:6667) anonymously.
// Listens for chat messages from the Blerp bot. Message format:
//   [viewer] played [title] [tts] Blerp for [bits] [playtype]!
// Parses out the bit amount and viewer name and broadcasts a 'blerp' event.
// ============================================================================
const net = require('net');
let ircClient;
let ircReconnectTimer;
let ircState = 'disconnected';

function connectIRC() {
  if (ircReconnectTimer) { clearTimeout(ircReconnectTimer); ircReconnectTimer = null; }
  ircState = 'connecting';
  console.log(`[IRC] Connecting to irc.chat.twitch.tv → #${CHANNEL_NAME}, watching for "${BLERP_BOT}"...`);

  ircClient = new net.Socket();
  let buffer = '';

  ircClient.connect(6667, 'irc.chat.twitch.tv', () => {
    ircClient.write('PASS oauth:justinfan12345\r\n');
    ircClient.write('NICK justinfan12345\r\n');
    ircClient.write(`JOIN #${CHANNEL_NAME}\r\n`);
    ircState = 'connected';
    console.log(`[IRC] Connected → #${CHANNEL_NAME}`);
  });

  ircClient.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\r\n');
    buffer = lines.pop(); // keep incomplete line for next chunk

    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('PING')) {
        ircClient.write('PONG :tmi.twitch.tv\r\n');
        continue;
      }

      // :username!username@username.tmi.twitch.tv PRIVMSG #channel :message
      const match = line.match(/^:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\w+ :(.+)$/);
      if (!match) continue;

      const username = match[1].toLowerCase();
      const message  = match[2];

      if (username !== BLERP_BOT) continue;

      console.log(`[Blerp] ${BLERP_BOT}: ${message}`);

      // Pull bit amount: "...Blerp for 100 once!" → 100
      const bitsMatch = message.match(/for\s+(\d+)\s+/i);
      if (!bitsMatch) {
        console.log(`[Blerp] Couldn't parse bits from: "${message}"`);
        continue;
      }
      const bits = parseInt(bitsMatch[1], 10);
      const viewerName = message.split(' ')[0]; // first word is the viewer

      broadcast({
        type: 'blerp',
        id: `blerp-irc:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        displayName: viewerName,
        user: viewerName.toLowerCase(),
        bits
      });
    }
  });

  ircClient.on('close', () => {
    ircState = 'disconnected';
    console.warn('[IRC] Disconnected — reconnecting in 5s');
    ircReconnectTimer = setTimeout(connectIRC, 5000);
  });

  ircClient.on('error', (err) => {
    console.error('[IRC] Error:', err.message);
    // 'close' will fire after error and trigger reconnect
  });
}

// ============================================================================
// Boot
// ============================================================================
app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Widget: http://localhost:${PORT}/`);
  console.log(`[Server] SSE:    http://localhost:${PORT}/events`);
  console.log(`[Server] Health: http://localhost:${PORT}/health`);
  console.log(`[Server] Test:   http://localhost:${PORT}/test/cheer   (or resub, giftsub3, giftsub10, blerp, etc.)`);
  console.log('');
});

async function start() {
  // Validate first so we know the token's real client_id before subscribing.
  await validateToken();

  // If the stored access token is dead but we have a refresh token, renew now.
  if (!tokenInfo.valid && currentRefresh) {
    const ok = await refreshAccessToken('startup — token invalid/expired');
    if (ok) await validateToken();
  }

  connectEventSub();
  connectIRC();
  scheduleTokenMaintenance();  // keeps the token alive long-term (no-op without a refresh token)
  startSubscriptionWatchdog();
}

// Safety net: Twitch can silently drop subscriptions (e.g. if the token that
// created them is invalidated) while the WebSocket still looks connected. That
// leaves the widget dead with no error anywhere. Notice it and reconnect.
function startSubscriptionWatchdog() {
  setInterval(() => {
    if (eventSubState !== 'connected') return;      // reconnect logic already handles this
    if (activeSubscriptions.size > 0) return;       // healthy
    if (failedSubscriptions.size > 0) return;       // real errors are already reported

    console.warn('[EventSub] ⚠️  Connected but 0 active subscriptions — they were dropped. Reconnecting...');
    try { twitchWs && twitchWs.close(); } catch {}  // 'close' handler reconnects + re-subscribes
  }, 5 * 60 * 1000);  // every 5 minutes
}

start();
