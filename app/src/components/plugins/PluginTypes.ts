export type PluginKind     = 'plugin' | 'raw_lora';
export type PluginCategory = 'style' | 'subject' | 'lighting' | 'texture' | 'concept' | 'generic';
export type PluginBaseModel =
  | 'flux-dev' | 'flux-schnell' | 'flux2-klein' | 'sdxl' | 'chroma' | '*';

export interface PluginRecord {
  id:                 string;
  kind:               PluginKind;
  name:               string;
  author:             string;
  author_url:         string | null;
  version:            string;
  description:        string;
  base_model:         PluginBaseModel;
  compatible_models:  PluginBaseModel[];
  trigger_words:      string[];
  category:           PluginCategory;
  tags:               string[];
  recommended_weight: number;
  weight_min:         number;
  weight_max:         number;
  rank:               number | null;
  training_images:    number | null;
  training_steps:     number | null;
  archive_path:       string;
  is_local_author:    boolean;
  has_license_unlock: boolean;
  installed_at:       string;
}

export const CATEGORY_LABELS: Record<PluginCategory, string> = {
  style: 'Style', subject: 'Subject', lighting: 'Lighting',
  texture: 'Texture', concept: 'Concept', generic: 'Generic',
};

export const BASE_MODEL_LABELS: Record<PluginBaseModel, string> = {
  'flux-dev': 'FLUX.1 Dev', 'flux-schnell': 'FLUX.1 Schnell',
  'flux2-klein': 'FLUX.2 Klein', 'sdxl': 'SDXL', 'chroma': 'Chroma', '*': 'Universal',
};

export function isCompatible(plugin: PluginRecord, activeModelId: string): boolean {
  if (plugin.kind === 'raw_lora') return true;
  if (plugin.compatible_models.includes('*')) return true;
  return plugin.compatible_models.some(cm =>
    activeModelId.toLowerCase().includes(cm.replace(/-/g, ''))
    || activeModelId.toLowerCase().startsWith(cm.split('-')[0])
  );
}
