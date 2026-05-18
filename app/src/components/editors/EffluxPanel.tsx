/**
 * EffluxPanel.tsx — Fullscreen DAW panel (Phase 2b — tracker UI live).
 *
 * Layout:
 *   ┌─ Toolbar (song title, SAVE, CLOSE) ───────────────────────────┐
 *   ├─ Transport (play/stop/record/loop/BPM/step readout) ──────────┤
 *   ├─ PatternTrackList (scrollable grid)                            │
 *   │     ChannelHeaders across top · step rows down                │
 *   │     Edit cursor is the green-bordered cell                    │
 *   │     Playback cursor is the translucent row highlight          │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Behaviour:
 *   • Keyboard input (QWERTY + ZXCV for notes, arrows for navigation,
 *     space to play, R to record) is handled globally by useKeyboardInput
 *     while the panel is mounted.
 *   • Step scheduling is driven by useTransportTick — subscribes to
 *     sequencer.playing and runs a rAF loop.
 *   • Play requires the WebAudio unlock gesture, handled by useAudioContext.
 *   • Save POSTs the song to /api/audio/daw/projects via DawApi.saveProject.
 *
 * Still silent in Phase 2b — AudioService.noteOn/noteOff are no-ops. The
 * note writes, cursor movement, save round-trip, and LED animation are the
 * 2b gate.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, AlertTriangle, Plus, FilePlus, FolderOpen, Folder, Save, Loader2, Check } from 'lucide-react';
import { useAppStore }       from '@/store/useAppStore';
import { useSongStore }      from '@/store/daw/useSongStore';
import { useSessionStore }   from '@/store/daw/useSessionStore';
import { useSequencerStore } from '@/store/daw/useSequencerStore';
import { useEditorStore }    from '@/store/daw/useEditorStore';
import { useAudioContext }   from '@/hooks/daw/useAudioContext';
import { useKeyboardInput }  from '@/hooks/daw/useKeyboardInput';
import { useTransportTick }  from '@/hooks/daw/useTransportTick';
import {
  saveSession,
  loadSession,
  openSessionFolder,
  SessionExistsError,
} from '@/components/audio/services/DawApi';
import AudioService from '@/components/audio/engine/services/audio-service';
import {
  serialize,
  deserialize,
  fromEffluxSong,
  PHOBOS_SESSION_EXTENSION,
  SessionFormatError,
} from '@/components/audio/engine/services/session-serializer';
import SongFactory          from '@/components/audio/engine/model/factories/song-factory';
import { Transport }         from '@/components/audio/efflux/Transport';
import { PatternTrackList }  from '@/components/audio/efflux/PatternTrackList';
import { NoteEntryEditor }   from '@/components/audio/efflux/NoteEntryEditor';
import { InstrumentEditor }  from '@/components/audio/efflux/InstrumentEditor';
import { InstrumentChainModal } from '@/components/audio/efflux/InstrumentChainModal';
import { EffluxBottomBar }   from '@/components/audio/efflux/EffluxBottomBar';
import { WaveformDisplay }   from '@/components/audio/efflux/WaveformDisplay';
import { ClipPropsPopover }  from '@/components/audio/efflux/ClipPropsPopover';
import { SessionPicker }     from '@/components/audio/efflux/SessionPicker';
import { useClipPopoverStore } from '@/store/daw/useClipPopoverStore';

const HEADER_HEIGHT_PX = 40;

// ── Toolbar ──────────────────────────────────────────────────────────────────

function EffluxToolbar({
  title, dirty, error,
  saving, justSaved, hasSession,
  onTitleChange,
  onNewSession, onSaveSession, onOpenSession, onOpenFolder,
  onClose, onNoteEntry,
}: {
  title:           string;
  dirty:           boolean;
  error:           string | null;
  saving:          boolean;
  justSaved:       boolean;
  hasSession:      boolean;
  onTitleChange:   (next: string) => void;
  onNewSession:    () => void;
  onSaveSession:   () => void;
  onOpenSession:   () => void;
  onOpenFolder:    () => void;
  onClose:         () => void;
  onNoteEntry:     () => void;
}) {
  const base  = 'flex items-center gap-2 px-4 py-1.5 text-sm font-terminal uppercase tracking-[0.12em] rounded-sm border transition-all disabled:opacity-30 disabled:cursor-not-allowed';
  const amber = `${base} border-phobos-amber/25 text-phobos-amber/60 hover:text-phobos-amber hover:border-phobos-amber/50`;
  const green = `${base} border-phobos-green/25 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/50`;

  // Inline title editing. Idle: looks like static text with a faint underline
  // that brightens on hover. Click → real input. Blur or Enter commits via
  // the parent's setTitle (which mutates session.meta.title in place).
  // We store a local buffer so partial edits don't fire bumps every keystroke.
  const [editing,    setEditing]    = useState(false);
  const [titleBuf,   setTitleBuf]   = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Re-sync the buffer when the upstream title changes (e.g. New Session
  // sets it to "Untitled", Open sets it to the loaded title). We only
  // overwrite the buffer when not editing — refusing to clobber the user's
  // mid-edit input.
  useEffect(() => {
    if (!editing) setTitleBuf(title);
  }, [title, editing]);

  const beginEdit = useCallback(() => {
    setTitleBuf(title);
    setEditing(true);
    // Defer focus to after the input mounts.
    queueMicrotask(() => {
      const el = inputRef.current;
      if (el) { el.focus(); el.select(); }
    });
  }, [title]);

  const commit = useCallback(() => {
    setEditing(false);
    const trimmed = titleBuf.trim();
    if (trimmed.length === 0) return;             // refuse blank — silently revert
    if (trimmed === title)    return;
    onTitleChange(trimmed);
  }, [titleBuf, title, onTitleChange]);

  const onTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setTitleBuf(title); }
  }, [commit, title]);

  return (
    <div className="h-14 flex items-center justify-between px-5 border-b border-border/30 bg-black/80 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-base font-terminal text-phobos-green/60 uppercase tracking-widest shrink-0">EFFLUX DAW</span>
        {hasSession && <div className="w-px h-4 bg-border/40 shrink-0" />}

        {/* Inline-editable title — only meaningful when a session is loaded.
            Without a session, there's nothing to name. */}
        {hasSession && (editing ? (
          <input
            ref={inputRef}
            value={titleBuf}
            onChange={(e) => setTitleBuf(e.target.value)}
            onBlur={commit}
            onKeyDown={onTitleKeyDown}
            className="text-sm font-mono bg-transparent border-b border-phobos-green/60 text-phobos-green focus:outline-none px-1 max-w-[320px] min-w-[120px]"
            placeholder="Untitled"
          />
        ) : (
          <button
            onClick={beginEdit}
            className="text-sm font-mono text-muted-foreground/70 hover:text-foreground border-b border-border/30 hover:border-border/70 transition-colors truncate max-w-[320px] px-1 cursor-text text-left"
            title="Click to rename"
          >
            {title || 'Untitled'}{dirty ? ' *' : ''}
          </button>
        ))}

        {error && (
          <>
            <div className="w-px h-4 bg-border/40 shrink-0" />
            <div className="flex items-center gap-1.5 text-destructive/70 min-w-0">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span className="text-sm font-mono truncate max-w-xs">{error}</span>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {/* Note-entry and Save are session-only — meaningless without an
            active session. New / Open / Open Folder remain visible because
            they're the entry points to GET a session. */}
        {hasSession && (
          <>
            <button onClick={onNoteEntry} className={green} title="Note entry at cursor">
              <Plus className="w-3.5 h-3.5" />
              Note
            </button>

            <div className="w-px h-4 bg-border/40 mx-1" />
          </>
        )}

        <button onClick={onNewSession} className={green} title="New session">
          <FilePlus className="w-3.5 h-3.5" />
          New
        </button>
        {hasSession && (
          <button
            onClick={onSaveSession}
            disabled={saving}
            className={justSaved ? green : amber}
            title="Save session to ~/.phobos/media/efflux/"
          >
            {saving      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : justSaved ? <Check   className="w-3.5 h-3.5" />
              :             <Save    className="w-3.5 h-3.5" />}
            {saving ? 'Saving' : justSaved ? 'Saved' : 'Save'}
          </button>
        )}
        <button onClick={onOpenSession} className={green} title="Open a saved session">
          <FolderOpen className="w-3.5 h-3.5" />
          Open
        </button>
        <button onClick={onOpenFolder} className={green} title="Open the sessions folder">
          <Folder className="w-3.5 h-3.5" />
          Open Folder
        </button>

        <div className="w-px h-4 bg-border/40 mx-1" />
        <button
          onClick={onClose}
          className="p-1.5 rounded text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-colors"
          title="Close panel"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

// ── No-session welcome screen ───────────────────────────────────────────────
//
// Replaces the body of the panel when there's no active session. The goal
// is to be informative — explain what the DAW is and what the chain modal
// does — without being a wall of text. Three concept cards using the same
// color language as InstrumentChainModal (green = instrument, amber = FX,
// blue = browser) so the visual vocabulary is consistent.

function EffluxWelcome({
  onNewSession, onOpenSession, onLoadTestSong, unlocking,
}: {
  onNewSession:   () => void;
  onOpenSession:  () => void;
  onLoadTestSong: () => void;
  unlocking:      boolean;
}) {
  return (
    <div className="relative flex-1 flex flex-col items-center justify-center px-8 py-10 overflow-y-auto">
      <div className="w-full max-w-3xl flex flex-col items-center gap-10">

        {/* Title block */}
        <div className="text-center flex flex-col gap-3">
          <h1 className="text-2xl font-terminal text-phobos-green/90 uppercase tracking-[0.18em]">
            Efflux DAW
          </h1>
          <p className="text-xs font-mono text-muted-foreground/70 leading-relaxed max-w-2xl">
            A tracker-style sequencer with a per-channel instrument chain. Build patterns step by step,
            pick the synth that drives each channel, then layer effects after it. Save your work as a session
            file to come back to later.
          </p>
        </div>

        {/* Three concept cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 w-full">

          {/* Channels */}
          <div className="rounded-sm border border-phobos-green/30 bg-phobos-green/[0.05] backdrop-blur-sm p-4 flex flex-col gap-2">
            <div className="text-[10px] font-terminal text-phobos-green/80 uppercase tracking-widest">
              01 — Channels
            </div>
            <div className="text-xs font-mono text-muted-foreground/70 leading-relaxed">
              Eight instrument channels arranged left to right. Each channel runs its own pattern of notes
              and has its own instrument chain. Click a header to select it; double-click to open its chain editor.
            </div>
          </div>

          {/* Instrument + FX chain */}
          <div className="rounded-sm border border-phobos-amber/30 bg-phobos-amber/[0.04] backdrop-blur-sm p-4 flex flex-col gap-2">
            <div className="text-[10px] font-terminal text-phobos-amber/80 uppercase tracking-widest">
              02 — Instrument Chain
            </div>
            <div className="text-xs font-mono text-muted-foreground/70 leading-relaxed">
              Each channel has one instrument (green) and a chain of effects (amber). Pick an instrument
              from the browser, then drop effects after it — signal flows down the chain into your mix.
              Bypass any slot to skip its processing.
            </div>
          </div>

          {/* Plugin browser */}
          <div className="rounded-sm border border-phobos-blue/30 bg-phobos-blue/[0.05] backdrop-blur-sm p-4 flex flex-col gap-2">
            <div className="text-[10px] font-terminal text-phobos-blue/80 uppercase tracking-widest">
              03 — Plugin Browser
            </div>
            <div className="text-xs font-mono text-muted-foreground/70 leading-relaxed">
              The chain editor includes a browser of every VST3 plugin discovered on this machine —
              both the bundled phobos plugins and your system VST3s. Drag, drop, or double-click to add.
            </div>
          </div>
        </div>

        {/* Primary call to action */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={onNewSession}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-terminal uppercase tracking-[0.12em] rounded-sm border border-phobos-green/50 text-phobos-green/90 bg-phobos-green/[0.05] hover:bg-phobos-green/[0.10] hover:border-phobos-green/80 transition-all"
            >
              <FilePlus className="w-4 h-4" />
              New Session
            </button>
            <span className="text-[10px] font-mono text-muted-foreground/40 uppercase tracking-widest">or</span>
            <button
              onClick={onOpenSession}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-terminal uppercase tracking-[0.12em] rounded-sm border border-phobos-green/30 text-phobos-green/70 hover:text-phobos-green/90 hover:border-phobos-green/60 transition-all"
            >
              <FolderOpen className="w-4 h-4" />
              Open Saved Session
            </button>
          </div>

          {/* TODO: remove before public release. */}
          <button
            onClick={onLoadTestSong}
            disabled={unlocking}
            className="mt-2 px-3 py-1 text-[9px] font-terminal uppercase tracking-[0.12em] rounded-sm border border-border/30 text-muted-foreground/40 hover:text-muted-foreground/70 hover:border-border/60 disabled:opacity-30 transition-colors"
          >
            Load Test Song (dev)
          </button>
        </div>

        {/* Footnote */}
        <p className="text-[10px] font-mono text-muted-foreground/35 text-center max-w-xl leading-relaxed">
          Sessions save to <span className="text-muted-foreground/55">~/.phobos/media/efflux/</span> as
          <span className="text-muted-foreground/55"> .phobos-session</span> files. Plugin chains, channel
          state, and patterns all persist together. Channel 0 is reserved by the phobos audio backend and
          is not surfaced in this editor.
        </p>
      </div>
    </div>
  );
}

// ── Dirty-prompt modal ──────────────────────────────────────────────────────
//
// Shown by handleNewSession and handlePickSession when there are unsaved
// changes. Three buttons: Save (run save then continue), Discard (continue
// without saving), Cancel (close, do nothing). The "what to do next" is
// passed in via `pendingAction` — no global state, just props.

function DirtyPrompt({
  open, onSave, onDiscard, onCancel,
}: {
  open:      boolean;
  onSave:    () => void;
  onDiscard: () => void;
  onCancel:  () => void;
}) {
  // Esc cancels. Same idiom as ClipPropsPopover.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const btn = 'px-4 py-1.5 text-xs font-terminal uppercase tracking-[0.12em] rounded-sm border transition-all';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[400px] max-w-[95vw] bg-background border border-phobos-amber/40 rounded-sm shadow-2xl"
      >
        <div className="px-5 py-4 border-b border-border/30">
          <h2 className="text-sm font-terminal uppercase tracking-[0.12em] text-phobos-amber">
            Unsaved changes
          </h2>
        </div>
        <div className="px-5 py-4 text-xs font-mono text-muted-foreground/80 leading-relaxed">
          You have unsaved changes in the current session. Save before continuing?
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/30">
          <button onClick={onCancel}  className={`${btn} border-border/40 text-muted-foreground/70 hover:text-foreground hover:border-border/70`}>
            Cancel
          </button>
          <button onClick={onDiscard} className={`${btn} border-destructive/40 text-destructive/80 hover:text-destructive hover:border-destructive/70`}>
            Discard
          </button>
          <button onClick={onSave}    className={`${btn} border-phobos-green/40 text-phobos-green/80 hover:text-phobos-green hover:border-phobos-green/70`}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Filename slugify (frontend half of the title→filename contract) ─────────
//
// Lowercase, replace any run of non-[a-z0-9] with a single hyphen, strip
// leading/trailing hyphens, fall back to "untitled" if empty. Periods in
// titles intentionally become hyphens (per Batch H confirmed UX) — the
// only dot in the result is the extension's. The backend re-validates.

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length === 0 ? 'untitled' : slug;
}

function filenameFor(title: string): string {
  return `${slugifyTitle(title)}.${PHOBOS_SESSION_EXTENSION}`;
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function EffluxPanel() {
  const dawPanelOpen   = useAppStore((s) => s.dawPanelOpen);
  const toggleDawPanel = useAppStore((s) => s.toggleDawPanel);

  // Toolbar reads from the session store now — the user authors a session,
  // and that's the dirty/title signal that matters for save prompts. The
  // song store is still populated in parallel during the Phase 3 transition
  // (ChannelHeader, EffluxBottomBar, InstrumentEditor still read it) but
  // its dirty flag is settings-around-the-composition, not the composition.
  const _sv          = useSessionStore((s) => s.sessionVersion);          // eslint-disable-line @typescript-eslint/no-unused-vars
  const session      = useSessionStore((s) => s.activeSession);
  const sessionDirty = useSessionStore((s) => s.dirty);

  const playing    = useSequencerStore((s) => s.playing);
  const setPlaying = useSequencerStore((s) => s.setPlaying);

  const { unlocking, error: audioError, unlock } = useAudioContext();

  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Save-button feedback state. `saving` flips the icon to a spinner during
  // the in-flight POST; `justSaved` flips it to a checkmark for a beat after
  // success so the user gets a visible "yes, that landed" cue. The timer is
  // tracked so a second save during the flash window cancels and restarts
  // it cleanly (no leak, no setState after unmount).
  const [saving,     setSaving]     = useState(false);
  const [justSaved,  setJustSaved]  = useState(false);
  const justSavedTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (justSavedTimerRef.current !== null) {
      window.clearTimeout(justSavedTimerRef.current);
    }
  }, []);

  // Modal state. SessionPicker opens on Open. DirtyPrompt opens on
  // New/Open when the current session is dirty; pendingActionRef holds
  // the deferred action to run after Save/Discard.
  const [pickerOpen,      setPickerOpen]      = useState(false);
  const [dirtyPromptOpen, setDirtyPromptOpen] = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  // Clip props popover — global controller. ClipCells call useClipPopoverStore
  // .openFor() on right-click; the popover renders here at panel level so it
  // sits above the tracker grid regardless of which channel was right-clicked.
  const popoverOpen      = useClipPopoverStore((s) => s.open);
  const popoverAnchor    = useClipPopoverStore((s) => s.anchor);
  const popoverChannel   = useClipPopoverStore((s) => s.channelIndex);
  const popoverClip      = useClipPopoverStore((s) => s.clipIndex);
  const closePopover     = useClipPopoverStore((s) => s.close);

  // ── Hooks that drive the tracker surface ──────────────────────────────────
  useKeyboardInput(dawPanelOpen);          // global key handler (only when panel visible)
  useTransportTick();                      // rAF step scheduler

  // ── Transport ─────────────────────────────────────────────────────────────
  const startPlayback = useCallback(async () => {
    await unlock();
    try { AudioService.togglePlayback(true); } catch { /* stub */ }
    setPlaying(true);
  }, [unlock, setPlaying]);

  const stopPlayback = useCallback(() => {
    try { AudioService.togglePlayback(false); } catch { /* stub */ }
    setPlaying(false);
  }, [setPlaying]);

  // Stop playback when the panel closes.
  useEffect(() => {
    if (!dawPanelOpen && playing) stopPlayback();
  }, [dawPanelOpen, playing, stopPlayback]);

  // ── Title edit ────────────────────────────────────────────────────────────
  const handleTitleChange = useCallback((next: string) => {
    useSessionStore.getState().setTitle(next);
  }, []);

  // ── Build a blank session, install in BOTH stores, rebuild audio graph ──
  // Used by handleNewSession and the dev "Load Test Song" button. The song
  // store still has consumers (ChannelHeader, EffluxBottomBar, etc) that
  // read instruments/master vol from it, so it must agree with the session
  // store on which instruments are active.
  const installFreshSession = useCallback((title: string) => {
    const song = SongFactory.create();
    song.meta.title = title;
    const fresh = fromEffluxSong(song);
    useSongStore.getState().setActiveSong(song);
    useSessionStore.getState().setActiveSession(fresh);     // bond cleared (no filename)
    try { AudioService.applyModulesForInstruments(fresh.instruments); } catch { /* engine not ready */ }
  }, []);

  // ── New Session ───────────────────────────────────────────────────────────
  const handleNewSession = useCallback(() => {
    const proceed = () => {
      setSaveErr(null);
      installFreshSession('Untitled');
    };
    if (useSessionStore.getState().dirty) {
      pendingActionRef.current = proceed;
      setDirtyPromptOpen(true);
    } else {
      proceed();
    }
  }, [installFreshSession]);

  // ── Save Session ──────────────────────────────────────────────────────────
  // Bond logic (see Batch H handoff §"The bond model"):
  //   • Compute targetFilename from current title.
  //   • If targetFilename matches bondFilename AND title matches bondTitle:
  //       overwrite silently (normal edit-and-save loop).
  //   • Otherwise the bond is broken or absent — try to write without
  //     overwrite. Backend returns 409 if the name is already taken; we
  //     surface that as a toolbar error and refuse to save.
  const handleSaveSession = useCallback(async (): Promise<boolean> => {
    setSaveErr(null);
    const state = useSessionStore.getState();
    const sess  = state.activeSession;
    if (!sess) {
      setSaveErr('No session to save');
      return false;
    }
    const currentTitle    = sess.meta.title || 'Untitled';
    const targetFilename  = filenameFor(currentTitle);
    const bondFilename    = state.bondFilename;
    const bondTitle       = state.bondTitle;
    const allowOverwrite  = bondFilename === targetFilename && bondTitle === currentTitle;

    setSaving(true);
    setJustSaved(false);
    try {
      const wire    = serialize(sess);
      const content = JSON.stringify(wire, null, 2);
      const result  = await saveSession(targetFilename, content, allowOverwrite);
      useSessionStore.getState().setBond(result.filename, currentTitle);
      useSessionStore.getState().markClean();

      // Flash a checkmark for ~1.2s. If a second save fires inside the
      // window, restart the timer rather than stack two of them.
      setJustSaved(true);
      if (justSavedTimerRef.current !== null) {
        window.clearTimeout(justSavedTimerRef.current);
      }
      justSavedTimerRef.current = window.setTimeout(() => {
        setJustSaved(false);
        justSavedTimerRef.current = null;
      }, 1200);

      return true;
    } catch (err) {
      if (err instanceof SessionExistsError) {
        setSaveErr(`A session named "${currentTitle}" already exists. Rename to save.`);
      } else {
        setSaveErr(`Save session failed: ${(err as Error).message}`);
      }
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  // ── Open Session ──────────────────────────────────────────────────────────
  const handleOpenSession = useCallback(() => {
    const proceed = () => {
      setSaveErr(null);
      setPickerOpen(true);
    };
    if (useSessionStore.getState().dirty) {
      pendingActionRef.current = proceed;
      setDirtyPromptOpen(true);
    } else {
      proceed();
    }
  }, []);

  // Picker → file chosen → fetch + deserialize + install (with bond) +
  // rebuild song shell so consumers reading useSongStore see fresh data.
  const handlePickSession = useCallback(async (filename: string) => {
    setPickerOpen(false);
    setSaveErr(null);
    try {
      const text = await loadSession(filename);
      const raw  = JSON.parse(text);
      const loaded = deserialize(raw);

      // Build a song shell that mirrors the loaded session for the components
      // that still read from useSongStore. Borrow instruments by reference
      // (no copy) so AudioService and InstrumentEditor see the same objects
      // the session store does.
      const shell = SongFactory.create(0);
      shell.instruments    = loaded.instruments;
      shell.meta.title     = loaded.meta.title;
      if (typeof loaded.meta.author === 'string') shell.meta.author = loaded.meta.author;
      shell.meta.timing.tempo = loaded.tempo;
      useSongStore.getState().setActiveSong(shell);

      useSessionStore.getState().setActiveSession(loaded, filename);   // bond set
      try { AudioService.applyModulesForInstruments(loaded.instruments); } catch { /* engine not ready */ }
    } catch (err) {
      if (err instanceof SessionFormatError) {
        setSaveErr(`Invalid session file: ${err.message}`);
      } else if (err instanceof SyntaxError) {
        setSaveErr('File is not valid JSON');
      } else {
        setSaveErr(`Open session failed: ${(err as Error).message}`);
      }
    }
  }, []);

  // ── Open Folder ───────────────────────────────────────────────────────────
  const handleOpenFolder = useCallback(async () => {
    setSaveErr(null);
    try {
      await openSessionFolder();
    } catch (err) {
      setSaveErr(`Open folder failed: ${(err as Error).message}`);
    }
  }, []);

  // ── Dirty-prompt callbacks ────────────────────────────────────────────────
  const onDirtySave = useCallback(async () => {
    setDirtyPromptOpen(false);
    const ok = await handleSaveSession();
    if (ok && pendingActionRef.current) pendingActionRef.current();
    pendingActionRef.current = null;
  }, [handleSaveSession]);

  const onDirtyDiscard = useCallback(() => {
    setDirtyPromptOpen(false);
    if (pendingActionRef.current) pendingActionRef.current();
    pendingActionRef.current = null;
  }, []);

  const onDirtyCancel = useCallback(() => {
    setDirtyPromptOpen(false);
    pendingActionRef.current = null;
  }, []);

  // ── Dev: load the upstream test song into BOTH stores ────────────────────
  // TODO: remove before public release.
  const handleLoadTestSong = useCallback(() => {
    setSaveErr(null);
    import('@/components/audio/engine/test-song').then(({ buildTestSong }) => {
      const song = buildTestSong();
      const fresh = fromEffluxSong(song);
      useSongStore.getState().setActiveSong(song);
      useSessionStore.getState().setActiveSession(fresh);
      try { AudioService.applyModulesForInstruments(fresh.instruments); } catch { /* engine not ready */ }
    });
  }, []);

  const openNoteEntry = useCallback(() => {
    useEditorStore.getState().setShowNoteEntry(true);
  }, []);

  // Track viewport size for the ambient waveform background layer.
  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth  : 1920,
    h: typeof window !== 'undefined' ? window.innerHeight : 1080,
  }));
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!dawPanelOpen) return null;

  const title        = session?.meta.title ?? '';
  const toolbarError = audioError ?? saveErr;

  return (
    <div
      className="phobos-efflux-panel fixed inset-0 z-40 flex flex-col"
      style={{ top: HEADER_HEIGHT_PX, backgroundColor: '#000' }}
    >
      {/* Ambient waveform background — master bus analyser, ~8% opacity */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.08]"
        aria-hidden
      >
        <WaveformDisplay
          analyserIndex={0}
          width={viewport.w}
          height={viewport.h - HEADER_HEIGHT_PX}
          color="#22c55e"
          background="transparent"
          lineWidth={1}
        />
      </div>

      <EffluxToolbar
        title={title}
        dirty={sessionDirty}
        error={toolbarError}
        saving={saving}
        justSaved={justSaved}
        hasSession={!!session}
        onTitleChange={handleTitleChange}
        onNewSession={handleNewSession}
        onSaveSession={handleSaveSession}
        onOpenSession={handleOpenSession}
        onOpenFolder={handleOpenFolder}
        onClose={toggleDawPanel}
        onNoteEntry={openNoteEntry}
      />

      {!session ? (
        <EffluxWelcome
          onNewSession={handleNewSession}
          onOpenSession={handleOpenSession}
          onLoadTestSong={handleLoadTestSong}
          unlocking={unlocking}
        />
      ) : (
        <div className="relative flex-1 flex flex-col min-h-0">
          <Transport onPlay={startPlayback} onStop={stopPlayback} />
          <PatternTrackList />
          <EffluxBottomBar />
        </div>
      )}

      <NoteEntryEditor />
      <InstrumentChainModal />
      <InstrumentEditor />

      <ClipPropsPopover
        open={popoverOpen}
        anchor={popoverAnchor}
        channelIndex={popoverChannel}
        clipIndex={popoverClip}
        onClose={closePopover}
      />

      <SessionPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handlePickSession}
      />

      <DirtyPrompt
        open={dirtyPromptOpen}
        onSave={onDirtySave}
        onDiscard={onDirtyDiscard}
        onCancel={onDirtyCancel}
      />
    </div>
  );
}
