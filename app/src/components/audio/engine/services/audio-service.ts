/**
 * audio-service.ts — Full WebAudio engine port (Phase 2c keystone).
 *
 * Replaces the Phase 2a stub. This file owns:
 *   1. The AudioContext (passed in by useAudioContext — we do NOT call
 *      webaudio-helper.init() because that installs its own gesture listeners
 *      which would double up with ours).
 *   2. The master output chain (master gain → destination).
 *   3. One InstrumentModules graph per Instrument slot — each owns a
 *      panner, EQ band-trio, overdrive WaveShaper, BiquadFilter+LFO,
 *      stereo Delay, a pre-FX output GainNode, and an Analyser.
 *   4. Voice allocation on noteOn: one OscillatorNode or AudioBufferSourceNode
 *      per enabled InstrumentOscillator, wired through ADSR gain nodes.
 *   5. Release scheduling on noteOff via ADSR envelope.
 *   6. Custom wavetable cache — CUSTOM-waveform oscillators pre-compute their
 *      PeriodicWave once per instrument-oscillator slot.
 *   7. An audio-clock look-ahead scheduler that reads pattern channels and
 *      calls noteOn / noteOff at sample-accurate AudioContext time. The UI
 *      currentStep pointer is updated by a rAF loop that reads the scheduler's
 *      most-recently-scheduled step — UI timing and audio timing are
 *      decoupled.
 *
 * Zero-allocation discipline:
 *   • InstrumentModules and EventVoiceList arrays are PRE-ALLOCATED on
 *     applyModules and never replaced.
 *   • The scheduler's local-scope variables are reused across ticks.
 *   • noteOn does allocate AudioNodes — this is unavoidable (WebAudio nodes
 *     can't be pooled reliably once started). Allocation is per user action
 *     / per pattern event, NOT per tick.
 *
 * Known gap: overdrive DSP is a MINIMAL WaveShaper stub. It exposes the four
 * automatable properties (drive, color, preBand, postCut) so routing and
 * automation work, but the curve is a simple soft-clip tanh. Replacing with
 * the real pinking algorithm is a Phase 2c.1 / 2d follow-up.
 */

import Config                     from '@engine/config';
import OscillatorTypes            from '@engine/definitions/oscillator-types';
import type { Instrument, InstrumentOscillator } from '@engine/model/types/instrument';
import type { InstrumentModules } from '@engine/model/types/instrument-modules';
import type { EventVoice, EventVoiceList } from '@engine/model/types/event-voice';
import type { EffluxAudioEvent }  from '@engine/model/types/audio-event';
import { ACTION_NOTE_ON, ACTION_NOTE_OFF } from '@engine/model/types/audio-event';
import type { EffluxSong }        from '@engine/model/types/song';
import type { Session }           from '@engine/model/types/session';
import type { ModuleParamDef }    from '@engine/definitions/automatable-parameters';

import ADSR                       from '@engine/services/audio/adsr-module';
import { applyRouting }           from '@engine/services/audio/module-router';
import {
  applyModuleParamChange,
  getCurrentValueForParam,
}                                 from '@engine/services/audio/module-automation';
import Pitch                      from '@engine/services/audio/pitch';
import { tuneToOscillator }       from '@engine/utils/instrument-util';
import {
  createGainNode,
  createStereoPanner,
  createWaveTableFromGraph,
  startOscillation,
  stopOscillation,
}                                 from '@engine/services/audio/webaudio-helper';
import Delay                      from '@engine/services/audio/modules/delay-module';

import { getDawBridge }           from './daw-bridge';

// ── Module-level singletons (mutated, never replaced) ───────────────────────

let audioContext:   AudioContext | null = null;
let masterBus:      GainNode     | null = null;
let instrumentMods: InstrumentModules[] = [];
/** Per-instrument active voice lists keyed by event id. Index = instrument slot. */
const activeEvents: Map<number, EventVoiceList>[] = [];
/** PeriodicWave cache keyed by [instrumentIndex][oscillatorIndex]. */
const customWaveCache: (PeriodicWave | null)[][] = [];
/** Monotonic event id stamped onto every played event. */
let eventIdSeed = 1;

/**
 * Sample cache reference, set by the app at init time via setSampleCacheRef.
 * Typed loosely so this file stays decoupled from the Zustand store layer.
 */
interface SampleCacheEntryShape {
  buffer: AudioBuffer | null;
  sample: {
    pitch?: { frequency: number } | null;
    loop: boolean;
    rangeStart: number;
    rangeEnd: number;
  };
}
let sampleCacheRef: Map<string, SampleCacheEntryShape> | null = null;

export const setSampleCacheRef = (cache: Map<string, SampleCacheEntryShape> | null): void => {
  sampleCacheRef = cache;
};

// Attack-floor: minimum ramp time (seconds) to mask oscillator-start click.
// Below this, the 0→V jump is audible as a transient pop. 2ms is below the
// perceptual envelope threshold (~5-10ms) but well above the click regime.
const MIN_ATTACK_SECONDS = 0.002;

// Scratch objects reused across every noteOn — avoids per-note allocation
// for the attack-floor path. Mutated in place at buildVoiceForOscillator.
const scratchAdsr: { attack: number; decay: number; sustain: number; release: number } = {
  attack: 0, decay: 0, sustain: 0, release: 0,
};
const scratchOsc: InstrumentOscillator = {
  enabled: true, waveform: 'SAW' as unknown as InstrumentOscillator['waveform'],
  volume: 1, detune: 0, octaveShift: 0, fineShift: 0,
  adsr:   scratchAdsr,
  pitch:  undefined,
  table:  undefined as unknown as InstrumentOscillator['table'],
  sample: '',
};

// ── Scheduler state (Phase 3 — session-based) ───────────────────────────────
//
// Replaces the Phase 2c linear-pattern scheduler. The scheduler now reads
// from a Session (useSessionStore.activeSession) rather than a single
// EffluxPattern. The global clock advances at session tempo; each channel
// walks its own per-clip cursor. Launch quantization (default 1 bar) snaps
// arm transitions to global bar boundaries.
//
// State lifecycle:
//   • togglePlayback(true)  — captures session reference, zeros global clock,
//                             sizes heldByChannel to channels.length, kicks
//                             setInterval(schedulerTick).
//   • togglePlayback(false) — clears interval, releases all held voices,
//                             writes -1 / 0 back into the session store.
//   • schedulerTick()       — advances globalStepCounter through any steps
//                             whose audio time falls in the look-ahead horizon.

let schedulerPlaying      = false;
let schedulerLookAheadMs  = 25;
let schedulerIntervalMs   = 25;
let schedulerTimerId:     ReturnType<typeof setInterval> | null = null;
let nextStepTime          = 0;   // AudioContext time of the NEXT global step

/**
 * Reference to the active session captured at togglePlayback(true). Held by
 * the scheduler so per-tick reads do not pay a Zustand getState() cost.
 * Cleared on stop. The session object is NOT defensively copied — the store
 * mutates it in place under the same single-threaded JS event loop, so the
 * captured reference always sees current state.
 */
let scheduledSession:     Session | null = null;

/**
 * Monotonic global step counter, incremented every step the scheduler
 * advances. Bar boundary = globalStepCounter % stepsPerBar === 0.
 *
 * Per-channel cursors live on the session (channels[c].playingCursor); this
 * counter tracks the GLOBAL clock the bar boundaries are computed against.
 * It is NEVER reset mid-playback — bar boundaries must remain monotonic so
 * 4-bar and 3-bar clips with different LCMs phase correctly.
 */
let globalStepCounter     = 0;

/** Cached at togglePlayback start to avoid per-tick session-meta reads. */
let stepsPerBarCache      = 16;     // beatsPerBar(4) * stepsPerBeat(4)
let stepsPerBeatCache     = 4;
let secPerStepCache       = 60 / 120 / 4;
/**
 * Steps between launch-quantization boundaries — derived from
 * session.quantization at togglePlayback. Drives the bar-boundary check
 * the scheduler uses to fire arm transitions and disable-stops.
 *
 *   '1bar'     → stepsPerBarCache       (default — full bar grid)
 *   '2bar'     → stepsPerBarCache * 2   (downbeat every 2 bars)
 *   'half_bar' → stepsPerBarCache / 2   (twice per bar)
 *   '1beat'    → stepsPerBeatCache      (every beat)
 *
 * Held cached for the duration of playback. Mid-playback quantization
 * changes don't take effect until next play — same constraint as tempo,
 * for the same reason (consistent grid across the running clock).
 */
let stepsPerLaunchCache   = 16;

/**
 * Per-channel currently-held voices. When the scheduler hits a new NOTE_ON
 * on channel N, it releases whatever voices channel N is already holding
 * before triggering the new ones — otherwise notes stack forever on each
 * clip loop (clips rarely carry explicit NOTE_OFF events).
 *
 * Pre-allocated to session.channels.length on playback start; cleared via
 * length=0 on stop. The entries themselves are EventVoiceList references
 * pointing back into mods.voices — same objects, two indices.
 */
const heldByChannel: (EventVoiceList | null)[] = [];

/** Analyser bus for the full mix (connected between masterBus and destination). */
let masterAnalyser: AnalyserNode | null = null;

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Boot the audio engine against a provided AudioContext. Must be called after
 * a user gesture has unlocked the context. Idempotent — calling again with
 * the same context is a no-op; calling with a different context rebuilds.
 */
function init(ctx: AudioContext): void {
  if (audioContext === ctx && masterBus !== null) return;
  disposeGraph();

  audioContext   = ctx;
  masterBus      = createGainNode(ctx);
  masterBus.gain.value = 1.0;
  masterAnalyser = ctx.createAnalyser();
  masterAnalyser.fftSize = 2048;

  masterBus.connect(masterAnalyser);
  masterAnalyser.connect(ctx.destination);
}

function disposeGraph(): void {
  // Tear down all instrument modules; WebAudio nodes disconnect themselves
  // when their last reference drops but we do it explicitly for clarity.
  for (const mod of instrumentMods) {
    if (!mod) continue;
    try { mod.output.disconnect(); }            catch { /* */ }
    try { mod.analyser.disconnect(); }          catch { /* */ }
    try { mod.panner?.disconnect(); }           catch { /* */ }
    try { mod.eq.output.disconnect(); }         catch { /* */ }
    try { mod.overdrive.overdrive.disconnect(); } catch { /* */ }
    try { mod.filter.filter.disconnect(); }     catch { /* */ }
    try { mod.filter.lfo.stop(); }              catch { /* already stopped */ }
    try { mod.filter.lfo.disconnect(); }        catch { /* */ }
    try { mod.delay.delay.output.disconnect(); } catch { /* */ }
  }
  instrumentMods.length = 0;
  activeEvents.length   = 0;
  customWaveCache.length = 0;

  if (masterAnalyser) { try { masterAnalyser.disconnect(); } catch {} }
  if (masterBus)      { try { masterBus.disconnect(); }      catch {} }
  masterAnalyser = null;
  masterBus      = null;
}

// ── Module graph construction ────────────────────────────────────────────────

function buildOverdriveNode(ctx: BaseAudioContext): AudioNode & {
  drive: number; color: number; preBand: number; postCut: number;
} {
  // Minimal overdrive: soft-clip WaveShaper between a pre-band highpass and
  // a post-cut lowpass. Exposes the four params module-automation expects.
  // See file-header note — this is intentionally a stub, not production DSP.
  const preBandFilter  = ctx.createBiquadFilter();
  const waveShaper     = ctx.createWaveShaper();
  const postCutFilter  = ctx.createBiquadFilter();
  const inGain         = createGainNode(ctx);
  const outGain        = createGainNode(ctx);

  preBandFilter.type  = 'highpass';
  postCutFilter.type  = 'lowpass';
  preBandFilter.frequency.value = 800;
  postCutFilter.frequency.value = 8000;

  // Build a tanh soft-clip curve scaled by drive.
  const curve = new Float32Array(1024);
  let currentDrive = 0.4;
  const rebuildCurve = (drive: number): void => {
    const k = 2 * drive * 50;
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * (1 + k));
    }
    waveShaper.curve = curve;
  };
  rebuildCurve(currentDrive);

  inGain.connect(preBandFilter);
  preBandFilter.connect(waveShaper);
  waveShaper.connect(postCutFilter);
  postCutFilter.connect(outGain);

  // Expose as an AudioNode with input/output semantics + the 4 props.
  const proxy = outGain as unknown as AudioNode & {
    drive: number; color: number; preBand: number; postCut: number;
    input?: AudioNode; output?: AudioNode;
  };
  // module-router reads `.input` and `.output` to wire things up.
  (proxy as { input: AudioNode }).input  = inGain;
  (proxy as { output: AudioNode }).output = outGain;

  Object.defineProperties(proxy, {
    drive: {
      get() { return currentDrive; },
      set(v: number) { currentDrive = v; rebuildCurve(v); },
      configurable: true,
    },
    color: {
      get() { return postCutFilter.frequency.value; },
      set(v: number) { postCutFilter.frequency.setValueAtTime(v, ctx.currentTime); },
      configurable: true,
    },
    preBand: {
      get() { return preBandFilter.frequency.value / Config.MAX_FILTER_FREQ; },
      set(v: number) { preBandFilter.frequency.setValueAtTime(v * Config.MAX_FILTER_FREQ, ctx.currentTime); },
      configurable: true,
    },
    postCut: {
      get() { return postCutFilter.frequency.value; },
      set(v: number) { postCutFilter.frequency.setValueAtTime(v, ctx.currentTime); },
      configurable: true,
    },
  });

  return proxy;
}

function buildInstrumentModules(ctx: AudioContext, instrument: Instrument, destination: AudioNode): InstrumentModules {
  // Per-instrument pre-FX output + analyser.
  const output   = createGainNode(ctx);
  output.gain.value = instrument.volume;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;

  // Panner (may be undefined on Safari).
  const panner   = createStereoPanner(ctx);
  if (panner) { panner.pan.value = instrument.panning; }

  // EQ: three bands (lowshelf, mid peaking, highshelf) each with its own gain node.
  const lowBand  = ctx.createBiquadFilter(); lowBand.type  = 'lowshelf';  lowBand.frequency.value  = 360;
  const midBand  = ctx.createBiquadFilter() as unknown as GainNode;       // typed as GainNode in audio-modules; actually BiquadFilter
  (midBand as unknown as BiquadFilterNode).type = 'peaking';
  (midBand as unknown as BiquadFilterNode).frequency.value = 1000;
  (midBand as unknown as BiquadFilterNode).Q.value = 0.5;
  const highBand = ctx.createBiquadFilter(); highBand.type = 'highshelf'; highBand.frequency.value = 3500;

  const lowGain  = createGainNode(ctx); lowGain.gain.value  = instrument.eq?.lowGain  ?? 1;
  const midGain  = createGainNode(ctx); midGain.gain.value  = instrument.eq?.midGain  ?? 1;
  const highGain = createGainNode(ctx); highGain.gain.value = instrument.eq?.highGain ?? 1;

  const eqOutput = createGainNode(ctx);
  lowBand.connect(lowGain).connect(eqOutput);
  (midBand as unknown as BiquadFilterNode).connect(midGain).connect(eqOutput);
  highBand.connect(highGain).connect(eqOutput);

  // Filter + LFO (amplitude-modulated BiquadFilter).
  const filter = ctx.createBiquadFilter();
  filter.type            = instrument.filter.type;
  filter.frequency.value = instrument.filter.frequency;
  filter.Q.value         = instrument.filter.q;

  const lfo = ctx.createOscillator();
  lfo.type      = (instrument.filter.lfoType === 'off' ? 'sine' : instrument.filter.lfoType) as OscillatorType;
  lfo.frequency.value = instrument.filter.speed;
  const lfoAmp = createGainNode(ctx);
  lfoAmp.gain.value = instrument.filter.depth;
  lfo.connect(lfoAmp);
  lfoAmp.connect(filter.frequency);
  lfo.start(ctx.currentTime);

  // Delay (uses the ported Delay class — WrappedAudioNode shape).
  const delayNode = new Delay(ctx, {
    delay:    instrument.delay.time,
    feedback: instrument.delay.feedback,
    cutoff:   instrument.delay.cutoff,
    offset:   instrument.delay.offset,
    dry:      instrument.delay.dry,
  });
  // Cast to the DelayModule shape (audio-modules expects input/output/type/delay/feedback/offset/cutoff/dry).
  const delayWrapped = {
    input:    delayNode.input,
    output:   delayNode.output,
    type:     instrument.delay.type,
    delay:    instrument.delay.time,
    feedback: instrument.delay.feedback,
    offset:   instrument.delay.offset,
    cutoff:   instrument.delay.cutoff,
    dry:      instrument.delay.dry,
  };

  const overdriveNode = buildOverdriveNode(ctx);
  overdriveNode.drive   = instrument.overdrive?.drive   ?? 0.4;
  overdriveNode.color   = instrument.overdrive?.color   ?? 8000;
  overdriveNode.preBand = instrument.overdrive?.preBand ?? 0.05;
  overdriveNode.postCut = instrument.overdrive?.postCut ?? 8000;

  const modules: InstrumentModules = {
    analyser,
    panner,
    overdrive: {
      overdrive:        overdriveNode,
      overdriveEnabled: instrument.overdrive?.enabled ?? false,
    },
    eq: {
      lowBand,
      midBand:   midBand as unknown as GainNode,
      highBand,
      lowGain,
      midGain,
      highGain,
      output:    eqOutput,
      eqEnabled: instrument.eq?.enabled ?? false,
    },
    filter: {
      filter,
      lfo,
      lfoAmp,
      lfoEnabled:    instrument.filter.lfoType !== 'off',
      filterEnabled: instrument.filter.enabled,
    },
    delay: {
      delay:        delayWrapped,
      delayEnabled: instrument.delay.enabled,
    },
    voices: [],
    output,
  };

  // Route modules → destination (master bus).
  applyRouting(modules, destination);
  return modules;
}

// ── Public API: applyModules ────────────────────────────────────────────────

/**
 * Build the per-instrument module graph from a song. The session-aware
 * caller (Phase 3 load path) should use applyModulesForInstruments instead
 * — they do the same work, this overload just preserves the legacy
 * EffluxSong-shaped surface for upstream callers (instrument-replace.ts,
 * useAudioContext.ts).
 */
export const applyModules = (song: EffluxSong, _withAnalysers = false): void => {
  applyModulesForInstruments(song.instruments);
};

/**
 * Phase 3 module-graph builder — takes the instruments array directly,
 * no EffluxSong wrapper required. Called after a session is loaded from
 * disk to rebuild the audio graph against the fresh Instrument objects
 * that came out of JSON.parse (the old graph references stale Instrument
 * objects from the prior session).
 */
export const applyModulesForInstruments = (instruments: Instrument[]): void => {
  if (!audioContext || !masterBus) return;

  // Tear down any previous graph then rebuild, preserving module array reuse.
  for (const mod of instrumentMods) {
    if (!mod) continue;
    try { mod.output.disconnect(); } catch {}
    try { mod.filter.lfo.stop(); }   catch {}
  }
  instrumentMods.length = 0;
  activeEvents.length   = 0;

  for (let i = 0; i < instruments.length; i++) {
    const mods = buildInstrumentModules(audioContext, instruments[i], masterBus);
    instrumentMods[i] = mods;
    activeEvents[i]   = new Map();
  }
};

export const applyModule = (_type: string, _instrumentIndex: number, _props: unknown): void => {
  // Invoked by the settings window when a user changes a routing toggle.
  // Phase 2c: full apply via applyModules (the above already does the right thing).
  // In Phase 2d this gets a fine-grained path for individual module updates.
  const song = getDawBridge().getState().song.activeSong;
  if (song) applyModules(song);
};

// ── Public API: cacheCustomTables ───────────────────────────────────────────

export const cacheCustomTables = (instruments: Instrument[]): void => {
  if (!audioContext) return;
  customWaveCache.length = 0;
  for (let i = 0; i < instruments.length; i++) {
    const perOsc: (PeriodicWave | null)[] = [];
    const inst = instruments[i];
    for (let j = 0; j < inst.oscillators.length; j++) {
      const osc = inst.oscillators[j];
      if (osc.waveform === OscillatorTypes.CUSTOM && Array.isArray(osc.table)) {
        try {
          perOsc[j] = createWaveTableFromGraph(audioContext, osc.table);
        } catch { perOsc[j] = null; }
      } else {
        perOsc[j] = null;
      }
    }
    customWaveCache[i] = perOsc;
  }
};

// ── Public API: note events ─────────────────────────────────────────────────

function ensureEventId(ev: EffluxAudioEvent): number {
  if (!ev.id) ev.id = eventIdSeed++;
  return ev.id!;
}

function buildVoiceForOscillator(
  ctx: AudioContext,
  instrumentIndex: number,
  oscillatorIndex: number,
  osc: InstrumentOscillator,
  frequencyHz: number,
  startTime: number,
  output: AudioNode,
): EventVoice | null {
  if (!osc.enabled) return null;

  const tunedFreq = tuneToOscillator(frequencyHz, osc);

  // Per-voice gain (pre-ADSR) + ADSR gain + oscillator.
  const gain     = createGainNode(ctx);
  gain.gain.value = osc.volume;

  const adsrGain = createGainNode(ctx);
  adsrGain.gain.value = 0;

  let generator: OscillatorNode | AudioBufferSourceNode;

  if (osc.waveform === OscillatorTypes.NOISE) {
    const bufferSize = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop   = true;
    generator = src;
  } else if (osc.waveform === OscillatorTypes.SAMPLE) {
    // Real sample playback — look up the cached buffer by sample name on
    // the oscillator (set by SampleEditor / sample upload).
    const sampleName = osc.sample;
    const entry      = sampleName ? sampleCacheRef?.get(sampleName) : null;
    const buffer     = entry?.buffer ?? null;

    if (!buffer) {
      // No sample loaded — fall through to silent oscillator to keep the chain coherent.
      const o = ctx.createOscillator();
      o.frequency.value = 0;
      generator = o;
    } else {
      const src = ctx.createBufferSource();
      src.buffer = buffer;

      // Pitch-shift: scale playbackRate by the ratio of the note's frequency
      // to the sample's root-note frequency. If no root is set, sample plays
      // at its natural pitch regardless of the MIDI note.
      const rootHz = entry!.sample.pitch?.frequency ?? null;
      if (rootHz && rootHz > 0 && isFinite(tunedFreq)) {
        src.playbackRate.value = tunedFreq / rootHz;
      } else {
        src.playbackRate.value = 1.0;
      }

      // Loop region (if sample has a range defined).
      if (entry!.sample.loop) {
        src.loop = true;
        if (entry!.sample.rangeStart !== undefined && entry!.sample.rangeEnd !== undefined) {
          src.loopStart = entry!.sample.rangeStart;
          src.loopEnd   = entry!.sample.rangeEnd > entry!.sample.rangeStart
            ? entry!.sample.rangeEnd
            : buffer.duration;
        }
      }

      generator = src;
    }
  } else {
    const o = ctx.createOscillator();
    if (osc.waveform === OscillatorTypes.CUSTOM) {
      const wave = customWaveCache[instrumentIndex]?.[oscillatorIndex];
      if (wave) o.setPeriodicWave(wave);
      else      o.type = 'sine';
    } else if (osc.waveform === OscillatorTypes.PWM) {
      o.type = 'square';                      // WebAudio has no PWM type
    } else {
      o.type = osc.waveform.toLowerCase() as OscillatorType;
    }
    o.frequency.value = tunedFreq;
    generator = o;
  }

  generator.connect(gain);
  gain.connect(adsrGain);
  adsrGain.connect(output);

  // Attack-floor policy: an instantaneous 0→V jump causes an audible click
  // because the oscillator was already producing signal before the ramp
  // starts. Clamp to a 2ms minimum — below perceptual envelope threshold,
  // above click threshold. Uses a scratch osc-shaped object so we don't
  // mutate the user's slider value.
  if (osc.adsr.attack < MIN_ATTACK_SECONDS) {
    scratchOsc.enabled     = osc.enabled;
    scratchOsc.waveform    = osc.waveform;
    scratchOsc.volume      = osc.volume;
    scratchOsc.detune      = osc.detune;
    scratchOsc.octaveShift = osc.octaveShift;
    scratchOsc.fineShift   = osc.fineShift;
    scratchOsc.table       = osc.table;
    scratchOsc.sample      = osc.sample;
    scratchOsc.pitch       = osc.pitch;
    scratchAdsr.attack     = MIN_ATTACK_SECONDS;
    scratchAdsr.decay      = osc.adsr.decay;
    scratchAdsr.sustain    = osc.adsr.sustain;
    scratchAdsr.release    = osc.adsr.release;
    scratchOsc.adsr        = scratchAdsr;
    ADSR.applyAmpEnvelope(scratchOsc, adsrGain, startTime);
  } else {
    ADSR.applyAmpEnvelope(osc, adsrGain, startTime);
  }
  if (osc.pitch) ADSR.applyPitchEnvelope(osc, generator, startTime);

  startOscillation(generator, startTime);

  return {
    generator,
    gain,
    outputNode: adsrGain,
    frequency:  tunedFreq,
    vo:         osc,
    gliding:    false,
  };
}

export const noteOn = (
  event:      EffluxAudioEvent,
  instrument: Instrument,
  startTimeInSeconds?: number,
): void => {
  if (!audioContext || !masterBus) return;
  const mods = instrumentMods[instrument.index];
  if (!mods) return;

  const start = (typeof startTimeInSeconds === 'number' && startTimeInSeconds > 0)
    ? startTimeInSeconds
    : audioContext.currentTime;

  const baseFreq = Pitch.getFrequency(event.note, event.octave);
  if (!isFinite(baseFreq)) return;

  const voices: EventVoiceList = [];
  for (let j = 0; j < instrument.oscillators.length; j++) {
    const voice = buildVoiceForOscillator(
      audioContext, instrument.index, j,
      instrument.oscillators[j], baseFreq, start, mods.output,
    );
    if (voice) voices.push(voice);
  }

  if (voices.length === 0) return;

  // Stash as the active voice-list for this event so noteOff can release it.
  mods.voices.push(voices);
  const id = ensureEventId(event);
  activeEvents[instrument.index].set(id, voices);

  // Apply any module-param change attached to the event.
  if (event.mp) {
    applyModuleParamChange(
      audioContext, event, mods, instrument, mods.voices, start, masterBus,
    );
  }
};

export const noteOff = (event: EffluxAudioEvent, startTimeInSeconds?: number): void => {
  if (!audioContext) return;
  if (!event.id) return;

  for (let i = 0; i < instrumentMods.length; i++) {
    const voices = activeEvents[i]?.get(event.id);
    if (!voices) continue;

    const start = (typeof startTimeInSeconds === 'number' && startTimeInSeconds > 0)
      ? startTimeInSeconds
      : audioContext.currentTime;

    for (const voice of voices) {
      try {
        ADSR.applyAmpRelease(voice.vo, voice.outputNode, start);
        if (voice.vo.pitch) ADSR.applyPitchRelease(voice.vo, voice.generator, start);

        const releaseEnd = start + (voice.vo.adsr.release || 0.05);
        stopOscillation(voice.generator, releaseEnd);
        // generator.onended cleans up after release.
        voice.generator.onended = () => {
          try { voice.generator.disconnect(); } catch {}
          try { voice.gain.disconnect(); }      catch {}
          try { voice.outputNode.disconnect(); } catch {}
        };
      } catch { /* ignore release errors on already-stopped voices */ }
    }

    activeEvents[i].delete(event.id);
    // Remove the voice-list from mods.voices so GC can reclaim.
    const idx = instrumentMods[i].voices.indexOf(voices);
    if (idx >= 0) instrumentMods[i].voices.splice(idx, 1);
    break;
  }
};

// ── Public API: transport ───────────────────────────────────────────────────

export const isRecording = (): boolean => {
  return getDawBridge().getState().sequencer.recording;
};

export const togglePlayback = (setPlaying: boolean): void => {
  if (!audioContext) return;

  if (setPlaying) {
    // Read the session — Phase 3's scheduler is driven from useSessionStore,
    // not useSongStore. If no session is loaded, refuse to play.
    const state   = getDawBridge().getState();
    const session = state.session.activeSession;
    if (!session) return;

    scheduledSession    = session;
    globalStepCounter   = 0;
    nextStepTime        = audioContext.currentTime + 0.05;     // small cushion
    schedulerPlaying    = true;

    // Cache session timing so the per-tick hot path does not re-read the
    // store. These are stable for the duration of playback (tempo changes
    // mid-playback are a Session 4 polish item; for now they take effect
    // on next togglePlayback).
    stepsPerBeatCache = session.stepsPerBeat;
    stepsPerBarCache  = session.beatsPerBar * session.stepsPerBeat;
    secPerStepCache   = 60 / session.tempo / session.stepsPerBeat;
    // Quantization grid → steps between launch boundaries. Switch happens
    // here once at play-start; the inner-tick check stays a single modulo.
    switch (session.quantization) {
      case '2bar':     stepsPerLaunchCache = stepsPerBarCache * 2;             break;
      case 'half_bar': stepsPerLaunchCache = Math.max(1, stepsPerBarCache >> 1); break;
      case '1beat':    stepsPerLaunchCache = stepsPerBeatCache;                break;
      case '1bar':
      default:         stepsPerLaunchCache = stepsPerBarCache;                 break;
    }

    // Size the per-channel held-voice tracker to the session's channel
    // count. Mutate length in place — never replace the array.
    const chanCount = session.channels.length;
    heldByChannel.length = chanCount;
    for (let c = 0; c < chanCount; c++) heldByChannel[c] = null;

    // Reset per-channel runtime fields (playingClipIdx / playingCursor) so
    // we start from a clean slate. armedClipIdx is preserved (Q3.1 — saved
    // arms become live on the first bar boundary, which is step 0 since
    // globalStepCounter starts at 0). Direct mutation; one bumpSessionVersion
    // covers the whole channel sweep.
    for (let c = 0; c < chanCount; c++) {
      const ch = session.channels[c];
      ch.playingClipIdx = -1;
      ch.playingCursor  = 0;
    }
    getDawBridge().commit.bumpSessionVersion();

    schedulerTimerId = setInterval(schedulerTick, schedulerIntervalMs);
  } else {
    schedulerPlaying = false;
    if (schedulerTimerId !== null) {
      clearInterval(schedulerTimerId);
      schedulerTimerId = null;
    }
    // Release all active voices immediately. Q3.2: stop is panic-action,
    // not bar-quantized. No latency between clicking Stop and silence.
    const releaseAt = audioContext.currentTime + 0.05;
    for (let i = 0; i < activeEvents.length; i++) {
      const map = activeEvents[i];
      if (!map) continue;
      // Materialise keys before mutating the map. Stop is a cold path —
      // one allocation per stop is acceptable; per-step would not be.
      const ids = Array.from(map.keys());
      for (let k = 0; k < ids.length; k++) {
        const id     = ids[k];
        const voices = map.get(id);
        if (!voices) continue;
        for (let v = 0; v < voices.length; v++) {
          try { stopOscillation(voices[v].generator, releaseAt); } catch {}
        }
        map.delete(id);
      }
    }
    // Release and clear the per-channel held-voice tracker.
    for (let c = 0; c < heldByChannel.length; c++) {
      const voices = heldByChannel[c];
      if (voices) releaseHeldVoices(voices, audioContext.currentTime);
      heldByChannel[c] = null;
    }
    heldByChannel.length = 0;

    // Reset per-channel runtime state in the session store. Arm state
    // remains as the user left it — they should be able to hit Play again
    // and resume from where they were.
    if (scheduledSession) {
      const channels = scheduledSession.channels;
      for (let c = 0; c < channels.length; c++) {
        channels[c].playingClipIdx = -1;
        channels[c].playingCursor  = 0;
      }
      getDawBridge().commit.bumpSessionVersion();
    }
    scheduledSession = null;
  }
};

// ── Scheduler ────────────────────────────────────────────────────────────────

function releaseHeldVoices(voices: EventVoiceList, releaseTime: number): void {
  if (!audioContext) return;
  for (let i = 0; i < voices.length; i++) {
    const voice = voices[i];
    try {
      ADSR.applyAmpRelease(voice.vo, voice.outputNode, releaseTime);
      if (voice.vo.pitch) ADSR.applyPitchRelease(voice.vo, voice.generator, releaseTime);
      const releaseEnd = releaseTime + (voice.vo.adsr.release || 0.05);
      stopOscillation(voice.generator, releaseEnd);
      voice.generator.onended = () => {
        try { voice.generator.disconnect(); }  catch {}
        try { voice.gain.disconnect(); }       catch {}
        try { voice.outputNode.disconnect(); } catch {}
      };
    } catch { /* already stopped */ }
  }
}

/**
 * Detach a per-channel held-voice list from the owning instrument's
 * mods.voices array so the GC can reclaim it. Channel→instrument lookup
 * is via the session; this is shared by every code path that releases a
 * held voice (mid-playback retrigger, launch transition, end-of-clip stop,
 * channel disable).
 */
function detachHeldVoices(channelIdx: number, voices: EventVoiceList): void {
  if (!scheduledSession) return;
  const instrIdx = scheduledSession.channels[channelIdx]?.instrumentIndex;
  if (instrIdx === undefined) return;
  const mods = instrumentMods[instrIdx];
  if (!mods) return;
  const idx = mods.voices.indexOf(voices);
  if (idx >= 0) mods.voices.splice(idx, 1);
}

/**
 * The scheduler tick — runs on a 25ms setInterval, schedules every step
 * whose AudioContext time falls within the look-ahead horizon.
 *
 * Per step (per channel):
 *   1. Bar-boundary check: process per-channel arm transitions and
 *      disable-stops. Launch boundary = globalStepCounter % stepsPerLaunchCache === 0.
 *   2. Per-channel cursor advance: read the event at the current cursor
 *      position, schedule via noteOn/noteOff with held-voice release,
 *      advance cursor (or wrap on loop, or stop on loop=false).
 *
 * Hot-path discipline:
 *   • No allocation. heldByChannel is pre-sized at togglePlayback start.
 *   • No spread, no destructuring. Indexed loops only.
 *   • Cached session timing (stepsPerBarCache, secPerStepCache) avoids
 *     per-tick property reads.
 *   • One bumpSessionVersion at end of tick — never per-channel.
 */
function schedulerTick(): void {
  if (!audioContext || !schedulerPlaying || !scheduledSession) return;

  const session  = scheduledSession;
  const channels = session.channels;
  const horizon  = audioContext.currentTime + (schedulerLookAheadMs / 1000);

  let anyMutation = false;

  while (nextStepTime < horizon) {
    // Launch-quantization grid boundary. stepsPerLaunchCache was set at
    // togglePlayback start from session.quantization (1bar / 2bar /
    // half_bar / 1beat). Bar-boundary handling for arms and disable-stops
    // fires when this lands on a grid step.
    const isLaunchBoundary = (globalStepCounter % stepsPerLaunchCache) === 0;

    // ── Launch-grid processing ───────────────────────────────────────────
    // Arm transitions and disable-stops fire on the launch grid.
    if (isLaunchBoundary) {
      for (let c = 0; c < channels.length; c++) {
        const ch = channels[c];

        // Disable-stop: channel was disabled mid-playback; let the current
        // clip finish through to this bar boundary, then stop. Per design
        // doc §4.3 channel-disable check.
        if (!ch.enabled && ch.playingClipIdx >= 0) {
          const held = heldByChannel[c];
          if (held) {
            releaseHeldVoices(held, nextStepTime);
            detachHeldVoices(c, held);
            heldByChannel[c] = null;
          }
          ch.playingClipIdx = -1;
          ch.playingCursor  = 0;
          anyMutation       = true;
          continue;
        }

        // Arm transition: queued clip becomes the playing clip. Skip if
        // the channel is disabled (the user disabled it before launch
        // — honor the disable, drop the arm silently to avoid a phantom
        // play-then-stop).
        if (ch.armedClipIdx >= 0 && ch.enabled) {
          // Release any clip currently sounding on this channel before the
          // new clip begins — otherwise the previous voice rings under the
          // new clip's first note.
          if (ch.playingClipIdx >= 0) {
            const held = heldByChannel[c];
            if (held) {
              releaseHeldVoices(held, nextStepTime);
              detachHeldVoices(c, held);
              heldByChannel[c] = null;
            }
          }
          ch.playingClipIdx = ch.armedClipIdx;
          ch.armedClipIdx   = -1;
          ch.playingCursor  = 0;
          anyMutation       = true;
        }
      }
    }

    // ── Per-channel cursor advance + event firing ────────────────────────
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      if (ch.playingClipIdx < 0) continue;
      if (!ch.enabled)           continue;     // Q3.5: enabled gate

      // Phase A host-route gate: when a channel has a host instrument set,
      // PhobosHost owns its voicing. The WebAudio synth path on this channel
      // is silent — we still need the cursor to advance (the UI's
      // playingCursor / playingClipIdx must reflect transport position even
      // for silent channels), but we skip the noteOn/noteOff dispatch and
      // the heldByChannel bookkeeping. The schema-level scheduler→host
      // dispatch lands in Phase 4 (clip-compile-and-launch via the host's
      // SchedulerNode — see Audio Spec §4.11 / §10.15). Until then,
      // host-routed channels are audibly silent during tracker playback;
      // user ops (showPluginUi, single-note keyboard input) still reach the
      // host via hostNote().
      const hostRouted = ch.hostInstrument !== null;

      const clip = ch.clips[ch.playingClipIdx];
      if (!clip) {
        // Defensive: clip was deleted while playing. Stop the channel.
        ch.playingClipIdx = -1;
        ch.playingCursor  = 0;
        anyMutation       = true;
        continue;
      }

      const instrument = session.instruments[ch.instrumentIndex];
      if (!instrument) continue;

      // Q3.5: instrument.muted is the OTHER half of the gate. Both must
      // pass for sound. Mute does NOT advance the cursor — keep the clip
      // at its current position until unmuted (matches Ableton: muted
      // tracks freeze in place during playback).
      if (instrument.muted) continue;

      const cursor = ch.playingCursor;
      const ev     = clip.channel[cursor];

      if (!hostRouted && ev !== 0 && ev !== undefined) {
        if (ev.action === ACTION_NOTE_ON) {
          // Release prior voice on this channel before triggering — the
          // stacking-notes prevention from Phase 2c.1, now keyed by
          // session channel rather than pattern channel.
          const prev = heldByChannel[c];
          if (prev) {
            releaseHeldVoices(prev, nextStepTime);
            detachHeldVoices(c, prev);
            heldByChannel[c] = null;
          }

          noteOn(ev, instrument, nextStepTime);
          // noteOn appended the new voice list to mods.voices — grab a
          // reference for release-on-next-trigger.
          const mods = instrumentMods[instrument.index];
          if (mods && mods.voices.length > 0) {
            heldByChannel[c] = mods.voices[mods.voices.length - 1];
          }
        } else if (ev.action === ACTION_NOTE_OFF) {
          const prev = heldByChannel[c];
          if (prev) {
            releaseHeldVoices(prev, nextStepTime);
            detachHeldVoices(c, prev);
            heldByChannel[c] = null;
          }
        }
      }

      // Cursor advance: wrap on loop, stop on loop=false at end.
      const nextCursor = cursor + 1;
      if (nextCursor >= clip.steps) {
        if (clip.loop) {
          ch.playingCursor = 0;
        } else {
          // End-of-clip with loop=false. Release held voice and stop the
          // channel. Per Q3 design: no implicit follow-clip; the user
          // can re-arm to play again.
          const prev = heldByChannel[c];
          if (prev) {
            releaseHeldVoices(prev, nextStepTime);
            detachHeldVoices(c, prev);
            heldByChannel[c] = null;
          }
          ch.playingClipIdx = -1;
          ch.playingCursor  = 0;
        }
      } else {
        ch.playingCursor = nextCursor;
      }
      anyMutation = true;
    }

    nextStepTime      += secPerStepCache;
    globalStepCounter += 1;
  }

  // One bump per tick. UI subscribers (ClipCell state, per-channel cursor
  // LEDs, etc.) re-render at scheduler tick rate (~40Hz). Below display
  // refresh, but well above the perceptual threshold for "playing" feedback.
  if (anyMutation) {
    getDawBridge().commit.bumpSessionVersion();
  }
}

/**
 * Phase 2c back-compat. The single-pattern model had ONE current step;
 * the session model has N per-channel cursors. Returns 0 — callers should
 * migrate to reading useSessionStore.activeSession.channels[c].playingCursor
 * directly. Kept as a no-op stub rather than removed because the engine's
 * default-export object lists it; removing the export would force a
 * cross-file edit elsewhere on this batch's critical path.
 *
 * useTransportTick has been migrated; this is for any straggler callers.
 */
export const getCurrentStep = (): number => 0;

/**
 * Phase 3 replacement for getCurrentStep. Returns the per-clip cursor of
 * the channel's currently-playing clip, or 0 if nothing is playing on
 * that channel.
 */
export const getCurrentStepForChannel = (channelIdx: number): number => {
  if (!scheduledSession) return 0;
  const ch = scheduledSession.channels[channelIdx];
  if (!ch || ch.playingClipIdx < 0) return 0;
  return ch.playingCursor;
};

// ── Public API: analysers + context + misc ─────────────────────────────────

export const getCurrentModuleParamValue = (instrument: Instrument, param: ModuleParamDef): number => {
  const mods = instrumentMods[instrument.index];
  if (!mods) return 0;
  return getCurrentValueForParam(mods, instrument, param);
};

export const prepareEnvironment = (
  ctx: BaseAudioContext,
  _optAudioCallback?: (audioBuffer: AudioBuffer, cb?: () => void) => void,
): void => {
  // Called by older code paths; we booted via init() directly.
  if (ctx instanceof AudioContext) init(ctx);
};

export const reset = (resetEventCounter = false): void => {
  for (let i = 0; i < activeEvents.length; i++) {
    activeEvents[i]?.clear();
  }
  for (const mods of instrumentMods) {
    mods?.voices.splice(0, mods.voices.length);
  }
  if (resetEventCounter) eventIdSeed = 1;
};

export const getAudioContext = (): BaseAudioContext | null => audioContext;

export const connectAnalysers = (): boolean => true;     // always on now

export const getAnalysers = (): AnalyserNode[] => {
  const list: AnalyserNode[] = [];
  if (masterAnalyser) list.push(masterAnalyser);
  for (const m of instrumentMods) if (m?.analyser) list.push(m.analyser);
  return list;
};

// ── Default export (Efflux's object-shaped API) ─────────────────────────────

const AudioService = {
  initialized: false,
  isSupported: (): boolean =>
    typeof AudioContext !== 'undefined' ||
    typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !== 'undefined',

  /**
   * Initialise against a pre-made AudioContext (typically built by
   * useAudioContext.unlock from the user gesture).
   */
  async init(ctx: AudioContext, _waveTables?: unknown, _outputRecorder?: unknown): Promise<void> {
    init(ctx);
    AudioService.initialized = true;
  },

  reset,
  togglePlayback,
  applyModules,
  applyModulesForInstruments,
  applyModule,
  cacheCustomTables,
  cacheAllOscillators(_instrumentIndex: number, _instrument: Instrument): void {
    // Fine-grained per-instrument re-cache. Phase 2c full-reload is fine.
    const song = getDawBridge().getState().song.activeSong;
    if (song) cacheCustomTables(song.instruments);
  },
  noteOn,
  noteOff,
  getAudioContext,
  getCurrentStep,
  getCurrentStepForChannel,
  isRecording,
  toggleRecordingState(): void {
    // OutputRecorder lands in 2d/export phase.
  },
  updateOscillator(
    _property: 'waveform' | 'tuning' | 'volume',
    _instrument: Instrument, _oscillatorIndex: number, _oscillator: InstrumentOscillator,
  ): void {
    // Re-cache custom table if waveform switched to/from CUSTOM, else nothing
    // to do — active voices keep their original waveform until replaced.
    const song = getDawBridge().getState().song.activeSong;
    if (song) cacheCustomTables(song.instruments);
  },
  adjustInstrumentVolume(instrumentIndex: number, volume: number): void {
    const mods = instrumentMods[instrumentIndex];
    if (!mods || !audioContext) return;
    mods.output.gain.setValueAtTime(volume, audioContext.currentTime);
  },
  adjustInstrumentPanning(instrumentIndex: number, pan: number): void {
    const mods = instrumentMods[instrumentIndex];
    if (!mods?.panner || !audioContext) return;
    mods.panner.pan.setValueAtTime(pan, audioContext.currentTime);
  },
  adjustMasterVolume(volume: number): void {
    if (!masterBus || !audioContext) return;
    masterBus.gain.setValueAtTime(volume, audioContext.currentTime);
  },
  getMasterVolume(): number {
    return masterBus ? masterBus.gain.value : 1.0;
  },
};

export default AudioService;
