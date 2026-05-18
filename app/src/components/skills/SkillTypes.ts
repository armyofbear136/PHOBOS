export type UserSkillScope = 'sayon' | 'seren' | 'both';

export interface DepFile {
  name: string;
  size: number;
  path: string;
}

export interface UserSkillRecord {
  id: string;
  name: string;
  description: string;
  version: string;
  scope: UserSkillScope;
  category: 'user';
  trigger: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  skill_md: string;
  runner: string;
  seren_context: string;
  deps: DepFile[];
  skill_path: string;
}

export interface UserSkillCreateInput {
  id: string;
  name: string;
  description: string;
  version: string;
  scope: UserSkillScope;
  trigger: string;
  enabled: boolean;
  skill_md: string;
  runner: string;
  seren_context: string;
}

export function createEmptySkill(): UserSkillRecord {
  return {
    id: '',
    name: '',
    description: '',
    version: '0.1.0',
    scope: 'both',
    category: 'user',
    trigger: '',
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    skill_md: '# Skill Name\n\nDescribe what this skill does and how the model should use it.\n\n## When to use\n\n## Instructions\n',
    runner: '// runner.ts — skill entry point\nexport async function run(params: Record<string, unknown>) {\n  // implement skill logic\n  return {};\n}',
    seren_context: '# SEREN Context\n\nDescribe how SEREN should apply this skill during deep reasoning tasks.',
    deps: [],
    skill_path: '',
  };
}

// Keep legacy alias so SkillCartridge doesn't need touching
export type PhobosSkill = UserSkillRecord;
