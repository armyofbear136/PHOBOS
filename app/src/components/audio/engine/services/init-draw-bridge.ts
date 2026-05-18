/**
 * initDawBridge.ts — Concrete DawBridge implementation (Phase 2c).
 *
 * Wires the engine's daw-bridge getState/getGetters/commit API to our Zustand
 * stores and the app's existing toast system. Called once by useAudioContext
 * on unlock.
 *
 * The bridge is stateless — every call re-reads `getState()` from Zustand.
 * Hot paths should snapshot the result into a local; see AudioService.init()
 * and the sequencer loop pattern.
 *
 * Phase 2c changes from 2b:
 *   • `state.sample.sampleCache` now reads the persistent Map from
 *     useSampleStore (was `new Map()` per snapshot → tiny allocation per
 *     bridge read, violated the philosophy on broadcast-path reads).
 */

import { toast } from 'sonner';
import {
  setDawBridge,
  type DawBridge,
  type EffluxState,
  type EffluxGetters,
} from '@/components/audio/engine/services/daw-bridge';
import { installHostBridgeWatcher } from '@/components/audio/engine/services/daw-host-bridge';
import { useSongStore }       from '@/store/daw/useSongStore';
import { useSequencerStore }  from '@/store/daw/useSequencerStore';
import { useSessionStore }    from '@/store/daw/useSessionStore';
import { useSettingsStore }   from '@/store/daw/useSettingsStore';
import { useEditorStore }     from '@/store/daw/useEditorStore';
import { useSelectionStore }  from '@/store/daw/useSelectionStore';
import { useSampleStore }     from '@/store/daw/useSampleStore';
import { PROPERTIES }         from '@/components/audio/engine/definitions/settings-properties';

export function initDawBridge(): void {
  const bridge: DawBridge = {
    getState(): EffluxState {
      const song      = useSongStore.getState();
      const session   = useSessionStore.getState();
      const sequencer = useSequencerStore.getState();
      const settings  = useSettingsStore.getState();
      const editor    = useEditorStore.getState();
      const selection = useSelectionStore.getState();
      const samples   = useSampleStore.getState();

      return {
        song: {
          activeSong: song.activeSong,
        },
        session: {
          activeSession: session.activeSession,
        },
        sequencer: {
          playing:            sequencer.playing,
          looping:            sequencer.looping,
          recording:          sequencer.recording,
          stepPrecision:      sequencer.stepPrecision,
          currentStep:        sequencer.currentStep,
          activeOrderIndex:   sequencer.activeOrderIndex,
          activePatternIndex: sequencer.activePatternIndex,
        },
        editor: {
          selectedInstrument:   editor.selectedInstrument,
          selectedStep:         editor.selectedStep,
          selectedSlot:         editor.selectedSlot,
          showNoteEntry:        editor.showNoteEntry,
          higherKeyboardOctave: editor.higherKeyboardOctave,
          lowerKeyboardOctave:  editor.lowerKeyboardOctave,
        },
        instrument: {
          instruments: song.activeSong?.instruments ?? [],
        },
        sample: {
          sampleCache: samples.sampleCache,        // persistent Map reference
        },
        // Phase 2d — real MIDI state lands with MidiService.
        midi: {
          midiPortNumber:  -1,
          midiConnected:   false,
          pairableParamId: null,
        },
        selection: {
          minSelectedStep:      selection.minSelectedStep,
          maxSelectedStep:      selection.maxSelectedStep,
          firstSelectedChannel: selection.firstSelectedChannel,
          lastSelectedChannel:  selection.lastSelectedChannel,
        },
        settings: {
          properties: settings._settings,
        },
      };
    },

    getGetters(): EffluxGetters {
      const song      = useSongStore.getState();
      const sequencer = useSequencerStore.getState();
      const settings  = useSettingsStore.getState();
      const selection = useSelectionStore.getState();

      const activeSong = song.activeSong;
      const activePatternIndex = sequencer.activePatternIndex;
      const activePattern = activeSong
        ? activeSong.patterns[activePatternIndex] ?? null
        : null;

      return {
        activeSong,
        activePattern,
        activePatternIndex,
        activeOrderIndex: sequencer.activeOrderIndex,
        jamMode:          activeSong?.type === 1,   // EffluxSongType.JAM = 1
        samples:          activeSong?.samples ?? [],
        hasSelection:     selection.hasSelection(),
        hasCopiedEvents:  selection.hasCopiedEvents(),
        followPlayback:   settings._settings[PROPERTIES.FOLLOW_PLAYBACK] === true,
      };
    },

    commit: {
      showNotification: ({ message, title }) => {
        if (title) toast(title, { description: message });
        else       toast(message);
      },
      bumpSessionVersion: () => {
        useSessionStore.getState().bumpSessionVersion();
      },
    },
  };

  setDawBridge(bridge);
  installHostBridgeWatcher();
}
