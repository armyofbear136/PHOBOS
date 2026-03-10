#!/usr/bin/env node
// scripts/fetch-linux-x64.js — fetch llama-server for linux-x64 only
import { fetchBinaries } from './fetch-llamacpp.js';

await fetchBinaries([
  {
    platform:   'linux',
    arch:       'x64',
    variants: [
      { suffix: 'ubuntu-x64',        ext: '.tar.gz' },
      { suffix: 'ubuntu-vulkan-x64', ext: '.tar.gz' },
    ],
    binInZip:   'llama-server',
    outName:    'llama-server-linux-x64',
    extractAll: true,
  },
]);
