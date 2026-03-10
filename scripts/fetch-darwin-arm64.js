#!/usr/bin/env node
// scripts/fetch-darwin-arm64.js — fetch llama-server for darwin-arm64 only
import { fetchBinaries } from './fetch-llamacpp.js';

await fetchBinaries([
  {
    platform:   'darwin',
    arch:       'arm64',
    variants: [
      { suffix: 'macos-arm64', ext: '.tar.gz' },
    ],
    binInZip:   'llama-server',
    outName:    'llama-server-darwin-arm64',
    extractAll: true,
  },
]);
