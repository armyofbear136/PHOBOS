/**
 * useTransportTick.ts — Cursor animation bridge for Phase 3.
 *
 * Phase 2c had this hook running an rAF loop that read AudioService's single
 * `lastScheduledStepIdx` at 60Hz and wrote it into useSequencerStore.currentStep.
 * The audio scheduler ran at 25ms intervals; rAF gave the LED frame-accurate
 * smoothness even though audio updates were quantised to 25ms.
 *
 * Phase 3 changes the model entirely:
 *
 *   • There is no single "current step" — each channel walks its own per-clip
 *     cursor (useSessionStore.activeSession.channels[c].playingCursor).
 *   • The scheduler writes those cursors directly into the session store and
 *     bumps sessionVersion once per tick. React re-renders pick up new cursor
 *     values via the store subscription — no rAF intermediary needed.
 *
 * What this hook does today:
 *
 *   • Subscribes to useSequencerStore.playing.
 *   • While playing, mirrors the SELECTED CHANNEL's per-clip cursor into
 *     useSequencerStore.currentStep so legacy single-cursor consumers
 *     (StepCursor.tsx, Transport.tsx) keep working unchanged. These will be
 *     migrated to read useSessionStore directly in Batch D when the
 *     per-channel LED visual lands; the mirror is the bridge during transition.
 *   • On stop, clears currentStep to 0.
 *
 * Zero allocation: the rAF tick reads two integers (selectedInstrument,
 * playingCursor) and conditionally writes one. No arrays, no objects.
 *
 * The rAF loop is RETAINED here (not the scheduler-driven push model) for one
 * reason: the legacy currentStep mirror needs to follow user selection of
 * different channels. If the user clicks channel 3 mid-playback, the cursor
 * should snap to channel 3's playingCursor. Driving that off
 * sessionVersion-only would miss selection changes; rAF samples both at the
 * display rate and Just Works.
 */

import { useEffect, useRef } from 'react';
import { useSequencerStore } from '@/store/daw/useSequencerStore';
import { useSessionStore }   from '@/store/daw/useSessionStore';
import { useEditorStore }    from '@/store/daw/useEditorStore';

export function useTransportTick(): void {
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = (): void => {
      const seq = useSequencerStore.getState();
      if (!seq.playing) return;

      const session  = useSessionStore.getState().activeSession;
      const selected = useEditorStore.getState().selectedInstrument;

      // The legacy currentStep is the SELECTED channel's playing cursor.
      // If the selected channel isn't playing, fall back to 0 (the LED
      // sits at the start, matching pre-Phase-3 behavior on a stopped pattern).
      let cursor = 0;
      if (session) {
        const ch = session.channels[selected];
        if (ch && ch.playingClipIdx >= 0) {
          cursor = ch.playingCursor;
        }
      }

      if (cursor !== seq.currentStep) {
        seq.setCurrentStep(cursor);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const unsubscribe = useSequencerStore.subscribe((state, prev) => {
      if (state.playing === prev.playing) return;

      if (state.playing) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        useSequencerStore.getState().setCurrentStep(0);
      }
    });

    return () => {
      unsubscribe();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);
}
