import { CAMOFOX_PORT } from './CamofoxManager.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = `http://127.0.0.1:${CAMOFOX_PORT}`;

// All PHOBOS browse calls share a single userId so cookies and session state
// persist across multi-step task sequences within the same conversation.
// The persistent Firefox profile is stored at ~/.camofox/profiles/phobos-agent/.
const SESSION_USER = 'phobos-agent';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BrowseResult {
  url:      string;
  title:    string;
  snapshot: string;   // ARIA accessibility tree — ~90% smaller than raw HTML
  error?:   string;
}

export interface YoutubeTranscriptResult {
  url:        string;
  title:      string;
  transcript: string;
  error?:     string;
}

// Shape returned by POST /tabs
interface TabCreatedResponse {
  tabId: string;
}

// Shape returned by GET|POST /tabs/:id/snapshot
interface SnapshotResponse {
  title?:    string;
  snapshot?: string;
  url?:      string;
  hasMore?:  boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function camofoxPost(
  urlPath: string,
  body: object,
  timeoutMs = 60_000
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${urlPath}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    if (!res.ok) throw new Error(`Camofox ${urlPath} → HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function createTab(): Promise<string> {
  // POST /tabs requires userId + sessionKey. sessionKey groups tabs within a
  // user session — we use a fixed key so all PHOBOS task tabs share one session.
  const result = await camofoxPost('/tabs', {
    userId:     SESSION_USER,
    sessionKey: 'phobos-task',
  }) as TabCreatedResponse;
  return result.tabId;
}

async function closeTab(tabId: string): Promise<void> {
  try {
    await camofoxPost(`/tabs/${tabId}/close`, { userId: SESSION_USER }, 5_000);
  } catch { /* non-fatal — tab may already be gone */ }
}

async function camofoxGet(urlPath: string, timeoutMs = 60_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${urlPath}`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Camofox ${urlPath} → HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getSnapshot(tabId: string): Promise<BrowseResult> {
  // GET /tabs/:id/snapshot?userId=... — userId is a query param, not a body field
  const snap = await camofoxGet(
    `/tabs/${tabId}/snapshot?userId=${encodeURIComponent(SESSION_USER)}`
  ) as SnapshotResponse;

  let snapshot = snap.snapshot ?? '';

  // Paginate if the page was truncated — fetch up to 2 more pages to stay
  // within a reasonable context budget. Each page is 50 000 chars.
  if (snap.hasMore) {
    let offset = snapshot.length;
    for (let page = 0; page < 2; page++) {
      const next = await camofoxGet(
        `/tabs/${tabId}/snapshot?userId=${encodeURIComponent(SESSION_USER)}&offset=${offset}`
      ) as SnapshotResponse;
      snapshot += '\n' + (next.snapshot ?? '');
      offset += next.snapshot?.length ?? 0;
      if (!next.hasMore) break;
    }
  }

  return {
    url:      snap.url      ?? '',
    title:    snap.title    ?? '',
    snapshot,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Navigate to a URL and return an ARIA accessibility snapshot.
 * The snapshot is token-efficient text suitable for direct LLM injection.
 */
export async function browseUrl(url: string): Promise<BrowseResult> {
  const tabId = await createTab();
  try {
    await camofoxPost(`/tabs/${tabId}/navigate`, { userId: SESSION_USER, url });
    return await getSnapshot(tabId);
  } catch (err) {
    return { url, title: '', snapshot: '', error: (err as Error).message };
  } finally {
    await closeTab(tabId);
  }
}

/**
 * Execute a named search macro and return the result as a snapshot.
 * macro examples: '@google_search', '@youtube_search', '@reddit_subreddit',
 *                 '@wikipedia_search', '@amazon_search'
 */
export async function browseSearch(macro: string, query: string): Promise<BrowseResult> {
  const tabId = await createTab();
  try {
    await camofoxPost(`/tabs/${tabId}/navigate`, { userId: SESSION_USER, macro, query });
    return await getSnapshot(tabId);
  } catch (err) {
    return {
      url:      `${macro}:${query}`,
      title:    '',
      snapshot: '',
      error:    (err as Error).message,
    };
  } finally {
    await closeTab(tabId);
  }
}

/**
 * Extract a YouTube video title from the page snapshot.
 * YouTube SPAs often return an empty `title` field from the accessibility
 * snapshot endpoint — the actual title appears as a heading in the snapshot text.
 * Tries, in order: snapshot title field → first [heading] line → first line.
 */
function extractYoutubeTitle(snapshotTitle: string | undefined, snapshotText: string): string {
  if (snapshotTitle && snapshotTitle.trim()) return snapshotTitle.trim();

  // Accessibility snapshots mark headings with [heading] prefix
  const headingMatch = snapshotText.match(/\[heading\]\s*(.+)/);
  if (headingMatch) return headingMatch[1].trim();

  // Fall back to first non-empty line
  const firstLine = snapshotText.split('\n').map(l => l.trim()).find(l => l.length > 3);
  return firstLine ?? '';
}

/**
 * Fetch the transcript/captions of a YouTube video.
 *
 * Strategy (tried in order):
 * 1. YouTube timedtext API (json3 format) — fast, works for manually-captioned videos
 * 2. YouTube timedtext API (srv3 format) — alternative format, broader compatibility
 * 3. Navigate to the watch page and return accessible page text — always works,
 *    returns title + description + any visible transcript panel text
 *
 * The redf0x1/camofox-browser fork has no /youtube/transcript REST endpoint,
 * so all extraction goes through the browser.
 */
export async function fetchYoutubeTranscript(url: string): Promise<YoutubeTranscriptResult> {
  const videoIdMatch = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (!videoIdMatch) {
    return { url, title: '', transcript: '', error: 'Could not extract YouTube video ID from URL' };
  }
  const videoId = videoIdMatch[1];

  const tabId = await createTab();
  try {
    // ── Strategy 1 & 2: timedtext API ─────────────────────────────────────────
    // Try both json3 and srv3 formats. json3 works for manually-captioned videos;
    // srv3 has broader compatibility for auto-generated captions.
    for (const fmt of ['json3', 'srv3'] as const) {
      const captionUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=${fmt}`;
      try {
        await camofoxPost(`/tabs/${tabId}/navigate`, { userId: SESSION_USER, url: captionUrl });
        const snap = await camofoxGet(
          `/tabs/${tabId}/snapshot?userId=${encodeURIComponent(SESSION_USER)}`
        ) as SnapshotResponse;

        const raw = snap.snapshot ?? '';
        if (!raw || raw.length < 20) continue; // empty response — try next format

        let transcript = '';

        if (fmt === 'json3') {
          try {
            const jsonStart = raw.indexOf('{');
            const jsonEnd   = raw.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1) {
              const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as {
                events?: Array<{ segs?: Array<{ utf8?: string }> }>;
              };
              transcript = (parsed.events ?? [])
                .flatMap(e => e.segs ?? [])
                .map(s => s.utf8 ?? '')
                .filter(t => t.trim())
                .join(' ')
                .replace(/\s{2,}/g, ' ')
                .trim();
            }
          } catch { /* fall through to srv3 */ }
        } else {
          // srv3 is XML — extract text content between <text> tags
          transcript = [...raw.matchAll(/<text[^>]*>([^<]+)<\/text>/g)]
            .map(m => m[1].trim())
            .filter(Boolean)
            .join(' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
        }

        if (transcript.length > 20) {
          // Navigate to the actual video page to get the title.
          // pageSnap.title may be empty for YouTube SPAs — fall back to
          // extracting the first [heading] line from the accessibility snapshot.
          await camofoxPost(`/tabs/${tabId}/navigate`, { userId: SESSION_USER, url });
          const pageSnap = await camofoxGet(
            `/tabs/${tabId}/snapshot?userId=${encodeURIComponent(SESSION_USER)}`
          ) as SnapshotResponse;
          const title = extractYoutubeTitle(pageSnap.title, pageSnap.snapshot ?? '');
          return { url, title, transcript };
        }
      } catch { /* strategy failed — try next */ }
    }

    // ── Strategy 3: watch page snapshot ───────────────────────────────────────
    // Navigate to the video page and return all accessible text. This always
    // returns something useful (title, description, comments) even when captions
    // are disabled. The transcript panel text appears here if it's open.
    await camofoxPost(`/tabs/${tabId}/navigate`, { userId: SESSION_USER, url });
    const pageSnap = await camofoxGet(
      `/tabs/${tabId}/snapshot?userId=${encodeURIComponent(SESSION_USER)}`
    ) as SnapshotResponse;

    const pageText = (pageSnap.snapshot ?? '').trim();
    const title    = extractYoutubeTitle(pageSnap.title, pageSnap.snapshot ?? '');

    if (pageText.length > 20) {
      return {
        url,
        title,
        // Prefix makes it clear this is page content, not a clean transcript
        transcript: `[Page content — captions unavailable]\n${pageText.slice(0, 50_000)}`,
      };
    }

    return { url, title: '', transcript: '', error: 'Could not retrieve transcript or page content for this video' };

  } catch (err) {
    return { url, title: '', transcript: '', error: (err as Error).message };
  } finally {
    await closeTab(tabId);
  }
}

/**
 * Multi-step interactive session — holds a tab open across multiple operations.
 * Used when a task requires: navigate → click → fill form → extract result.
 * Always call close() when done to release the tab.
 */
export class BrowseSession {
  private tabId: string | null = null;

  async open(url: string): Promise<BrowseResult> {
    this.tabId = await createTab();
    await camofoxPost(`/tabs/${this.tabId}/navigate`, { userId: SESSION_USER, url });
    return getSnapshot(this.tabId);
  }

  async navigate(url: string): Promise<BrowseResult> {
    if (!this.tabId) throw new Error('BrowseSession: no open tab');
    await camofoxPost(`/tabs/${this.tabId}/navigate`, { userId: SESSION_USER, url });
    return getSnapshot(this.tabId);
  }

  async click(ref: string): Promise<BrowseResult> {
    if (!this.tabId) throw new Error('BrowseSession: no open tab');
    await camofoxPost(`/tabs/${this.tabId}/click`, { userId: SESSION_USER, ref });
    return getSnapshot(this.tabId);
  }

  async type(ref: string, text: string, pressEnter = false): Promise<BrowseResult> {
    if (!this.tabId) throw new Error('BrowseSession: no open tab');
    await camofoxPost(`/tabs/${this.tabId}/type`, { userId: SESSION_USER, ref, text, pressEnter });
    return getSnapshot(this.tabId);
  }

  async snapshot(): Promise<BrowseResult> {
    if (!this.tabId) throw new Error('BrowseSession: no open tab');
    return getSnapshot(this.tabId);
  }

  async close(): Promise<void> {
    if (this.tabId) {
      await closeTab(this.tabId);
      this.tabId = null;
    }
  }
}
