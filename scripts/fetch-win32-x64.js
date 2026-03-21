#!/usr/bin/env node
// scripts/fetch-win32-x64.js — fetch llama-server + CUDA DLL for win32-x64 only
import { fetchBinaries } from './fetch-llamacpp.js';

await fetchBinaries(
  [
    {
      platform:   'win32',
      arch:       'x64',
      variants: [
        { suffix: 'win-vulkan-x64',      ext: '.zip' },
        { suffix: 'win-vulkan-avx2-x64', ext: '.zip' },
        { suffix: 'win-avx2-x64',        ext: '.zip' },
        { suffix: 'win-avx-x64',         ext: '.zip' },
        { suffix: 'win-cpu-x64',         ext: '.zip' },
      ],
      binInZip:   'llama-server.exe',
      outName:    'llama-server-win32-x64.exe',
      extractAll: true,
    },
  ],
  [
    // ── ggml-cuda.dll — the CUDA compute backend for llama-server ──────────────
    // IMPORTANT: ggml-cuda.dll and all cudart DLLs below MUST come from the same
    // CUDA major version. CUDA 12.x builds produce cublas64_12.dll etc.
    // CUDA 13.x builds produce cublas64_13.dll — different filenames, incompatible.
    // Pin to 12.4 first to match the runtime DLL names we extract (*64_12.dll).
    {
      variants: [
        { suffix: 'win-cuda-12.4-x64', ext: '.zip' },
        { suffix: 'win-cuda-12.8-x64', ext: '.zip' },
        { suffix: 'win-cuda-12.6-x64', ext: '.zip' },
        { suffix: 'win-cuda-12.2-x64', ext: '.zip' },
      ],
      dllInZip: 'ggml-cuda.dll',
      outName:  'ggml-cuda.dll',
    },

    // ── CUDA runtime DLLs — required by ggml-cuda.dll at load time ─────────────
    // ggml-cuda.dll depends on cudart64_12.dll, cublas64_12.dll, cublasLt64_12.dll.
    // These are NOT included in the normal NVIDIA display driver — only the CUDA
    // Toolkit installs them. Without them, ggml-cuda.dll silently fails to load
    // and llama-server falls back to CPU with no error message.
    //
    // The cudart-llama zip is a separate release asset from llama.cpp CI that
    // packages only these three runtime DLLs for redistribution.
    // CUDA 12.x only — must match the ggml-cuda.dll variant above.
    {
      variants: [
        { suffix: 'win-cuda-12.4-x64', ext: '.zip', cudartZip: true },
        { suffix: 'win-cuda-12.8-x64', ext: '.zip', cudartZip: true },
        { suffix: 'win-cuda-12.6-x64', ext: '.zip', cudartZip: true },
        { suffix: 'win-cuda-12.2-x64', ext: '.zip', cudartZip: true },
      ],
      dllInZip: 'cudart64_12.dll',
      outName:  'cudart64_12.dll',
      cudartPrefix: 'cudart-llama', // uses cudart-llama-bin-win-cuda-X.Y-x64.zip naming
    },
    {
      variants: [
        { suffix: 'win-cuda-12.4-x64', ext: '.zip', cudartZip: true },
        { suffix: 'win-cuda-12.8-x64', ext: '.zip', cudartZip: true },
        { suffix: 'win-cuda-12.6-x64', ext: '.zip', cudartZip: true },
        { suffix: 'win-cuda-12.2-x64', ext: '.zip', cudartZip: true },
      ],
      dllInZip: 'cublas64_12.dll',
      outName:  'cublas64_12.dll',
      cudartPrefix: 'cudart-llama',
    },
    {
      variants: [
        { suffix: 'win-cuda-12.4-x64', ext: '.zip', cudartZip: true },
        { suffix: 'win-cuda-12.8-x64', ext: '.zip', cudartZip: true },
        { suffix: 'win-cuda-12.6-x64', ext: '.zip', cudartZip: true },
        { suffix: 'win-cuda-12.2-x64', ext: '.zip', cudartZip: true },
      ],
      dllInZip: 'cublasLt64_12.dll',
      outName:  'cublasLt64_12.dll',
      cudartPrefix: 'cudart-llama',
    },
  ],
);
