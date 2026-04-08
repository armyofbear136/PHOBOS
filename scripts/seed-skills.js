#!/usr/bin/env node
/**
 * seed-skills.js
 * Run once: node seed-skills.js
 * Creates ~/.phobos/skills/core/ with the 4 priority system skills.
 */
import fs from 'fs/promises';
import path from 'node:path';
import os from 'node:os';

const SKILLS_ROOT = path.join(os.homedir(), 'NodeJS', 'Projects', 'dual-reasoning', 'phobos', 'skills');

const SKILLS = [
  // ── 1. context-compression ────────────────────────────────────────────────
  // Surface: sayon_ingest — appended to SAYON's file summarisation prompts
  {
    dir: 'core/context-compression',
    manifest: {
      id: 'context-compression',
      name: 'Context Compression',
      description: 'Guides SAYON to compress long-form context efficiently, preserving signal and dropping noise.',
      version: '1.0.0',
      scope: 'sayon',
      category: 'core',
      trigger: 'Active during file summarisation and request rewriting in Phase 1',
      runner: null,
    },
    instructions: `# Context Compression

When summarising files and assembling context for SEREN, apply these compression principles:

**Preserve unconditionally:**
- Function signatures, class names, exported symbols, API contracts
- Error messages, constraint definitions, and explicit user requirements
- File paths and the relationships between files
- Any data whose omission would change SEREN's decision

**Compress aggressively:**
- Boilerplate, license headers, repetitive import blocks
- Inline comments that restate what the code visibly does
- Large data literals (summarise the shape, not every value)
- Duplicate information already captured in another file summary

**Summarisation rule:** One summary per file. State what the file IS and what it EXPORTS. Do not pad. Every token costs — spend them only where SEREN needs them.

**Rewrite rule:** The reformulated prompt must contain exactly the information SEREN needs to plan correctly and nothing more. Resolve ambiguity. Name the files. State the outcome. Strip the prose.`,
    instructions_seren: null,
  },

  // ── 2. interleaved-thinking ───────────────────────────────────────────────
  // Surface: seren_system — appended to SEREN's system prompt on every execution turn
  {
    dir: 'core/interleaved-thinking',
    manifest: {
      id: 'interleaved-thinking',
      name: 'Interleaved Thinking',
      description: 'Guides SEREN to structure reasoning traces for maximum clarity and correctness.',
      version: '1.0.0',
      scope: 'seren',
      category: 'core',
      trigger: 'Always active in SEREN execution turns',
      runner: null,
    },
    instructions: null,
    instructions_seren: `# Interleaved Thinking

Before writing any output, structure your reasoning in this order:

1. **Restate the goal** — in one sentence, what does success look like for this task?
2. **Identify constraints** — what must not break? What files must not be touched beyond the target?
3. **Plan the approach** — what is the exact sequence of operations? Name the functions, variables, and lines involved.
4. **Check the plan** — does this approach actually satisfy the goal? Are there edge cases?
5. **Execute** — now write the output.

**During execution:**
- If you reach a point where a decision could go two ways, think through both and state which you chose and why.
- If you realise mid-execution that your plan was wrong, stop, restate the correct plan, then continue.
- Never fabricate function signatures, import paths, or variable names. If you do not know, emit a read_file request.

**Output discipline:** Emit the complete result. Do not truncate. Do not summarise what you "would" write — write it.`,
  },

  // ── 3. llm-as-judge ──────────────────────────────────────────────────────
  // Surface: sayon_review — replaces the hardcoded review rubric
  {
    dir: 'core/llm-as-judge',
    manifest: {
      id: 'llm-as-judge',
      name: 'LLM-as-Judge',
      description: 'Structured rubric-based evaluation for SAYON\'s per-task review. Replaces binary approve/reject with scored, reasoned decisions.',
      version: '1.0.0',
      scope: 'sayon',
      category: 'core',
      trigger: 'Active during SAYON per-task review in Phase 4',
      runner: null,
    },
    instructions: `# LLM-as-Judge Review Protocol

You are SAYON reviewing work produced by SEREN. Score each task output against this rubric.

## Rubric

**1. Intent Alignment (0–3)**
Does the output address what was actually asked?
- 3: Exactly matches intent, correct file(s), correct operation
- 2: Mostly correct but minor scope mismatch
- 1: Partial — addresses some of the request
- 0: Wrong file, wrong operation, or ignores the request

**2. Completeness (0–3)**
Is the output complete — not truncated, not stubbed, not placeholder?
- 3: Complete. All required code/content is present.
- 2: Mostly complete, minor omission
- 1: Significant omission — key sections missing
- 0: Stub, placeholder, or "// TODO" without implementation

**3. Correctness (0–2)**
Are there obvious errors — syntax, missing imports, broken logic?
- 2: No apparent errors
- 1: Minor issues (missing import, typo)
- 0: Syntax error or logic that cannot work

**4. Preservation (0–2)**
Does the change preserve existing functionality that should remain?
- 2: Untouched what should be untouched
- 1: Minor unintentional change
- 0: Broke or removed existing behaviour

## Scoring

Total = Intent + Completeness + Correctness + Preservation (max 10)

- **APPROVE** (≥8): Output is correct and complete. Proceed.
- **NEEDS_REVISION** (5–7): Specific fixable issues. List them precisely so the next attempt can target them exactly.
- **REJECT** (<5): Wrong approach, wrong file, or stub output. Describe what the correct approach would be.

## Output format
Respond ONLY with valid JSON:
\`\`\`
{
  "score": <0.0–1.0 normalised from /10>,
  "decision": "APPROVE|NEEDS_REVISION|REJECT",
  "issues": [{"file":"...","line_range":"...","issue":"...","expected":"..."}],
  "guidance": "<targeted direction for next attempt, or empty string if APPROVE>"
}
\`\`\``,
    instructions_seren: null,
  },

  // ── 4. reflexion-critique ─────────────────────────────────────────────────
  // Surface: seren_final_validation — appended to SEREN's holistic review prompt
  {
    dir: 'core/reflexion-critique',
    manifest: {
      id: 'reflexion-critique',
      name: 'Reflexion Critique',
      description: 'Guides SEREN\'s final holistic review with structured self-critique patterns.',
      version: '1.0.0',
      scope: 'seren',
      category: 'core',
      trigger: 'Active during SEREN final validation in Phase 4.5',
      runner: null,
    },
    instructions: null,
    instructions_seren: `# Reflexion Critique Protocol

You are performing holistic final validation of all completed work. Apply this structured critique:

## Step 1 — Ground truth check
Re-read the original user request. In one sentence: what did they actually ask for?

## Step 2 — Cross-file consistency
For each pair of files that interact:
- Do the function signatures match between caller and callee?
- Do the import paths resolve to files that actually exist?
- Are shared types/constants defined in exactly one place?

## Step 3 — Gap analysis
What was asked for that is not present in the output?
List each gap explicitly. A gap is only acceptable if the task explicitly excluded it.

## Step 4 — Regression check
What existing functionality could this change break?
Name the specific functions or behaviours at risk.

## Step 5 — Verdict
Based on steps 1–4:
- **SATISFIED**: The work fully addresses the request with no critical gaps.
- **REWORK_TASKS**: Specific tasks need correction. List them with precise issues.

Do not invent gaps. Do not request changes to things the user did not ask for. The goal is correctness, not perfection.`,
  },
];

async function main() {
  await fs.mkdir(SKILLS_ROOT, { recursive: true });

  for (const skill of SKILLS) {
    const skillDir = path.join(SKILLS_ROOT, skill.dir);
    await fs.mkdir(skillDir, { recursive: true });

    await fs.writeFile(
      path.join(skillDir, 'manifest.json'),
      JSON.stringify(skill.manifest, null, 2),
      'utf-8'
    );

    // Merge sayon and seren context into a single instruction_manual.md.
    // For the 4 core skills, one is always null — just take whichever has content.
    const instructionContent = skill.instructions || skill.instructions_seren || null;
    if (instructionContent) {
      await fs.writeFile(path.join(skillDir, 'instruction_manual.md'), instructionContent, 'utf-8');
    }

    console.log(`✓  ${skill.manifest.name}  →  ${skillDir}`);
  }

  // Write _registry.json
  const registry = {
    version: '1.0',
    generated: new Date().toISOString(),
    skills: SKILLS.map(s => ({
      ...s.manifest,
      path: path.join(SKILLS_ROOT, s.dir),
    })),
  };
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
  console.log(`✓  Registry written to ${REGISTRY_PATH}`);
}

const REGISTRY_PATH = path.join(SKILLS_ROOT, '_registry.json');
main().catch(err => { console.error(err); process.exit(1); });
