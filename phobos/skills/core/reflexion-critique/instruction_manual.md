# Reflexion Critique Protocol

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

Do not invent gaps. Do not request changes to things the user did not ask for. The goal is correctness, not perfection.