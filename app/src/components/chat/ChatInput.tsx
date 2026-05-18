import { useState, useRef, useEffect, KeyboardEvent, ChangeEvent, DragEvent } from 'react';
import { Send, Paperclip, FileText, X, Square, Image, Mic, MicOff, Loader2 } from 'lucide-react';
import { DocumentEditor } from '@/components/documents/DocumentEditor';
import { useAppStore } from '@/store/useAppStore';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// Image MIME types and extensions that will be treated as images rather than text.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff', 'tif', 'avif']);
function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

// Detect if pasted text looks like code being pasted raw (hint to use attach instead)
function detectPastedCode(text: string): boolean {
  const lines = text.split('\n');
  const firstLine = lines[0].trim();
  if (/\.(gd|ts|tsx|js|jsx|py|rs|go|cs|cpp|c|rb|php|sh|lua|zig|swift)$/i.test(firstLine)) return true;
  return lines.length > 15
    && (text.match(/[.!?]/g) ?? []).length < 3
    && /^[ \t]*(func |def |function |class |import |extends |@export)/m.test(text);
}

interface Props {
  onSend: (content: string, files?: File[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** When true, suppress the offline/partial-offline status messages. Used by CopilotPanel. */
  hideStatus?: boolean;
  /** When true, show a push-to-talk mic button for STT via Whisper. */
  enableSTT?: boolean;
}

export function ChatInput({
  onSend,
  onStop,
  isStreaming = false,
  placeholder = 'Send a message…',
  disabled = false,
  hideStatus = false,
  enableSTT = false,
}: Props) {
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const imageGenerating = useAppStore((s) => s.imageGenerating);
  const imageGenStatus = useAppStore((s) => s.imageGenStatus);

  const isOffline = disabled || (
    connectionStatus.coordinator === 'disconnected' &&
    connectionStatus.engine === 'disconnected'
  );
  const isPartialOffline = disabled ||
    connectionStatus.coordinator === 'disconnected' ||
    connectionStatus.engine === 'disconnected';
  const isLocked = isStreaming;

  const [value, setValue] = useState('');
  const [showChatMd, setShowChatMd] = useState(false);
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [stopping, setStopping] = useState(false);

  // ── STT state ─────────────────────────────────────────────────────────────
  const [sttListening,    setSttListening]    = useState(false);
  const [sttTranscribing, setSttTranscribing] = useState(false);
  const [sttError,        setSttError]        = useState(false);
  // Refs — mutated without triggering re-renders
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef        = useRef<MediaStream | null>(null);
  const chunksRef        = useRef<Blob[]>([]);
  const sttErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── STT handlers ──────────────────────────────────────────────────────────

  const handleSttPress = () => {
    if (!enableSTT || sttListening || sttTranscribing) return;
    setSttListening(true);
    chunksRef.current.length = 0;
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        streamRef.current = stream;
        const mt = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
        const recorder = new MediaRecorder(stream, mt ? { mimeType: mt } : undefined);
        mediaRecorderRef.current = recorder;
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.start(100);  // timesliced — data arrives before onstop fires
      })
      .catch(() => {
        setSttListening(false);
        setSttError(true);
        if (sttErrorTimerRef.current) clearTimeout(sttErrorTimerRef.current);
        sttErrorTimerRef.current = setTimeout(() => setSttError(false), 1500);
      });
  };

  const handleSttRelease = async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') { setSttListening(false); return; }

    recorder.onstop = async () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
      setSttListening(false);

      const blob = new Blob(chunksRef.current, { type: 'audio/wav' });
      chunksRef.current.length = 0;
      if (blob.size < 1000) return;

      setSttTranscribing(true);
      try {
        const arrayBuf = await blob.arrayBuffer();
        const bytes    = new Uint8Array(arrayBuf);
        let   binary   = '';
        const CHUNK    = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        const res = await fetch(`${ENGINE_URL}/api/audio/transcribe`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ audioData: btoa(binary) }),
        });
        if (!res.ok) throw new Error('transcribe failed');
        const data = await res.json() as { text: string };
        const transcript = data.text?.trim() ?? '';
        if (transcript) {
          // Append to existing text with a space so the user can continue typing
          setValue(prev => prev ? `${prev} ${transcript}` : transcript);
          // Trigger textarea auto-resize
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
          });
        }
      } catch {
        setSttError(true);
        if (sttErrorTimerRef.current) clearTimeout(sttErrorTimerRef.current);
        sttErrorTimerRef.current = setTimeout(() => setSttError(false), 1500);
      } finally {
        setSttTranscribing(false);
      }
    };

    recorder.stop();
  };

  useEffect(() => {
    if (!isStreaming) setStopping(false);
  }, [isStreaming]);

  // ── Send ──────────────────────────────────────────────────────────────────

  const handleSend = () => {
    if (isLocked || isOffline) return;
    const trimmed = value.trim();
    // Allow send if there's text OR queued files — files alone are a valid query
    if (!trimmed && queuedFiles.length === 0) return;
    onSend(trimmed, queuedFiles.length > 0 ? queuedFiles : undefined);
    setValue('');
    setQueuedFiles([]);
    setPasteHint(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Textarea resize ───────────────────────────────────────────────────────

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setValue(text);
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
    if (text.length > 500 && detectPastedCode(text)) {
      setPasteHint('Tip: use the clip button to attach this as a file so the AI can edit it by path');
    } else {
      setPasteHint(null);
    }
  };

  // ── File queueing — query-only, nothing touches the workspace ─────────────

  const queueFiles = (incoming: File[]) => {
    setQueuedFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...incoming.filter((f) => !names.has(f.name))];
    });
  };

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) queueFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  // ── Drag-and-drop — also query-only ──────────────────────────────────────

  const handleDragOver = (e: DragEvent) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave = (e: DragEvent) => { e.preventDefault(); setDragOver(false); };
  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files) queueFiles(Array.from(e.dataTransfer.files));
  };

  const removeFile = (index: number) => {
    setQueuedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // ── Derived display ───────────────────────────────────────────────────────

  const canSend = (value.trim().length > 0 || queuedFiles.length > 0) && !isOffline && !isLocked;
  const showLengthWarning = value.length > 8000;
  const tokenCount = Math.ceil(value.length / 4);
  const tokenColorClass = tokenCount > 3000
    ? 'text-amber-400/60'
    : tokenCount >= 1000
      ? 'text-phobos-green/40'
      : 'text-muted-foreground/25';

  return (
    <>
      <div className="border-t border-border p-3 bg-card">

        {/* ── Queued file chips ── */}
        {queuedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2 px-1">
            {queuedFiles.map((file, i) => {
              const isImg = isImageFile(file);
              return (
                <span
                  key={`${file.name}-${i}`}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded border ${
                    isImg
                      ? 'bg-blue-400/10 border-blue-400/30 text-blue-300'
                      : 'bg-accent border-border text-accent-foreground'
                  }`}
                  title={isImg ? 'Image — filename will be injected into query' : 'Text file — contents will be inlined into query'}
                >
                  {isImg
                    ? <Image className="w-3 h-3 shrink-0" />
                    : <FileText className="w-3 h-3 shrink-0" />
                  }
                  {file.name}
                  <button
                    onClick={() => removeFile(i)}
                    className="hover:text-destructive transition-colors ml-0.5"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {/* ── Input row ── */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`flex items-end gap-2 bg-background/60 rounded-md border px-3 py-2 transition-colors ${
            dragOver
              ? 'border-primary/60 bg-primary/5'
              : isLocked
                ? 'border-primary/40'
                : 'border-border'
          }`}
        >
          <input
            type="file"
            ref={fileInputRef}
            multiple
            accept="*"
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isLocked}
            className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors shrink-0 mb-0.5"
            title="Attach file to query"
          >
            <Paperclip className="w-4 h-4" />
          </button>

          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              isStreaming
                ? 'Engine working…'
                : (imageGenerating && !hideStatus)
                  ? `● ${imageGenStatus || 'Rendering…'} — type to queue next`
                  : placeholder
            }
            disabled={isLocked}
            rows={1}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none leading-5 disabled:opacity-50"
            style={{ maxHeight: '120px' }}
          />

          {value.length > 0 && (
            <span className={`text-[10px] font-mono select-none shrink-0 self-end mb-1 ${tokenColorClass}`}>
              ~{tokenCount}t
            </span>
          )}

          <button
            onClick={() => setShowChatMd(true)}
            disabled={isLocked}
            className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors shrink-0 mb-0.5"
            title="chat.md rules"
          >
            <FileText className="w-4 h-4" />
          </button>

          {isStreaming ? (
            stopping ? (
              <button
                disabled
                className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-destructive/40 text-destructive/60 text-[10px] font-terminal tracking-wider shrink-0 mb-0.5 cursor-not-allowed"
              >
                <Square className="w-3 h-3 animate-pulse" />
                STOPPING
              </button>
            ) : (
              <button
                onClick={() => {
                  setStopping(true);
                  onStop?.();
                  setTimeout(() => setStopping(false), 2000);
                }}
                className="p-1.5 rounded-md bg-destructive/80 text-white hover:bg-destructive transition-colors shrink-0 mb-0.5"
                title="Stop generation"
              >
                <Square className="w-3.5 h-3.5" />
              </button>
            )
          ) : (
            <>
              {imageGenerating && !hideStatus && (
                <span className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-primary/20 text-primary/50 text-[10px] font-terminal tracking-wider shrink-0 mb-0.5 select-none">
                  <Square className="w-3 h-3 animate-pulse" />
                  RENDER
                </span>
              )}
              {/* ── STT mic button — push-to-talk, only when enableSTT ─── */}
              {enableSTT && (
                <button
                  onPointerDown={handleSttPress}
                  onPointerUp={handleSttRelease}
                  onPointerLeave={() => { if (sttListening) handleSttRelease(); }}
                  disabled={isOffline || isStreaming}
                  title={
                    sttError        ? 'Transcription failed'
                    : sttTranscribing ? 'Transcribing…'
                    : sttListening    ? 'Release to transcribe'
                    : 'Push to talk'
                  }
                  className={`p-1.5 rounded-md transition-colors shrink-0 mb-0.5 disabled:opacity-30 ${
                    sttError
                      ? 'bg-destructive/20 text-destructive'
                      : sttListening
                        ? 'bg-red-500/20 text-red-400 animate-pulse'
                        : sttTranscribing
                          ? 'bg-yellow-500/10 text-yellow-400/70'
                          : 'bg-muted/50 text-muted-foreground/60 hover:text-foreground hover:bg-muted'
                  }`}
                >
                  {sttTranscribing
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : sttListening
                      ? <MicOff className="w-3.5 h-3.5" />
                      : <Mic className="w-3.5 h-3.5" />
                  }
                </button>
              )}
              <button
                onClick={handleSend}
                disabled={!canSend}
                className="p-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30 transition-opacity shrink-0 mb-0.5"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>

        {/* ── Hints and warnings ── */}
        {pasteHint && (
          <p className="text-[11px] text-amber-400 mt-1.5 px-1">{pasteHint}</p>
        )}
        {!hideStatus && isPartialOffline && !isOffline && (
          <p className="text-[10px] font-mono text-amber-400/70 mt-1 px-1">
            Partial backend offline — some features may be unavailable
          </p>
        )}
        {!hideStatus && isOffline && (
          <p className="text-[10px] font-mono text-destructive/70 mt-1 px-1">
            Backend offline — sending disabled
          </p>
        )}
        {showLengthWarning && !pasteHint && (
          <p className="text-[11px] text-amber-400 mt-1.5 px-1">
            Message is very long ({value.length.toLocaleString()} chars) — consider attaching as a file instead
          </p>
        )}
      </div>

      {showChatMd && (
        <DocumentEditor docKey="chatMd" onClose={() => setShowChatMd(false)} />
      )}
    </>
  );
}