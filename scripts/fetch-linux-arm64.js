#!/usr/bin/env node
// scripts/fetch-linux-arm64.js — fetch llama-server for linux-arm64 only
import { fetchBinaries } from './fetch-llamacpp.js';

await fetchBinaries([
  {
    platform: 'linux',
    arch:     'arm64',
    variants: [
      { suffix: 'ubuntu-arm64',        ext: '.tar.gz' },
      { suffix: 'ubuntu-vulkan-arm64', ext: '.tar.gz' },
    ],
    binInZip: 'llama-server',
    outName:  'llama-server-linux-arm64',
  },
]);
