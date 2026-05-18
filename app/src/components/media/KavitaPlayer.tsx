const KAVITA_ORIGIN = 'http://localhost:18000';
const WINDOW_NAME   = 'kavita-reader';

let _win: Window | null = null;

function buildWinFeatures(): string {
  return [
    `width=${Math.min(window.screen.availWidth,  1400)}`,
    `height=${Math.min(window.screen.availHeight, 900)}`,
    'left=60',
    'top=40',
    'scrollbars=yes',
    'resizable=yes',
  ].join(',');
}

async function fetchKavitaToken(): Promise<{ token: string; username: string } | null> {
  try {
    const r = await fetch('/api/kavita/token');
    if (!r.ok) return null;
    return r.json() as Promise<{ token: string; username: string }>;
  } catch {
    return null;
  }
}

async function ensureOpen(dest: string): Promise<Window | null> {
  const auth = await fetchKavitaToken();

  const url = auth
    ? `${KAVITA_ORIGIN}/autologin.html?token=${encodeURIComponent(auth.token)}&username=${encodeURIComponent(auth.username)}&dest=${encodeURIComponent(dest)}`
    : dest;

  if (_win && !_win.closed) {
    _win.location.href = url;
    _win.focus();
  } else {
    _win = window.open(url, WINDOW_NAME, buildWinFeatures());
  }
  return _win;
}

// ── Public API ────────────────────────────────────────────────────────────────

export const KavitaPlayer = {
  openChapter(libraryId: number, seriesId: number, chapterId: number | null): Promise<Window | null> {
    const dest = chapterId !== null
      ? `${KAVITA_ORIGIN}/library/${libraryId}/series/${seriesId}/chapter/${chapterId}`
      : `${KAVITA_ORIGIN}/library/${libraryId}/series/${seriesId}`;
    return ensureOpen(dest);
  },

  openSeries(libraryId: number, seriesId: number): Promise<Window | null> {
    return ensureOpen(`${KAVITA_ORIGIN}/library/${libraryId}/series/${seriesId}`);
  },

  openLibrary(): Promise<Window | null> {
    return ensureOpen(KAVITA_ORIGIN);
  },

  isOpen(): boolean {
    return _win !== null && !_win.closed;
  },

  close(): void {
    if (_win && !_win.closed) _win.close();
    _win = null;
  },

  getWindow(): Window | null {
    return _win && !_win.closed ? _win : null;
  },
};

export default KavitaPlayer;