#!/usr/bin/env node
// scripts/fetch-win32-x64.js — fetch llama-server + CUDA DLL for win32-x64 only
import { fetchBinaries } from './fetch-llamacpp.js';

await fetchBinaries(
  [
    {
      platform:   'win32',
      arch:       'x64',
      variants: [
        { suffix: 'win-vulkan-x64', ext: '.zip' },
        { suffix: 'win-cpu-x64',    ext: '.zip' },
      ],
      binInZip:   'llama-server.exe',
      outName:    'llama-server-win32-x64.exe',
      extractAll: true,
    },
  ],
  [
    {
      variants: [
        { suffix: 'win-cuda-12.4-x64', ext: '.zip' },
        { suffix: 'win-cuda-12.8-x64', ext: '.zip' },
        { suffix: 'win-cuda-12.2-x64', ext: '.zip' },
        { suffix: 'win-cuda-12.6-x64', ext: '.zip' },
      ],
      dllInZip: 'ggml-cuda.dll',
      outName:  'ggml-cuda.dll',
    },
  ],
);
