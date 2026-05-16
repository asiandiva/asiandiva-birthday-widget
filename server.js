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
const BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID;
const CHANNEL_NAME = (process.env.TWITCH_CHANNEL || 'asiandiva__').toLowerCase();
const BLERP_BOT = (process.env.BLERP_BOT || 'blerp').toLowerCase();

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

async function subscribeAll() {
  console.log(`[EventSub] Creating ${SUBSCRIPTIONS.length} subscriptions...`);
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
          'Client-Id': CLIENT_ID,
          'Authorization': `Bearer ${USER_TOKEN}`,
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
          console.error('  ⚠️  TOKEN INVALID OR EXPIRED. Update TWITCH_USER_TOKEN env var.');
        } else if (res.status === 403) {
          console.error('  ⚠️  Token lacks required scope for this event. Regenerate with bits:read + channel:read:subscriptions.');
        }
      }
    } catch (e) {
      failedSubscriptions.set(sub.type, { status: 'exception', message: e.message, at: new Date().toISOString() });
      console.error(`  ❌ ${sub.type} → exception:`, e.message);
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

connectEventSub();
connectIRC();
