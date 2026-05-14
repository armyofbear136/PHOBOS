#!/usr/bin/env node
/**
 * phobos-kokoro.mjs — Kokoro 82M TTS daemon.
 *
 * Spawned ONCE by AudioServerManager and kept alive for the session.
 * Accepts newline-delimited JSON jobs on stdin, processes them sequentially,
 * and writes progress lines to stdout.
 *
 * Startup:
 *   node phobos-kokoro.mjs --model-dir /path/to/bin/kokoro [--voice af_heart] [--speed 1.0]
 *
 * Job protocol (stdin, one JSON object per line):
 *   { "id": "<uuid>", "text": "Hello.", "output": "/path/to/out.wav", "voice": "af_heart", "speed": 1.0 }
 *
 * Response protocol (stdout, flushed):
 *   [INFO ] <message>                    — progress / status
 *   [ERROR] <id> <message>               — job failed (daemon stays alive)
 *   [DONE ] <id> <outputPath>            — job succeeded
 *   [READY]                              — model loaded, ready for jobs
 *
 * The daemon exits only on unrecoverable startup failure (model not found, etc.)
 * or when stdin closes (parent process died).
 */

import { parseArgs }  from 'node:util';
import { createInterface } from 'node:readline';
import path            from 'node:path';
import fs              from 'node:fs';

// ── CLI args ──────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    'model-dir': { type: 'string' },
    'voice':     { type: 'string', default: 'af_heart' },
    'speed':     { type: 'string', default: '1.0' },
  },
  strict: false,
});

function info(msg)           { process.stdout.write(`[INFO ] ${msg}\n`); }
function ready()             { process.stdout.write(`[READY]\n`); }
function done(id, outPath)   { process.stdout.write(`[DONE ] ${id} ${outPath}\n`); }
function jobError(id, msg)   { process.stdout.write(`[ERROR] ${id} ${msg}\n`); }

function die(msg) {
  process.stdout.write(`[FATAL] ${msg}\n`);
  process.exit(1);
}

if (!args['model-dir']) die('--model-dir is required');

const modelDir     = args['model-dir'];
const defaultVoice = args['voice'];
const defaultSpeed = parseFloat(args['speed']);
const modelFile    = path.join(modelDir, 'onnx', 'model_quantized.onnx');

if (!fs.existsSync(modelFile)) {
  die(`Kokoro model not found at ${modelFile} — download via Phobos settings`);
}

// ── Load model once at startup ────────────────────────────────────────────────

let tts;

try {
  const { env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels  = true;
  env.localModelPath    = modelDir;
  env.cacheDir          = modelDir;

  const { KokoroTTS } = await import('kokoro-js');

  info('Loading Kokoro ONNX model...');
  tts = await KokoroTTS.from_pretrained(modelDir, {
    dtype:  'q8',
    device: 'cpu',
    progress_callback: (p) => {
      if (typeof p === 'object' && p !== null && 'progress' in p) {
        const pct = Math.round(Number(p.progress ?? 0));
        info(`Loading model: ${pct}%`);
      }
    },
  });
  info('Model loaded — daemon ready');
  ready();
} catch (err) {
  const msg = err?.message ?? String(err);
  if (msg.includes('Cannot find module') && msg.includes('kokoro-js'))
    die('kokoro-js not installed — run: npm install');
  if (msg.includes('Cannot find module') && msg.includes('@huggingface/transformers'))
    die('@huggingface/transformers not installed — run: npm install');
  die(msg);
}

// ── Job loop — read one JSON job per line from stdin ─────────────────────────

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Exit cleanly when the parent closes stdin (parent died or shut down the daemon).
rl.on('close', () => process.exit(0));

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let job;
  try {
    job = JSON.parse(trimmed);
  } catch {
    // Malformed line — skip silently (don't crash the daemon)
    continue;
  }

  const { id, text, output, voice, speed } = job;
  if (!id || !text || !output) {
    jobError(id ?? '?', 'job missing required fields: id, text, output');
    continue;
  }

  try {
    fs.mkdirSync(path.dirname(output), { recursive: true });

    const audio = await tts.generate(text, {
      voice: voice ?? defaultVoice,
      speed: speed  ?? defaultSpeed,
    });

    await audio.save(output);

    if (!fs.existsSync(output)) {
      jobError(id, `audio.save() completed but file not found: ${output}`);
      continue;
    }

    done(id, output);
  } catch (err) {
    jobError(id, err?.message ?? String(err));
  }
}
