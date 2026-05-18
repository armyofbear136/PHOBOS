/**
 * useCopilotAudio.ts — TTS/STT audio lifecycle hook for SAYON/SEREN PRIME.
 *
 * One instance per copilot persona. Owns:
 *   - Kokoro TTS synthesis + playback (browser AudioContext or PhobosHost)
 *   - Whisper STT via push-to-talk MediaRecorder
 *   - Voice selection state
 *   - Playback mode selection (browser vs host)
 *
 * Allocation contract:
 *   - AudioContext created once on first speak(), reused thereafter.
 *   - MediaRecorder created fresh per recording (Web API requirement).
 *   - chunksRef.current is reset to length 0 before each recording — no spread/replace.
 *   - Base64 encoding uses the same chunked pattern as WorkspacePanel.uploadFiles
 *     to avoid stack overflow on recordings longer than ~500KB.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// Chunk size for Uint8Array → base64 conversion — avoids stack overflow on
// large audio blobs. Must not be changed without profiling on the target platform.
const B64_CHUNK = 8192;

// ── Types ─────────────────────────────────────────────────────────────────────

export type TtsPlaybackMode = 'browser' | 'host';

export interface CopilotAudioState {
  ttsEnabled:      boolean;
  ttsPlaying:      boolean;
  sttListening:    boolean;
  transcribing:    boolean;
  selectedVoice:   string;
  availableVoices: string[];
  playbackMode:    TtsPlaybackMode;
}

export interface CopilotAudioActions {
  setTtsEnabled:    (v: boolean) => void;
  setSelectedVoice: (v: string) => void;
  setPlaybackMode:  (v: TtsPlaybackMode) => void;
  // Speak a complete pre-assembled string (e.g. voice-mode auto-stop response).
  speak:          (text: string, threadId: string) => void;
  // Feed one streaming token. Internally accumulates tokens and fires synthesis
  // as soon as a sentence boundary is detected — first audio starts as early as
  // the first complete sentence, in parallel with continued streaming.
  speakChunk:     (token: string, threadId: string) => void;
  // Call once when the LLM stream ends to flush any partial trailing sentence.
  flushSpeech:    (threadId: string) => void;
  interrupt:        () => void;
  startListening:   () => void;
  stopListening:    () => Promise<string>;
  getStream:        () => MediaStream | null;
  getListeningRef:  () => React.MutableRefObject<boolean>;
}

export type CopilotAudioHook = CopilotAudioState & CopilotAudioActions;

// ── Hook ──────────────────────────────────────────────────────────────────────

console.log('[useCopilotAudio] MODULE LOADED v5');

export function useCopilotAudio(): CopilotAudioHook {
  // ── State ──────────────────────────────────────────────────────────────────
  const [ttsEnabled,      setTtsEnabled]      = useState(false);
  const [ttsPlaying,      setTtsPlaying]      = useState(false);
  // Always use this instead of bare setTtsPlaying so ttsPlayingRef stays in sync.
  const setPlaying = useCallback((v: boolean) => {
    ttsPlayingRef.current = v;
    setTtsPlaying(v);
  }, []);
  const [sttListening,    setSttListening]    = useState(false);
  // Stable ref that mirrors sttListening — read synchronously in callbacks
  // that close over a stale snapshot of the boolean state.
  const sttListeningRef = useRef(false);
  // Always use this instead of bare setSttListening so ref stays in sync.
  const setListening = useCallback((v: boolean) => {
    sttListeningRef.current = v;
    setSttListening(v);
  }, []);
  const [transcribing,    setTranscribing]    = useState(false);
  const [selectedVoice,   setSelectedVoice]   = useState('af_heart');
  const [availableVoices, setAvailableVoices] = useState<string[]>(['af_heart']);
  const [playbackMode,    setPlaybackMode]    = useState<TtsPlaybackMode>('browser');

  // ── Refs — never trigger re-renders ───────────────────────────────────────
  // AudioContext: one per hook instance, lazy-created on first speak()
  const audioCtxRef     = useRef<AudioContext | null>(null);
  // Currently playing source node — held for interrupt()
  const sourceRef       = useRef<AudioBufferSourceNode | null>(null);
  // AbortController for in-flight TTS fetch
  const ttsAbortRef     = useRef<AbortController | null>(null);
  // audioId returned by PhobosHost when playback === 'host'
  const hostAudioIdRef  = useRef<number | null>(null);
  // MediaRecorder for push-to-talk
  const recorderRef     = useRef<MediaRecorder | null>(null);
  // MediaStream — track.stop() on cleanup
  const streamRef       = useRef<MediaStream | null>(null);
  // Recorded audio chunks — length reset to 0 before each recording
  const chunksRef       = useRef<Blob[]>([]);

  // ── Sentence-streaming TTS queue ──────────────────────────────────────────
  // Tokens are accumulated here as they arrive from the LLM stream. When a
  // sentence boundary is detected the sentence is moved to ttsQueueRef and
  // synthesis begins immediately, in parallel with continued streaming.
  const ttsTokenBufRef  = useRef('');
  // FIFO queue of sentences waiting to be synthesized + played. drainQueue
  // processes one entry at a time so playback is seamless and in order.
  const ttsQueueRef     = useRef<Array<{ text: string; threadId: string }>>([]);
  // True while drainQueue is actively running — prevents re-entrant drain calls.
  const ttsDrainingRef  = useRef(false);
  // Mirrors ttsPlaying state for synchronous reads inside async callbacks.
  const ttsPlayingRef   = useRef(false);

  // ── Fetch available voices once on mount ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    fetch(`${ENGINE_URL}/api/audio/voices`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { voices: string[] } | null) => {
        if (cancelled || !data?.voices?.length) return;
        setAvailableVoices(data.voices);
        setSelectedVoice(prev => data.voices.includes(prev) ? prev : data.voices[0]);
      })
      .catch(() => { /* keep defaults */ });
    return () => { cancelled = true; };
  }, []);

  // ── interrupt — stop any active TTS and clear the queue ──────────────────
  const interrupt = useCallback(() => {
    // Clear pending queue and token buffer so nothing queued fires after interrupt
    ttsQueueRef.current.length = 0;
    ttsTokenBufRef.current = '';
    ttsDrainingRef.current = false;
    // Abort any pending TTS fetch
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort();
      ttsAbortRef.current = null;
    }
    // Stop browser AudioBufferSourceNode
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current = null;
    }
    // Stop PhobosHost playback
    if (hostAudioIdRef.current !== null) {
      const id = hostAudioIdRef.current;
      hostAudioIdRef.current = null;
      fetch(`${ENGINE_URL}/api/audio/player/stop`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ audioId: id }),
      }).catch(() => { /* best-effort */ });
    }
    setPlaying(false);
  }, [setPlaying]);

  // ── setTtsEnabled — interrupt if disabling mid-speech ────────────────────
  const handleSetTtsEnabled = useCallback((v: boolean) => {
    if (!v) interrupt();
    setTtsEnabled(v);
  }, [interrupt]);

  // ── synthesizeOne — fetch TTS for one segment and play it ─────────────────
  // Internal. Returns when playback finishes (browser mode) or when the host
  // confirms the clip is playing (host mode). Rejects on abort or error.
  // Uses the abort controller stored in ttsAbortRef at call time.
  const synthesizeOne = useCallback(async (
    text: string,
    threadId: string,
    abort: AbortController,
  ): Promise<void> => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    const ctx = audioCtxRef.current;

    const res = await fetch(`${ENGINE_URL}/api/audio/tts`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        text,
        threadId,
        voice:    selectedVoice,
        playback: playbackMode,
      }),
      signal: abort.signal,
    });

    if (!res.ok || !res.body) throw new Error('TTS request failed');

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   sseBuffer    = '';
    let   outputPath: string | null = null;
    let   hostAudioId: number | undefined;

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try {
          const evt = JSON.parse(raw) as {
            type: string; outputPath?: string; audioId?: number; message?: string;
          };
          if (evt.type === 'done') {
            outputPath  = evt.outputPath ?? null;
            hostAudioId = evt.audioId;
            break outer;
          }
          if (evt.type === 'error') throw new Error(evt.message ?? 'TTS error');
        } catch (parseErr) {
          if ((parseErr as Error).message !== 'Unexpected token') throw parseErr;
        }
      }
    }

    if (abort.signal.aborted) return;

    if (playbackMode === 'host') {
      hostAudioIdRef.current = hostAudioId ?? null;
      if (typeof hostAudioId === 'number') {
        await new Promise<void>((resolve) => {
          const poll = async () => {
            try {
              const sr = await fetch(
                `${ENGINE_URL}/api/audio/player/status?audioId=${hostAudioId}`,
                { signal: abort.signal },
              );
              if (!sr.ok) { resolve(); return; }
              const s = await sr.json() as { playing: boolean; finished: boolean };
              if (s.finished || !s.playing) {
                hostAudioIdRef.current = null;
                resolve();
              } else {
                setTimeout(poll, 500);
              }
            } catch { resolve(); }
          };
          setTimeout(poll, 500);
        });
      }
      return;
    }

    // Browser mode
    if (!outputPath) throw new Error('TTS returned no outputPath');

    const wavRes = await fetch(
      `${ENGINE_URL}/api/audio/output?path=${encodeURIComponent(outputPath)}`,
      { signal: abort.signal },
    );
    if (!wavRes.ok) throw new Error('Failed to fetch WAV for playback');

    const arrayBuf    = await wavRes.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuf);

    if (abort.signal.aborted) return;

    if (ctx.state === 'suspended') await ctx.resume();

    await new Promise<void>((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => {
        sourceRef.current = null;
        resolve();
      };
      source.start();
      sourceRef.current = source;
    });
  }, [selectedVoice, playbackMode]);

  // ── drainQueue — play queued sentences with synthesis overlap ───────────────
  // Re-entrant calls are no-ops — only one drain loop runs at a time.
  //
  // Overlap strategy: while sentence N is PLAYING, we start synthesizing sentence
  // N+1 in parallel. synthesizeOne is split into two phases:
  //   Phase A — fetch + decode (network + ONNX, ~3-4s): runs during playback of N
  //   Phase B — play (AudioBufferSourceNode): runs after N finishes
  // This hides kokoro inference time behind playback, eliminating the gap between
  // sentences that made the queue feel like "one sentence at a time".
  const drainQueue = useCallback(() => {
    if (ttsDrainingRef.current) return;
    ttsDrainingRef.current = true;

    const run = async () => {
      // Pre-fetched AudioBuffer for the NEXT segment, synthesized in parallel
      // with playback of the CURRENT segment.
      let prefetchedBuffer: AudioBuffer | null = null;
      let prefetchAbort: AbortController | null = null;

      const stopPrefetch = () => {
        prefetchAbort?.abort();
        prefetchAbort = null;
        prefetchedBuffer = null;
      };

      // Synthesize one segment: fetch SSE → decode WAV → return AudioBuffer.
      // Does NOT play — returns the buffer so the caller controls timing.
      const fetchBuffer = async (text: string, threadId: string, abort: AbortController): Promise<AudioBuffer> => {
        // Fetch + decode only — does not play. Mirrors synthesizeOne's SSE/WAV
        // logic but returns an AudioBuffer so the caller controls timing.
        const ctx = audioCtxRef.current ?? new AudioContext();
        if (!audioCtxRef.current) audioCtxRef.current = ctx;

        const res = await fetch(`${ENGINE_URL}/api/audio/tts`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            text, threadId,
            voice: selectedVoice,
            label: 'copilot-tts',
          }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`TTS fetch failed: ${res.status}`);

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let outputPath: string | null = null;

        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (!raw) continue;
            try {
              const evt = JSON.parse(raw) as { type: string; outputPath?: string; message?: string };
              if (evt.type === 'done') { outputPath = evt.outputPath ?? null; break outer; }
              if (evt.type === 'error') throw new Error(evt.message ?? 'TTS error');
            } catch (parseErr) {
              if ((parseErr as Error).message !== 'Unexpected token') throw parseErr;
            }
          }
        }

        if (abort.signal.aborted) throw Object.assign(new Error('AbortError'), { name: 'AbortError' });
        if (!outputPath) throw new Error('TTS returned no outputPath');

        const wavRes = await fetch(
          `${ENGINE_URL}/api/audio/output?path=${encodeURIComponent(outputPath)}`,
          { signal: abort.signal },
        );
        if (!wavRes.ok) throw new Error('Failed to fetch WAV');
        const arrayBuf = await wavRes.arrayBuffer();
        return ctx.decodeAudioData(arrayBuf);
      };

      // Play a pre-decoded AudioBuffer and wait for it to finish.
      const playBuffer = async (buffer: AudioBuffer, abort: AbortController): Promise<void> => {
        const ctx = audioCtxRef.current ?? new AudioContext();
        if (!audioCtxRef.current) audioCtxRef.current = ctx;
        if (ctx.state === 'suspended') await ctx.resume();
        if (abort.signal.aborted) return;
        await new Promise<void>((resolve) => {
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          source.onended = () => { sourceRef.current = null; resolve(); };
          source.start();
          sourceRef.current = source;
          abort.signal.addEventListener('abort', () => { source.stop(); resolve(); });
        });
      };

      try {
        while (ttsQueueRef.current.length > 0) {
          const entry = ttsQueueRef.current[0];
          const abort = new AbortController();
          ttsAbortRef.current = abort;

          let currentBuffer: AudioBuffer;
          try {
            // Use pre-fetched buffer if available, otherwise fetch now (first segment)
            if (prefetchedBuffer) {
              currentBuffer = prefetchedBuffer;
              prefetchedBuffer = null;
            } else {
              currentBuffer = await fetchBuffer(entry.text, entry.threadId, abort);
            }
          } catch (err) {
            stopPrefetch();
            if ((err as Error).name !== 'AbortError') {
              console.error('[useCopilotAudio] TTS segment error:', (err as Error).message);
            }
            ttsQueueRef.current.length = 0;
            ttsTokenBufRef.current = '';
            ttsDrainingRef.current = false;
            setPlaying(false);
            return;
          }

          if (abort.signal.aborted) { stopPrefetch(); break; }

          // Start pre-fetching the NEXT segment while we play this one
          const nextEntry = ttsQueueRef.current[1];
          if (nextEntry) {
            prefetchAbort = new AbortController();
            const pa = prefetchAbort;
            fetchBuffer(nextEntry.text, nextEntry.threadId, pa)
              .then(buf => { if (!pa.signal.aborted) prefetchedBuffer = buf; })
              .catch(() => { prefetchedBuffer = null; });
          }

          // Play current segment — next segment synthesizes in parallel
          try {
            await playBuffer(currentBuffer, abort);
          } catch (err) {
            stopPrefetch();
            if ((err as Error).name !== 'AbortError') {
              console.error('[useCopilotAudio] TTS playback error:', (err as Error).message);
            }
            ttsQueueRef.current.length = 0;
            ttsTokenBufRef.current = '';
            ttsDrainingRef.current = false;
            setPlaying(false);
            return;
          }

          // Remove finished segment
          ttsQueueRef.current.splice(0, 1);
        }
      } finally {
        stopPrefetch();
        ttsDrainingRef.current = false;
        setPlaying(false);
      }
    };

    run();
  }, [selectedVoice, setPlaying]);

  // ── enqueue — add a sentence to the queue and start draining ─────────────
  const enqueue = useCallback((text: string, threadId: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    ttsQueueRef.current.push({ text: trimmed, threadId });
    setPlaying(true);
    drainQueue();
  }, [drainQueue, setPlaying]);

  // ── speak — synthesize and play a complete string (voice mode / legacy) ───
  const speak = useCallback((text: string, threadId: string) => {
    if (!ttsEnabled || !text.trim()) return;
    interrupt();
    enqueue(text, threadId);
  }, [ttsEnabled, interrupt, enqueue]);

  // ── speakChunk — feed one streaming token ────────────────────────────────
  // Accumulates tokens and fires synthesis on sentence boundaries so the first
  // segment starts as early as the first complete sentence arrives.
  //
  // Sentence boundary: [.!?] followed by whitespace or end of string.
  // We do NOT split on colons or commas — partial list items sound worse than
  // slightly longer sentences.
  const speakChunk = useCallback((token: string, threadId: string) => {
    if (!ttsEnabled) return;
    ttsTokenBufRef.current += token;

    // Walk the buffer looking for sentence boundaries
    const BOUNDARY = /[.!?](?:\s|$)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = BOUNDARY.exec(ttsTokenBufRef.current)) !== null) {
      // Include the punctuation char (match.index + 1) but not the trailing space
      const end      = match.index + 1;
      const sentence = ttsTokenBufRef.current.slice(lastIndex, end).trim();
      if (sentence.length >= 4) { // ignore single-char fragments like "I."
        enqueue(sentence, threadId);
      }
      lastIndex = end;
      BOUNDARY.lastIndex = end; // advance past boundary
    }

    // Keep only the unprocessed tail in the buffer
    if (lastIndex > 0) {
      ttsTokenBufRef.current = ttsTokenBufRef.current.slice(lastIndex);
    }
  }, [ttsEnabled, enqueue]);

  // ── flushSpeech — emit trailing partial sentence after stream ends ────────
  const flushSpeech = useCallback((threadId: string) => {
    if (!ttsEnabled) return;
    const remaining = ttsTokenBufRef.current.trim();
    ttsTokenBufRef.current = '';
    if (remaining.length >= 4) {
      enqueue(remaining, threadId);
    }
  }, [ttsEnabled, enqueue]);



  // ── startListening — begin push-to-talk recording ────────────────────────
  const startListening = useCallback(() => {
    console.log('[STT:START] startListening called, sttListening=', sttListening, 'chunks before reset:', chunksRef.current.length);
    if (sttListening) { console.log('[STT:START] early exit - already listening'); return; }
    // Interrupt any active TTS — mic press always wins
    if (ttsPlaying) interrupt();

    setListening(true);
    chunksRef.current.length = 0;
    console.log('[STT:START] chunks reset to 0, getUserMedia starting');

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        streamRef.current = stream;
        console.log('[STT:0] stream acquired, creating MediaRecorder');
        // Prefer webm/opus — wide browser support, Whisper CLI accepts it directly.
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/webm')
            ? 'audio/webm'
            : '';
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorderRef.current = recorder;
        // Timesliced at 100ms — data arrives continuously, eliminating the
        // onstop/ondataavailable race condition where onstop fires before the
        // final chunk is delivered.
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.start(100);
        console.log('[STT:0b] recorder started, state=', recorder.state);
      })
      .catch((err) => {
        console.error('[useCopilotAudio] getUserMedia failed:', err.message);
        setListening(false);
      });
  }, [sttListening, ttsPlaying, interrupt]);

  // ── stopListening — stop recording, transcribe, return transcript ─────────
  const stopListening = useCallback((): Promise<string> => {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      console.log('[STT:GUARD] recorderRef=', recorder ? 'exists' : 'null', 'state=', recorder?.state, 'chunks=', chunksRef.current.length);
      if (!recorder || recorder.state === 'inactive') {
        console.warn('[STT:GUARD] early exit - recorder null or inactive');
        setListening(false);
        resolve('');
        return;
      }

      recorder.onstop = () => {
        console.log('[STT:1] onstop fired, chunks=', chunksRef.current.length, 'sizes=', JSON.stringify(chunksRef.current.map(b => b.size)));
        // Stop all media tracks to release the microphone
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current  = null;
        recorderRef.current = null;
        setListening(false);

        // Use the recorder’s actual mimeType — with timesliced recording all chunks
        // are already collected before onstop fires, so no race condition here.
        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current.length = 0;

        console.log('[STT:1b] blob.size=', blob.size, 'mimeType=', mimeType);
        if (blob.size < 1000) {
          console.warn('[STT:1c] blob too small');
          resolve('');
          return;
        }

        setTranscribing(true);

        // Promise chain — no async/await inside onstop to avoid unhandled rejection
        blob.arrayBuffer()
          .then((arrayBuf) => {
            const bytes  = new Uint8Array(arrayBuf);
            let   binary = '';
            for (let i = 0; i < bytes.length; i += B64_CHUNK) {
              binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
            }
            const audioData = btoa(binary);
            return fetch(`${ENGINE_URL}/api/audio/transcribe`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ audioData }),
            });
          })
          .then((res) => {
            if (!res.ok) throw new Error(`Transcribe failed: ${res.status}`);
            return res.json() as Promise<{ text: string }>;
          })
          .then((data) => {
            console.log('[STT:4] transcript=', JSON.stringify(data.text));
            resolve(data.text?.trim() ?? '');
          })
          .catch((err) => {
            console.error('[useCopilotAudio] transcribe error:', (err as Error).message);
            resolve('');
          })
          .finally(() => {
            setTranscribing(false);
          });
      };

      recorder.stop();
    });
  }, []);

  return {
    ttsEnabled,
    ttsPlaying,
    sttListening,
    transcribing,
    selectedVoice,
    availableVoices,
    playbackMode,
    setTtsEnabled: handleSetTtsEnabled,
    setSelectedVoice,
    setPlaybackMode,
    speak,
    speakChunk,
    flushSpeech,
    interrupt,
    startListening,
    stopListening,
    getStream:       () => streamRef.current,
    getListeningRef: () => sttListeningRef,
  };
}