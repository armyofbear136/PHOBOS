#!/usr/bin/env node
// scripts/start-gimp.ts
// ─────────────────────────────────────────────────────────────────────────────
// Standalone script that starts broadwayd + GIMP via BroadwayManager.
// Replaces the two manual MSYS2 bash terminals used during development.
//
// Usage:
//   npx tsx scripts/start-gimp.ts
//
// Stop: Ctrl+C — graceful SIGTERM to both processes.
// ─────────────────────────────────────────────────────────────────────────────

import { startBroadway, stopBroadway, getBroadwayStatus } from '../phobos/BroadwayManager.js';

async function main() {
  console.log('[start-gimp] Starting Broadway + GIMP...');

  try {
    await startBroadway();
  } catch (err) {
    console.error('[start-gimp] Failed to start:', (err as Error).message);
    process.exit(1);
  }

  const status = getBroadwayStatus();
  console.log('\n✅  GIMP is running in browser');
  console.log(`   Open: ${status.iframeUrl}`);
  console.log('   Ctrl+C to stop both processes\n');

  // Keep alive until signal
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.once(signal, async () => {
      console.log(`\n[start-gimp] ${signal} — stopping...`);
      await stopBroadway();
      console.log('[start-gimp] Stopped. Bye.');
      process.exit(0);
    });
  }
}

main().catch(err => {
  console.error('[start-gimp] Fatal:', err);
  process.exit(1);
});
