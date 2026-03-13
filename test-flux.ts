// test-flux.ts — Phase 2 test (CLI mode)
// npx tsx test-flux.ts

import { buildSdConfig, generateImage } from './phobos/ImageServerManager.js';

const PROMPT = 'a red apple sitting on a wooden table, soft natural lighting, photorealistic';
const OUT    = './test-output.png';

console.log('\n=== FLUX Phase 2 Test ===\n');

console.log('Step 1: Detecting hardware and resolving FLUX config...');
const cfg = await buildSdConfig();
if (!cfg) {
  console.error('FAIL: No FLUX model found in ~/.phobos/models/flux/');
  process.exit(1);
}
console.log(`  Model:     ${cfg.fluxSpec.label}`);
console.log(`  Device:    ${cfg.deviceIndex ?? 'auto'} (${cfg.gpuBackend ?? 'auto'})`);
console.log(`  Aux files: ${cfg.auxFiles.map(a => a.id).join(', ')}`);
console.log('');

console.log('Step 2: Generating image (sd-cli will load model, generate, and exit)...');
console.log(`  Prompt: "${PROMPT}"`);
const t = Date.now();
let result: Awaited<ReturnType<typeof generateImage>>;
try {
  result = await generateImage(OUT, cfg, { prompt: PROMPT, seed: 42 });
} catch (err) {
  console.error(`FAIL: ${(err as Error).message}`);
  process.exit(1);
}
console.log('');
console.log(`=== PASS ===`);
console.log(`  Output:  ${result.outputPath}`);
console.log(`  Seed:    ${result.seed}`);
console.log(`  Time:    ${(result.elapsedMs / 1000).toFixed(1)}s`);
console.log('');
