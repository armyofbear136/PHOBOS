#!/usr/bin/env node
/**
 * phobos-supertonic.mjs — Supertonic 3 TTS daemon.
 *
 * Spawned ONCE by AudioServerManager and kept alive for the session.
 * Accepts newline-delimited JSON jobs on stdin, processes them sequentially,
 * and writes progress lines to stdout.
 *
 * Startup:
 *   node phobos-supertonic.mjs --model-dir /path/to/dist/supertonic
 *
 * Job protocol (stdin, one JSON object per line):
 *   { "id": "<uuid>", "text": "Hello.", "output": "/path/to/out.wav", "voice": "M1", "lang": "na", "speed": 1.05, "steps": 8 }
 *
 * Response protocol (stdout, flushed):
 *   [INFO ] <message>                    — progress / status
 *   [ERROR] <id> <message>               — job failed (daemon stays alive)
 *   [DONE ] <id> <outputPath>            — job succeeded
 *   [READY]                              — models loaded, ready for jobs
 *
 * Voice IDs: M1, M2, M3, M4, M5, F1, F2, F3, F4, F5
 * Lang codes: en, ko, ja, fr, de, es, pt, ar, bg, cs, da, el, et, fi, hr, hi,
 *             hu, id, it, lt, lv, nl, pl, ro, ru, sk, sl, sv, tr, uk, vi, na
 */

import { parseArgs }    from 'node:util';
import { createInterface } from 'node:readline';
import path              from 'node:path';
import fs                from 'node:fs';
import * as ort          from 'onnxruntime-node';

// ── CLI args ──────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    'model-dir': { type: 'string', short: 'm' },
  },
  allowPositionals: true,
  strict: false,
});

const modelDir = args['model-dir'] ?? process.argv[2];

if (!modelDir) {
  process.stderr.write('[FATAL] --model-dir is required\n');
  process.exit(1);
}

const AVAILABLE_LANGS = [
  'en','ko','ja','ar','bg','cs','da','de','el','es','et','fi','fr','hi',
  'hr','hu','id','it','lt','lv','nl','pl','pt','ro','ru','sk','sl','sv',
  'tr','uk','vi','na',
];

// ── Unicode text processor ────────────────────────────────────────────────────

function loadUnicodeIndexer(modelDir) {
  const p = path.join(modelDir, 'unicode_indexer.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function preprocessText(text, lang, indexer) {
  text = text.normalize('NFKD');

  // Remove emojis
  const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
  text = text.replace(emojiPattern, '');

  const replacements = {
    '–': '-', '‑': '-', '—': '-', '_': ' ',
    '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'",
    '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ',
    '/': ' ', '#': ' ', '→': ' ', '←': ' ',
  };
  for (const [k, v] of Object.entries(replacements)) text = text.replaceAll(k, v);

  text = text.replace(/[♥☆♡©\\]/g, '');

  const exprReplacements = { '@': ' at ', 'e.g.,': 'for example, ', 'i.e.,': 'that is, ' };
  for (const [k, v] of Object.entries(exprReplacements)) text = text.replaceAll(k, v);

  text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!')
             .replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':')
             .replace(/ '/g, "'");

  while (text.includes('""')) text = text.replace('""', '"');
  while (text.includes("''")) text = text.replace("''", "'");

  text = text.replace(/\s+/g, ' ').trim();

  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += '.';

  const activeLang = AVAILABLE_LANGS.includes(lang) ? lang : 'na';
  text = `<${activeLang}>${text}</${activeLang}>`;
  return text;
}

function textToIds(text, indexer) {
  return Array.from(text).map(c => indexer[c.charCodeAt(0)] ?? 0);
}

function lengthToMask(lengths) {
  const maxLen = Math.max(...lengths);
  return lengths.map(len => {
    const row = new Array(maxLen).fill(0.0);
    for (let j = 0; j < len; j++) row[j] = 1.0;
    return [row]; // [1, maxLen] per batch item
  });
}

function getLatentMask(wavLengths, baseChunkSize, chunkCompressFactor) {
  const latentSize = baseChunkSize * chunkCompressFactor;
  const latentLengths = wavLengths.map(l => Math.floor((l + latentSize - 1) / latentSize));
  return lengthToMask(latentLengths);
}

function arrayToTensor(array, dims) {
  const flat = array.flat(Infinity);
  return new ort.Tensor('float32', Float32Array.from(flat), dims);
}

function intArrayToTensor(array, dims) {
  const flat = array.flat(Infinity);
  return new ort.Tensor('int64', BigInt64Array.from(flat.map(x => BigInt(x))), dims);
}

function writeWavFile(filename, audioData, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = audioData.length * bitsPerSample / 8;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < audioData.length; i++) {
    const sample = Math.max(-1, Math.min(1, audioData[i]));
    buffer.writeInt16LE(Math.floor(sample * 32767), 44 + i * 2);
  }

  fs.writeFileSync(filename, buffer);
}

function chunkText(text, maxLen = 300) {
  const paragraphs = text.trim().split(/\n\s*\n+/).filter(p => p.trim());
  const chunks = [];
  for (const paragraph of paragraphs) {
    const sentences = paragraph.split(/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/);
    let current = '';
    for (const sentence of sentences) {
      if (current.length + sentence.length + 1 <= maxLen) {
        current += (current ? ' ' : '') + sentence;
      } else {
        if (current) chunks.push(current.trim());
        current = sentence;
      }
    }
    if (current) chunks.push(current.trim());
  }
  return chunks.length > 0 ? chunks : [text.trim()];
}

// ── TTS inference ─────────────────────────────────────────────────────────────

async function inferChunk(textList, langList, style, sessions, cfgs, indexer, totalStep, speed) {
  const bsz = textList.length;
  const { dpOrt, textEncOrt, vectorEstOrt, vocoderOrt } = sessions;
  const sampleRate = cfgs.ae.sample_rate;
  const baseChunkSize = cfgs.ae.base_chunk_size;
  const chunkCompressFactor = cfgs.ttl.chunk_compress_factor;
  const ldim = cfgs.ttl.latent_dim;

  // Build text tensors
  const processedTexts = textList.map((t, i) => preprocessText(t, langList[i], indexer));
  const textIdsLengths = processedTexts.map(t => t.length);
  const maxLen = Math.max(...textIdsLengths);

  const textIds = processedTexts.map(t => {
    const row = new Array(maxLen).fill(0);
    const vals = textToIds(t, indexer);
    for (let j = 0; j < vals.length; j++) row[j] = vals[j];
    return row;
  });

  const textMask = lengthToMask(textIdsLengths);
  const textIdsShape = [bsz, maxLen];
  const textMaskShape = [bsz, 1, maxLen];

  const textMaskTensor = arrayToTensor(textMask, textMaskShape);
  const textIdsTensor  = intArrayToTensor(textIds, textIdsShape);

  // Duration predictor
  const dpResult = await dpOrt.run({
    text_ids: textIdsTensor,
    style_dp: style.dp,
    text_mask: textMaskTensor,
  });
  const durOnnx = Array.from(dpResult.duration.data).map(d => d / speed);

  // Text encoder
  const textEncResult = await textEncOrt.run({
    text_ids: textIdsTensor,
    style_ttl: style.ttl,
    text_mask: textMaskTensor,
  });
  const textEmbTensor = textEncResult.text_emb;

  // Sample noisy latent
  const wavLenMax = Math.max(...durOnnx) * sampleRate;
  const wavLengths = durOnnx.map(d => Math.floor(d * sampleRate));
  const chunkSize = baseChunkSize * chunkCompressFactor;
  const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
  const latentDim = ldim * chunkCompressFactor;

  const noisyLatent = [];
  for (let b = 0; b < bsz; b++) {
    const batch = [];
    for (let d = 0; d < latentDim; d++) {
      const row = [];
      for (let t = 0; t < latentLen; t++) {
        const u1 = Math.max(1e-10, Math.random());
        const u2 = Math.random();
        row.push(Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2));
      }
      batch.push(row);
    }
    noisyLatent.push(batch);
  }

  const latentMask = getLatentMask(wavLengths, baseChunkSize, chunkCompressFactor);
  for (let b = 0; b < noisyLatent.length; b++) {
    for (let d = 0; d < noisyLatent[b].length; d++) {
      for (let t = 0; t < noisyLatent[b][d].length; t++) {
        noisyLatent[b][d][t] *= latentMask[b][0][t];
      }
    }
  }

  const latentShape = [bsz, noisyLatent[0].length, noisyLatent[0][0].length];
  const latentMaskShape = [bsz, 1, latentMask[0][0].length];
  const latentMaskTensor = arrayToTensor(latentMask, latentMaskShape);
  const scalarShape = [bsz];
  const totalStepTensor = arrayToTensor(new Array(bsz).fill(totalStep), scalarShape);

  // Flow matching denoising loop
  for (let step = 0; step < totalStep; step++) {
    const vectorEstResult = await vectorEstOrt.run({
      noisy_latent: arrayToTensor(noisyLatent, latentShape),
      text_emb: textEmbTensor,
      style_ttl: style.ttl,
      text_mask: textMaskTensor,
      latent_mask: latentMaskTensor,
      total_step: totalStepTensor,
      current_step: arrayToTensor(new Array(bsz).fill(step), scalarShape),
    });

    const denoised = Array.from(vectorEstResult.denoised_latent.data);
    let idx = 0;
    for (let b = 0; b < noisyLatent.length; b++)
      for (let d = 0; d < noisyLatent[b].length; d++)
        for (let t = 0; t < noisyLatent[b][d].length; t++)
          noisyLatent[b][d][t] = denoised[idx++];
  }

  // Vocoder
  const vocoderResult = await vocoderOrt.run({
    latent: arrayToTensor(noisyLatent, latentShape),
  });

  return { wav: Array.from(vocoderResult.wav_tts.data), duration: durOnnx, sampleRate };
}

async function synthesize(text, lang, style, sessions, cfgs, indexer, totalStep, speed, output) {
  const sampleRate = cfgs.ae.sample_rate;
  const maxLen = (lang === 'ko' || lang === 'ja') ? 120 : 300;
  const chunks = chunkText(text, maxLen);
  const silenceDuration = 0.3;

  let wavCat = null;
  for (const chunk of chunks) {
    const { wav, duration } = await inferChunk(
      [chunk], [lang], style, sessions, cfgs, indexer, totalStep, speed
    );
    if (wavCat === null) {
      const wavLen = Math.floor(duration[0] * sampleRate);
      wavCat = wav.slice(0, wavLen);
    } else {
      const wavLen = Math.floor(duration[0] * sampleRate);
      const silence = new Array(Math.floor(silenceDuration * sampleRate)).fill(0);
      wavCat = [...wavCat, ...silence, ...wav.slice(0, wavLen)];
    }
  }

  writeWavFile(output, wavCat ?? [], sampleRate);
}

// ── Load voice style from JSON ─────────────────────────────────────────────────

function loadVoiceStyle(voiceStylePath) {
  const data = JSON.parse(fs.readFileSync(voiceStylePath, 'utf8'));
  const ttlDims = data.style_ttl.dims;
  const dpDims  = data.style_dp.dims;

  const ttlFlat = new Float32Array(data.style_ttl.data.flat(Infinity));
  const dpFlat  = new Float32Array(data.style_dp.data.flat(Infinity));

  return {
    ttl: new ort.Tensor('float32', ttlFlat, ttlDims),
    dp:  new ort.Tensor('float32', dpFlat,  dpDims),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Verify model directory
  const requiredFiles = [
    'duration_predictor.onnx',
    'text_encoder.onnx',
    'vector_estimator.onnx',
    'vocoder.onnx',
    'tts.json',
    'unicode_indexer.json',
  ];
  for (const f of requiredFiles) {
    if (!fs.existsSync(path.join(modelDir, f))) {
      process.stderr.write(`[FATAL] Missing model file: ${path.join(modelDir, f)}\n`);
      process.exit(1);
    }
  }

  process.stdout.write('[INFO ] Loading Supertonic 3 models...\n');

  const cfgs    = JSON.parse(fs.readFileSync(path.join(modelDir, 'tts.json'), 'utf8'));
  const indexer = loadUnicodeIndexer(modelDir);

  const opts = {}; // CPU — onnxruntime-node default
  const [dpOrt, textEncOrt, vectorEstOrt, vocoderOrt] = await Promise.all([
    ort.InferenceSession.create(path.join(modelDir, 'duration_predictor.onnx'), opts),
    ort.InferenceSession.create(path.join(modelDir, 'text_encoder.onnx'), opts),
    ort.InferenceSession.create(path.join(modelDir, 'vector_estimator.onnx'), opts),
    ort.InferenceSession.create(path.join(modelDir, 'vocoder.onnx'), opts),
  ]);
  const sessions = { dpOrt, textEncOrt, vectorEstOrt, vocoderOrt };

  // Pre-load all bundled voice styles
  const voiceStylesDir = path.join(modelDir, 'voice_styles');
  const voiceCache = new Map();
  if (fs.existsSync(voiceStylesDir)) {
    for (const f of fs.readdirSync(voiceStylesDir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.replace(/\.json$/, ''); // e.g. 'M1', 'F1'
      try {
        voiceCache.set(id, loadVoiceStyle(path.join(voiceStylesDir, f)));
      } catch (e) {
        process.stderr.write(`[WARN ] Failed to load voice ${id}: ${e.message}\n`);
      }
    }
  }

  if (voiceCache.size === 0) {
    process.stderr.write('[FATAL] No voice style JSON files found in voice_styles/\n');
    process.exit(1);
  }

  process.stdout.write('[READY]\n');

  // ── Job loop ──────────────────────────────────────────────────────────────

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (!line) return;

    let job;
    try {
      job = JSON.parse(line);
    } catch {
      process.stderr.write(`[ERROR] Failed to parse job JSON: ${line}\n`);
      return;
    }

    const { id, text, output, voice = 'M1', lang = 'na', speed = 1.05, steps = 8 } = job;

    if (!id || !text || !output) {
      process.stdout.write(`[ERROR] ${id ?? '?'} missing required fields (id, text, output)\n`);
      return;
    }

    const style = voiceCache.get(voice) ?? voiceCache.get('M1');
    if (!style) {
      process.stdout.write(`[ERROR] ${id} voice '${voice}' not found and no fallback\n`);
      return;
    }

    try {
      await synthesize(text, lang, style, sessions, cfgs, indexer, steps, speed, output);
      process.stdout.write(`[DONE ] ${id} ${output}\n`);
    } catch (err) {
      process.stdout.write(`[ERROR] ${id} ${err.message}\n`);
    }
  });

  rl.on('close', () => process.exit(0));
}

main().catch(err => {
  process.stderr.write(`[FATAL] ${err.message}\n`);
  process.exit(1);
});
