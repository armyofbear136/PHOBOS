export {};

const BASE = 'http://127.0.0.1:18050';
const V8   = { 'Accept-Version': '8' };

const auth = await fetch(`${BASE}/api/auth`, {
  method: 'POST',
  headers: { ...V8, 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'phobos', password: 'phobos-test-pw' }),
});
const { token } = await auth.json() as { token: string };
console.log('Token:', token.substring(0, 8));

async function authed(path: string) {
  const r = await fetch(`${BASE}${path}`, { headers: { ...V8, 'Authorization': `Bearer ${token}` } });
  const body = await r.json().catch(() => null);
  console.log(`\n--- GET ${path} (${r.status}) ---`);
  console.log(JSON.stringify(body)?.substring(0, 600));
}

await authed('/api/albums?random=false&offset=0&count=3');
await authed('/api/artists?offset=0&count=3');

const artRes  = await fetch(`${BASE}/api/artists?offset=0&count=1`, { headers: { ...V8, 'Authorization': `Bearer ${token}` } });
const artData = await artRes.json() as any;
console.log('\nRaw artists response keys:', Object.keys(artData ?? {}));
const firstName = artData?.artists?.[0]?.name ?? artData?.items?.[0]?.name ?? (Array.isArray(artData) ? artData[0]?.name : null);
console.log('First artist name:', firstName);

if (firstName) {
  await authed(`/api/artist/${encodeURIComponent(firstName)}/albums?offset=0&count=5`);
  await authed(`/api/artist/${encodeURIComponent(firstName)}/songs?offset=0&count=3`);
}

await authed('/api/browse');
await authed('/api/index_status');
await authed('/api/playlists');
