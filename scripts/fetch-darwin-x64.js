#!/usr/bin/env node
// scripts/fetch-darwin-x64.js — fetch llama-server for darwin-x64 (macOS Intel) only
import { fetchBinaries } from './fetch-llamacpp.js';

await fetchBinaries([
  {
    platform:   'darwin',
    arch:       'x64',
    variants: [
      { suffix: 'macos-x64', ext: '.tar.gz' },
    ],
    binInZip:   'llama-server',
    outName:    'llama-server-darwin-x64',
    extractAll: true,
  },
]);
