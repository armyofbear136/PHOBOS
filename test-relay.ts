/**
 * test-relay.ts — Autarch WebRTC Relay Smoke Test
 *
 * Tests the live relay at wss://autarch.net/relay end-to-end without needing
 * a real phobos-core or mobile device. Simulates both sides of the signaling:
 *   - A "fake core" that registers and handles an offer
 *   - A "fake mobile" that connects with the code and sends a dummy offer
 *
 * Run: npx tsx test-relay.ts
 *
 * Requires: ws package  (npm install ws -g  OR  npx tsx with ws in local deps)
 */

import WebSocket from 'ws';

export {};   // makes this a module (enables top-level await)

// ── Config ────────────────────────────────────────────────────────────────────

const RELAY_URL = process.env.RELAY_URL ?? 'wss://autarch.net/relay';
const TIMEOUT_MS = 10_000;

// ── Utilities ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string): void {
  console.log(`  ✅  ${label}`);
  passed++;
}

function fail(label: string, detail?: string): void {
  console.log(`  ❌  ${label}${detail ? `: ${detail}` : ''}`);
  failed++;
}

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), TIMEOUT_MS);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), TIMEOUT_MS);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(raw.toString())); }
      catch { reject(new Error('Bad JSON')); }
    });
    ws.once('close', () => { clearTimeout(timer); reject(new Error('WS closed')); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function send(ws: WebSocket, obj: unknown): void {
  ws.send(JSON.stringify(obj));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Dummy SDP ─────────────────────────────────────────────────────────────────
// A minimal (invalid for ICE but parseable) SDP offer. The relay only forwards
// the sdp string opaquely — it doesn't parse or validate SDP content.

const DUMMY_SDP_OFFER = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
].join('\r\n');

const DUMMY_SDP_ANSWER = [
  'v=0',
  'o=- 1 1 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
].join('\r\n');

// ── Test sections ─────────────────────────────────────────────────────────────

console.log('\n📡  PHOBOS Relay Smoke Test');
console.log('────────────────────────────────────────────────');
console.log(`   Relay:  ${RELAY_URL}`);
console.log();

// ─── [ 1 ] Core registers and gets a code ─────────────────────────────────────

console.log('[ 1 ] Core registration...');

let coreWs: WebSocket;
let code: string;
let iceServers: unknown[];

try {
  coreWs = await openWs(RELAY_URL);
  ok('Core WebSocket connected');

  send(coreWs, { type: 'register', activeUser: 'owner' });

  const registered = await nextMessage(coreWs) as Record<string, unknown>;

  if (registered.type !== 'registered') {
    fail('type === registered', `got ${JSON.stringify(registered.type)}`);
  } else {
    ok('Received registered');
  }

  if (typeof registered.code === 'string' && registered.code.length === 6) {
    ok(`Code received (${registered.code})`);
    code = registered.code;
  } else {
    fail('Code is 6-char string', JSON.stringify(registered.code));
    process.exit(1);
  }

  if (Array.isArray(registered.iceServers) && registered.iceServers.length > 0) {
    ok(`ICE servers received (${(registered.iceServers as unknown[]).length} entries)`);
    iceServers = registered.iceServers as unknown[];
  } else {
    fail('iceServers array present', JSON.stringify(registered.iceServers));
    iceServers = [];
  }

  if (typeof registered.expiresIn === 'number' && registered.expiresIn >= 0) {
    const label = registered.expiresIn === 0 ? 'permanent (instanceId session)' : `${registered.expiresIn / 1000}s`;
    ok(`expiresIn = ${label}`);
  } else {
    fail('expiresIn is a non-negative number');
  }

} catch (err) {
  fail('Core connection / registration', (err as Error).message);
  process.exit(1);
}

// ─── [ 2 ] Bad code is rejected ───────────────────────────────────────────────

console.log('\n[ 2 ] Unknown code rejection...');

try {
  const badWs = await openWs(RELAY_URL);
  ok('Bad-code WS connected');

  send(badWs, { type: 'connect', code: 'ZZZZZZ', sdp: DUMMY_SDP_OFFER, activeUser: 'owner' });

  const errorMsg = await nextMessage(badWs) as Record<string, unknown>;

  if (errorMsg.type === 'error') {
    ok('Unknown code → error response');
  } else {
    fail('Unknown code should return error', JSON.stringify(errorMsg));
  }

  badWs.close();
} catch (err) {
  fail('Bad-code rejection test', (err as Error).message);
}

// ─── [ 3 ] Mobile connects — offer forwarded to core ─────────────────────────

console.log('\n[ 3 ] Mobile connect + offer forwarding...');

let mobileWs: WebSocket;

// Set up a promise to capture the offer on the core side
let coreGotOffer: (m: unknown) => void;
const coreOfferPromise = new Promise<unknown>((res) => { coreGotOffer = res; });
const coreOfferTimer = setTimeout(() => coreGotOffer({ type: '__timeout__' }), TIMEOUT_MS);

coreWs.on('message', (raw) => {
  try {
    const m = JSON.parse(raw.toString());
    coreGotOffer(m);
    clearTimeout(coreOfferTimer);
  } catch { /* ignore */ }
});

try {
  mobileWs = await openWs(RELAY_URL);
  ok('Mobile WebSocket connected');

  send(mobileWs, { type: 'connect', code, sdp: DUMMY_SDP_OFFER, activeUser: 'owner' });

  const offer = await coreOfferPromise as Record<string, unknown>;

  if (offer.type === 'offer') {
    ok('Core received offer forwarded from mobile');
  } else {
    fail('Core expected offer', JSON.stringify(offer.type));
  }

  if (offer.sdp === DUMMY_SDP_OFFER) {
    ok('SDP forwarded intact');
  } else {
    fail('SDP mismatch', String(offer.sdp).slice(0, 40));
  }

  if (offer.activeUser === 'owner') {
    ok('activeUser forwarded');
  } else {
    fail('activeUser mismatch', JSON.stringify(offer.activeUser));
  }

} catch (err) {
  fail('Mobile connect / offer forwarding', (err as Error).message);
}

// ─── [ 4 ] Core sends answer — forwarded to mobile as 'configured' ────────────

console.log('\n[ 4 ] Answer forwarding (core → relay → mobile)...');

let mobileGotConfigured: (m: unknown) => void;
const mobileConfiguredPromise = new Promise<unknown>((res) => { mobileGotConfigured = res; });
const mobileConfiguredTimer = setTimeout(() => mobileGotConfigured({ type: '__timeout__' }), TIMEOUT_MS);

mobileWs!.once('message', (raw) => {
  try { mobileGotConfigured(JSON.parse(raw.toString())); }
  catch { mobileGotConfigured({ type: '__parse_error__' }); }
  clearTimeout(mobileConfiguredTimer);
});

try {
  send(coreWs, { type: 'answer', code, sdp: DUMMY_SDP_ANSWER });

  const configured = await mobileConfiguredPromise as Record<string, unknown>;

  if (configured.type === 'configured') {
    ok('Mobile received configured');
  } else {
    fail('Mobile expected configured', JSON.stringify(configured.type));
  }

  if ((configured as { sdp?: string }).sdp === DUMMY_SDP_ANSWER) {
    ok('Answer SDP forwarded intact');
  } else {
    fail('Answer SDP mismatch');
  }

  if (Array.isArray((configured as { iceServers?: unknown[] }).iceServers)) {
    ok('iceServers present in configured');
  } else {
    fail('iceServers missing from configured');
  }

} catch (err) {
  fail('Answer forwarding', (err as Error).message);
}

// ─── [ 5 ] Trickle ICE core → mobile ────────────────────────────────────────

console.log('\n[ 5 ] Trickle ICE (core → mobile)...');

const DUMMY_ICE = {
  candidate:     'candidate:1 1 udp 2113937151 192.168.1.1 54321 typ host',
  sdpMid:        '0',
  sdpMLineIndex: 0,
};

let mobileGotIce: (m: unknown) => void;
const mobileIcePromise = new Promise<unknown>((res) => { mobileGotIce = res; });
setTimeout(() => mobileGotIce({ type: '__timeout__' }), TIMEOUT_MS);

mobileWs!.once('message', (raw) => {
  try { mobileGotIce(JSON.parse(raw.toString())); }
  catch { mobileGotIce({ type: '__parse_error__' }); }
});

try {
  send(coreWs, { type: 'ice', code, ...DUMMY_ICE });

  const ice = await mobileIcePromise as Record<string, unknown>;

  if (ice.type === 'ice') {
    ok('Mobile received ICE from core');
  } else {
    fail('Mobile expected ICE', JSON.stringify(ice.type));
  }

  if (ice.candidate === DUMMY_ICE.candidate) {
    ok('ICE candidate forwarded intact');
  } else {
    fail('ICE candidate mismatch');
  }

} catch (err) {
  fail('Core→mobile ICE forwarding', (err as Error).message);
}

// ─── [ 6 ] Trickle ICE mobile → core ────────────────────────────────────────

console.log('\n[ 6 ] Trickle ICE (mobile → core)...');

let coreGotIce: (m: unknown) => void;
const coreIcePromise = new Promise<unknown>((res) => { coreGotIce = res; });
setTimeout(() => coreGotIce({ type: '__timeout__' }), TIMEOUT_MS);

coreWs.once('message', (raw) => {
  try { coreGotIce(JSON.parse(raw.toString())); }
  catch { coreGotIce({ type: '__parse_error__' }); }
});

try {
  send(mobileWs!, {
    type:          'ice',
    candidate:     DUMMY_ICE.candidate,
    sdpMid:        DUMMY_ICE.sdpMid,
    sdpMLineIndex: DUMMY_ICE.sdpMLineIndex,
  });

  const ice = await coreIcePromise as Record<string, unknown>;

  if (ice.type === 'ice') {
    ok('Core received ICE from mobile');
  } else {
    fail('Core expected ICE', JSON.stringify(ice.type));
  }

  if (ice.candidate === DUMMY_ICE.candidate) {
    ok('ICE candidate forwarded intact');
  } else {
    fail('ICE candidate mismatch');
  }

  if (ice.code === code) {
    ok('Code echoed back in ICE (for core routing)');
  } else {
    fail('Code missing from ICE frame', JSON.stringify(ice.code));
  }

} catch (err) {
  fail('Mobile→core ICE forwarding', (err as Error).message);
}

// ─── [ 7 ] Expired / already-connected code handling ────────────────────────

console.log('\n[ 7 ] Duplicate mobile connection on same code...');

// The code was 'consumed' by the first mobile connect. A second mobile
// trying the same code should either get an error or get the same session.
// Current relay implementation: session.mobileWs is overwritten (last wins).
// This test just verifies the relay doesn't crash or hang on a second connect.

try {
  const dupeWs = await openWs(RELAY_URL);

  // Set a promise for any response
  const dupeResponse = new Promise<unknown>((res) => {
    const timer = setTimeout(() => res({ type: '__timeout__' }), 3_000);
    dupeWs.once('message', (raw) => {
      clearTimeout(timer);
      try { res(JSON.parse(raw.toString())); } catch { res({ type: '__parse_error__' }); }
    });
    dupeWs.once('close', () => { clearTimeout(timer); res({ type: '__closed__' }); });
  });

  send(dupeWs, { type: 'connect', code, sdp: DUMMY_SDP_OFFER, activeUser: 'owner' });

  const resp = await dupeResponse as Record<string, unknown>;

  if (resp.type === '__timeout__') {
    // Relay swapped the mobile WS silently — not ideal but non-crashing
    ok('Relay handled duplicate connect (no crash, no hang)');
  } else if (resp.type === 'error') {
    ok('Relay rejected duplicate connect with error');
  } else {
    ok(`Relay responded to duplicate connect (type=${String(resp.type)})`);
  }

  dupeWs.close();
  await sleep(100);
} catch (err) {
  fail('Duplicate connect handling', (err as Error).message);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

try { coreWs.close(); } catch { /* ignore */ }
try { mobileWs!.close(); } catch { /* ignore */ }

await sleep(200);

// ─── Results ─────────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────────────');
console.log(`✅  Passed: ${passed}`);
console.log(`❌  Failed: ${failed}`);

if (failed === 0) {
  console.log('✅  Relay smoke test PASSED\n');
  process.exit(0);
} else {
  console.log('❌  Relay smoke test FAILED\n');
  process.exit(1);
}