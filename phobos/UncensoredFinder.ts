// ── Types ─────────────────────────────────────────────────────────────────────

export interface UncensoredVariant {
  repoId:    string;
  fileName:  string;
  label:     string;   // short display name
  method:    'heretic' | 'abliterated' | 'dolphin' | 'uncensored';
  pageUrl:   string;   // HF repo page for the user to visit
}

// ── Static map ────────────────────────────────────────────────────────────────
// Pre-researched uncensored variants for every model in GGUF_CATALOGUE.
// Key = modelId.  Value = ordered list of known variants (best first).
//
// To verify links are still live: node scripts/verify-uncensored-links.js

const UNCENSORED_MAP: Record<string, UncensoredVariant[]> = {

  // ── Llama 3 ──────────────────────────────────────────────────────────────────

  'llama3.2-3b-q4': [
    { repoId: 'bartowski/Llama-3.2-3B-Instruct-abliterated-GGUF',
      fileName: 'Llama-3.2-3B-Instruct-abliterated-Q4_K_M.gguf',
      label: 'Llama 3.2 3B Abliterated (bartowski)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-abliterated-GGUF' },
  ],

  'llama3.1-8b-q4': [
    { repoId: 'bartowski/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF',
      fileName: 'Meta-Llama-3.1-8B-Instruct-abliterated-Q4_K_M.gguf',
      label: 'Llama 3.1 8B Abliterated (bartowski)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF' },
    { repoId: 'bartowski/p-e-w_Llama-3.1-8B-Instruct-heretic-GGUF',
      fileName: 'p-e-w_Llama-3.1-8B-Instruct-heretic-Q4_K_M.gguf',
      label: 'Llama 3.1 8B Heretic (bartowski)', method: 'heretic',
      pageUrl: 'https://huggingface.co/bartowski/p-e-w_Llama-3.1-8B-Instruct-heretic-GGUF' },
    { repoId: 'mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF',
      fileName: 'Meta-Llama-3.1-8B-Instruct-abliterated-Q4_K_M.gguf',
      label: 'Llama 3.1 8B Abliterated (mlabonne)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF' },
  ],

  // ── Gemma 3 ──────────────────────────────────────────────────────────────────

  'gemma3-1b-q4': [
    { repoId: 'mradermacher/gemma-3-1b-it-heretic-extreme-uncensored-abliterated-GGUF',
      fileName: 'gemma-3-1b-it-heretic-extreme-uncensored-abliterated.Q4_K_M.gguf',
      label: 'Gemma 3 1B Heretic Extreme (mradermacher)', method: 'heretic',
      pageUrl: 'https://huggingface.co/mradermacher/gemma-3-1b-it-heretic-extreme-uncensored-abliterated-GGUF' },
  ],

  'gemma3-4b-q4': [
    { repoId: 'mlabonne/gemma-3-4b-it-abliterated-GGUF',
      fileName: 'gemma-3-4b-it-abliterated-Q4_K_M.gguf',
      label: 'Gemma 3 4B Abliterated (mlabonne)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/mlabonne/gemma-3-4b-it-abliterated-GGUF' },
  ],

  'gemma3-12b-q4': [
    { repoId: 'mlabonne/gemma-3-12b-it-abliterated-GGUF',
      fileName: 'gemma-3-12b-it-abliterated-Q4_K_M.gguf',
      label: 'Gemma 3 12B Abliterated (mlabonne)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/mlabonne/gemma-3-12b-it-abliterated-GGUF' },
    { repoId: 'Otakadelic/gemma-3-12b-it-abliterated-Q4_K_M-GGUF',
      fileName: 'gemma-3-12b-it-abliterated-q4_k_m.gguf',
      label: 'Gemma 3 12B Abliterated (Otakadelic)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/Otakadelic/gemma-3-12b-it-abliterated-Q4_K_M-GGUF' },
  ],

  // ── Mistral ───────────────────────────────────────────────────────────────────

  'mistral-7b-q4': [
    { repoId: 'mradermacher/Mistral-7B-Instruct-v0.3-abliterated-GGUF',
      fileName: 'Mistral-7B-Instruct-v0.3-abliterated.Q4_K_M.gguf',
      label: 'Mistral 7B v0.3 Abliterated (mradermacher)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/mradermacher/Mistral-7B-Instruct-v0.3-abliterated-GGUF' },
  ],

  // ── DeepSeek-R1 ──────────────────────────────────────────────────────────────

  'deepseek-r1-8b-q4': [
    { repoId: 'mradermacher/DeepSeek-R1-Distill-Llama-8B-Uncensored-GGUF',
      fileName: 'DeepSeek-R1-Distill-Llama-8B-Uncensored.Q4_K_M.gguf',
      label: 'DeepSeek-R1 8B Uncensored (mradermacher)', method: 'uncensored',
      pageUrl: 'https://huggingface.co/mradermacher/DeepSeek-R1-Distill-Llama-8B-Uncensored-GGUF' },
    { repoId: 'bartowski/huihui-ai_DeepSeek-R1-Distill-Llama-8B-abliterated-GGUF',
      fileName: 'huihui-ai_DeepSeek-R1-Distill-Llama-8B-abliterated-Q4_K_M.gguf',
      label: 'DeepSeek-R1 8B Abliterated (bartowski/huihui)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/bartowski/huihui-ai_DeepSeek-R1-Distill-Llama-8B-abliterated-GGUF' },
  ],

  'deepseek-r1-14b-q4': [
    { repoId: 'mradermacher/DeepSeek-R1-Distill-Qwen-14B-abliterated-v2-GGUF',
      fileName: 'DeepSeek-R1-Distill-Qwen-14B-abliterated-v2.Q4_K_M.gguf',
      label: 'DeepSeek-R1 14B Abliterated v2 (mradermacher)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/mradermacher/DeepSeek-R1-Distill-Qwen-14B-abliterated-v2-GGUF' },
    { repoId: 'QuantFactory/DeepSeek-R1-Distill-Qwen-14B-abliterated-v2-GGUF',
      fileName: 'DeepSeek-R1-Distill-Qwen-14B-abliterated-v2.Q4_K_M.gguf',
      label: 'DeepSeek-R1 14B Abliterated v2 (QuantFactory)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/QuantFactory/DeepSeek-R1-Distill-Qwen-14B-abliterated-v2-GGUF' },
  ],

  'deepseek-r1-70b-q4': [
    { repoId: 'bartowski/huihui-ai_DeepSeek-R1-Distill-Llama-70B-abliterated-GGUF',
      fileName: 'huihui-ai_DeepSeek-R1-Distill-Llama-70B-abliterated-Q4_K_M.gguf',
      label: 'DeepSeek-R1 70B Abliterated (bartowski/huihui)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/bartowski/huihui-ai_DeepSeek-R1-Distill-Llama-70B-abliterated-GGUF' },
  ],

  // ── Qwen 3 (legacy) ───────────────────────────────────────────────────────────

  'qwen3-4b-q4': [
    { repoId: 'DavidAU/Qwen3-4B-Heretic-Uncensored-Thinking-GGUF',
      fileName: 'Qwen3-4B-Heretic-Uncensored-Thinking-Q4_K_M.gguf',
      label: 'Qwen3 4B Heretic Uncensored (DavidAU)', method: 'heretic',
      pageUrl: 'https://huggingface.co/DavidAU/Qwen3-4B-Heretic-Uncensored-Thinking-GGUF' },
  ],

  'qwen3-8b-q4': [
    { repoId: 'mradermacher/Qwen3-8B-abliterated-GGUF',
      fileName: 'Qwen3-8B-abliterated.Q4_K_M.gguf',
      label: 'Qwen3 8B Abliterated (mradermacher)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/mradermacher/Qwen3-8B-abliterated-GGUF' },
  ],

  'qwen3-14b-q4': [
    { repoId: 'mradermacher/Qwen3-14B-abliterated-GGUF',
      fileName: 'Qwen3-14B-abliterated.Q4_K_M.gguf',
      label: 'Qwen3 14B Abliterated (mradermacher)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/mradermacher/Qwen3-14B-abliterated-GGUF' },
  ],

  'qwen3-30b-a3b-q4': [
    { repoId: 'mradermacher/Qwen3-30B-A3B-Gemini-Pro-High-Reasoning-2507-ABLITERATED-UNCENSORED-GGUF',
      fileName: 'Qwen3-30B-A3B-Gemini-Pro-High-Reasoning-2507-ABLITERATED-UNCENSORED.Q4_K_M.gguf',
      label: 'Qwen3 30B-A3B Abliterated (mradermacher)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/mradermacher/Qwen3-30B-A3B-Gemini-Pro-High-Reasoning-2507-ABLITERATED-UNCENSORED-GGUF' },
  ],

  // ── Qwen 3.5 ─────────────────────────────────────────────────────────────────

  'qwen3.5-4b-q4': [
    { repoId: 'HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive',
      fileName: 'Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf',
      label: 'Qwen3.5 4B Uncensored Aggressive (HauhauCS)', method: 'uncensored',
      pageUrl: 'https://huggingface.co/HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive' },
  ],

  'qwen3.5-9b-q4': [
    { repoId: 'HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive',
      fileName: 'Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf',
      label: 'Qwen3.5 9B Uncensored Aggressive (HauhauCS)', method: 'uncensored',
      pageUrl: 'https://huggingface.co/HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive' },
    { repoId: 'DavidAU/Qwen3.5-9B-Claude-4.6-OS-Auto-Variable-HERETIC-UNCENSORED-THINKING-MAX-NEOCODE-Imatrix-GGUF',
      fileName: 'Qwen3.5-9B-Claude-4.6-OS-AV-HERETIC-Q4_K_M.gguf',
      label: 'Qwen3.5 9B Heretic Uncensored (DavidAU)', method: 'heretic',
      pageUrl: 'https://huggingface.co/DavidAU/Qwen3.5-9B-Claude-4.6-OS-Auto-Variable-HERETIC-UNCENSORED-THINKING-MAX-NEOCODE-Imatrix-GGUF' },
  ],

  'qwen3.5-27b-q4': [
    { repoId: 'mradermacher/Huihui-Qwen3.5-27B-abliterated-GGUF',
      fileName: 'Huihui-Qwen3.5-27B-abliterated.Q4_K_M.gguf',
      label: 'Qwen3.5 27B Abliterated huihui (mradermacher)', method: 'abliterated',
      pageUrl: 'https://huggingface.co/mradermacher/Huihui-Qwen3.5-27B-abliterated-GGUF' },
  ],

  'qwen3.5-35b-a3b-q4': [
    { repoId: 'HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive',
      fileName: 'Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf',
      label: 'Qwen3.5 35B-A3B Uncensored Aggressive (HauhauCS)', method: 'uncensored',
      pageUrl: 'https://huggingface.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive' },
  ],
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Returns pre-researched uncensored variants for a given catalogue modelId.
 * Instant — no network call. Returns empty array if no variants are known yet.
 */
export function findUncensoredVariants(modelId: string): UncensoredVariant[] {
  return UNCENSORED_MAP[modelId] ?? [];
}
