import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { X, Cpu, Zap, Download, AlertTriangle, Loader2, Trash2, Play, ExternalLink, Lock, Image, Film, CheckCircle2, Music, FolderOpen, FolderSearch, HardDrive, Settings2, RefreshCw, Globe, Terminal, BookOpen, BookMarked, Shuffle, Sun, Moon } from 'lucide-react';
import { useTheme } from '@/lib/useTheme';
import { DownloadConfirmDialog, buildLicenseEntries, type DownloadFileSpec } from '@/components/phobos/DownloadConfirmDialog';
import { useModelConfig } from '@/hooks/useThread';
import { useAppStore } from '@/store/useAppStore';
import {
  usePhobosHardware,
  usePhobosDownloadedModels,
  usePhobosDownload,
  usePhobosServerStatus,
  useModelsInfo,
  startPhobosServers,
  useFluxStatus,
  useFluxDownload,
  useAudioDownload,
  useImageCatalogue,
  useImageConvert,
  type ConvertStage,
  deleteFluxModel,
  useAutoConfig,
  useScanFolder,
  useSetBasePath,
  useResync,
  useSetModelOverride,
  useClearModelOverride,
  useOpenFileDialog,
  useOpenFolderDialog,
  useRelocate,
  usePythonEnvStatus,
  usePythonEnvInstall,
  usePythonInstall,
  useUncensoredVariant,
  type GGUFSpec,
  type FluxRecommendation,
  type AutoConfigPlan,
  type AutoConfigPhase,
  type RelocatePhase,
  type ScannedMatch,
} from '@/hooks/usePhobosLocal';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Model catalogue (mirrors backend GGUF_CATALOGUE) ─────────────────────────
const ALL_MODELS: GGUFSpec[] = [
  // ── Gemma 4 family — April 2026, MatFormer MoE, Apache 2.0 ─────────────────
  { modelId: 'gemma4-e4b-q4',                  label: 'Gemma 4 E4B Q4',                   family: 'Gemma 4',          role: 'sayon', thinkingTokens: true,  sizeBytes: 2_600_000_000,  ramRequiredGb: 4,  contextWindow: 131072, sayonQuality: 5, speedClass: 'fast' , license: 'Gemma-Terms', licenseUrl: 'https://ai.google.dev/gemma/terms'},
  { modelId: 'gemma4-26b-a4b-q4',              label: 'Gemma 4 26B-A4B Q4',               family: 'Gemma 4',          role: 'seren', thinkingTokens: true,  sizeBytes: 16_800_000_000, ramRequiredGb: 19, contextWindow: 262144, serenQuality: 5, speedClass: 'fast' , license: 'Gemma-Terms', licenseUrl: 'https://ai.google.dev/gemma/terms'},
  // ── Nemotron 3 family ───────────────────────────────────────────────────────
  { modelId: 'nemotron3-4b-q4',                label: 'Nemotron 3 Nano 4B Q4',             family: 'Nemotron 3',       role: 'sayon', thinkingTokens: true,  sizeBytes: 2_600_000_000,  ramRequiredGb: 4,  contextWindow: 32768,  sayonQuality: 4, speedClass: 'fast' , license: 'NVIDIA-Open-Model', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/'},
  { modelId: 'nemotron3-9b-q4',                label: 'Nemotron 3 Nano 9B v2 Q4',          family: 'Nemotron 3',       role: 'seren', thinkingTokens: true,  sizeBytes: 5_700_000_000,  ramRequiredGb: 6,  contextWindow: 32768,  serenQuality: 3, speedClass: 'medium' , license: 'NVIDIA-Open-Model', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/'},
  { modelId: 'nemotron3-30b-a3b-q4',           label: 'Nemotron 3 Nano 30B-A3B Q4',        family: 'Nemotron 3',       role: 'seren', thinkingTokens: true,  sizeBytes: 22_800_000_000, ramRequiredGb: 25, contextWindow: 32768,  serenQuality: 4, speedClass: 'fast' , license: 'NVIDIA-Open-Model', licenseUrl: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/'},
  // ── Qwen3.5 Opus distills — Claude 4.6 Opus CoT fine-tunes, Apache 2.0 ─────
  { modelId: 'qwen3.5-27b-opus-distill-q4',    label: 'Qwen3.5 27B Opus Distill Q4',       family: 'Qwen3.5 Distill',  role: 'seren', thinkingTokens: true,  sizeBytes: 16_500_000_000, ramRequiredGb: 18, contextWindow: 262144, serenQuality: 5, speedClass: 'medium' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  { modelId: 'qwen3.5-27b-opus-distill-v2-q4', label: 'Qwen3.5 27B Opus Distill v2 Q4',    family: 'Qwen3.5 Distill',  role: 'seren', thinkingTokens: true,  sizeBytes: 16_500_000_000, ramRequiredGb: 18, contextWindow: 262144, serenQuality: 5, speedClass: 'medium' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  { modelId: 'qwen3.5-9b-opus-distill-q4',     label: 'Qwen3.5 9B Opus Distill Q4',        family: 'Qwen3.5 Distill',  role: 'seren', thinkingTokens: true,  sizeBytes: 5_800_000_000,  ramRequiredGb: 7,  contextWindow: 262144, serenQuality: 4, speedClass: 'medium' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  { modelId: 'qwen3.5-2b-opus-distill-q4',     label: 'Qwen3.5 2B Opus Distill Q4',        family: 'Qwen3.5 Distill',  role: 'sayon', thinkingTokens: true,  sizeBytes: 1_270_804_416,  ramRequiredGb: 2,  contextWindow: 262144, sayonQuality: 3, speedClass: 'fast' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  // ── Qwen3.5 base — thinking tokens, 262K context ────────────────────────────
  { modelId: 'qwen3.5-4b-q4',                  label: 'Qwen3.5 4B Q4',                     family: 'Qwen3.5',          role: 'seren', thinkingTokens: true,  sizeBytes: 2_600_000_000,  ramRequiredGb: 3,  contextWindow: 262144, serenQuality: 3, speedClass: 'fast' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  { modelId: 'qwen3.5-9b-q4',                  label: 'Qwen3.5 9B Q4',                     family: 'Qwen3.5',          role: 'seren', thinkingTokens: true,  sizeBytes: 5_500_000_000,  ramRequiredGb: 7,  contextWindow: 262144, serenQuality: 4, speedClass: 'medium' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  { modelId: 'qwen3.5-27b-q4',                 label: 'Qwen3.5 27B Q4',                    family: 'Qwen3.5',          role: 'seren', thinkingTokens: true,  sizeBytes: 16_000_000_000, ramRequiredGb: 18, contextWindow: 262144, serenQuality: 5, speedClass: 'slow' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  { modelId: 'qwen3.5-35b-a3b-q4',             label: 'Qwen3.5 35B-A3B Q4',                family: 'Qwen3.5',          role: 'seren', thinkingTokens: true,  sizeBytes: 21_000_000_000, ramRequiredGb: 23, contextWindow: 262144, serenQuality: 4, speedClass: 'fast' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  { modelId: 'qwen3.5-2b-q4',                  label: 'Qwen3.5 2B Q4',                     family: 'Qwen3.5',          role: 'seren', thinkingTokens: true,  sizeBytes: 1_329_766_560,  ramRequiredGb: 2,  contextWindow: 262144, serenQuality: 1, speedClass: 'fast' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  // ── Qwen3.6 — vision, thinking tokens, 262K context, Apache 2.0 ─────────────
  { modelId: 'qwen3.6-27b-q4',                 label: 'Qwen3.6 27B Q4',                    family: 'Qwen3.6',          role: 'seren', thinkingTokens: true,  sizeBytes: 17_500_000_000, ramRequiredGb: 20, contextWindow: 262144, serenQuality: 5, speedClass: 'slow' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  { modelId: 'qwen3.6-35b-a3b-q4',             label: 'Qwen3.6 35B-A3B Q4',                family: 'Qwen3.6',          role: 'seren', thinkingTokens: true,  sizeBytes: 21_400_000_000, ramRequiredGb: 24, contextWindow: 262144, serenQuality: 5, speedClass: 'fast' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  // ── Magistral — Mistral's large reasoning model ──────────────────────────────
  { modelId: 'magistral-24b-q4',               label: 'Magistral 24B Q4',                  family: 'Mistral',          role: 'seren', thinkingTokens: true,  sizeBytes: 14_400_000_000, ramRequiredGb: 16, contextWindow: 131072, serenQuality: 5, speedClass: 'slow' , license: 'Mistral-Research-License', licenseUrl: 'https://mistral.ai/licenses/MRL-0.1.md'},
  // ── Llama 4 family ──────────────────────────────────────────────────────────
  { modelId: 'llama4-scout-17b-q4',            label: 'Llama 4 Scout 17B Q4',              family: 'Llama 4',          role: 'seren', thinkingTokens: false, sizeBytes: 60_000_000_000, ramRequiredGb: 65, contextWindow: 131072, serenQuality: 5, speedClass: 'slow' , license: 'Meta-Llama-4-Community', licenseUrl: 'https://www.llama.com/llama4/license/'},
  // ── DeepSeek-R1 — strong reasoning ──────────────────────────────────────────
  { modelId: 'deepseek-r1-1.5b-q4',            label: 'DeepSeek-R1 1.5B Q4',               family: 'DeepSeek-R1',      role: 'seren', thinkingTokens: true,  sizeBytes: 1_100_000_000,  ramRequiredGb: 2,  contextWindow: 131072, serenQuality: 1, speedClass: 'fast' , license: 'MIT', licenseUrl: 'https://opensource.org/licenses/MIT'},
  { modelId: 'deepseek-r1-8b-q4',              label: 'DeepSeek-R1 8B Q4',                 family: 'DeepSeek-R1',      role: 'seren', thinkingTokens: true,  sizeBytes: 5_190_000_000,  ramRequiredGb: 6,  contextWindow: 32768,  serenQuality: 3, speedClass: 'medium' , license: 'MIT', licenseUrl: 'https://opensource.org/licenses/MIT'},
  { modelId: 'deepseek-r1-14b-q4',             label: 'DeepSeek-R1 14B Q4',                family: 'DeepSeek-R1',      role: 'seren', thinkingTokens: true,  sizeBytes: 9_050_000_000,  ramRequiredGb: 11, contextWindow: 65536,  serenQuality: 4, speedClass: 'slow' , license: 'MIT', licenseUrl: 'https://opensource.org/licenses/MIT'},
  { modelId: 'deepseek-r1-70b-q4',             label: 'DeepSeek-R1 70B Q4',                family: 'DeepSeek-R1',      role: 'seren', thinkingTokens: true,  sizeBytes: 42_520_000_000, ramRequiredGb: 48, contextWindow: 65536,  serenQuality: 5, speedClass: 'slow' , license: 'MIT', licenseUrl: 'https://opensource.org/licenses/MIT'},
  // ── Power-user / frontier models (400B+ parameter range) ────────────────────
  { modelId: 'deepseek-r1-671b-q2',            label: 'DeepSeek-R1 671B Q2 (Power)',       family: 'DeepSeek-R1',      role: 'seren', thinkingTokens: true,  sizeBytes: 236_000_000_000, ramRequiredGb: 256, contextWindow: 65536, serenQuality: 5, speedClass: 'slow' , license: 'MIT', licenseUrl: 'https://opensource.org/licenses/MIT'},
  // ── Nanbeige4.1 — Qwen2.5-based, fast standard attention ────────────────────
  { modelId: 'nanbeige4.1-3b-q4',              label: 'Nanbeige4.1 3B Q4',                 family: 'Nanbeige',         role: 'seren', thinkingTokens: true,  sizeBytes: 2_440_000_000,  ramRequiredGb: 3,  contextWindow: 32768,  serenQuality: 3, speedClass: 'fast' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  // ── SmolLM3 — HuggingFace 3B, 128K context ──────────────────────────────────
  { modelId: 'smollm3-3b-q4',                  label: 'SmolLM3 3B Q4',                     family: 'SmolLM3',          role: 'seren', thinkingTokens: true,  sizeBytes: 1_920_000_000,  ramRequiredGb: 3,  contextWindow: 131072, serenQuality: 3, speedClass: 'fast' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  // ── Phi-4 Mini Reasoning — Microsoft R1 distill ──────────────────────────────
  { modelId: 'phi4-mini-reasoning-q4',          label: 'Phi-4 Mini Reasoning Q4',           family: 'Phi-4',            role: 'seren', thinkingTokens: true,  sizeBytes: 2_390_000_000,  ramRequiredGb: 3,  contextWindow: 131072, serenQuality: 3, speedClass: 'fast' , license: 'MIT', licenseUrl: 'https://opensource.org/licenses/MIT'},
  // ── Ministral 3B Reasoning — smallest viable SEREN ──────────────────────────
  { modelId: 'ministral-3b-q4',                label: 'Ministral 3B Reasoning Q4',         family: 'Ministral',        role: 'seren', thinkingTokens: true,  sizeBytes: 1_830_000_000,  ramRequiredGb: 2,  contextWindow: 131072, serenQuality: 2, speedClass: 'fast' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  // ── Llama 3 — no thinking tokens, SAYON-class ───────────────────────────────
  { modelId: 'llama3.2-3b-q4',                 label: 'Llama 3.2 3B Q4',                   family: 'Llama 3',          role: 'sayon', thinkingTokens: false, sizeBytes: 2_020_000_000,  ramRequiredGb: 3,  contextWindow: 131072, sayonQuality: 2, speedClass: 'fast' , license: 'Meta-Llama-3-Community', licenseUrl: 'https://www.llama.com/llama3/license/'},
  { modelId: 'llama3.1-8b-q4',                 label: 'Llama 3.1 8B Q4',                   family: 'Llama 3',          role: 'sayon', thinkingTokens: false, sizeBytes: 4_920_000_000,  ramRequiredGb: 6,  contextWindow: 131072, sayonQuality: 3, speedClass: 'medium' , license: 'Meta-Llama-3-Community', licenseUrl: 'https://www.llama.com/llama3/license/'},
  { modelId: 'llama3.1-405b-q3',               label: 'Llama 3.1 405B Q3 (Power)',         family: 'Llama 3',          role: 'seren', thinkingTokens: false, sizeBytes: 175_000_000_000, ramRequiredGb: 192, contextWindow: 131072, serenQuality: 5, speedClass: 'slow' , license: 'Meta-Llama-3-Community', licenseUrl: 'https://www.llama.com/llama3/license/'},
  // ── Gemma 3 — no thinking tokens, SAYON alternative ────────────────────────
  { modelId: 'gemma3-1b-q4',                   label: 'Gemma 3 1B Q4',                     family: 'Gemma 3',          role: 'sayon', thinkingTokens: false, sizeBytes: 694_000_000,    ramRequiredGb: 1,  contextWindow: 32768,  sayonQuality: 1, speedClass: 'fast' , license: 'Gemma-Terms', licenseUrl: 'https://ai.google.dev/gemma/terms'},
  { modelId: 'gemma3-4b-q4',                   label: 'Gemma 3 4B Q4',                     family: 'Gemma 3',          role: 'sayon', thinkingTokens: false, sizeBytes: 2_530_000_000,  ramRequiredGb: 3,  contextWindow: 131072, sayonQuality: 3, speedClass: 'fast' , license: 'Gemma-Terms', licenseUrl: 'https://ai.google.dev/gemma/terms'},
  { modelId: 'gemma3-12b-q4',                  label: 'Gemma 3 12B Q4',                    family: 'Gemma 3',          role: 'sayon', thinkingTokens: false, sizeBytes: 7_800_000_000,  ramRequiredGb: 10, contextWindow: 131072, sayonQuality: 4, speedClass: 'medium' , license: 'Gemma-Terms', licenseUrl: 'https://ai.google.dev/gemma/terms'},
  // ── Mistral 7B — non-thinking SAYON ─────────────────────────────────────────
  { modelId: 'mistral-7b-q4',                  label: 'Mistral 7B v0.3 Q4',                family: 'Mistral',          role: 'sayon', thinkingTokens: false, sizeBytes: 4_370_000_000,  ramRequiredGb: 6,  contextWindow: 32768,  sayonQuality: 3, speedClass: 'medium' , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  // ── Legacy models ────────────────────────────────────────────────────────────
  { modelId: 'qwen3-4b-q4',                    label: 'Qwen3 4B Q4',                       family: 'Qwen3',            role: 'seren', thinkingTokens: true,  sizeBytes: 2_580_000_000,  ramRequiredGb: 3,  contextWindow: 32768,  serenQuality: 2, speedClass: 'fast',   legacy: true , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  { modelId: 'qwen3-8b-q4',                    label: 'Qwen3 8B Q4',                       family: 'Qwen3',            role: 'seren', thinkingTokens: true,  sizeBytes: 5_190_000_000,  ramRequiredGb: 6,  contextWindow: 32768,  serenQuality: 3, speedClass: 'medium', legacy: true , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  { modelId: 'qwen3-14b-q4',                   label: 'Qwen3 14B Q4',                      family: 'Qwen3',            role: 'seren', thinkingTokens: true,  sizeBytes: 9_000_000_000,  ramRequiredGb: 11, contextWindow: 32768,  serenQuality: 3, speedClass: 'slow',   legacy: true , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
  { modelId: 'qwen3-30b-a3b-q4',               label: 'Qwen3 30B-A3B Q4',                  family: 'Qwen3',            role: 'seren', thinkingTokens: true,  sizeBytes: 18_400_000_000, ramRequiredGb: 20, contextWindow: 32768,  serenQuality: 3, speedClass: 'fast',   legacy: true , license: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'},
];

const MODEL_FAMILIES = ['Gemma 4', 'Nemotron 3', 'Qwen3.5 Distill', 'Qwen3.5', 'Qwen3.6', 'Magistral', 'Llama 4', 'DeepSeek-R1', 'Nanbeige', 'SmolLM3', 'Phi-4', 'Ministral', 'Llama 3', 'Gemma 3', 'Mistral'] as const;
const LEGACY_FAMILIES = ['Qwen3'] as const;

const MODEL_LICENSE_URLS: Record<string, string> = {
  'gemma4-e4b-q4':                  'https://ai.google.dev/gemma/terms',
  'gemma4-26b-a4b-q4':              'https://ai.google.dev/gemma/terms',
  'nemotron3-4b-q4':                'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/',
  'nemotron3-9b-q4':                'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/',
  'nemotron3-30b-a3b-q4':           'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/',
  'qwen3.5-27b-opus-distill-q4':    'https://www.apache.org/licenses/LICENSE-2.0',
  'qwen3.5-27b-opus-distill-v2-q4': 'https://www.apache.org/licenses/LICENSE-2.0',
  'qwen3.5-9b-opus-distill-q4':     'https://www.apache.org/licenses/LICENSE-2.0',
  'qwen3.5-2b-opus-distill-q4':     'https://www.apache.org/licenses/LICENSE-2.0',
  'qwen3.5-2b-q4':                  'https://www.apache.org/licenses/LICENSE-2.0',
  'qwen3.5-4b-q4':                  'https://www.apache.org/licenses/LICENSE-2.0',
  'qwen3.5-9b-q4':                  'https://www.apache.org/licenses/LICENSE-2.0',
  'qwen3.5-27b-q4':                 'https://www.apache.org/licenses/LICENSE-2.0',
  'qwen3.5-35b-a3b-q4':             'https://www.apache.org/licenses/LICENSE-2.0',
  'qwen3.5-coder-32b-q4':           'https://www.apache.org/licenses/LICENSE-2.0',
  'llama4-scout-17b-q4':            'https://www.apache.org/licenses/LICENSE-2.0',
  'magistral-8b-q4':                'https://mistral.ai/licenses/MRL-0.1.md',
  'deepseek-r1-8b-q4':              'https://huggingface.co/deepseek-ai/DeepSeek-R1/blob/main/LICENSE',
  'deepseek-r1-14b-q4':             'https://huggingface.co/deepseek-ai/DeepSeek-R1/blob/main/LICENSE',
  'deepseek-r1-70b-q4':             'https://huggingface.co/deepseek-ai/DeepSeek-R1/blob/main/LICENSE',
  'deepseek-r1-671b-q2':            'https://huggingface.co/deepseek-ai/DeepSeek-R1/blob/main/LICENSE',
  'nanbeige4.1-3b-q4':              'https://www.apache.org/licenses/LICENSE-2.0',
  'smollm3-3b-q4':                  'https://www.apache.org/licenses/LICENSE-2.0',
  'phi4-mini-reasoning-q4':         'https://opensource.org/licenses/MIT',
  'ministral-3b-q4':                'https://www.apache.org/licenses/LICENSE-2.0',
  'llama3.2-3b-q4':                 'https://ai.meta.com/llama/license/',
  'llama3.1-8b-q4':                 'https://ai.meta.com/llama/license/',
  'llama3.1-405b-q3':               'https://ai.meta.com/llama/license/',
  'gemma3-1b-q4':                   'https://ai.google.dev/gemma/terms',
  'gemma3-4b-q4':                   'https://ai.google.dev/gemma/terms',
  'gemma3-12b-q4':                  'https://ai.google.dev/gemma/terms',
  'mistral-7b-q4':                  'https://mistral.ai/licenses/MRL-0.1.md',
  'qwen3-4b-q4':                    'https://huggingface.co/Qwen/Qwen3-235B-A22B/blob/main/LICENSE',
  'qwen3-8b-q4':                    'https://huggingface.co/Qwen/Qwen3-235B-A22B/blob/main/LICENSE',
  'qwen3-14b-q4':                   'https://huggingface.co/Qwen/Qwen3-235B-A22B/blob/main/LICENSE',
  'qwen3-30b-a3b-q4':               'https://huggingface.co/Qwen/Qwen3-235B-A22B/blob/main/LICENSE',
};
interface Props {
  onClose: () => void;
}

function bytesLabel(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${n} B`;
}

/** Render quality tier as filled/empty dots: ●●●○○ */
function QualityDots({ quality }: { quality: number }) {
  if (!quality) return null;
  const MAX = 5;
  return (
    <span className="inline-flex gap-px text-[10px]" title={`Quality: ${quality}/${MAX}`}>
      {Array.from({ length: MAX }, (_, i) => (
        <span key={i} className={i < quality ? 'text-phobos-amber/70' : 'text-foreground/15'}>●</span>
      ))}
    </span>
  );
}

/** Speed class badge */
function SpeedBadge({ speed }: { speed?: 'fast' | 'medium' | 'slow' }) {
  if (!speed) return null;
  const styles: Record<string, string> = {
    fast:   'border-phobos-green/25 text-phobos-green/55',
    medium: 'border-phobos-amber/25 text-phobos-amber/55',
    slow:   'border-foreground/15 text-foreground/35',
  };
  return (
    <span className={`text-[10px] font-terminal uppercase px-1 py-0.5 border rounded ${styles[speed]}`}>
      {speed}
    </span>
  );
}

/**
 * Check if a model exceeds the available memory budget for its intended device.
 * Returns true if the model is INCOMPATIBLE (over budget).
 */
function isIncompatible(spec: GGUFSpec, hw: { ramGb: number; gpus: { vramGb: number; unifiedMemory?: boolean }[] } | undefined): boolean {
  if (!hw) return false;
  const bestGpu = hw.gpus.length > 0 ? hw.gpus.reduce((a, b) => b.vramGb > a.vramGb ? b : a) : null;
  const isUnified = bestGpu?.unifiedMemory === true;
  // Unified memory: budget is 80% of total RAM
  if (isUnified) return spec.ramRequiredGb > Math.floor(hw.ramGb * 0.80);
  // Discrete GPU: budget is 90% of best GPU VRAM (for GPU models) or 80% of RAM (for CPU)
  if (bestGpu && bestGpu.vramGb >= 3) return spec.ramRequiredGb > Math.floor(bestGpu.vramGb * 0.90);
  // CPU fallback: 80% of RAM, but need room for both models
  return spec.ramRequiredGb > Math.floor(hw.ramGb * 0.70);
}

function ProgressBar({ received, total, label }: { received?: number; total?: number; label?: string }) {
  const hasData = typeof received === 'number' && received > 0;
  const pct = hasData && total && total > 0
    ? Math.min(100, Math.round((received! / total) * 100))
    : null;
  return (
    <div className="mt-1 space-y-0.5">
      <div className="w-full h-1 bg-border/30 rounded-full overflow-hidden">
        {pct !== null
          ? <div className="h-full bg-phobos-green/60 rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
          : <div className="h-full w-1/4 bg-phobos-green/20 rounded-full animate-pulse" />}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-foreground/35 font-mono">
          {label ?? ''}
        </span>
        <span className="text-[10px] text-phobos-green/50 font-mono">
          {pct !== null
            ? `${pct}% (${bytesLabel(received!)} / ${bytesLabel(total!)})`
            : received && received > 0
              ? `${bytesLabel(received)} received…`
              : 'connecting…'}
        </span>
      </div>
    </div>
  );
}

const BACKEND_BADGE: Record<string, { border: string; text: string; label: string }> = {
  cuda:   { border: 'border-phobos-green/20', text: 'text-phobos-green/40', label: 'CUDA' },
  vulkan: { border: 'border-amber-500/20',    text: 'text-amber-500/40',    label: 'Vulkan' },
  metal:  { border: 'border-blue-400/20',     text: 'text-blue-400/40',     label: 'Metal' },
};

// ── SystemCapabilityCard ──────────────────────────────────────────────────────
// Card-style capability tile used in the system capabilities grid.
function SystemCapabilityRow({
  icon,
  label,
  online,
  detail,
  placeholder = false,
}: {
  icon: React.ReactNode;
  label: string;
  online: boolean;
  detail: string;
  placeholder?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center gap-1 px-3 py-2.5 rounded border text-center ${
      placeholder ? 'opacity-35 border-border/10 bg-transparent' :
      online ? 'border-phobos-green/15 bg-phobos-green/[0.03]' : 'border-border/15 bg-black/20'
    }`}>
      <div className="flex items-center gap-2">
        {/* Indicator dot */}
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          online ? 'bg-phobos-green shadow-[0_0_4px_hsl(120_100%_50%/0.6)]' : 'bg-muted-foreground/20'
        }`} />
        {/* Icon */}
        <span className={`shrink-0 ${online ? 'text-foreground/60' : 'text-muted-foreground/25'}`}>
          {icon}
        </span>
        {/* Label */}
        <span className={`text-[11px] font-terminal tracking-[0.12em] uppercase ${
          online ? 'text-foreground/80' : 'text-muted-foreground/35'
        }`}>
          {label}
        </span>
      </div>
      {/* Detail line */}
      <span className={`text-[10px] font-mono ${
        online ? 'text-phobos-green/55' : 'text-muted-foreground/25'
      }`}>
        {detail}
      </span>
    </div>
  );
}

// ── UncensoredPopover ─────────────────────────────────────────────────────────
// Inline popover attached to the 🔓 button on a downloaded model row.
// Searches HF Hub for uncensored variants and lets the user replace the file.

function UncensoredPopover({ modelId, onClose }: { modelId: string; onClose: () => void }) {
  const { stage, search, download, reset } = useUncensoredVariant(modelId);

  // Kick off search on mount
  useEffect(() => { search(); }, []);

  const handleSelect = (v: Parameters<typeof download>[0]) => { download(v); };

  return (
    <div className="absolute right-0 top-full mt-1 z-50 w-[340px] bg-card border border-phobos-amber/30 rounded-sm shadow-[0_4px_24px_rgba(0,0,0,0.6)] font-mono p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-terminal tracking-[0.15em] text-phobos-amber/80 uppercase">Find Uncensored Version</span>
        <button onClick={onClose} className="text-muted-foreground/40 hover:text-foreground/60 transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* States */}
      {stage.kind === 'searching' && (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50 py-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          Searching HuggingFace Hub…
        </div>
      )}

      {stage.kind === 'none-found' && (
        <p className="text-[10px] font-mono text-muted-foreground/40 py-1 leading-relaxed">
          No uncensored variants mapped for this model yet. Check back after a PHOBOS update.
        </p>
      )}

      {stage.kind === 'error' && (
        <div className="flex items-start gap-2 text-[10px] text-destructive/70 py-1">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{stage.message}</span>
        </div>
      )}

      {stage.kind === 'found' && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-mono text-muted-foreground/40 leading-relaxed">
            Select a variant to download. It will replace the current file in place.
            Delete and re-download the original to revert.
          </p>
          {stage.variants.map(v => (
            <div key={v.repoId} className="flex items-stretch gap-1">
              <button
                onClick={() => handleSelect(v)}
                className="flex-1 text-left flex items-start gap-2 px-2.5 py-2 rounded border border-border/20 hover:border-phobos-amber/30 hover:bg-phobos-amber/[0.04] transition-all group"
              >
                <Shuffle className="w-4 h-4 text-phobos-amber/40 group-hover:text-phobos-amber/70 shrink-0 mt-0.5 transition-colors" />
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="text-[10px] text-foreground/75 truncate">{v.label}</div>
                  <div className="text-[10px] font-mono text-muted-foreground/40 uppercase tracking-wide">{v.method}</div>
                </div>
              </button>
              <a
                href={v.pageUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="View on HuggingFace"
                className="flex items-center px-2 border border-border/20 rounded text-muted-foreground/30 hover:text-phobos-amber/60 hover:border-phobos-amber/30 transition-all"
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          ))}
        </div>
      )}

      {stage.kind === 'downloading' && (
        <div className="space-y-2 py-1">
          <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground/50">
            <span className="truncate max-w-[220px]">{stage.repoId.split('/').pop()}</span>
            <span>
              {stage.bytesTotal > 0
                ? `${Math.round((stage.bytesReceived / stage.bytesTotal) * 100)}%`
                : `${(stage.bytesReceived / 1e6).toFixed(0)} MB`}
            </span>
          </div>
          <div className="h-1 bg-border/20 rounded-full overflow-hidden">
            {stage.bytesTotal > 0 ? (
              <div
                className="h-full bg-phobos-amber/50 transition-all duration-200 rounded-full"
                style={{ width: `${Math.min(100, (stage.bytesReceived / stage.bytesTotal) * 100)}%` }}
              />
            ) : (
              <div className="h-full bg-phobos-amber/30 rounded-full animate-pulse w-full" />
            )}
          </div>
          <div className="text-[10px] font-mono text-muted-foreground/30">
            {stage.bytesTotal > 0
              ? `${(stage.bytesReceived / 1e6).toFixed(0)} MB / ${(stage.bytesTotal / 1e6).toFixed(0)} MB`
              : `${(stage.bytesReceived / 1e6).toFixed(0)} MB downloaded…`}
          </div>
        </div>
      )}

      {stage.kind === 'done' && (
        <div className="flex items-center gap-2 text-[10px] text-phobos-amber/70 py-1">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Replaced. Restart PHOBOS to load the new model.
        </div>
      )}
    </div>
  );
}

export function PhobosLLMPanel({ onClose }: Props) {
  const { data: hwData, isLoading: hwLoading, error: hwError } = usePhobosHardware();
  const { data: modelsData, refetch: refetchModels }           = usePhobosDownloadedModels();
  const { downloadStage, startDownload, cancelDownload, resetDownload } = usePhobosDownload();
  const { data: serverData, isLoading: serverLoading, error: serverError, refetch: refetchStatus } = usePhobosServerStatus();
  const { data: modelsInfo, refetch: refetchModelsInfo } = useModelsInfo();
  const { updateConfig, data: savedConfig } = useModelConfig();
  const configOptimal    = useAppStore((s) => s.configOptimal);
  const visionCapability = useAppStore((s) => s.visionCapability);
  const { phase: autoPhase, fetchPlan, execute: executeAutoConfig, cancel: cancelAutoConfig, reset: resetAutoConfig } = useAutoConfig();

  // ── Path management hooks ──
  const { resync, pending: resyncing }  = useResync();
  const { setOverride }                 = useSetModelOverride();
  const { clearOverride }               = useClearModelOverride();
  const { openDialog: openFileDialog }  = useOpenFileDialog();
  const { openDialog: openFolderDialog } = useOpenFolderDialog();
  const { phase: relocatePhase, relocate, abort: abortRelocate, reset: resetRelocate } = useRelocate();
  const { setBasePath }                 = useSetBasePath();

  // ── PyTorch environment ──
  const { data: pyEnvData } = usePythonEnvStatus();
  const { installing: pyInstalling, progress: pyProgress, startInstall: pyStartInstall } = usePythonEnvInstall();
  const { running: pyAutoInstalling, progress: pyAutoProgress, start: pyStartAutoInstall, retryDetection: pyRetryDetection } = usePythonInstall();
  const [pythonInstallDialogOpen, setPythonInstallDialogOpen] = useState(false);

  // ── System capabilities status strip data ─────────────────────────────────
  // Each fetch is panel-local (only runs while panel is open).
  // react-query deduplicates the image catalogue fetch with OptionalModelsPanel.
  const { data: imageCatalogueData, refetch: refetchImageCatalogue } = useImageCatalogue();
  const anyImageModelReady = (imageCatalogueData?.models ?? []).some(m => m.downloaded);

  const { data: servicesData } = useQuery<{
    polaris:     { state: string };
    meridian:  { state: string };
    jellyfin:    { state: string };
    kavita:      { state: string };
  }>({
    queryKey: ['services', 'all'],
    queryFn: async () => {
      const res = await fetch(`${ENGINE_URL}/api/services/all`);
      if (!res.ok) throw new Error('services status failed');
      return res.json();
    },
    staleTime: 8_000,
    retry: false,
  });

  const polarisOnline     = servicesData?.polaris?.state     === 'running';
  const meridianOnline  = servicesData?.meridian?.state  === 'running';
  const jellyfinOnline  = servicesData?.jellyfin?.state  === 'running';
  const kavitaOnline  = servicesData?.kavita?.state  === 'running';

  const { data: featureFlagsData, refetch: refetchFeatureFlags } = useQuery<{
    sandboxExecutorEnabled: boolean;
    camofoxState: string;
  }>({
    queryKey: ['status', 'featureflags'],
    queryFn: async () => {
      const res = await fetch(`${ENGINE_URL}/api/status`);
      if (!res.ok) throw new Error('status failed');
      const d = await res.json();
      return {
        sandboxExecutorEnabled: d.sandboxExecutorEnabled ?? false,
        camofoxState: (d.camofox?.state as string) ?? 'stopped',
      };
    },
    staleTime: 15_000,
    retry: false,
  });
  const [executorEnabled, setExecutorEnabled] = useState<boolean | null>(null);
  // Sync optimistic local state from fetched value on first load
  useEffect(() => {
    if (featureFlagsData !== undefined && executorEnabled === null) {
      setExecutorEnabled(featureFlagsData.sandboxExecutorEnabled);
    }
  }, [featureFlagsData, executorEnabled]);
  const effectiveExecutorEnabled = executorEnabled ?? featureFlagsData?.sandboxExecutorEnabled ?? false;
  const camofoxState = featureFlagsData?.camofoxState ?? 'stopped';

  const toggleSandboxExecutor = useCallback(async () => {
    const next = !effectiveExecutorEnabled;
    setExecutorEnabled(next); // optimistic
    try {
      await fetch(`${ENGINE_URL}/api/config/sandbox-executor`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      refetchFeatureFlags();
    } catch {
      setExecutorEnabled(!next); // revert on failure
    }
  }, [effectiveExecutorEnabled, refetchFeatureFlags]);

  // Default true until status loads — avoids flashing the amber badge during the initial fetch.
  const pythonFound = pyEnvData?.python.found ?? true;

  // True if any vendor has a background pip install running server-side (panel was closed mid-install)
  const anyBackgroundInstall = pyEnvData?.vendors.some(v => v.installing) ?? false;

  const [showChangeFolderDialog, setShowChangeFolderDialog] = useState(false);

  const rec = hwData?.recommendation;
  const hw  = hwData?.hardware;

  // ── Auto-config cleanup selection ────────────────────────────────────────
  const [autoCleanupSelected, setAutoCleanupSelected] = useState<Set<string>>(new Set());



  // ── Download selection ────────────────────────────────────────────────────
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [hoveredDelete, setHoveredDelete] = useState<string | null>(null);
  const [uncensoredOpen, setUncensoredOpen] = useState<string | null>(null);
  const [llmConfirmPending, setLlmConfirmPending] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  // ── Launch config — tracks what the user has selected in the dropdowns ──────
  // Initialised to empty string (= "no model / stopped"). On first render once
  // serverData arrives, snapped to whatever is currently running. After that the
  // user controls these values freely.
  const [launchSayonModel, setLaunchSayonModel] = useState<string>('');
  const [launchSerenModel, setLaunchSerenModel] = useState<string>('');
  const [sayonDeviceIdx,   setSayonDeviceIdx]   = useState<'cpu' | number>('cpu');
  const [serenDeviceIdx,   setSerenDeviceIdx]   = useState<'cpu' | number>('cpu');

  // ── Sync dropdowns to running state ──────────────────────────────────────
  // Seed priority: DB saved config (deviceIndex, model) → running state fallback.
  // After the initial seed, dropdowns are owned by the user.
  // The only time we overwrite them after that is when a RELAUNCH completes
  // (handled in the startup completion effect below).
  // We do NOT follow reconcile movements on every status poll — that causes the
  // device dropdown to flip whenever the backend OOM-recovers or changes device.
  const seededRef = useRef(false);

  useEffect(() => {
    if (seededRef.current) return;
    // Prefer DB-saved config as the source of truth for what the user last intended.
    // Fall back to running state if the DB has no config yet.
    const dbCoordinator = savedConfig?.coordinator;
    const dbEngine      = savedConfig?.engine;
    const s             = serverData?.status;

    // Need at least one source to seed from.
    if (!dbCoordinator && !s) return;

    seededRef.current = true;

    // Model: DB model if phobos provider, else running state
    const seedSayonModel = (dbCoordinator?.provider === 'phobos' && dbCoordinator?.model)
      ? dbCoordinator.model
      : (s?.sayon?.state === 'running' ? (s.sayon.modelId ?? '') : '');
    const seedSerenModel = (dbEngine?.provider === 'phobos' && dbEngine?.model)
      ? dbEngine.model
      : (s?.seren?.state === 'running' ? (s.seren.modelId ?? '') : '');

    // Device: DB deviceIndex if set, else running state, else cpu
    const seedSayonDevice: 'cpu' | number =
      (dbCoordinator?.deviceIndex !== undefined && dbCoordinator.deviceIndex !== -1)
        ? dbCoordinator.deviceIndex
        : (s?.sayon?.deviceIndex ?? 'cpu');
    const seedSerenDevice: 'cpu' | number =
      (dbEngine?.deviceIndex !== undefined && dbEngine.deviceIndex !== -1)
        ? dbEngine.deviceIndex
        : (s?.seren?.deviceIndex ?? 'cpu');

    setLaunchSayonModel(seedSayonModel);
    setLaunchSerenModel(seedSerenModel);
    setSayonDeviceIdx(seedSayonDevice);
    setSerenDeviceIdx(seedSerenDevice);
  }, [savedConfig, serverData]);

  // ── Startup state ─────────────────────────────────────────────────────────
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Seed download checklist with recommendation
  useEffect(() => {
    if (!rec || checked.size > 0) return;
    setChecked(new Set(
      [rec.sayon.modelId, rec.seren.modelId].filter(id => downloadedIds.has(id))
    ));
  }, [rec]);

  const downloadedIds    = new Set((modelsData?.models ?? []).map(m => m.modelId));
  const downloadedModels = ALL_MODELS.filter(m => downloadedIds.has(m.modelId));
  const sayonDownloaded  = downloadedModels.filter(m => m.role === 'sayon');
  const serenDownloaded  = downloadedModels.filter(m => m.role === 'seren');

  // Poll status while starting
  useEffect(() => {
    if (!isStarting) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(() => { refetchStatus(); }, 2_000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [isStarting, refetchStatus]);

  // Detect both running
  useEffect(() => {
    if (!isStarting || !serverData?.status) return;
    const s = serverData.status;
    // Done when each server is in its target state:
    // - non-empty selection → must be 'running' WITH THE REQUESTED MODEL
    //   (not just any model — the old model may still be reported as running
    //   before the stop signal arrives, causing a false-positive completion)
    // - empty selection (stop) → must be 'stopped'
    const sayonDone = launchSayonModel
      ? s.sayon.state === 'running' && s.sayon.modelId === launchSayonModel
      : s.sayon.state === 'stopped';
    const serenDone = launchSerenModel
      ? s.seren.state === 'running' && s.seren.modelId === launchSerenModel
      : s.seren.state === 'stopped';
    if (sayonDone && serenDone) {
      setIsStarting(false);
      // Sync model dropdowns to live running state — covers OOM fallback where
      // reconcile may have switched to a smaller model than requested.
      if (s.sayon?.modelId) setLaunchSayonModel(s.sayon.modelId);
      if (s.seren?.modelId) setLaunchSerenModel(s.seren.modelId);
    }
    if (s.sayon.state === 'error' || s.seren.state === 'error') {
      const errs = [s.sayon.error, s.seren.error].filter(Boolean).join('; ');
      setStartError(errs || 'Server failed to start');
      setIsStarting(false);
    }
  }, [serverData, isStarting, launchSayonModel, launchSerenModel]);

  const toggleCheck = (modelId: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      next.has(modelId) ? next.delete(modelId) : next.add(modelId);
      return next;
    });
  };

  const handleDownloadClick = () => {
    if ([...checked].filter(id => !downloadedIds.has(id)).length === 0) return;
    setLlmConfirmPending(true);
  };

  const handleDownloadConfirmed = () => {
    setLlmConfirmPending(false);
    const toDownload = [...checked].filter(id => !downloadedIds.has(id));
    if (toDownload.length === 0) return;
    resetDownload();
    startDownload(toDownload);
  };

  const handleDeleteModel = async (modelId: string) => {
    try {
      await fetch(`${ENGINE_URL}/api/phobos/models/${modelId}`, { method: 'DELETE' });
      refetchModels();
      if (launchSayonModel === modelId)   setLaunchSayonModel('');
      if (launchSerenModel === modelId) setLaunchSerenModel('');
    } catch { /* silent */ }
  };

  const isPulling = downloadStage.kind === 'downloading';

  // Panel cannot be closed while a server start or install is in progress.
  // Downloads are independent and no longer gate panel close.
  const panelLocked = isStarting || !!pyInstalling || pyAutoInstalling || anyBackgroundInstall;

  // ── Priority 1: any checked model not yet downloaded → show Download ─────
  const toDownloadIds   = [...checked].filter(id => !downloadedIds.has(id));
  const toDownloadCount = toDownloadIds.length;
  const wantsDownload   = toDownloadCount > 0 && !isPulling && !isStarting;

  // ── Server running state ──────────────────────────────────────────────────
  const bothRunning = serverData?.status?.sayon?.state === 'running'
    && serverData?.status?.seren?.state === 'running';

  // What is actually loaded right now (empty string when stopped)
  const runningSayonModel = serverData?.status?.sayon?.modelId ?? '';
  const runningSerenModel = serverData?.status?.seren?.modelId ?? '';

  // Launch is actionable when the selection differs from what's running.
  // Empty string = "stopped" — always a valid selection.
  // A non-empty value must be in the downloaded list to be launchable.
  const sayonValid = launchSayonModel === '' || downloadedIds.has(launchSayonModel);
  const serenValid = launchSerenModel === '' || downloadedIds.has(launchSerenModel);
  const normDevice = (d: number | string | undefined): string =>
    (d === undefined || d === 'cpu' || d === -1) ? 'cpu' : String(d);
  const runningSayonDevice = serverData?.status?.sayon?.deviceIndex;
  const runningSerenDevice = serverData?.status?.seren?.deviceIndex;
  const selectionMatchesRunning =
    launchSayonModel === runningSayonModel
    && launchSerenModel === runningSerenModel
    && normDevice(sayonDeviceIdx) === normDevice(runningSayonDevice)
    && normDevice(serenDeviceIdx) === normDevice(runningSerenDevice);
  const launchReady = sayonValid && serenValid;
  const wantsLaunch = launchReady && !selectionMatchesRunning && !isStarting;

  // ── Priority 3: selection matches what is running → PHOBOS ONLINE ─────────
  // Online means: selection exactly matches running state (including both-stopped = both-empty)
  const isOnline = selectionMatchesRunning;

  const parseDeviceValue = (v: string): 'cpu' | number => v === 'cpu' ? 'cpu' : parseInt(v, 10);

  const handleStart = async () => {
    if (!hw) return;
    setIsStarting(true);
    setStartError(null);

    const sayonSpec = launchSayonModel ? ALL_MODELS.find(m => m.modelId === launchSayonModel) : null;
    const serenSpec = launchSerenModel ? ALL_MODELS.find(m => m.modelId === launchSerenModel) : null;

    // If a non-empty model ID has no spec something is wrong — bail
    if ((launchSayonModel && !sayonSpec) || (launchSerenModel && !serenSpec)) {
      setIsStarting(false);
      return;
    }

    const sayonGpuLayers = sayonDeviceIdx !== 'cpu' ? 99 : 0;
    const serenGpuLayers = serenDeviceIdx !== 'cpu' ? 99 : 0;
    const sayonGpu = sayonDeviceIdx !== 'cpu' ? hw.gpus.find(g => g.index === sayonDeviceIdx) : null;
    const serenGpu = serenDeviceIdx !== 'cpu' ? hw.gpus.find(g => g.index === serenDeviceIdx) : null;

    try {
      await startPhobosServers(
        { modelId: sayonSpec?.modelId ?? '', gpuLayers: sayonGpuLayers, deviceIndex: sayonDeviceIdx !== 'cpu' ? sayonDeviceIdx : undefined, gpuBackend: sayonGpu?.backend },
        { modelId: serenSpec?.modelId ?? '', gpuLayers: serenGpuLayers, deviceIndex: serenDeviceIdx !== 'cpu' ? serenDeviceIdx : undefined, gpuBackend: serenGpu?.backend },
      );
      // Persist config so reconcilePhobosServers knows the intended state.
      // Empty model = "stopped" — reconcile will leave the server stopped on next call.
      await updateConfig.mutateAsync({
        coordinator: sayonSpec
          ? { provider: 'phobos', model: sayonSpec.modelId, deviceIndex: sayonDeviceIdx !== 'cpu' ? sayonDeviceIdx : -1, gpuBackend: sayonGpu?.backend, gpuLayers: sayonGpuLayers }
          : { provider: 'phobos', model: '' },
        engine: serenSpec
          ? { provider: 'phobos', model: serenSpec.modelId, deviceIndex: serenDeviceIdx !== 'cpu' ? serenDeviceIdx : -1, gpuBackend: serenGpu?.backend, gpuLayers: serenGpuLayers }
          : { provider: 'phobos', model: '' },
      });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Start failed');
      setIsStarting(false);
    }
  };

  // Provider status helpers
  const renderStatusDot = (state: string) => {
    switch (state) {
      case 'running':  return <span className="text-phobos-green/80">●</span>;
      case 'starting': return <span className="text-phobos-amber/80 animate-pulse">●</span>;
      case 'error':    return <span className="text-destructive/80">✕</span>;
      default:         return <span className="text-muted-foreground/40">○</span>;
    }
  };

  const renderStatusLabel = (state: string) => {
    switch (state) {
      case 'running':  return <span className="text-phobos-green/80">RUNNING</span>;
      case 'starting': return <span className="text-phobos-amber/80">STARTING</span>;
      case 'error':    return <span className="text-destructive/80">ERROR</span>;
      default:         return <span className="text-muted-foreground/50">STOPPED</span>;
    }
  };

  const getDeviceName = (deviceIndex?: number) => {
    if (deviceIndex == null || !hw?.gpus) return null;
    const gpu = hw.gpus.find(g => g.index === deviceIndex);
    return gpu ? gpu.name.replace(/NVIDIA |AMD |Intel /, '') : null;
  };

  return (
    <>
    <div
      className="fixed inset-0 z-[200] bg-black/80 flex items-center justify-center p-[3vh]"
      onClick={(e) => { if (e.target === e.currentTarget && !panelLocked) onClose(); }}
    >
      <div className="flex flex-row gap-3 w-[min(2000px,96vw)] h-full max-h-[94vh]">

        {/* ═══════════════════════════════════════════════════════════════════
            LEFT COLUMN — COMMAND CENTER
           ═══════════════════════════════════════════════════════════════════ */}
        <div className="w-[930px] shrink-0 flex flex-col min-h-0">
        <div className="phobos-llm-panel bg-card border border-phobos-green/25 rounded-sm shadow-[0_0_40px_hsl(120_100%_50%/0.08)] font-mono flex flex-col flex-1 min-h-0 overflow-y-auto scrollbar-phobos">

          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-border/40">
            <span className="text-xs font-terminal tracking-[0.2em] text-phobos-green/80 uppercase">PHOBOS COMMAND CENTER</span>
            <div className="flex items-center gap-1">
              {/* TODO: wire isDarkMode to your theme provider */}
              <button
                onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                className="p-1.5 rounded hover:bg-accent text-muted-foreground/50 hover:text-foreground transition-colors"
                title={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {resolvedTheme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              </button>
              <button onClick={onClose} disabled={panelLocked} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="px-6 py-5 space-y-5">

            {/* Row 1: Provider status + Auto-config */}
            <div className="flex items-start gap-6">
              {/* Provider status — left side */}
              <div className="flex-1">
                {serverLoading ? (
                  <div className="text-sm text-muted-foreground/50 font-mono">Connecting to backend…</div>
                ) : serverError ? (
                  <div className="text-sm text-muted-foreground/50 font-mono">Provider status unavailable</div>
                ) : serverData?.status ? (
                  <div className="space-y-2.5">
                    {(['sayon', 'seren'] as const).map((agent) => {
                      const s = serverData.status[agent];
                      const deviceName = getDeviceName(s.deviceIndex);
                      return (
                        <div key={agent} className="flex items-center gap-3 text-sm">
                          <img
                            src={agent === 'sayon' ? `${import.meta.env.BASE_URL}sayon.png` : `${import.meta.env.BASE_URL}seren.png`}
                            alt={agent}
                            className="w-7 h-7 rounded-sm object-cover opacity-80"
                          />
                          <span className={`font-terminal tracking-[0.15em] text-base ${agent === 'sayon' ? 'text-sayon' : 'text-seren'}`}>
                            {agent.toUpperCase()}
                          </span>
                          <span className="font-mono text-foreground/55">
                            {s.modelId || '—'}
                          </span>
                          {deviceName && (
                            <span className="text-xs text-muted-foreground/45">on {deviceName}</span>
                          )}
                          <span className="text-sm">{renderStatusDot(s.state)}</span>
                          <span className="text-xs font-mono">{renderStatusLabel(s.state)}</span>
                          <span className="text-xs font-mono text-muted-foreground/20 ml-auto">
                            :{s.port}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              {/* Auto-config + optimality — right side */}
              <div className="flex flex-col items-end gap-2 shrink-0">
                <button
                  onClick={() => { if (autoPhase.kind === 'idle') fetchPlan(); }}
                  disabled={isPulling || isStarting || autoPhase.kind !== 'idle'}
                  className="flex items-center gap-2 px-4 py-2 rounded-sm border border-phobos-amber/30 text-phobos-amber/80 hover:text-phobos-amber hover:border-phobos-amber/50 hover:bg-phobos-amber/5 transition-all text-[11px] font-terminal uppercase tracking-[0.15em] disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Settings2 className="w-4 h-4" />
                  AUTO-CONFIG
                </button>
                {configOptimal === true && (
                  <span className="text-xs font-mono text-phobos-green/60 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Optimal
                  </span>
                )}
                {configOptimal === false && (
                  <span className="text-xs font-mono text-phobos-amber/70 flex items-center gap-1 animate-pulse">
                    <AlertTriangle className="w-3.5 h-3.5" /> Better config available
                  </span>
                )}
              </div>
            </div>


            {/* Row 3: Launch config — stacked dropdowns */}
            {!isStarting && (
              <div className="border border-phobos-green/20 bg-phobos-green/[0.03] rounded p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-terminal text-phobos-green/60 tracking-[0.15em] uppercase">
                    {isOnline ? 'RUNNING CONFIG' : 'LAUNCH CONFIG'}
                  </div>
                  {/* Primary action — inline with config header */}
                  <div className="flex items-center gap-2">
                    {!isOnline && bothRunning && launchReady && (
                      <span className="text-xs font-mono text-phobos-amber/60">↻ relaunch to apply</span>
                    )}
                    {isStarting ? (
                      <div className="flex items-center gap-1.5 px-3 py-1 rounded-sm border border-phobos-green/30 bg-phobos-green/8 text-phobos-green/60 text-[10px] font-terminal uppercase tracking-[0.15em]">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        STARTING…
                      </div>
                    ) : wantsLaunch ? (
                      <button onClick={handleStart}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded-sm border transition-all text-[10px] font-terminal uppercase tracking-[0.15em] ${
                          bothRunning
                            ? 'border-phobos-amber/40 bg-phobos-amber/10 text-phobos-amber hover:bg-phobos-amber/20 hover:border-phobos-amber/60'
                            : 'border-phobos-green/40 bg-phobos-green/10 text-phobos-green hover:bg-phobos-green/20 hover:border-phobos-green/60'
                        }`}>
                        <Play className="w-3 h-3" />
                        {bothRunning && (launchSayonModel || launchSerenModel) ? 'RELAUNCH'
                          : (!launchSayonModel && !launchSerenModel) ? 'STOP PHOBOS'
                          : 'START PHOBOS'}
                      </button>
                    ) : isOnline ? (
                      <div className="flex items-center gap-1.5 px-3 py-1 rounded-sm border border-phobos-green/35 bg-phobos-green/[0.07] text-phobos-green/80 text-[10px] font-terminal uppercase tracking-[0.15em] select-none">
                        <span className="text-phobos-green/80">●</span>
                        PHOBOS ONLINE
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="flex gap-6">
                  {/* SAYON column — stacked */}
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <img src={`${import.meta.env.BASE_URL}sayon.png`} alt="SAYON" className="w-5 h-5 rounded-sm opacity-70" />
                      <span className="font-terminal text-sm tracking-[0.15em] text-sayon">SAYON</span>
                      <span className="text-xs text-foreground/30 font-mono">coordinator</span>
                    </div>
                    <select value={launchSayonModel} onChange={(e) => setLaunchSayonModel(e.target.value)}
                      className="w-full bg-transparent border border-border/30 rounded text-sm font-mono text-foreground/75 px-2.5 py-1.5 focus:border-phobos-green/40 focus:outline-none">
                      <option value="" className="bg-black text-muted-foreground/50">— stopped —</option>
                      {sayonDownloaded.map(m => (
                        <option key={m.modelId} value={m.modelId} className="bg-black">
                          {m.label}{rec?.sayon.modelId === m.modelId ? ' ★' : ''}
                        </option>
                      ))}
                    </select>
                    {hw && hw.gpus.length > 0 && (
                      <select value={String(sayonDeviceIdx)} onChange={(e) => setSayonDeviceIdx(parseDeviceValue(e.target.value))}
                        className="w-full bg-transparent border border-border/30 rounded text-sm font-mono text-foreground/60 px-2.5 py-1.5 focus:border-phobos-green/40 focus:outline-none">
                        <option value="cpu" className="bg-black">CPU</option>
                        {hw.gpus.map(gpu => <option key={gpu.index} value={String(gpu.index)} className="bg-black">{gpu.name.replace(/NVIDIA |AMD |Intel |Apple /, '')} {gpu.vramGb}G</option>)}
                      </select>
                    )}
                  </div>

                  {/* SEREN column — stacked */}
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <img src={`${import.meta.env.BASE_URL}seren.png`} alt="SEREN" className="w-5 h-5 rounded-sm opacity-70" />
                      <span className="font-terminal text-sm tracking-[0.15em] text-seren">SEREN</span>
                      <span className="text-xs text-foreground/30 font-mono">reasoning engine</span>
                    </div>
                    <select value={launchSerenModel} onChange={(e) => setLaunchSerenModel(e.target.value)}
                      className="w-full bg-transparent border border-border/30 rounded text-sm font-mono text-foreground/75 px-2.5 py-1.5 focus:border-phobos-green/40 focus:outline-none">
                      <option value="" className="bg-black text-muted-foreground/50">— stopped —</option>
                      {serenDownloaded.map(m => (
                        <option key={m.modelId} value={m.modelId} className="bg-black">
                          {m.label}{rec?.seren.modelId === m.modelId ? ' ★' : ''}
                        </option>
                      ))}
                    </select>
                    {hw && hw.gpus.length > 0 && (
                      <select value={String(serenDeviceIdx)} onChange={(e) => setSerenDeviceIdx(parseDeviceValue(e.target.value))}
                        className="w-full bg-transparent border border-border/30 rounded text-sm font-mono text-foreground/60 px-2.5 py-1.5 focus:border-phobos-green/40 focus:outline-none">
                        <option value="cpu" className="bg-black">CPU</option>
                        {hw.gpus.map(gpu => <option key={gpu.index} value={String(gpu.index)} className="bg-black">{gpu.name.replace(/NVIDIA |AMD |Intel |Apple /, '')} {gpu.vramGb}G</option>)}
                      </select>
                    )}
                  </div>
                </div>

              </div>
            )}

            {/* Starting progress */}
            {isStarting && serverData?.status && (
              <div className="border border-phobos-green/20 bg-phobos-green/[0.03] rounded p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-terminal text-phobos-green/70 tracking-[0.15em] uppercase">
                  <Loader2 className="w-4 h-4 animate-spin" /> LAUNCHING SERVERS…
                </div>
                {(['sayon', 'seren'] as const).map((agent) => {
                  const s = serverData.status[agent];
                  return (
                    <div key={agent} className="flex items-center gap-2 text-sm">
                      <span className={`font-terminal tracking-[0.1em] ${agent === 'sayon' ? 'text-sayon' : 'text-seren'}`}>{agent.toUpperCase()}</span>
                      <span>{renderStatusDot(s.state)}</span>
                      <span className="text-xs font-mono">{renderStatusLabel(s.state)}</span>
                      {s.state === 'starting' && <span className="text-xs text-foreground/45 font-mono">loading model…</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Error */}
            {(downloadStage.kind === 'error' || startError) && (
              <div className="flex items-start gap-2 text-sm text-destructive/80 bg-destructive/5 border border-destructive/15 rounded px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{downloadStage.kind === 'error' ? (downloadStage as { message?: string }).message : startError}</span>
              </div>
            )}

            {/* ── System Capabilities ──────────────────────────────────────────────────
                Core systems — always shown, status reflects live state.
                Optional systems — shown with setup affordance when offline.
               ─────────────────────────────────────────────────────────────────────── */}
            <div className="border border-border/20 rounded bg-black/30">


            {/* Row 2: Hardware — visual cards */}
            {hwLoading && (
              <div className="flex items-center gap-2 text-sm text-foreground/50">
                <Loader2 className="w-4 h-4 animate-spin" /> Detecting hardware...
              </div>
            )}
            {hwError && (
              <div className="flex items-center gap-2 text-sm text-destructive/70">
                <AlertTriangle className="w-4 h-4" /> Cannot reach backend.
              </div>
            )}
            {hw && (
              <div className="flex gap-3 flex-wrap">
                {/* CPU card */}
                <div className="flex-1 min-w-[200px] bg-accent/20 rounded border border-border/20 px-3 py-2.5">
                  <div className="flex items-center gap-2 mb-1">
                    <Cpu className="w-4 h-4 text-muted-foreground/50" />
                    <span className="text-xs font-terminal text-muted-foreground/50 uppercase tracking-wider">CPU</span>
                  </div>
                  <div className="text-sm text-foreground/80 font-mono">{hw.cpuName}</div>
                  <div className="text-xs text-foreground/45 font-mono">{hw.cpuCores} cores · {hw.ramGb} GB RAM</div>
                </div>
                {/* GPU cards */}
                {hw.gpus.map((gpu) => {
                  const badge = BACKEND_BADGE[gpu.backend];
                  // Map GPU to PyTorch vendor for env status lookup
                  const pyVendor = gpu.backend === 'cuda' ? 'cuda'
                    : gpu.backend === 'metal' ? 'apple'
                    : /AMD|Radeon/i.test(gpu.name) ? 'rocm'
                    : /Intel.*Arc/i.test(gpu.name) ? 'xpu'
                    : null;
                  const pyVendorStatus = pyVendor
                    ? pyEnvData?.vendors.find(v => v.vendor === pyVendor)
                    : null;
                  const pyReady = pyVendorStatus?.ready ?? false;
                  const pyStale = pyVendorStatus?.stale ?? false;
                  const pyIsInstalling = pyVendor === pyInstalling;
                  // True when a background pip install is running server-side but the
                  // frontend hook is no longer connected (e.g. panel was closed mid-install).
                  const pyIsInstallingBackground = pyVendor
                    ? (pyEnvData?.vendors.find(v => v.vendor === pyVendor)?.installing ?? false)
                    : false;
                  return (
                    <div key={gpu.index} className="flex-1 min-w-[200px] bg-accent/20 rounded border border-border/20 px-3 py-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-terminal text-muted-foreground/50 uppercase tracking-wider">GPU {gpu.index}</span>
                        {badge && (
                          <span className={`text-[11px] font-terminal border rounded px-1.5 py-0.5 ${badge.border} ${badge.text}`}>
                            {badge.label}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-foreground/80 font-mono">{gpu.name}</div>
                      <div className="text-xs text-foreground/45 font-mono">{gpu.vramGb} GB VRAM</div>
                      {/* PyTorch status badge */}
                      {pyVendor && (
                        <div className="mt-1.5">
                          {pyIsInstalling || pyIsInstallingBackground || (pyAutoInstalling && !pythonFound) ? (
                            <div className="flex items-center gap-1.5">
                              <Loader2 className="w-3 h-3 animate-spin text-phobos-amber" />
                              <span className="text-[10px] font-mono text-phobos-amber">
                                {pyIsInstalling
                                  ? (pyProgress?.label ?? 'Installing…')
                                  : pyIsInstallingBackground
                                  ? 'Installing (background)…'
                                  : (pyAutoProgress?.label ?? 'Installing Python…')}
                              </span>
                            </div>
                          ) : pyReady && pyStale ? (
                            <button
                              onClick={() => pyStartInstall(pyVendor, true)}
                              className="flex items-center gap-1.5 hover:opacity-80 transition-opacity group"
                              title="PyTorch packages have been updated — click to upgrade your environment"
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-phobos-amber inline-block group-hover:bg-amber-400" />
                              <span className="text-[10px] font-mono text-phobos-amber/80 group-hover:text-amber-400 underline decoration-dotted underline-offset-2">
                                Update PyTorch env
                              </span>
                            </button>
                          ) : pyReady ? (
                            <div className="flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                              <span className="text-[10px] font-mono text-emerald-500/80">PyTorch ready</span>
                            </div>
                          ) : !pythonFound ? (
                            <button
                              onClick={() => setPythonInstallDialogOpen(true)}
                              className="flex items-center gap-1.5 hover:opacity-80 transition-opacity group"
                              title="Python 3.12 required before PyTorch can be installed"
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block group-hover:bg-amber-400" />
                              <span className="text-[10px] font-mono text-amber-500/80 group-hover:text-amber-400 underline decoration-dotted underline-offset-2">
                                Install Python first
                              </span>
                            </button>
                          ) : (
                            <button
                              onClick={() => pyStartInstall(pyVendor)}
                              className="flex items-center gap-1.5 hover:opacity-80 transition-opacity group"
                              title={`Install PyTorch for ${pyVendor.toUpperCase()}`}
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block group-hover:bg-red-400" />
                              <span className="text-[10px] font-mono text-red-500/80 group-hover:text-red-400 underline decoration-dotted underline-offset-2">
                                Set up PyTorch
                              </span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {hw.gpus.length === 0 && (
                  <div className="flex-1 min-w-[200px] bg-accent/20 rounded border border-border/20 px-3 py-2.5">
                    <div className="text-xs font-terminal text-muted-foreground/50 uppercase tracking-wider mb-1">GPU</div>
                    <div className="text-sm text-foreground/50 font-mono">No GPU detected — CPU only</div>
                  </div>
                )}
              </div>
            )}


            {/* PyTorch Models — image models that have been converted to diffusers format */}
            {(() => {
              const readyModels = (imageCatalogueData?.models ?? []).filter(m => m.pytorchVariantReady);
              if (readyModels.length === 0) return null;
              return (
                <div className="border border-border/20 rounded p-3 space-y-2">
                  <div className="text-[11px] font-terminal text-muted-foreground/40 uppercase tracking-[0.15em]">
                    PyTorch Models
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {readyModels.map(m => (
                      <div key={m.modelId}
                        className="flex items-center gap-1.5 px-2 py-1 border border-phobos-green/25 rounded text-[11px] font-mono text-phobos-green/70 bg-phobos-green/[0.04]">
                        <span className="truncate max-w-[140px]">{m.displayName}</span>
                        <span className="text-muted-foreground/30 shrink-0">
                          {m.sizeBytes >= 1e9 ? `${(m.sizeBytes / 1e9).toFixed(1)}gb` : `${(m.sizeBytes / 1e6).toFixed(0)}mb`}
                        </span>
                        <button
                          onClick={() => deleteFluxModel(m.modelId).then(() => refetchImageCatalogue())}
                          className="text-muted-foreground/25 hover:text-destructive/60 transition-colors shrink-0 ml-0.5"
                          title={`Delete ${m.displayName}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

              {/* Core systems grid */}
              <div className="px-4 pt-3 pb-2 grid grid-cols-2 gap-2">

                {/* TWIN SUN — coordinator + engine pair */}
                <SystemCapabilityRow
                  icon={<Cpu className="w-3.5 h-3.5" />}
                  label="TWIN SUN"
                  online={bothRunning}
                  detail={bothRunning ? `${runningSayonModel ? 'SAYON + SEREN' : ''}` : 'LLM servers offline'}
                />

                {/* Image Engine */}
                <SystemCapabilityRow
                  icon={<Image className="w-3.5 h-3.5" />}
                  label="IMAGE ENGINE"
                  online={anyImageModelReady}
                  detail={anyImageModelReady ? 'Models ready' : 'No models downloaded'}
                />

                {/* Vision */}
                <SystemCapabilityRow
                  icon={<Zap className="w-3.5 h-3.5" />}
                  label="VISION"
                  online={!!(visionCapability?.coordinatorSupportsVision || visionCapability?.engineSupportsVision)}
                  detail={
                    visionCapability?.engineSupportsVision ? 'SEREN + SAYON'
                    : visionCapability?.coordinatorSupportsVision ? 'SAYON only'
                    : 'Not supported by active models'
                  }
                />

                {/* Polaris music server */}
                <SystemCapabilityRow
                  icon={<Music className="w-3.5 h-3.5" />}
                  label="POLARIS"
                  online={polarisOnline}
                  detail={polarisOnline ? 'Music server active' : 'Stopped'}
                />

                {/* Jellyfin video server */}
                <SystemCapabilityRow
                  icon={<Film className="w-3.5 h-3.5" />}
                  label="JELLYFIN"
                  online={jellyfinOnline}
                  detail={jellyfinOnline ? 'Video host active' : 'Stopped'}
                />

                {/* PHOBOS Meridian photo server*/}
                <SystemCapabilityRow
                  icon={<BookOpen className="w-3.5 h-3.5" />}
                  label="MERIDIAN"
                  online={meridianOnline}
                  detail={meridianOnline ? 'Photo library active' : 'Stopped'}
                />

                {/* Kavita reading server */}
                <SystemCapabilityRow
                  icon={<BookMarked className="w-3.5 h-3.5" />}
                  label="KAVITA"
                  online={kavitaOnline}
                  detail={kavitaOnline ? 'Reading feed active' : 'Stopped'}
                />

                {/* Web Browse — Camofox */}
                <SystemCapabilityRow
                  icon={<Globe className="w-3.5 h-3.5" />}
                  label="WEB BROWSE"
                  online={camofoxState === 'running'}
                  detail={
                    camofoxState === 'running'  ? 'Camoufox active' :
                    camofoxState === 'starting' ? 'Starting…'       :
                    camofoxState === 'error'    ? 'Error — check logs' :
                    'Camofox not running'
                  }
                />

              </div>

              {/* Optional systems separator */}
              <div className="mx-4 border-t border-border/15 mt-1 mb-2" />
              <div className="px-4 pb-1">
                <span className="text-[11px] font-terminal text-muted-foreground/30 uppercase tracking-[0.18em]">Optional Add-ons</span>
              </div>

              {/* Sandbox Executor row — Close button sits on the same line */}
              <div className="px-4 pb-3 flex items-center gap-3">
                <button
                  onClick={toggleSandboxExecutor}
                  className="flex items-center gap-3 flex-1 group text-left min-w-0"
                >
                  {/* Checkbox */}
                  <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 transition-colors ${
                    effectiveExecutorEnabled
                      ? 'border-phobos-green/60 bg-phobos-green/20'
                      : 'border-border/30 group-hover:border-border/50'
                  }`}>
                    {effectiveExecutorEnabled && (
                      <CheckCircle2 className="w-2.5 h-2.5 text-phobos-green" />
                    )}
                  </div>

                  <Terminal className="w-3 h-3 text-muted-foreground/40 shrink-0" />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-terminal tracking-[0.12em] text-foreground/60 uppercase">
                        Sandbox Executor
                      </span>
                      {!effectiveExecutorEnabled && (
                        <span className="text-[10px] text-phobos-amber/50 font-mono border border-phobos-amber/25 rounded px-1">
                          setup required
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground/30 font-mono mt-0.5">
                      {effectiveExecutorEnabled
                        ? 'SEREN can run code it writes in an isolated sandbox'
                        : 'Enable to let SEREN execute code in a sandboxed environment'}
                    </div>
                  </div>
                </button>

                {/* Close — inline, right-aligned */}
                {!panelLocked && (
                  <button onClick={onClose}
                    className="px-3 py-1.5 rounded-sm border border-border/20 text-foreground/40 hover:text-foreground/70 hover:border-border/35 transition-all text-[10px] uppercase tracking-[0.15em] shrink-0">
                    CLOSE
                  </button>
                )}
              </div>
            </div>

            {/* Recommendation note — fine print below the strip */}
            {rec && (
              <p className="text-[12px] text-foreground/25 leading-relaxed">{rec.reasoning}</p>
            )}
          </div>
        </div>
        </div>{/* end left column */}

        {/* ═══════════════════════════════════════════════════════════════════
            RIGHT COLUMN — LLM Models + Optional Models
           ═══════════════════════════════════════════════════════════════════ */}
        <div className="flex-1 flex flex-row gap-3 min-w-0 min-h-0">

          {/* ── LLM Models ── */}
          <div className="phobos-llm-panel flex-1 flex flex-col min-h-0 bg-card border border-phobos-green/25 rounded-sm shadow-[0_0_40px_hsl(120_100%_50%/0.08)] font-mono overflow-y-auto scrollbar-phobos">
            <div className="flex items-center justify-between px-5 py-3">
              {/* Left: label + GB + path controls — all on one line */}
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-xs font-terminal tracking-[0.2em] text-phobos-green/80 uppercase">LLM MODELS</span>
                {modelsInfo && (
                  <span className="text-[10px] text-foreground/40 font-mono flex items-center gap-1">
                    <HardDrive className="w-3 h-3" />
                    {modelsInfo.totalBytes >= 1e9 ? `${(modelsInfo.totalBytes / 1e9).toFixed(1)} GB` : `${(modelsInfo.totalBytes / 1e6).toFixed(0)} MB`}
                  </span>
                )}
                {/* Path controls */}
                {modelsInfo?.path && (
                  <button type="button"
                    onClick={(e) => { e.stopPropagation(); fetch(`${ENGINE_URL}/api/phobos/open-folder?path=${encodeURIComponent(modelsInfo.path)}`).catch(() => {}); }}
                    className="text-[10px] text-muted-foreground/40 hover:text-phobos-green/70 transition-colors flex items-center gap-1 shrink-0"
                    title={`Open ${modelsInfo.path}`}>
                    <FolderOpen className="w-3 h-3" /> Open
                  </button>
                )}
                <button type="button"
                  onClick={(e) => { e.stopPropagation(); setShowChangeFolderDialog(true); }}
                  className="text-[10px] text-muted-foreground/40 hover:text-phobos-green/70 transition-colors flex items-center gap-1 shrink-0"
                  title="Change models folder">
                  <FolderSearch className="w-3 h-3" /> Change
                </button>
                <button type="button"
                  disabled={resyncing}
                  onClick={async (e) => { e.stopPropagation(); await resync(); refetchModelsInfo(); refetchModels(); }}
                  className="text-[10px] text-muted-foreground/40 hover:text-phobos-green/70 transition-colors flex items-center gap-1 shrink-0 disabled:opacity-40"
                  title="Resync — re-scan current folder and rebuild model links">
                  {resyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  {resyncing ? 'Syncing…' : 'Resync'}
                </button>
              </div>

              {/* Right: LLM download button or active progress */}
              <div className="flex items-center gap-2 shrink-0 ml-3">
                {isPulling && downloadStage.kind === 'downloading' ? (
                  <>
                    <div className="flex flex-col items-end gap-0.5 min-w-[140px]">
                      <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-phobos-green/70 rounded-full transition-all duration-300"
                          style={{ width: `${downloadStage.sayon?.bytesTotal ? Math.round((downloadStage.sayon.bytesReceived / downloadStage.sayon.bytesTotal) * 100) : 0}%` }}
                        />
                      </div>
                      <span className="text-[9px] text-phobos-green/50 font-mono">
                        {downloadStage.sayon?.phase === 'complete'
                          ? downloadStage.seren
                            ? `SEREN ${downloadStage.seren.bytesTotal > 0 ? Math.round((downloadStage.seren.bytesReceived / downloadStage.seren.bytesTotal) * 100) : 0}%`
                            : 'Installing…'
                          : `${downloadStage.sayon?.bytesTotal ? Math.round((downloadStage.sayon.bytesReceived / downloadStage.sayon.bytesTotal) * 100) : 0}% · ${downloadStage.queueRemaining > 0 ? `${downloadStage.queueRemaining} queued` : 'downloading'}`
                        }
                      </span>
                    </div>
                    <button onClick={cancelDownload}
                      className="text-[9px] text-muted-foreground/40 hover:text-destructive/70 transition-colors uppercase tracking-[0.1em] shrink-0">
                      Cancel
                    </button>
                  </>
                ) : downloadStage.kind === 'error' ? (
                  <button onClick={resetDownload}
                    className="text-[9px] text-destructive/60 hover:text-destructive transition-colors uppercase tracking-[0.1em]">
                    Error — Retry
                  </button>
                ) : wantsDownload ? (
                  <button onClick={handleDownloadClick}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm border border-phobos-green/30 text-phobos-green/70 hover:text-phobos-green hover:border-phobos-green/50 transition-all text-[9px] uppercase tracking-[0.15em] shrink-0">
                    <Download className="w-3 h-3" />
                    {toDownloadCount} model{toDownloadCount > 1 ? 's' : ''}
                  </button>
                ) : null}
              </div>
            </div>

            <div className="border-t border-border/20 px-5 py-4 space-y-3 scrollbar-phobos">

                {/* Row 1 — role hint */}
                <div className="flex items-center gap-4 px-3 py-2 border border-border/15 rounded bg-black/20">
                  <span className="text-[11px] font-terminal tracking-[0.12em] text-blue-300/70">SAYON</span>
                  <span className="text-[10px] text-foreground/35 font-mono">Fast coordinator — speed-optimised responses</span>
                  <span className="text-[10px] text-foreground/20 font-mono mx-1">·</span>
                  <span className="text-[11px] font-terminal tracking-[0.12em] text-phobos-amber/70">SEREN</span>
                  <span className="text-[10px] text-foreground/35 font-mono">Deep reasoning engine — quality-optimised</span>
                </div>

                {/* Row 2 — recommended note */}
                {rec && (
                  <div className="text-[11px] text-foreground/40 font-mono px-1">
                    ★ = recommended models based on your hardware
                  </div>
                )}

                {/* Row 3 — legacy toggle with description */}
                <div className="flex items-center gap-3 px-3 py-2.5 border border-border/20 rounded text-[11px] font-mono text-muted-foreground/40">
                  <span className="flex-1">Legacy models are previous Phobos LLMs that were superseded or decommissioned.</span>
                  <button type="button" onClick={() => setShowLegacy(!showLegacy)}
                    className={`text-[11px] font-terminal tracking-[0.1em] border px-2 py-1 rounded-sm transition-all shrink-0 ${
                      showLegacy ? 'border-phobos-amber/30 text-phobos-amber/60 bg-phobos-amber/5 hover:border-phobos-amber/50' : 'border-border/20 text-muted-foreground/40 hover:text-phobos-green/60 hover:border-phobos-green/20'
                    }`}>
                    {showLegacy ? 'HIDE' : 'SHOW'}
                  </button>
                </div>

                {MODEL_FAMILIES.map(family => {
                  const familyModels = ALL_MODELS.filter(m => m.family === family && !m.legacy);
                  return (
                    <div key={family}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[11px] font-terminal text-muted-foreground/50 uppercase tracking-[0.12em]">{family}</span>
                        {familyModels[0]?.thinkingTokens && (
                          <span className="text-[10px] text-phobos-amber/40 font-mono">⟨think⟩</span>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        {familyModels.map(spec => {
                          const isDownloaded    = downloadedIds.has(spec.modelId);
                          const isChecked       = checked.has(spec.modelId);
                          const isSayonRec      = rec?.sayon.modelId   === spec.modelId;
                          const isSerenRec    = rec?.seren.modelId === spec.modelId;
                          const isDeleteHovered = hoveredDelete === spec.modelId;
                          const overBudget      = isIncompatible(spec, hw);
                          const isRunning = bothRunning && (spec.modelId === runningSayonModel || spec.modelId === runningSerenModel);
                          const runningRole = isRunning ? spec.modelId === runningSayonModel ? 'SAYON' : 'SEREN' : null;
                          const progKey = downloadStage.kind === 'downloading'
                            ? (downloadStage.sayon?.modelId === spec.modelId ? downloadStage.sayon : downloadStage.seren?.modelId === spec.modelId ? downloadStage.seren : null)
                            : null;
                          const isInstalling = !!(progKey?.installing && !progKey.done);
                          const displayTotal = progKey && progKey.bytesTotal > 0 ? progKey.bytesTotal : spec.sizeBytes;

                          return (
                            <div key={spec.modelId}
                              onClick={() => !isDownloaded && !isPulling && toggleCheck(spec.modelId)}
                              className={`relative flex items-center gap-3 px-3 py-2 rounded border transition-colors select-none ${
                                overBudget && !isDownloaded
                                  ? isChecked ? 'border-red-500/25 bg-red-500/[0.03] cursor-pointer' : 'border-red-500/15 hover:border-red-500/25 cursor-pointer'
                                  : isDownloaded
                                  ? isDeleteHovered && !isRunning ? 'border-destructive/15 bg-destructive/[0.02] cursor-default'
                                    : isRunning ? 'border-phobos-green/30 bg-phobos-green/[0.04] cursor-default'
                                    : 'border-phobos-green/12 bg-phobos-green/[0.025] cursor-default'
                                  : isPulling ? 'border-border/12 cursor-not-allowed opacity-50'
                                  : isChecked ? 'border-border/25 bg-accent/10 cursor-pointer'
                                  : 'border-border/12 hover:border-border/20 cursor-pointer'
                              }`}
                            >
                              {isInstalling && (
                                <div className="absolute inset-0 rounded flex items-center justify-center bg-[#0a0a0a]/80 z-10">
                                  <div className="flex items-center gap-2">
                                    <Loader2 className="w-3 h-3 text-phobos-green/60 animate-spin" />
                                    <span className="text-[10px] font-terminal text-phobos-green/60 tracking-[0.15em] uppercase">Installing…</span>
                                  </div>
                                </div>
                              )}
                              <div className={`w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center transition-colors ${
                                isDownloaded ? 'border-phobos-green/40 bg-phobos-green/10' : isChecked ? 'border-phobos-green/40 bg-phobos-green/10' : 'border-border/30'
                              }`}>
                                {(isDownloaded || isChecked) && <div className="w-1.5 h-1.5 rounded-sm bg-phobos-green/60" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                {/* Row 1 — name + rec + running + license */}
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className={`text-[13px] ${overBudget ? 'text-red-400/70' : spec.role === 'sayon' ? 'text-blue-300/80' : 'text-phobos-amber/80'}`}>{spec.label}</span>
                                  {isSayonRec && <span className="text-[11px] text-phobos-green/60 flex items-center gap-0.5"><Cpu className="w-3 h-3" /> ★ SAYON</span>}
                                  {isSerenRec && <span className="text-[11px] text-phobos-green/60 flex items-center gap-0.5"><Zap className="w-3 h-3" /> ★ SEREN</span>}
                                  {isRunning && (
                                    <span className="text-[10px] font-terminal text-phobos-green/70 tracking-[0.1em] flex items-center gap-0.5">● {runningRole} ACTIVE</span>
                                  )}
                                  {MODEL_LICENSE_URLS[spec.modelId] && (
                                    <a href={MODEL_LICENSE_URLS[spec.modelId]} target="_blank" rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="text-[10px] text-muted-foreground/40 hover:text-phobos-green/60 transition-colors flex items-center gap-0.5">
                                      License <ExternalLink className="w-2.5 h-2.5" />
                                    </a>
                                  )}
                                </div>
                                {/* Row 2 — speed · dots · size · ctx */}
                                <div className="flex items-center gap-2 mt-0.5">
                                  <SpeedBadge speed={spec.speedClass} />
                                  <QualityDots quality={spec.role === 'sayon' ? (spec.sayonQuality ?? 0) : (spec.serenQuality ?? 0)} />
                                  <span className="text-[11px] text-foreground/60">{bytesLabel(spec.sizeBytes)}</span>
                                  <span className="text-[11px] text-foreground/50">{(spec.contextWindow / 1000).toFixed(0)}k ctx</span>
                                  {overBudget && <span className="text-[10px] text-red-400/60 font-terminal">EXCEEDS VRAM</span>}
                                </div>
                                {progKey && !progKey.done && !isInstalling && (
                                  <ProgressBar received={progKey.bytesReceived} total={displayTotal} label={spec.modelId} />
                                )}
                              </div>
                              <div className="shrink-0 flex items-center gap-1">
                                {isDownloaded ? (
                                  isRunning ? (
                                    <span title="In use — switch models before deleting" className="text-phobos-green/40 cursor-not-allowed"><Lock className="w-3.5 h-3.5" /></span>
                                  ) : (
                                    <>
                                      {/* Find uncensored version */}
                                      <div className="relative">
                                        <button type="button" disabled={isPulling}
                                          onClick={(e) => { e.stopPropagation(); setUncensoredOpen(uncensoredOpen === spec.modelId ? null : spec.modelId); }}
                                          title="Find uncensored version"
                                          className="text-muted-foreground/25 hover:text-phobos-amber/60 transition-colors cursor-pointer disabled:opacity-25">
                                          <Shuffle className="w-5 h-5" />
                                        </button>
                                        {uncensoredOpen === spec.modelId && (
                                          <UncensoredPopover
                                            modelId={spec.modelId}
                                            onClose={() => setUncensoredOpen(null)}
                                          />
                                        )}
                                      </div>
                                      <button type="button" disabled={isPulling}
                                        onClick={(e) => { e.stopPropagation(); handleDeleteModel(spec.modelId); }}
                                        onMouseEnter={() => setHoveredDelete(spec.modelId)}
                                        onMouseLeave={() => setHoveredDelete(null)}
                                        className="text-muted-foreground/30 hover:text-destructive/70 transition-colors cursor-pointer disabled:opacity-25">
                                        <Trash2 className="w-5 h-5" />
                                      </button>
                                    </>
                                  )
                                ) : progKey ? (
                                  progKey.done ? <Trash2 className="w-5 h-5 text-muted-foreground/20" />
                                    : <Loader2 className="w-3.5 h-3.5 text-phobos-green/40 animate-spin" />
                                ) : (
                                  <span className="flex items-center gap-1">
                                    <span className="text-[11px] text-foreground/45">{spec.ramRequiredGb} GB</span>
                                    {/* Locate button — lets user point to an existing file instead of downloading */}
                                    {modelsInfo?.overrides?.[`llm:${spec.modelId}`] ? (
                                      <button type="button"
                                        onClick={async (e) => { e.stopPropagation(); await clearOverride('llm', spec.modelId); refetchModels(); refetchModelsInfo(); }}
                                        className="text-[10px] text-phobos-amber/50 hover:text-destructive/70 transition-colors"
                                        title={`Linked: ${modelsInfo.overrides[`llm:${spec.modelId}`]}\nClick to clear link`}>
                                        ×
                                      </button>
                                    ) : (
                                      <button type="button"
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          const p = await openFileDialog('gguf');
                                          if (!p) return;
                                          const ok = await setOverride('llm', spec.modelId, p);
                                          if (ok) { refetchModels(); refetchModelsInfo(); }
                                        }}
                                        className="text-muted-foreground/25 hover:text-phobos-amber/60 transition-colors"
                                        title="Locate — point to an existing file on disk">
                                        <FolderSearch className="w-5 h-5" />
                                      </button>
                                    )}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* Legacy models */}
                {showLegacy && (
                  <div className="border-t border-border/15 pt-2 mt-1">
                    <div className="text-[11px] font-terminal text-phobos-amber/40 uppercase tracking-[0.12em] mb-2">Legacy Models</div>
                    {ALL_MODELS.filter(m => m.legacy).map(spec => {
                      const isDownloaded = downloadedIds.has(spec.modelId);
                      const isChecked    = checked.has(spec.modelId);
                      return (
                        <div key={spec.modelId}
                          onClick={() => !isDownloaded && !isPulling && toggleCheck(spec.modelId)}
                          className={`relative flex items-center gap-3 px-3 py-2 rounded border transition-colors select-none opacity-70 ${
                            isDownloaded ? 'border-phobos-green/12 bg-phobos-green/[0.025] cursor-default'
                            : isPulling  ? 'border-border/12 cursor-not-allowed opacity-40'
                            : isChecked  ? 'border-border/25 bg-accent/10 cursor-pointer'
                            : 'border-border/12 hover:border-border/20 cursor-pointer'
                          }`}>
                          <div className={`w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center transition-colors ${
                            isDownloaded ? 'border-phobos-green/40 bg-phobos-green/10' : isChecked ? 'border-phobos-green/40 bg-phobos-green/10' : 'border-border/30'
                          }`}>
                            {(isDownloaded || isChecked) && <div className="w-1.5 h-1.5 rounded-sm bg-phobos-green/60" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`text-[13px] ${spec.role === 'sayon' ? 'text-blue-300/55' : 'text-phobos-amber/55'}`}>{spec.label}</span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <SpeedBadge speed={spec.speedClass} />
                              <QualityDots quality={spec.role === 'sayon' ? (spec.sayonQuality ?? 0) : (spec.serenQuality ?? 0)} />
                              <span className="text-[11px] text-foreground/40">{bytesLabel(spec.sizeBytes)}</span>
                              <span className="text-[11px] text-foreground/35">{(spec.contextWindow / 1000).toFixed(0)}k ctx</span>
                            </div>
                          </div>
                          <div className="shrink-0">
                            {isDownloaded ? (
                              <button type="button" disabled={isPulling}
                                onClick={(e) => { e.stopPropagation(); handleDeleteModel(spec.modelId); }}
                                className="text-muted-foreground/30 hover:text-destructive/70 transition-colors cursor-pointer disabled:opacity-25">
                                <Trash2 className="w-5 h-5" />
                              </button>
                            ) : (
                              <span className="text-[11px] text-foreground/35">{spec.ramRequiredGb} GB RAM</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
            </div>
          </div>

          {/* ── Optional Models ── */}
          <div className="phobos-llm-panel flex-1 flex flex-col min-h-0 bg-card border border-phobos-green/25 rounded-sm shadow-[0_0_40px_hsl(120_100%_50%/0.08)] font-mono overflow-y-auto scrollbar-phobos">
            <div className="flex items-center justify-between px-5 py-3">
              <span className="text-xs font-terminal tracking-[0.2em] text-phobos-green/80 uppercase">OPTIONAL MODELS</span>
            </div>
            <div className="border-t border-border/20 scrollbar-phobos">
              <PhobosOptionalModelsPanel onClose={onClose} embedded />
            </div>
          </div>
        </div>{/* end right column */}
      </div>
    </div>

      {llmConfirmPending && (() => {
        const pendingSpecs = [...checked]
          .filter(id => !downloadedIds.has(id))
          .map(id => ALL_MODELS.find(m => m.modelId === id))
          .filter((s): s is GGUFSpec => !!s);
        const licenseFiles: DownloadFileSpec[] = pendingSpecs.map(s => ({
          id:         s.modelId,
          label:      s.label,
          license:    s.license,
          licenseUrl: s.licenseUrl,
        }));
        return (
          <DownloadConfirmDialog
            title="LLM MODEL DOWNLOAD"
            entries={buildLicenseEntries(licenseFiles)}
            onConfirm={handleDownloadConfirmed}
            onCancel={() => setLlmConfirmPending(false)}
          />
        );
      })()}

      {/* ── Auto-config confirmation dialog ── */}
      {autoPhase.kind === 'confirming' && (
        <AutoConfigConfirmDialog
          plan={autoPhase.plan}
          cleanupSelected={autoCleanupSelected}
          onToggleCleanup={(id) => {
            setAutoCleanupSelected(prev => {
              const next = new Set(prev);
              next.has(id) ? next.delete(id) : next.add(id);
              return next;
            });
          }}
          onConfirm={() => {
            executeAutoConfig(autoPhase.plan, [...autoCleanupSelected], hw?.gpus ?? []);
          }}
          onCancel={() => { resetAutoConfig(); setAutoCleanupSelected(new Set()); }}
        />
      )}

      {/* ── Auto-config progress overlay ── */}
      {(autoPhase.kind === 'cleanup' || autoPhase.kind === 'downloading-llm' || autoPhase.kind === 'downloading-image' || autoPhase.kind === 'starting' || autoPhase.kind === 'done' || autoPhase.kind === 'error') && (
        <AutoConfigProgressOverlay
          phase={autoPhase}
          onDone={() => {
            resetAutoConfig();
            setAutoCleanupSelected(new Set());
            refetchModels();
            refetchStatus();
            if (autoPhase.kind === 'done') {
              const plan = autoPhase.plan;
              const rec  = plan.recommendation;
              // Sync dropdowns to what auto-config actually launched
              setLaunchSayonModel(rec.sayon.modelId);
              setLaunchSerenModel(rec.seren.modelId);
              setSayonDeviceIdx(rec.sayonDevice);
              setSerenDeviceIdx(rec.serenDevice);
              // seededRef stays true — the explicit sets above are the sync.
              // Resetting it would let the next status poll overwrite selections
              // mid-restart when deviceIndex may be undefined or stale.
              updateConfig.mutateAsync({
                coordinator: { provider: 'phobos', model: rec.sayon.modelId },
                engine:      { provider: 'phobos', model: rec.seren.modelId },
              }).catch(() => {});
            }
          }}
          onCancel={cancelAutoConfig}
        />
      )}

      {/* ── Change folder dialog ── */}
      {showChangeFolderDialog && (
        <ChangeFolderDialog
          currentPath={modelsInfo?.path ?? ''}
          relocatePhase={relocatePhase}
          onConfirm={async (newPath, doMove) => {
            if (doMove) {
              await relocate(newPath);
            } else {
              await setBasePath(newPath, true);
              refetchModelsInfo();
              refetchModels();
              setShowChangeFolderDialog(false);
            }
          }}
          onDone={() => { resetRelocate(); setShowChangeFolderDialog(false); refetchModelsInfo(); refetchModels(); }}
          onAbort={abortRelocate}
          onCancel={() => { resetRelocate(); setShowChangeFolderDialog(false); }}
          openFolderDialog={openFolderDialog}
        />
      )}

      {/* ── Python install dialog ── */}
      {pythonInstallDialogOpen && createPortal(
        <PythonSetupDialog
          progress={pyAutoProgress}
          running={pyAutoInstalling}
          onInstall={pyStartAutoInstall}
          onRetry={() => { pyRetryDetection(); setPythonInstallDialogOpen(false); }}
          onClose={() => {
            if (!pyAutoInstalling) {
              if (pyAutoProgress?.phase === 'complete') pyRetryDetection();
              setPythonInstallDialogOpen(false);
            }
          }}
        />,
        document.body,
      )}
    </>
  );
}

// ── ChangeFolderDialog ────────────────────────────────────────────────────────

function ChangeFolderDialog({
  currentPath,
  relocatePhase,
  onConfirm,
  onDone,
  onAbort,
  onCancel,
  openFolderDialog,
}: {
  currentPath:    string;
  relocatePhase:  RelocatePhase;
  onConfirm:      (newPath: string, doMove: boolean) => Promise<void>;
  onDone:         () => void;
  onAbort:        () => Promise<void>;
  onCancel:       () => void;
  openFolderDialog: (initialPath?: string) => Promise<string | null>;
}) {
  const [inputPath, setInputPath]   = useState(currentPath);
  const [doMove,    setDoMove]      = useState(true);
  const [confirming, setConfirming] = useState(false);

  // Debounced scan — fires 400ms after user stops typing
  const [scanPath, setScanPath]     = useState('');
  const debounceRef                 = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePathChange = (v: string) => {
    setInputPath(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setScanPath(v.trim()), 400);
  };

  const { data: scanData, isLoading: scanning } = useScanFolder(scanPath);

  const isMoving = relocatePhase.kind === 'copying'
    || relocatePhase.kind === 'moving'
    || relocatePhase.kind === 'stopping-servers'
    || relocatePhase.kind === 'updating-config'
    || relocatePhase.kind === 'deleting-originals';

  const isDone  = relocatePhase.kind === 'done';
  const isError = relocatePhase.kind === 'error';

  // Progress bar pct during move
  const pct = (relocatePhase.kind === 'copying' || relocatePhase.kind === 'moving') && relocatePhase.fileCount > 0
    ? Math.round((relocatePhase.fileIndex / relocatePhase.fileCount) * 100)
    : 0;

  const phaseLabel: Record<string, string> = {
    'stopping-servers':   'Stopping servers…',
    'copying':            'Copying files…',
    'moving':             'Moving files…',
    'updating-config':    'Updating config…',
    'deleting-originals': 'Cleaning up originals…',
  };

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/60">
      <div className="bg-card border border-phobos-green/20 rounded-sm shadow-2xl w-[480px] font-mono p-5 space-y-4">

        <div className="flex items-center justify-between">
          <span className="text-sm font-terminal tracking-[0.15em] text-phobos-green/80 uppercase">Change Models Folder</span>
          {!isMoving && !isDone && (
            <button onClick={onCancel} className="text-muted-foreground/40 hover:text-foreground/60 transition-colors">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* ── Active move progress ── */}
        {(isMoving || isDone || isError || relocatePhase.kind === 'aborted') ? (
          <div className="space-y-3">
            {isMoving && (
              <>
                <div className="text-[10px] text-foreground/60">{phaseLabel[relocatePhase.kind] ?? 'Working…'}</div>
                {(relocatePhase.kind === 'copying' || relocatePhase.kind === 'moving') && (
                  <>
                    <div className="text-[11px] text-muted-foreground/40 truncate">
                      {relocatePhase.file ?? ''}
                    </div>
                    <div className="w-full h-1 bg-border/20 rounded-full overflow-hidden">
                      <div className="h-full bg-phobos-green/50 transition-all duration-200" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-[11px] text-muted-foreground/40">
                      {relocatePhase.fileIndex} / {relocatePhase.fileCount} files
                    </div>
                  </>
                )}
                <button onClick={onAbort}
                  className="text-[11px] font-terminal tracking-[0.1em] text-destructive/60 hover:text-destructive/80 border border-destructive/20 hover:border-destructive/40 px-3 py-1.5 rounded-sm transition-all">
                  ABORT
                </button>
              </>
            )}
            {isDone && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-[10px] text-phobos-green/70">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Move complete. {(relocatePhase as { matchCount: number }).matchCount} models linked.
                </div>
                <button onClick={onDone}
                  className="text-[11px] font-terminal tracking-[0.1em] text-phobos-green/70 border border-phobos-green/20 hover:border-phobos-green/40 px-3 py-1.5 rounded-sm transition-all">
                  CLOSE
                </button>
              </div>
            )}
            {isError && (
              <div className="space-y-2">
                <div className="text-[10px] text-destructive/70">
                  Error: {(relocatePhase as { message: string }).message}
                </div>
                <button onClick={onCancel}
                  className="text-[11px] font-terminal tracking-[0.1em] text-muted-foreground/50 border border-border/20 px-3 py-1.5 rounded-sm transition-all">
                  CLOSE
                </button>
              </div>
            )}
            {relocatePhase.kind === 'aborted' && (
              <div className="space-y-2">
                <div className="text-[10px] text-phobos-amber/60">Move aborted. Files already copied remain at destination.</div>
                <button onClick={onCancel}
                  className="text-[11px] font-terminal tracking-[0.1em] text-muted-foreground/50 border border-border/20 px-3 py-1.5 rounded-sm transition-all">
                  CLOSE
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* ── Path input ── */}
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground/50 uppercase tracking-[0.12em]">New folder path</label>
              <div className="flex gap-2">
                <input
                  value={inputPath}
                  onChange={(e) => handlePathChange(e.target.value)}
                  className="flex-1 bg-background border border-border/20 rounded-sm px-2.5 py-1.5 text-[11px] text-foreground/80 focus:outline-none focus:border-phobos-green/30"
                  placeholder="/path/to/models"
                />
                <button
                  onClick={async () => {
                    const p = await openFolderDialog(inputPath.trim() || currentPath);
                    if (p) handlePathChange(p);
                  }}
                  className="text-[11px] font-terminal tracking-[0.1em] text-muted-foreground/50 hover:text-phobos-green/70 border border-border/20 hover:border-phobos-green/20 px-2.5 py-1.5 rounded-sm transition-all shrink-0">
                  BROWSE
                </button>
              </div>
            </div>

            {/* ── Scan preview ── */}
            {scanPath && (
              <div className="text-[11px] text-muted-foreground/40">
                {scanning
                  ? 'Scanning…'
                  : scanData
                    ? `Found ${scanData.matches.length} of ${scanData.totalKnown} known models — will be linked automatically.`
                    : null}
              </div>
            )}

            {/* ── Move checkbox ── */}
            <label className="flex items-start gap-2.5 cursor-pointer group">
              <div
                onClick={() => setDoMove(!doMove)}
                className={`mt-0.5 w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${
                  doMove ? 'border-phobos-amber/80 bg-phobos-amber/15' : 'border-foreground/30 bg-transparent hover:border-foreground/50'
                }`}>
                {doMove && <div className="w-2 h-2 rounded-sm bg-phobos-amber/90" />}
              </div>
              <div className="space-y-0.5">
                <div className="text-[10px] text-foreground/70 group-hover:text-foreground/90 transition-colors">Move files to new folder</div>
                <div className="text-[11px] text-muted-foreground/40">
                  {doMove
                    ? 'Files will be copied then originals deleted. Servers stop during move.'
                    : 'Without this, only the path config changes. Files stay where they are.'}
                </div>
              </div>
            </label>

            {/* ── Action buttons ── */}
            <div className="flex gap-2 pt-1">
              <button
                disabled={!inputPath.trim() || inputPath.trim() === currentPath || confirming}
                onClick={async () => {
                  setConfirming(true);
                  await onConfirm(inputPath.trim(), doMove);
                  if (!doMove) setConfirming(false);
                }}
                className="text-[10px] font-terminal tracking-[0.1em] text-phobos-green font-bold border border-phobos-green/40 hover:border-phobos-green/70 hover:bg-phobos-green/10 px-3 py-1.5 rounded-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                {confirming ? 'APPLYING…' : doMove ? 'MOVE & APPLY' : 'APPLY'}
              </button>
              <button onClick={onCancel}
                className="text-[11px] font-terminal tracking-[0.1em] text-muted-foreground/40 hover:text-muted-foreground/60 border border-border/15 hover:border-border/30 px-3 py-1.5 rounded-sm transition-all">
                CANCEL
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── PythonSetupDialog ─────────────────────────────────────────────────────────

interface PythonSetupDialogProps {
  progress: { phase: string; label: string; done: boolean; error?: string } | null;
  running: boolean;
  onInstall: () => void;
  onRetry: () => void;
  onClose: () => void;
}

function PythonSetupDialog({ progress, running, onInstall, onRetry, onClose }: PythonSetupDialogProps) {
  const isWindows = navigator.userAgent.toLowerCase().includes('win');
  const isDone    = progress?.phase === 'complete';
  const isError   = progress?.phase === 'error';

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-lg shadow-xl w-[480px] max-w-[95vw] p-5 flex flex-col gap-4">

        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-terminal text-foreground">Python 3.12 Required</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              PHOBOS needs Python 3.12 to create the PyTorch environment for image generation.
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={running}
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Why 3.12 specifically */}
        <div className="bg-accent/30 border border-border/40 rounded px-3 py-2 text-[11px] font-mono text-muted-foreground leading-relaxed">
          Python 3.12 is the only version with AMD ROCm Windows wheels.
          Python 3.11 and 3.13 will not work for AMD GPU support.
        </div>

        {/* Progress area — shown once install starts */}
        {progress && (
          <div className="bg-accent/20 border border-border/30 rounded px-3 py-2.5">
            <div className="flex items-start gap-2">
              {running  && <Loader2 className="w-3.5 h-3.5 animate-spin text-phobos-amber flex-shrink-0 mt-0.5" />}
              {isDone   && <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0 inline-block mt-1" />}
              {isError  && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0 inline-block mt-1" />}
              <span className={`text-[11px] font-mono leading-snug ${isError ? 'text-red-400' : isDone ? 'text-emerald-400' : 'text-phobos-amber'}`}>
                {progress.label}
              </span>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2">

          {/* Automated install — Windows only, hidden after success */}
          {isWindows && !isDone && (
            <button
              onClick={onInstall}
              disabled={running}
              className="flex items-center justify-center gap-2 bg-phobos-amber/90 hover:bg-phobos-amber text-black text-xs font-terminal px-4 py-2 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {running
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Installing…</>
                : 'Install Python 3.12 automatically'}
            </button>
          )}

          {/* Manual download link */}
          {!isDone && (
            <button
              onClick={() => window.open('https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe', '_blank')}
              className="flex items-center justify-center gap-1.5 border border-border/50 hover:border-border text-xs font-mono text-muted-foreground hover:text-foreground px-4 py-2 rounded transition-colors"
            >
              Download installer manually ↗
            </button>
          )}

          {/* PATH reminder */}
          {!running && !isDone && (
            <p className="text-[10px] font-mono text-muted-foreground/60 text-center leading-snug">
              If installing manually: check{' '}
              <span className="text-foreground/70">"Add Python to PATH"</span>{' '}
              during the install wizard.
            </p>
          )}

          {/* Already installed — retry detection */}
          {!running && !isDone && (
            <button
              onClick={onRetry}
              className="text-[10px] font-mono text-muted-foreground/50 hover:text-muted-foreground underline decoration-dotted underline-offset-2 text-center transition-colors"
            >
              I already installed it — re-check now
            </button>
          )}

          {/* Done — close */}
          {isDone && (
            <button
              onClick={onClose}
              className="flex items-center justify-center gap-2 bg-emerald-600/80 hover:bg-emerald-600 text-white text-xs font-terminal px-4 py-2 rounded transition-colors"
            >
              Python ready — close
            </button>
          )}

        </div>
      </div>
    </div>
  );
}

// ── Auto-config confirmation dialog ──────────────────────────────────────────

function AutoConfigConfirmDialog({
  plan,
  cleanupSelected,
  onToggleCleanup,
  onConfirm,
  onCancel,
}: {
  plan: AutoConfigPlan;
  cleanupSelected: Set<string>;
  onToggleCleanup: (id: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const rec = plan.recommendation;
  const totalDownloadBytes = [
    ...plan.llmNeeded.map(id => {
      const m = rec.sayon.modelId === id ? rec.sayon : rec.seren;
      return m.sizeBytes;
    }),
  ].reduce((a, b) => a + b, 0);
  const totalCleanupBytes = plan.cleanupCandidates
    .filter(c => cleanupSelected.has(c.modelId))
    .reduce((a, c) => a + c.sizeBytes, 0);

  return (
    <div className="fixed inset-0 z-[300] bg-black/85 flex items-center justify-center" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-[460px] max-h-[80vh] overflow-y-auto scrollbar-phobos bg-card border border-phobos-amber/30 rounded-sm shadow-[0_0_40px_hsl(40_100%_50%/0.1)] p-5 space-y-4 font-mono">
        <div className="text-xs font-terminal tracking-[0.2em] text-phobos-amber/80 uppercase">AUTO-CONFIG PLAN</div>

        {/* Recommended config */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-terminal text-foreground/40 uppercase tracking-wider">Recommended Config</div>
          <div className="flex items-center gap-2 text-[10px]">
            <img src="/sayon.png" alt="SAYON" className="w-4 h-4 rounded-sm opacity-70" />
            <span className="text-sayon font-terminal tracking-wider">SAYON</span>
            <span className="text-foreground/70">{rec.sayon.label}</span>
            {plan.llmNeeded.includes(rec.sayon.modelId) && <span className="text-[10px] text-phobos-amber/60">↓ download</span>}
          </div>
          <div className="flex items-center gap-2 text-[10px]">
            <img src="/seren.png" alt="SEREN" className="w-4 h-4 rounded-sm opacity-70" />
            <span className="text-seren font-terminal tracking-wider">SEREN</span>
            <span className="text-foreground/70">{rec.seren.label}</span>
            {plan.llmNeeded.includes(rec.seren.modelId) && <span className="text-[10px] text-phobos-amber/60">↓ download</span>}
          </div>
        </div>

        {/* Optional models */}
        {(plan.imageModel || plan.videoModel) && (
          <div className="space-y-1.5">
            <div className="text-[11px] font-terminal text-foreground/40 uppercase tracking-wider">Optional Models</div>
            {plan.imageModel && (
              <div className="flex items-center gap-2 text-[10px]">
                <Image className="w-3.5 h-3.5 text-foreground/40" />
                <span className="text-foreground/70">{plan.imageModel.displayName}</span>
                <span className="text-[11px] text-foreground/40">{bytesLabel(plan.imageModel.sizeBytes)}</span>
                {plan.imageNeeded.includes(plan.imageModel.modelId) ? <span className="text-[10px] text-phobos-amber/60">↓ download</span> : <span className="text-[10px] text-phobos-green/50">ready</span>}
              </div>
            )}
            {plan.videoModel && (
              <div className="flex items-center gap-2 text-[10px]">
                <Film className="w-3.5 h-3.5 text-foreground/40" />
                <span className="text-foreground/70">{plan.videoModel.displayName}</span>
                <span className="text-[11px] text-foreground/40">{bytesLabel(plan.videoModel.sizeBytes)}</span>
                {plan.imageNeeded.includes(plan.videoModel.modelId) ? <span className="text-[10px] text-phobos-amber/60">↓ download</span> : <span className="text-[10px] text-phobos-green/50">ready</span>}
              </div>
            )}
          </div>
        )}

        {/* Cleanup candidates */}
        {plan.cleanupCandidates.length > 0 && (
          <div className="space-y-1.5 border-t border-border/20 pt-3">
            <div className="text-[11px] font-terminal text-foreground/40 uppercase tracking-wider">Remove Unused LLM Models</div>
            <p className="text-[11px] text-foreground/35">These downloaded LLM models are not in the recommended config. Select any to remove.</p>
            {plan.cleanupCandidates.map(c => (
              <label key={c.modelId} className="flex items-center gap-2 text-[10px] cursor-pointer group">
                <div className={`w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center transition-colors ${
                  cleanupSelected.has(c.modelId) ? 'border-red-400/50 bg-red-400/10' : 'border-border/30 group-hover:border-border/50'
                }`}>
                  {cleanupSelected.has(c.modelId) && <div className="w-1.5 h-1.5 rounded-sm bg-red-400/60" />}
                </div>
                <input type="checkbox" className="sr-only" checked={cleanupSelected.has(c.modelId)} onChange={() => onToggleCleanup(c.modelId)} />
                <span className="text-foreground/60">{c.label}</span>
                <span className="text-[11px] text-foreground/35">{bytesLabel(c.sizeBytes)}</span>
              </label>
            ))}
            {totalCleanupBytes > 0 && (
              <div className="text-[11px] text-red-400/50">Frees {bytesLabel(totalCleanupBytes)}</div>
            )}
          </div>
        )}

        {/* Summary + actions */}
        <div className="flex items-center justify-between pt-2 border-t border-border/20">
          <div className="text-[11px] text-foreground/40">
            {totalDownloadBytes > 0 ? `Download: ~${bytesLabel(totalDownloadBytes)}` : 'All models ready'}
          </div>
          <div className="flex gap-2">
            <button onClick={onCancel}
              className="px-3 py-1.5 rounded-sm border border-border/25 text-foreground/50 hover:text-foreground/75 text-[10px] uppercase tracking-wider">
              Cancel
            </button>
            <button onClick={onConfirm}
              className="px-4 py-1.5 rounded-sm border border-phobos-amber/40 bg-phobos-amber/10 text-phobos-amber hover:bg-phobos-amber/20 text-[10px] font-terminal uppercase tracking-wider">
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Auto-config progress overlay ─────────────────────────────────────────────

function AutoConfigProgressOverlay({
  phase,
  onDone,
  onCancel,
}: {
  phase: AutoConfigPhase;
  onDone: () => void;
  onCancel: () => void;
}) {
  let statusLabel = '';
  let statusDetail = '';
  let showCancel = false;
  let showDone = false;
  let isError = false;
  let progressPct: number | null = null;

  switch (phase.kind) {
    case 'cleanup':
      statusLabel = 'CLEANING UP';
      statusDetail = 'Removing unused models…';
      break;
    case 'downloading-llm':
      statusLabel = 'DOWNLOADING LLM';
      statusDetail = phase.progress?.modelId ?? 'Starting…';
      showCancel = true;
      if (phase.progress && phase.progress.bytesTotal > 0) {
        progressPct = Math.min(100, Math.round((phase.progress.bytesReceived / phase.progress.bytesTotal) * 100));
      }
      break;
    case 'downloading-image': {
      statusLabel = 'DOWNLOADING';
      const label = phase.progress?.label ?? phase.modelId;
      statusDetail = label;
      showCancel = true;
      if (phase.progress && phase.progress.bytesTotal > 0) {
        progressPct = Math.min(100, Math.round((phase.progress.bytesReceived / phase.progress.bytesTotal) * 100));
      }
      break;
    }
    case 'starting':
      statusLabel = 'LAUNCHING SERVERS';
      statusDetail = 'Starting SAYON + SEREN…';
      break;
    case 'done':
      statusLabel = 'AUTO-CONFIG COMPLETE';
      statusDetail = 'PHOBOS is online with the optimal configuration.';
      showDone = true;
      break;
    case 'error':
      statusLabel = 'ERROR';
      statusDetail = phase.message;
      isError = true;
      showDone = true;
      break;
  }

  return (
    <div className="fixed inset-0 z-[300] bg-black/85 flex items-center justify-center">
      <div className="w-[400px] bg-card border border-phobos-green/25 rounded-sm shadow-[0_0_40px_hsl(120_100%_50%/0.08)] p-5 space-y-4 font-mono">
        <div className={`text-xs font-terminal tracking-[0.2em] uppercase ${isError ? 'text-destructive/80' : 'text-phobos-green/80'}`}>
          {statusLabel}
        </div>

        <div className={`text-[10px] ${isError ? 'text-destructive/60' : 'text-foreground/60'}`}>
          {statusDetail}
        </div>

        {progressPct !== null && (
          <div className="space-y-1">
            <div className="w-full h-1.5 bg-border/20 rounded-full overflow-hidden">
              <div className="h-full bg-phobos-green/50 rounded-full transition-all duration-300" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="text-[10px] text-foreground/35 text-right">{progressPct}%</div>
          </div>
        )}

        {!showDone && !showCancel && (
          <div className="flex items-center gap-2 text-[10px] text-foreground/40">
            <Loader2 className="w-3 h-3 animate-spin text-phobos-green/50" />
            Please wait…
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {showCancel && (
            <button onClick={onCancel}
              className="px-3 py-1.5 rounded-sm border border-border/25 text-foreground/50 hover:text-destructive hover:border-destructive/30 text-[10px] uppercase tracking-wider transition-all">
              Cancel
            </button>
          )}
          {showDone && (
            <button onClick={onDone}
              className={`px-4 py-1.5 rounded-sm border text-[10px] font-terminal uppercase tracking-wider ${
                isError ? 'border-destructive/40 text-destructive/80 hover:bg-destructive/10' : 'border-phobos-green/40 text-phobos-green/80 hover:bg-phobos-green/10'
              }`}>
              {isError ? 'Dismiss' : 'Done'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Shared formatting helpers ─────────────────────────────────────────────────

function fmt(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function pct(received: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, (received / total) * 100);
}

// ── PhobosOptionalModelsPanel ─────────────────────────────────────────────────
// Second panel — same dimensions as the LLM panel. Hosts optional capability
// sections (image models, future: voice, embeddings, etc.) as named tabs.

type OptionalTab = 'image' | 'video' | 'audio';

const OPTIONAL_TABS: { id: OptionalTab; label: string; icon: React.ReactNode }[] = [
  { id: 'image', label: 'IMAGE MODELS', icon: <Image className="w-3 h-3" /> },
  { id: 'video', label: 'VIDEO MODELS', icon: <Film className="w-3 h-3" /> },
  { id: 'audio', label: 'AUDIO MODELS', icon: <Music className="w-3 h-3" /> },
];

function PhobosOptionalModelsPanel({ onClose, embedded }: { onClose: () => void; embedded?: boolean }) {
  const [activeTab, setActiveTab] = useState<OptionalTab>('image');
  const [checked, setChecked]     = useState<Set<string>>(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const { data, isLoading, refetch }  = useImageCatalogue();
  const { stage, startFluxDownloadQueue, cancelFluxDownload, resetFluxDownload } = useFluxDownload();
  const { stage: convertStage, startConvert, cancelConvert, resetConvert } = useImageConvert();
  const { data: modelsInfo, refetch: refetchModelsInfo } = useModelsInfo();
  const { setOverride } = useSetModelOverride();
  const { clearOverride } = useClearModelOverride();
  const { openDialog: openFileDialog } = useOpenFileDialog();

  // Audio download — independent, runs in parallel with LLM and image downloads
  const {
    stage: audioStage,
    startDownloadQueue: startAudioDownloadQueue,
    cancelDownload: cancelAudioDownload,
    resetDownload: resetAudioDownload,
  } = useAudioDownload();

  const overrides = modelsInfo?.overrides ?? {};

  const handleLocateImageModel = async (modelId: string) => {
    const p = await openFileDialog('any');
    if (!p) return;
    const ok = await setOverride('img', modelId, p);
    if (ok) { refetch(); refetchModelsInfo(); }
  };

  const handleClearImageModelOverride = async (modelId: string) => {
    await clearOverride('img', modelId);
    refetch();
    refetchModelsInfo();
  };

  const isDownloading = stage.kind === 'downloading';
  const allModels = data?.models ?? [];

  // Auto-reset done conversion and refresh catalogue
  useEffect(() => {
    if (convertStage.kind !== 'done') return;
    const t = setTimeout(() => { resetConvert(); refetch(); }, 2000);
    return () => clearTimeout(t);
  }, [convertStage.kind, resetConvert, refetch]);

  // Auto-reset done state and refresh catalogue
  useEffect(() => {
    if (stage.kind !== 'done') return;
    const t = setTimeout(() => { resetFluxDownload(); refetch(); setChecked(new Set()); }, 2000);
    return () => clearTimeout(t);
  }, [stage.kind, resetFluxDownload, refetch]);

  useEffect(() => {
    if (stage.kind === 'error') refetch();
  }, [stage.kind, refetch]);

  // Toggle a model in the checked set
  const toggleCheck = useCallback((modelId: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }, []);

  // Compute download totals from checked models that aren't already downloaded
  const checkedToDownload = [...checked].filter(id => {
    const m = allModels.find(x => x.modelId === id);
    return m && !m.downloaded;
  });
  const totalDownloadBytes = checkedToDownload.reduce((sum, id) => {
    const m = allModels.find(x => x.modelId === id);
    return sum + (m?.totalDownloadBytes ?? 0);
  }, 0);

  const handleStartDownload = () => {
    if (checkedToDownload.length === 0) return;
    setShowConfirm(false);
    startFluxDownloadQueue(checkedToDownload);
  };

  // Build confirm file list from all checked models
  const confirmFiles = checkedToDownload.flatMap(id => {
    const m = allModels.find(x => x.modelId === id);
    if (!m) return [];
    return [
      { id: m.modelId, label: `${m.displayName} (main)`, license: m.license, licenseUrl: m.licenseUrl },
      ...m.auxFiles.filter(f => !f.downloaded).map(f => ({ id: f.id, label: f.label, license: f.license, licenseUrl: f.licenseUrl })),
    ];
  });
  // Deduplicate aux files (shared across models — e.g. FLUX VAE, ESRGAN)
  const uniqueConfirmFiles = [...new Map(confirmFiles.map(f => [f.id, f])).values()];

  const isConverting  = convertStage.kind === 'converting';
  const panelLocked = isDownloading || isConverting;

  const content = (
    <>
      {/* Tab strip */}
      <div className="flex items-center gap-0 border-b border-border/25 shrink-0 px-5">
        {OPTIONAL_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-terminal tracking-[0.15em] uppercase border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-phobos-green/60 text-phobos-green/80'
                : 'border-transparent text-muted-foreground/40 hover:text-foreground/60'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Image/Video download bar — shows when models are checked or downloading ── */}
      {(checkedToDownload.length > 0 || isDownloading || stage.kind === 'done' || stage.kind === 'error') && (
        <div className="flex items-center gap-3 px-5 py-2.5 border-b border-border/25 shrink-0 bg-accent/5">
          {isDownloading && stage.kind === 'downloading' ? (
            <>
              <div className="flex-1 space-y-1">
                <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground/50">
                  <span className="truncate max-w-[260px]">{stage.current?.label ?? 'Starting…'}</span>
                  <span>{stage.current ? `${pct(stage.current.bytesReceived, stage.current.bytesTotal).toFixed(0)}%` : ''}</span>
                </div>
                <div className="h-0.5 bg-border/20 rounded-full overflow-hidden">
                  <div className="h-full bg-phobos-green/50 transition-all duration-200"
                    style={{ width: `${stage.current ? pct(stage.current.bytesReceived, stage.current.bytesTotal) : 0}%` }} />
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/30">
                  {stage.current ? `${fmt(stage.current.bytesReceived)} / ${fmt(stage.current.bytesTotal)}` : ''}
                </div>
              </div>
              <button onClick={cancelFluxDownload}
                className="text-[11px] font-terminal tracking-[0.1em] uppercase text-muted-foreground/50 hover:text-destructive/70 border border-border/20 hover:border-destructive/30 px-2 py-1 rounded-sm transition-all shrink-0">
                Cancel
              </button>
            </>
          ) : stage.kind === 'done' ? (
            <div className="flex items-center gap-2 text-[10px] font-terminal tracking-[0.15em] text-phobos-green/60">
              <CheckCircle2 className="w-3.5 h-3.5" />
              All downloads complete
            </div>
          ) : stage.kind === 'error' ? (
            <div className="flex items-center gap-2 flex-1">
              <AlertTriangle className="w-3 h-3 text-destructive/60 shrink-0" />
              <span className="text-[11px] font-mono text-destructive/60 truncate">{stage.message}</span>
              <button onClick={resetFluxDownload}
                className="text-[11px] text-muted-foreground/50 hover:text-foreground shrink-0 ml-auto">Dismiss</button>
            </div>
          ) : (
            <>
              <span className="text-[11px] font-mono text-muted-foreground/50 flex-1">
                {checkedToDownload.length} model{checkedToDownload.length !== 1 ? 's' : ''} selected · {fmt(totalDownloadBytes)}
              </span>
              <button
                onClick={() => setShowConfirm(true)}
                className="flex items-center gap-1.5 text-[10px] font-terminal tracking-[0.15em] uppercase text-phobos-green/70 hover:text-phobos-green border border-phobos-green/20 hover:border-phobos-green/40 px-3 py-1.5 rounded-sm transition-all shrink-0"
              >
                <Download className="w-3 h-3" />
                Download · {fmt(totalDownloadBytes)}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Audio download bar — always visible when active or checked ───── */}
      {(audioStage.kind !== 'idle') && (
        <div className="flex items-center gap-3 px-5 py-2 border-b border-border/20 shrink-0 bg-accent/[0.03]">
          <Music className="w-3 h-3 text-muted-foreground/30 shrink-0" />
          {audioStage.kind === 'downloading' ? (
            <>
              <div className="flex-1 space-y-0.5">
                <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground/40">
                  <span className="truncate">{audioStage.modelId}</span>
                  <span>{audioStage.pct.toFixed(0)}%</span>
                </div>
                <div className="h-0.5 bg-border/20 rounded-full overflow-hidden">
                  <div className="h-full bg-phobos-green/40 transition-all duration-200"
                    style={{ width: `${audioStage.pct}%` }} />
                </div>
              </div>
              <button onClick={cancelAudioDownload}
                className="text-[9px] text-muted-foreground/40 hover:text-destructive/60 uppercase tracking-[0.1em] shrink-0 transition-colors">
                Cancel
              </button>
            </>
          ) : audioStage.kind === 'done' ? (
            <span className="text-[10px] font-terminal tracking-[0.12em] text-phobos-green/50">
              Audio model ready
            </span>
          ) : audioStage.kind === 'error' ? (
            <div className="flex items-center gap-2 flex-1">
              <span className="text-[10px] font-mono text-destructive/50 truncate">{audioStage.message}</span>
              <button onClick={resetAudioDownload}
                className="text-[9px] text-muted-foreground/40 hover:text-foreground ml-auto shrink-0">Dismiss</button>
            </div>
          ) : null}
        </div>
      )}

      {/* Tab content */}
      <div className="overflow-y-auto flex-1 scrollbar-phobos">
        {activeTab === 'image' && (
          <ImageModelsSection
            data={data} isLoading={isLoading} refetch={refetch}
            checked={checked} toggleCheck={toggleCheck}
            stage={stage} anyDownloading={isDownloading}
            cancelFluxDownload={cancelFluxDownload} resetFluxDownload={resetFluxDownload}
            overrides={overrides}
            onLocateModel={handleLocateImageModel}
            onClearModelOverride={handleClearImageModelOverride}
            convertStage={convertStage}
            onStartConvert={startConvert}
            onCancelConvert={cancelConvert}
            onResetConvert={resetConvert}
          />
        )}
        {activeTab === 'video' && (
          <VideoModelsSection
            data={data} isLoading={isLoading} refetch={refetch}
            checked={checked} toggleCheck={toggleCheck}
            stage={stage} anyDownloading={isDownloading}
            cancelFluxDownload={cancelFluxDownload} resetFluxDownload={resetFluxDownload}
            overrides={overrides}
            onLocateModel={handleLocateImageModel}
            onClearModelOverride={handleClearImageModelOverride}
          />
        )}
        {activeTab === 'audio' && (
          <AudioModelsSection
            audioStage={audioStage}
            onStartDownload={startAudioDownloadQueue}
          />
        )}
      </div>

      {/* Confirm dialog — unified license-grouped component */}
      {showConfirm && uniqueConfirmFiles.length > 0 && (
        <DownloadConfirmDialog
          title="OPTIONAL MODEL DOWNLOAD"
          entries={buildLicenseEntries(uniqueConfirmFiles)}
          onConfirm={handleStartDownload}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </>
  );

  // When embedded inside the collapsible panel, skip the outer shell
  if (embedded) return content;

  return (
    <div className="relative w-[500px] max-h-[92vh] flex flex-col bg-card border border-phobos-green/25 rounded-sm shadow-[0_0_40px_hsl(120_100%_50%/0.08)] font-mono">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/40 shrink-0">
        <span className="text-xs font-terminal tracking-[0.2em] text-phobos-green/80 uppercase">OPTIONAL MODELS</span>
        <button onClick={onClose} disabled={panelLocked} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
          title={panelLocked ? 'Download in progress — cannot close' : 'Close'}>
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {content}
    </div>
  );
}

// ── Category config ──────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  'realistic':      'REALISTIC',
  'anime':          'ANIME',
  'kontext':        'EDITING',
  'legacy':         'LEGACY',
  'nsfw-artistic':  'NSFW · ARTISTIC',
  'nsfw-realistic': 'NSFW · REALISTIC',
  'nsfw-anime':     'NSFW · ANIME',
  'civitai':        'NSFW · CIVITAI',
};

const CATEGORY_ORDER = ['realistic', 'anime', 'kontext', 'nsfw-artistic', 'nsfw-realistic', 'nsfw-anime', 'civitai', 'legacy'];

// ── CivitaiTokenSection ──────────────────────────────────────────────────────
// Inline section for entering/clearing the CivitAI API token.
// Shows inside the image models panel when NSFW is unlocked.

function CivitaiTokenSection() {
  const [token, setToken]     = useState('');
  const [saved, setSaved]     = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load current token state on mount
  useEffect(() => {
    fetch(`${ENGINE_URL}/api/phobos/civitai-token`)
      .then(r => r.json())
      .then(d => { setHasToken(!!d.hasToken); setToken(''); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const saveToken = async () => {
    if (!token.trim()) return;
    try {
      await fetch(`${ENGINE_URL}/api/phobos/civitai-token`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      setHasToken(true);
      setToken('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* silent */ }
  };

  const clearToken = async () => {
    try {
      await fetch(`${ENGINE_URL}/api/phobos/civitai-token`, { method: 'DELETE' });
      setHasToken(false);
      setToken('');
    } catch { /* silent */ }
  };

  if (loading) return null;

  return (
    <div className="flex flex-col gap-2 px-3 py-3 border border-phobos-amber/20 rounded bg-phobos-amber/[0.03]">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-terminal tracking-[0.15em] text-phobos-amber/70 uppercase">CIVITAI API TOKEN</span>
        {hasToken && (
          <span className="text-[11px] font-mono text-phobos-green/60">● saved</span>
        )}
      </div>
      <div className="text-[11px] font-mono text-foreground/40 leading-relaxed">
        Required to download CivitAI-exclusive models below. Get your token from{' '}
        <span className="text-foreground/60">civitai.com → Account Settings → API Keys</span>.
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveToken(); }}
          placeholder={hasToken ? '••••••••••••••••' : 'Paste your CivitAI API key'}
          className="flex-1 text-[10px] font-mono bg-background border border-border/40 rounded px-2 py-1.5 text-foreground/80 placeholder:text-muted-foreground/30 focus:border-phobos-amber/40 focus:outline-none"
        />
        <button
          onClick={saveToken}
          disabled={!token.trim()}
          className="text-[11px] font-terminal tracking-[0.1em] text-foreground/50 hover:text-phobos-green/70 border border-border/30 hover:border-phobos-green/30 px-2.5 py-1 rounded-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
        >
          {saved ? '✓ SAVED' : 'SAVE'}
        </button>
        {hasToken && (
          <button
            onClick={clearToken}
            className="text-[11px] font-terminal tracking-[0.1em] text-foreground/30 hover:text-destructive/60 border border-border/20 hover:border-destructive/30 px-2.5 py-1 rounded-sm transition-all shrink-0"
          >
            CLEAR
          </button>
        )}
      </div>
    </div>
  );
}

// ── ImageModelsSection ────────────────────────────────────────────────────────
// Renders all image models grouped by category. Each card has its own
// download lifecycle. The confirm dialog is shared (one at a time).

interface SectionProps {
  data: ReturnType<typeof useImageCatalogue>['data'];
  isLoading: boolean;
  refetch: () => void;
  checked: Set<string>;
  toggleCheck: (modelId: string) => void;
  stage: ReturnType<typeof useFluxDownload>['stage'];
  anyDownloading: boolean;
  cancelFluxDownload: () => void;
  resetFluxDownload: () => void;
  overrides: Record<string, string>;
  onLocateModel: (modelId: string) => Promise<void>;
  onClearModelOverride: (modelId: string) => Promise<void>;
  // Convert props — only wired for image tab, not video tab
  convertStage?: ConvertStage;
  onStartConvert?: (modelId: string) => void;
  onCancelConvert?: () => void;
  onResetConvert?: () => void;
}

function ImageModelsSection({ data, isLoading, refetch, checked, toggleCheck, stage, anyDownloading, cancelFluxDownload, resetFluxDownload, overrides, onLocateModel, onClearModelOverride, convertStage = { kind: 'idle' }, onStartConvert, onCancelConvert = () => {}, onResetConvert = () => {} }: SectionProps) {
  const [nsfwUnlocked, setNsfwUnlocked] = useState(false);
  const [showLegacy, setShowLegacy]     = useState(false);


  const hw      = data?.hardware;
  const models  = (data?.models ?? []).filter(m => m.category !== 'video');
  const activeDownloadId = stage.kind === 'downloading' ? stage.modelId : null;

  // Group by category
  const grouped = new Map<string, typeof models>();
  for (const cat of CATEGORY_ORDER) grouped.set(cat, []);
  for (const m of models) {
    grouped.get(m.category)?.push(m);
  }

  if (isLoading) {
    return (
      <div className="px-5 py-4 text-[10px] font-mono text-muted-foreground/40 animate-pulse">
        Detecting hardware…
      </div>
    );
  }

  return (
    <div className="flex flex-col px-5 py-4 space-y-5">

      {/* SD hint */}
      <div className="flex items-center gap-3 px-3 py-2.5 border border-border/15 rounded bg-black/20 text-[11px] font-mono text-muted-foreground/40">
        Image models for Stable Diffusion — please convert to use PyTorch
      </div>

      {/* NSFW unlock banner */}
      {!nsfwUnlocked && (
        <div className="flex items-center gap-3 px-3 py-2.5 border border-border/20 rounded text-[11px] font-mono text-muted-foreground/40">
          <span className="flex-1">NSFW models are hidden. These are uncensored image generation models intended for adults.</span>
          <button
            onClick={() => setNsfwUnlocked(true)}
            className="text-[11px] font-terminal tracking-[0.1em] text-muted-foreground/40 hover:text-phobos-green/60 border border-border/20 hover:border-phobos-green/20 px-2 py-1 rounded-sm transition-all shrink-0"
          >
            SHOW
          </button>
        </div>
      )}

      {/* Category groups */}
      {CATEGORY_ORDER.map(cat => {
        const group = grouped.get(cat) ?? [];
        if (group.length === 0) return null;
        const isNsfw   = cat.startsWith('nsfw') || cat === 'civitai';
        const isLegacy = cat === 'legacy';
        const isCivitai = cat === 'civitai';
        if (isNsfw   && !nsfwUnlocked) return null;

        return (
          <div key={cat} className="space-y-3">
            <div className="flex items-center gap-2">
              <div className={`text-[11px] font-terminal tracking-[0.15em] uppercase ${
                isNsfw ? 'text-phobos-amber/60' : 'text-foreground/50'
              }`}>
                {CATEGORY_LABELS[cat]}
              </div>
              {isLegacy && (
                <button
                  onClick={() => setShowLegacy(!showLegacy)}
                  className="text-[11px] font-terminal tracking-[0.1em] text-muted-foreground/40 hover:text-phobos-amber/50 border border-border/20 hover:border-phobos-amber/20 px-1.5 py-0.5 rounded-sm transition-all"
                >
                  {showLegacy ? 'HIDE' : 'SHOW'}
                </button>
              )}
            </div>
            {/* CivitAI category: show token input above model cards */}
            {isCivitai && <CivitaiTokenSection />}
            {(!isLegacy || showLegacy) && group.map(model => (
              <ImageModelCard
                key={model.modelId}
                model={model}
                hw={hw ?? null}
                stage={stage}
                isActiveDownload={activeDownloadId === model.modelId}
                anyDownloading={anyDownloading}
                checked={checked.has(model.modelId)}
                onToggleCheck={() => toggleCheck(model.modelId)}
                onCancel={cancelFluxDownload}
                onDelete={async () => { await deleteFluxModel(model.modelId); refetch(); }}
                onReset={resetFluxDownload}
                overridePath={overrides[`img:${model.modelId}`]}
                onLocate={() => onLocateModel(model.modelId)}
                onClearOverride={() => onClearModelOverride(model.modelId)}
                convertStage={convertStage}
                onStartConvert={onStartConvert}
                onCancelConvert={onCancelConvert}
                onResetConvert={onResetConvert}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── ImageModelCard ────────────────────────────────────────────────────────────

interface ImageModelCardProps {
  model: NonNullable<ReturnType<typeof useImageCatalogue>['data']>['models'][number];
  hw: { totalVramGb: number; backend: string; gpuName: string } | null;
  stage: ReturnType<typeof useFluxDownload>['stage'];
  isActiveDownload: boolean;
  anyDownloading: boolean;
  checked: boolean;
  onToggleCheck: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onReset: () => void;
  /** Absolute path if user has manually linked this model */
  overridePath?: string;
  /** Called when user clicks the locate (folder) button */
  onLocate: () => Promise<void>;
  /** Called when user clicks × to clear a manual link */
  onClearOverride: () => Promise<void>;
  // Convert props — only relevant for SDXL. Optional so VideoModelsSection
  // can render ImageModelCard without wiring convert infrastructure.
  convertStage?: ConvertStage;
  onStartConvert?: (modelId: string) => void;
  onCancelConvert?: () => void;
  onResetConvert?: () => void;
}

function ImageModelCard({ model, hw, stage, isActiveDownload, anyDownloading, checked, onToggleCheck, onCancel, onDelete, onReset, overridePath, onLocate, onClearOverride, convertStage = { kind: 'idle' }, onStartConvert, onCancelConvert = () => {}, onResetConvert = () => {} }: ImageModelCardProps) {
  const isDownloading = isActiveDownload && stage.kind === 'downloading';
  const isDone        = isActiveDownload && stage.kind === 'done';
  const isError       = isActiveDownload && stage.kind === 'error';
  const currentProgress = isDownloading && stage.kind === 'downloading' ? stage.current : null;

  // PyTorch conversion state for this card
  const isActiveConvert  = convertStage.kind !== 'idle' && (convertStage as any).modelId === model.modelId;
  const isConverting     = isActiveConvert && convertStage.kind === 'converting';
  const isConvertDone    = isActiveConvert && convertStage.kind === 'done';
  const isConvertError   = isActiveConvert && convertStage.kind === 'error';
  const convertPct       = isConverting && convertStage.kind === 'converting' ? convertStage.pct : 0;
  const convertLabel     = isConverting && convertStage.kind === 'converting' ? convertStage.label : '';
  // Only SDXL models support conversion; show button once downloaded, hide once ready
  // Profiles that phobos-convert.py can handle — maps to the model-type arg.
  // flux2 (klein/kontext variant of FLUX.2) uses 'kontext' type — excluded until validated.
  const CONVERTIBLE_PROFILES = new Set(['sdxl', 'flux', 'kontext', 'wan', 'qwen-image', 'z-image']);
  const showConvertButton = model.downloaded && CONVERTIBLE_PROFILES.has(model.runnerProfile) && !model.pytorchVariantReady && !isConverting;

  const quantLabel = model.quantization === 'Q8_0' ? 'Q8' : model.quantization === 'Q4_K_M' ? 'Q4' : model.quantization;
  const estSeconds = hw?.backend === 'cuda' ? model.estSecondsCuda : model.estSecondsVulkan;
  const compat = model.gpuCompat ?? [];
  const isSdxl    = model.runnerProfile === 'sdxl';
  const isKontext = model.runnerProfile === 'flux1-kontext';

  return (
    <div
      className={`rounded border px-4 py-3 space-y-2 transition-colors cursor-pointer ${
        model.downloaded
          ? 'border-phobos-green/20 bg-phobos-green/[0.03]'
          : checked
            ? 'border-phobos-amber/30 bg-phobos-amber/[0.04]'
            : 'border-border/20 bg-accent/10 hover:border-border/30'
      }`}
      onClick={() => {
        // Toggle checkbox on card click — but not if downloaded or downloading
        if (!model.downloaded && !anyDownloading) onToggleCheck();
      }}
    >

      {/* Name row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          {/* Checkbox / status */}
          {model.downloaded ? (
            <CheckCircle2 className="w-4 h-4 text-phobos-green/60 shrink-0 mt-0.5" />
          ) : isDownloading ? (
            <Loader2 className="w-4 h-4 text-phobos-green/50 animate-spin shrink-0 mt-0.5" />
          ) : (
            <div
              className={`w-4 h-4 rounded-sm border-2 shrink-0 mt-0.5 flex items-center justify-center transition-colors ${
                checked
                  ? 'border-phobos-amber/60 bg-phobos-amber/20'
                  : 'border-border/30 hover:border-border/50'
              }`}
            >
              {checked && <div className="w-2 h-2 rounded-[1px] bg-phobos-amber/80" />}
            </div>
          )}
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-mono text-foreground/90">{model.displayName}</span>
              <span className="text-[11px] font-mono text-muted-foreground/50 border border-border/25 px-1.5 py-0.5 rounded">
                {quantLabel}
              </span>
              {isSdxl && (
                <span className="text-[10px] font-terminal tracking-[0.1em] text-muted-foreground/30 border border-border/15 px-1 py-0.5 rounded">
                  SDXL
                </span>
              )}
              {isKontext && (
                <span className="text-[10px] font-terminal tracking-[0.1em] text-indigo-400/50 border border-indigo-400/15 px-1 py-0.5 rounded">
                  WORKFLOW NODE
                </span>
              )}
              {model.downloaded && (
                <span className="text-[11px] font-terminal tracking-[0.1em] text-phobos-green/70">● READY</span>
              )}
              {model.pytorchVariantReady && (
                <span className="text-[11px] font-terminal tracking-[0.1em] text-indigo-400/70" title="Pre-converted diffusers directory — loads faster and works with all transformers versions">⚡ PyTorch</span>
              )}
              {isConvertDone && !model.pytorchVariantReady && (
                <span className="text-[11px] font-terminal tracking-[0.1em] text-indigo-400/70">⚡ CONVERTED</span>
              )}
              {isConverting && (
                <span className="text-[11px] font-terminal tracking-[0.1em] text-phobos-amber/60 animate-pulse">◌ Converting…</span>
              )}
              {isDone && !model.downloaded && (
                <span className="text-[11px] font-terminal tracking-[0.1em] text-phobos-green/70">● DOWNLOADED</span>
              )}
              {!model.downloaded && compat.length > 0 && !compat.some(g => g.fits && !g.vulkanBlocked) && (
                <span className="text-[10px] font-terminal text-destructive/50">⚠ NO COMPATIBLE GPU</span>
              )}
            </div>
            <div className="text-[11px] font-mono text-muted-foreground/45 flex items-center gap-2 flex-wrap">
              <span>{fmt(model.sizeBytes)} weights</span>
              <span className="text-muted-foreground/25">·</span>
              {/* Per-GPU VRAM badges — green=fits, orange=vulkan blocked, red=doesn't fit */}
              {compat.length > 0 ? compat.map(g => {
                const label = `${(g.totalNeededMb / 1024).toFixed(1)}GB`;
                const shortName = g.gpuName.replace(/NVIDIA |AMD |Intel |Apple |Radeon\(TM\) |GeForce /g, '').trim();
                if (g.vulkanBlocked) {
                  return (
                    <span key={g.gpuIndex} className="text-[10px] font-terminal text-orange-400/70 border border-orange-400/20 px-1.5 py-0.5 rounded" title={`${shortName}: ${g.reason ?? 'Vulkan incompatible'}`}>
                      {label}
                    </span>
                  );
                }
                if (!g.fits) {
                  return (
                    <span key={g.gpuIndex} className="text-[10px] font-terminal text-red-400/70 border border-red-400/20 px-1.5 py-0.5 rounded" title={`${shortName}: ${g.reason ?? 'Insufficient VRAM'}`}>
                      {label}
                    </span>
                  );
                }
                return (
                  <span key={g.gpuIndex} className="text-[10px] font-terminal text-phobos-green/60 border border-phobos-green/15 px-1.5 py-0.5 rounded" title={`${shortName}: fits in ${g.vramMb / 1024}GB`}>
                    {label}
                  </span>
                );
              }) : (
                <span>{model.vramRequiredGb} GB VRAM</span>
              )}
              {estSeconds != null && <><span className="text-muted-foreground/25">·</span><span>~{estSeconds}s/image</span></>}
              <span className="text-muted-foreground/25">·</span>
              <a href={model.licenseUrl} target="_blank" rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="text-muted-foreground/35 hover:text-phobos-green/50 transition-colors inline-flex items-center gap-0.5">
                {model.license} <ExternalLink className="w-2 h-2" />
              </a>
            </div>
            {model.recommendedT5 && (
              <div className="text-[11px] font-mono text-muted-foreground/35">
                T5 {model.recommendedT5.replace('flux-t5-', '').toUpperCase()}
              </div>
            )}
            {isKontext && (
              <div className="text-[11px] font-mono text-indigo-400/40">
                Prompt-driven image editing — adds a KEDIT node to the workflow builder
              </div>
            )}
          </div>
        </div>

        {model.downloaded && !anyDownloading && (
          <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
            {/* Convert to PyTorch button — SDXL only, shown when not yet converted */}
            {showConvertButton && (
              <button
                onClick={(e) => { e.stopPropagation(); onStartConvert(model.modelId); }}
                className="text-[10px] font-terminal tracking-[0.1em] text-indigo-400/50 hover:text-indigo-400/80 border border-indigo-400/15 hover:border-indigo-400/30 px-1.5 py-0.5 rounded-sm transition-all"
                title="Convert to PyTorch format — one-time conversion for faster loading and full compatibility. Requires ~3-4 GB extra disk space."
              >
                ⚡ PyTorch
              </button>
            )}
            {isConverting && (
              <button
                onClick={(e) => { e.stopPropagation(); onCancelConvert(); }}
                className="text-[10px] font-terminal tracking-[0.1em] text-phobos-amber/50 hover:text-destructive/60 border border-phobos-amber/15 hover:border-destructive/30 px-1.5 py-0.5 rounded-sm transition-all"
              >
                ✕ Cancel
              </button>
            )}
            <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="p-1 text-muted-foreground/30 hover:text-destructive/60 transition-colors"
              title="Delete model">
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        )}
        {!model.downloaded && !anyDownloading && !isDownloading && (
          <div className="flex items-center gap-1 shrink-0 mt-0.5">
            {overridePath ? (
              <button onClick={async (e) => { e.stopPropagation(); await onClearOverride(); }}
                className="text-[10px] text-phobos-amber/50 hover:text-destructive/70 transition-colors"
                title={`Linked: ${overridePath}\nClick to clear link`}>
                ×
              </button>
            ) : (
              <button onClick={async (e) => { e.stopPropagation(); await onLocate(); }}
                className="p-1 text-muted-foreground/25 hover:text-phobos-amber/60 transition-colors"
                title="Locate — point to an existing file on disk">
                <FolderSearch className="w-5 h-5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Download progress */}
      {isDownloading && currentProgress && (
        <div className="space-y-1.5 pt-1 border-t border-border/15">
          <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground/50">
            <span className="truncate max-w-[260px]">{currentProgress.label}</span>
            <span>{pct(currentProgress.bytesReceived, currentProgress.bytesTotal).toFixed(0)}%</span>
          </div>
          <div className="h-0.5 bg-border/20 rounded-full overflow-hidden">
            <div className="h-full bg-phobos-green/50 transition-all duration-200"
              style={{ width: `${pct(currentProgress.bytesReceived, currentProgress.bytesTotal)}%` }} />
          </div>
          <div className="text-[10px] font-mono text-muted-foreground/30">
            {fmt(currentProgress.bytesReceived)} / {fmt(currentProgress.bytesTotal)}
          </div>
        </div>
      )}

      {/* Conversion progress */}
      {isConverting && (
        <div className="space-y-1.5 pt-1 border-t border-border/15">
          <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground/50">
            <span className="truncate max-w-[260px]">{convertLabel || 'Converting…'}</span>
            <span>{Math.round(convertPct * 100)}%</span>
          </div>
          <div className="h-0.5 bg-border/20 rounded-full overflow-hidden">
            <div className="h-full bg-indigo-400/50 transition-all duration-300"
              style={{ width: `${convertPct * 100}%` }} />
          </div>
          <div className="text-[10px] font-mono text-muted-foreground/30">
            One-time conversion — subsequent loads will be faster
          </div>
        </div>
      )}

      {/* Conversion error */}
      {isConvertError && convertStage.kind === 'error' && (
        <div className="flex items-center gap-2 text-[10px] font-mono text-destructive/70">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span className="truncate flex-1">{convertStage.message}</span>
          <button onClick={(e) => { e.stopPropagation(); onResetConvert(); }} className="text-muted-foreground/50 hover:text-foreground shrink-0 text-[11px]">Dismiss</button>
        </div>
      )}

      {/* Download error */}
      {isError && stage.kind === 'error' && (
        <div className="flex items-center gap-2 text-[10px] font-mono text-destructive/70">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span className="truncate flex-1">{stage.message}</span>
          <button onClick={(e) => { e.stopPropagation(); onReset(); }} className="text-muted-foreground/50 hover:text-foreground shrink-0 text-[11px]">Dismiss</button>
        </div>
      )}

      {/* File checklist — shown when not actively downloading this model */}
      {!isDownloading && !isDone && model.auxFiles.length > 0 && (
        <div className="pt-1 border-t border-border/15 space-y-0.5" onClick={e => e.stopPropagation()}>
          <div className="text-[10px] font-mono text-muted-foreground/30 mb-1">
            {model.downloaded ? 'All files ready' : 'Required files'}
          </div>
          {[
            { id: model.modelId, label: `${model.displayName} (main)`, sizeBytes: model.sizeBytes, downloaded: model.mainDownloaded, license: model.license, licenseUrl: model.licenseUrl },
            ...model.auxFiles,
          ].map(f => (
            <div key={f.id} className="flex items-center gap-2 text-[11px] font-mono">
              <span className={f.downloaded ? 'text-phobos-green/50' : 'text-muted-foreground/30'}>
                {f.downloaded ? '✓' : '○'}
              </span>
              <span className={f.downloaded ? 'text-foreground/50' : 'text-muted-foreground/40'}>{f.label}</span>
              <a href={f.licenseUrl} target="_blank" rel="noopener noreferrer"
                className="text-[10px] text-muted-foreground/25 hover:text-phobos-green/50 transition-colors inline-flex items-center gap-0.5 shrink-0">
                {f.license} <ExternalLink className="w-2 h-2" />
              </a>
              <span className="text-muted-foreground/25 ml-auto">{fmt(f.sizeBytes)}</span>
            </div>
          ))}
          {model.totalDownloadBytes > 0 && !model.downloaded && (
            <div className="text-[10px] font-mono text-muted-foreground/30 pt-1">
              {fmt(model.totalDownloadBytes)} to download
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── VideoModelsSection ───────────────────────────────────────────────────────
// Renders all video models (category: 'video'). Same download infrastructure
// as ImageModelsSection — no NSFW gate, no legacy toggle.

function VideoModelsSection({ data, isLoading, refetch, checked, toggleCheck, stage, anyDownloading, cancelFluxDownload, resetFluxDownload, overrides, onLocateModel, onClearModelOverride }: SectionProps) {
  const hw     = data?.hardware;
  const models = (data?.models ?? []).filter(m => m.category === 'video');
  const activeDownloadId = stage.kind === 'downloading' ? stage.modelId : null;

  if (isLoading) {
    return (
      <div className="px-5 py-4 text-[10px] font-mono text-muted-foreground/40 animate-pulse">
        Detecting hardware…
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="px-5 py-6 flex flex-col items-center gap-2 text-center">
        <Film className="w-5 h-5 text-muted-foreground/20" />
        <p className="text-[11px] font-mono text-muted-foreground/25 max-w-[280px] leading-relaxed">
          No video models in catalogue yet.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col px-5 py-4 space-y-5">
      {hw && (
        <div className="text-[11px] font-mono text-muted-foreground/30">
          {hw.gpuName} · {hw.totalVramGb} GB VRAM · {hw.backend.toUpperCase()}
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[10px] font-terminal tracking-[0.2em] text-muted-foreground/30 uppercase">
          VIDEO MODELS
        </div>
        {models.map(model => (
          <ImageModelCard
            key={model.modelId}
            model={model}
            hw={hw ?? null}
            stage={stage}
            isActiveDownload={activeDownloadId === model.modelId}
            anyDownloading={anyDownloading}
            checked={checked.has(model.modelId)}
            onToggleCheck={() => toggleCheck(model.modelId)}
            onCancel={cancelFluxDownload}
            onDelete={async () => { await deleteFluxModel(model.modelId); refetch(); }}
            onReset={resetFluxDownload}
            overridePath={overrides[`img:${model.modelId}`]}
            onLocate={() => onLocateModel(model.modelId)}
            onClearOverride={() => onClearModelOverride(model.modelId)}
          />
        ))}
      </div>
    </div>
  );
}

// ── AudioModelsSection ────────────────────────────────────────────────────────
// Manages audio generation deps (DepPrep-managed, status-only) and large
// user-downloaded models (Whisper large-v3, ACE-Step, F5-TTS).
//
// Download state is owned by useAudioDownload in PhobosOptionalModelsPanel and
// passed in as props — this component is pure UI.

interface AudioDepStatus {
  kokoro:  boolean;
  whisper: boolean;
  aceStep: boolean;
}

interface AudioModelStatus {
  whisperLargeV3: boolean;
  aceStepModels:  boolean;
  f5tts:          boolean;
}

// Model metadata — sizes are rough estimates for the progress bar denominator
const AUDIO_MODEL_SPECS: {
  modelId: 'whisper-large-v3' | 'ace-step-v1.5' | 'f5-tts-v1-base';
  label: string;
  sizeBytes: number;
  requiresPytorch: boolean;
  description: string;
}[] = [
  {
    modelId:         'whisper-large-v3',
    label:           'Whisper Large v3',
    sizeBytes:       3_100_000_000,
    requiresPytorch: false,
    description:     'OpenAI speech-to-text. Used for copilot voice input and voice clone reference transcription.',
  },
  {
    modelId:         'ace-step-v1.5',
    label:           'ACE-Step v1.5',
    sizeBytes:       5_800_000_000,
    requiresPytorch: true,
    description:     'Music generation from text prompts. Requires PyTorch.',
  },
  {
    modelId:         'f5-tts-v1-base',
    label:           'F5-TTS Base',
    sizeBytes:       3_400_000_000,
    requiresPytorch: true,
    description:     'Zero-shot voice cloning. Requires PyTorch.',
  },
];

function AudioModelsSection({
  audioStage,
  onStartDownload,
}: {
  audioStage: ReturnType<typeof useAudioDownload>['stage'];
  onStartDownload: (modelIds: string[]) => void;
}) {
  const [depStatus,   setDepStatus]   = useState<AudioDepStatus | null>(null);
  const [modelStatus, setModelStatus] = useState<AudioModelStatus | null>(null);

  // PyTorch status — check if any vendor is ready (needed for ACE-Step and F5-TTS)
  const { data: pyEnvData } = usePythonEnvStatus();
  const pytorchReady = (pyEnvData?.vendors ?? []).some(v => v.ready && !v.stale);

  const fetchStatus = useCallback(async () => {
    try {
      const [dRes, mRes] = await Promise.all([
        fetch(`${ENGINE_URL}/api/audio/dep-status`),
        fetch(`${ENGINE_URL}/api/audio/model-status`),
      ]);
      if (dRes.ok) setDepStatus(await dRes.json());
      if (mRes.ok) setModelStatus(await mRes.json());
    } catch { /* backend not ready */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 8_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // Refresh model status when a download completes
  useEffect(() => {
    if (audioStage.kind === 'done') fetchStatus();
  }, [audioStage.kind, fetchStatus]);

  const isDownloaded = (modelId: string): boolean => {
    if (modelId === 'whisper-large-v3') return modelStatus?.whisperLargeV3 ?? false;
    if (modelId === 'ace-step-v1.5')    return modelStatus?.aceStepModels  ?? false;
    if (modelId === 'f5-tts-v1-base')   return modelStatus?.f5tts          ?? false;
    return false;
  };

  const isAudioDownloading = audioStage.kind === 'downloading';

  return (
    <div className="flex flex-col px-5 py-4 space-y-5">

      {/* ── Binary deps (DepPrep-managed) ─────────────────────────────── */}
      <div className="space-y-2">
        <div className="text-[11px] font-terminal tracking-[0.15em] text-muted-foreground/40 uppercase">
          Binary Dependencies
        </div>
        <p className="text-[11px] font-mono text-muted-foreground/30 leading-relaxed">
          These binaries are managed by PHOBOS DepPrep and installed automatically.
          Green = installed and ready.
        </p>
        <div className="space-y-1.5">
          {/* Kokoro */}
          <div className="flex items-center gap-2.5 px-3 py-2 rounded border border-border/15 bg-accent/5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              depStatus?.kokoro ? 'bg-phobos-green/70 shadow-[0_0_4px_hsl(120_100%_50%/0.5)]' : 'bg-muted-foreground/20'
            }`} />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-terminal tracking-[0.1em] text-foreground/60">Kokoro TTS</div>
              <div className="text-[11px] font-mono text-muted-foreground/30">
                ONNX runtime · copilot voice synthesis · no PyTorch required
              </div>
            </div>
            {depStatus && !depStatus.kokoro && (
              <span className="text-[10px] font-terminal text-phobos-amber/50 border border-phobos-amber/20 rounded px-1.5 py-0.5 shrink-0">
                PENDING
              </span>
            )}
          </div>
          {/* Whisper CLI */}
          <div className="flex items-center gap-2.5 px-3 py-2 rounded border border-border/15 bg-accent/5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              depStatus?.whisper ? 'bg-phobos-green/70 shadow-[0_0_4px_hsl(120_100%_50%/0.5)]' : 'bg-muted-foreground/20'
            }`} />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-terminal tracking-[0.1em] text-foreground/60">Whisper CLI</div>
              <div className="text-[11px] font-mono text-muted-foreground/30">
                C++ binary · push-to-talk transcription · runs standalone
              </div>
            </div>
            {depStatus && !depStatus.whisper && (
              <span className="text-[10px] font-terminal text-phobos-amber/50 border border-phobos-amber/20 rounded px-1.5 py-0.5 shrink-0">
                PENDING
              </span>
            )}
          </div>
          {/* ACE-Step binary */}
          <div className="flex items-center gap-2.5 px-3 py-2 rounded border border-border/15 bg-accent/5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              depStatus?.aceStep ? 'bg-phobos-green/70 shadow-[0_0_4px_hsl(120_100%_50%/0.5)]' : 'bg-muted-foreground/20'
            }`} />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-terminal tracking-[0.1em] text-foreground/60">ACE-Step Runtime</div>
              <div className="text-[11px] font-mono text-muted-foreground/30">
                C++ LM + DiT binary · music generation · model downloaded separately
              </div>
            </div>
            {depStatus && !depStatus.aceStep && (
              <span className="text-[10px] font-terminal text-phobos-amber/50 border border-phobos-amber/20 rounded px-1.5 py-0.5 shrink-0">
                PENDING
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Large models ───────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="text-[11px] font-terminal tracking-[0.15em] text-muted-foreground/40 uppercase">
          Large Models
        </div>
        <p className="text-[11px] font-mono text-muted-foreground/30 leading-relaxed">
          Downloaded once to <span className="text-foreground/40">~/.phobos/models/audio/</span>.
          Models marked PyTorch require a working GPU environment (see hardware cards above).
        </p>

        {/* PyTorch warning banner */}
        {!pytorchReady && (
          <div className="flex items-start gap-2 px-3 py-2 rounded border border-phobos-amber/20 bg-phobos-amber/5">
            <AlertTriangle className="w-3 h-3 text-phobos-amber/60 shrink-0 mt-0.5" />
            <div className="text-[11px] font-mono text-phobos-amber/60 leading-relaxed">
              PyTorch environment not ready. ACE-Step and F5-TTS require PyTorch.
              Set up a GPU environment using the hardware cards in the main panel.
            </div>
          </div>
        )}

        <div className="space-y-2">
          {AUDIO_MODEL_SPECS.map(spec => {
            const downloaded     = isDownloaded(spec.modelId);
            const isActive       = audioStage.kind === 'downloading' && audioStage.modelId === spec.modelId;
            const isDone         = audioStage.kind === 'done'        && audioStage.modelId === spec.modelId;
            const pytorchBlocked = spec.requiresPytorch && !pytorchReady;
            const canDownload    = !downloaded && !isAudioDownloading && !pytorchBlocked;

            return (
              <div
                key={spec.modelId}
                className={`rounded border px-4 py-3 space-y-2 transition-colors ${
                  downloaded
                    ? 'border-phobos-green/20 bg-phobos-green/[0.03]'
                    : isActive
                      ? 'border-cyan-400/20 bg-cyan-400/[0.03]'
                      : 'border-border/20 bg-accent/10'
                }`}
              >
                {/* Header row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5 min-w-0">
                    {downloaded ? (
                      <CheckCircle2 className="w-4 h-4 text-phobos-green/60 shrink-0 mt-0.5" />
                    ) : isActive ? (
                      <Loader2 className="w-4 h-4 text-cyan-400/60 animate-spin shrink-0 mt-0.5" />
                    ) : (
                      <div className="w-4 h-4 rounded-sm border-2 border-border/30 shrink-0 mt-0.5" />
                    )}
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-mono text-foreground/85">{spec.label}</span>
                        <span className="text-[11px] font-mono text-muted-foreground/40 border border-border/20 rounded px-1.5 py-0.5">
                          {(spec.sizeBytes / 1e9).toFixed(1)} GB
                        </span>
                        {spec.requiresPytorch && (
                          <span className={`text-[10px] font-terminal tracking-[0.1em] border rounded px-1 py-0.5 ${
                            pytorchReady
                              ? 'border-indigo-400/20 text-indigo-400/50'
                              : 'border-phobos-amber/20 text-phobos-amber/50'
                          }`}>
                            PyTorch
                          </span>
                        )}
                        {downloaded && (
                          <span className="text-[11px] font-terminal tracking-[0.1em] text-phobos-green/70">● READY</span>
                        )}
                        {isDone && !downloaded && (
                          <span className="text-[11px] font-terminal tracking-[0.1em] text-phobos-green/70">● DOWNLOADED</span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-muted-foreground/35 leading-relaxed">
                        {spec.description}
                      </div>
                    </div>
                  </div>

                  {/* Action button */}
                  {!downloaded && !isActive && (
                    canDownload ? (
                      <button
                        onClick={() => onStartDownload([spec.modelId])}
                        className="flex items-center gap-1.5 text-[11px] font-terminal tracking-[0.1em] text-cyan-400/70 hover:text-cyan-400 border border-cyan-400/20 hover:border-cyan-400/40 px-2.5 py-1 rounded-sm transition-all shrink-0"
                      >
                        <Download className="w-3 h-3" />
                        DOWNLOAD
                      </button>
                    ) : pytorchBlocked ? (
                      <span className="text-[10px] font-terminal text-phobos-amber/40 border border-phobos-amber/15 rounded px-1.5 py-1 shrink-0">
                        NEEDS PYTORCH
                      </span>
                    ) : (
                      <span className="text-[10px] font-terminal text-muted-foreground/25 shrink-0">
                        wait…
                      </span>
                    )
                  )}
                </div>

                {/* Progress bar — driven by audioStage from the hook */}
                {isActive && audioStage.kind === 'downloading' && (
                  <div className="space-y-1 pt-1 border-t border-border/15">
                    <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground/40">
                      <span>{audioStage.pct.toFixed(0)}%</span>
                      <span>
                        {audioStage.bytesTotal > 0
                          ? `${(audioStage.bytesReceived / 1e9).toFixed(2)} / ${(audioStage.bytesTotal / 1e9).toFixed(2)} GB`
                          : `${(audioStage.bytesReceived / 1e6).toFixed(0)} MB received…`}
                      </span>
                    </div>
                    <div className="h-1 bg-border/20 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-cyan-400/50 rounded-full transition-all duration-300"
                        style={{ width: `${audioStage.pct}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Error — shown inline when this model errored */}
                {(() => {
                  if (audioStage.kind !== 'error' || !isActive) return null;
                  const { message } = audioStage;
                  return (
                    <div className="flex items-center gap-2 text-[11px] font-mono text-destructive/60 pt-1 border-t border-border/15">
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      <span className="flex-1 truncate">{message}</span>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}