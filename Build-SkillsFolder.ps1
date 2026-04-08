# Build-SkillsFolder.ps1
# PowerShell 5 compatible.
#
# Reads the scan-report.txt produced by Scan-Skills.ps1 and copies SKILL.md
# files from your actualskills source tree into a phobos/skills/ folder
# structure next to this script, organised as:
#
#   phobos/skills/
#     _registry.json         <- merged manifest for all installed skills
#     core/                  <- 4 priority system skills (from seed-skills.js)
#       context-compression/
#       interleaved-thinking/
#       llm-as-judge/
#       reflexion-critique/
#     tools/
#       prime/               <- skills shown to SEREN during planning (~85)
#         <skill-id>/
#           manifest.json
#           instruction_manual.md  <- SKILL.md content
#       reserve/             <- rest of the library, searched on demand
#         <skill-id>/
#           manifest.json
#           instruction_manual.md
#
# Usage:
#   .\Build-SkillsFolder.ps1 `
#       -SkillsRoot "C:\Users\armyo\Phobos\agentskills\actualskills" `
#       -ReportPath ".\scan-report.txt"
#
# The phobos/ folder is written next to this script.
# Copy or move it into your project root after reviewing.

param(
    [Parameter(Mandatory=$true)]
    [string]$SkillsRoot,

    [string]$ReportPath = (Join-Path $PSScriptRoot 'scan-report.txt'),

    [string]$OutputDir  = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

# ── PRIME skill IDs (must match SkillManager.ts PRIME_SKILL_IDS) ─────────────
$PRIME_IDS = @(
    'context-compression', 'context-optimization', 'context-fundamentals',
    'memory-systems', 'multi-agent-patterns', 'evaluation', 'advanced-evaluation',
    'tool-design', 'project-development', 'filesystem-context', 'context-degradation',
    'base', 'typescript', 'python', 'react-web', 'nodejs-backend', 'security',
    'code-review', 'commit-hygiene', 'database-schema', 'existing-repo',
    'playwright-testing', 'iterative-development', 'llm-patterns', 'agentic-development',
    'git-commit', 'github-pr-creation', 'github-pr-review', 'github-pr-merge',
    'creating-skills',
    'copywriting', 'content-strategy', 'copy-editing', 'seo-audit',
    'email-sequence', 'pricing-strategy', 'social-content', 'de-ai-ify',
    'strategic-planning', 'prd-generator', 'go-to-market-plan',
    'sop-creator', 'pricing-strategist',
    'create-prd', 'user-stories', 'sprint-plan', 'competitor-analysis',
    'market-sizing', 'user-personas', 'sentiment-analysis', 'grammar-check',
    'prioritization-frameworks', 'product-vision', 'lean-canvas', 'swot-analysis',
    'release-notes', 'summarize-meeting', 'sql-queries',
    'resume-tailor', 'resume-bullet-writer', 'resume-ats-optimizer',
    'cover-letter-generator', 'job-description-analyzer',
    'tech-resume-optimizer', 'salary-negotiation-prep',
    'contract-review-anthropic', 'docx-processing-anthropic',
    'pdf-processing-anthropic', 'xlsx-processing-anthropic',
    'legal-risk-assessment-anthropic', 'nda-triage-anthropic',
    'finding-duplicate-functions', 'using-tmux-for-interactive-commands', 'mcp-cli',
    'baseline-ui', 'fixing-accessibility', 'output-skill', 'taste-skill',
    'core', 'ci', 'playwright-cli',
    'vibesec-skill', 'security-bluebook-builder',
    'kreuzberg',
    'download-video', 'transcribe-video', 'compress-images',
    'youtube-clipper-skill'
)
$PRIME_SET = @{}
foreach ($id in $PRIME_IDS) { $PRIME_SET[$id] = $true }

# ── Skills to drop entirely (junk entries) ────────────────────────────────────
$DROP_IDS = @(
    'template', 'clarity-gate', 'create-voltagent', 'voltagent-best-practices',
    'voltagent-core-reference', 'voltagent-docs-bundle',
    'offer-k-dense-web', 'generate-image', 'perplexity-search', 'parallel-web',
    'agent-skills-for-context-engineering'
)
$DROP_SET = @{}
foreach ($id in $DROP_IDS) { $DROP_SET[$id] = $true }

# ── Helper: make a safe JS-compatible id from folder name ─────────────────────
function ConvertTo-SafeId {
    param([string]$Name)
    return ($Name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
}

# ── Helper: read first description paragraph from SKILL.md ────────────────────
function Get-FirstParagraph {
    param([string]$FilePath)
    try {
        $lines = Get-Content -LiteralPath $FilePath -TotalCount 60 -Encoding UTF8
        $pastH1 = $false
        $desc = New-Object System.Collections.Generic.List[string]
        foreach ($line in $lines) {
            if (-not $pastH1) {
                if ($line -match '^#\s+') { $pastH1 = $true }
                continue
            }
            if ($line -match '^#{1,6}\s+' -and $desc.Count -eq 0) { continue }
            if ($line.Trim() -eq '' -and $desc.Count -eq 0) { continue }
            if ($line -match '^#{1,6}\s+' -and $desc.Count -gt 0) { break }
            if ($line.Trim() -eq '' -and $desc.Count -gt 0) { break }
            $desc.Add($line.Trim())
            if ($desc.Count -ge 2) { break }
        }
        if ($desc.Count -gt 0) {
            $j = ($desc -join ' ') -replace '\s+', ' '
            if ($j.Length -gt 200) { return $j.Substring(0, 197) + '...' }
            return $j
        }
    } catch { }
    return 'No description available.'
}

function Get-SkillTrigger {
    param([string]$FilePath)
    try {
        $lines = Get-Content -LiteralPath $FilePath -TotalCount 80 -Encoding UTF8
        $inSection = $false
        $trigger = New-Object System.Collections.Generic.List[string]
        foreach ($line in $lines) {
            if ($line -match '^#{1,3}\s+.*(when|trigger|use|usage|activat)' -and
                $line -notmatch 'example|result|output') {
                $inSection = $true
                continue
            }
            if ($inSection) {
                if ($line -match '^#{1,3}\s+') { break }
                if ($line.Trim() -eq '' -and $trigger.Count -gt 0) { break }
                if ($line.Trim() -ne '') {
                    $trigger.Add($line.Trim())
                    if ($trigger.Count -ge 2) { break }
                }
            }
        }
        if ($trigger.Count -gt 0) {
            $t = ($trigger -join ' ') -replace '\s+', ' '
            if ($t.Length -gt 160) { return $t.Substring(0, 157) + '...' }
            return $t
        }
    } catch { }
    return 'Invoke when the task matches this skill.'
}

# ── Parse scan-report.txt to get id → source path mapping ────────────────────

Write-Host ''
Write-Host 'Reading scan report...' -ForegroundColor Cyan

if (-not (Test-Path $ReportPath)) {
    Write-Error "scan-report.txt not found at: $ReportPath"
    exit 1
}

$reportLines = Get-Content -LiteralPath $ReportPath -Encoding UTF8
$skills = New-Object System.Collections.Generic.List[hashtable]

$currentId   = $null
$currentPath = $null

foreach ($line in $reportLines) {
    # Match lines like: [12] context-compression
    if ($line -match '^\[(\d+)\]\s+(.+)$') {
        $currentId   = $Matches[2].Trim()
        $currentPath = $null
        continue
    }
    # Match path line: "    Path:    Agent-Skills-for-Context-Engineering\..."
    if ($null -ne $currentId -and $line -match '^\s+Path:\s+(.+)$') {
        $currentPath = $Matches[1].Trim()
        # Build full absolute path to the SKILL.md
        $fullSkillMd = Join-Path $SkillsRoot $currentPath
        $skills.Add(@{
            Id       = $currentId
            SkillMd  = $fullSkillMd
        })
        $currentId   = $null
        $currentPath = $null
    }
}

Write-Host ('Parsed ' + $skills.Count + ' skills from report.') -ForegroundColor Green

# ── Set up output folder ──────────────────────────────────────────────────────

$phobosRoot = Join-Path $OutputDir 'phobos'
$skillsOut  = Join-Path $phobosRoot 'skills'

$null = New-Item -ItemType Directory -Force -Path (Join-Path $skillsOut 'tools\prime')
$null = New-Item -ItemType Directory -Force -Path (Join-Path $skillsOut 'tools\reserve')
# core/ is expected to be seeded by seed-skills.js — we only create the directory
$null = New-Item -ItemType Directory -Force -Path (Join-Path $skillsOut 'core')

Write-Host ('Output root: ' + $skillsOut) -ForegroundColor Cyan

# ── Copy skills ───────────────────────────────────────────────────────────────

$primeCopied   = 0
$reserveCopied = 0
$dropped       = 0
$missing       = 0

$registryEntries = New-Object System.Collections.Generic.List[hashtable]

foreach ($skill in $skills) {
    $id = $skill.Id

    # Drop junk
    if ($DROP_SET.ContainsKey($id)) {
        $dropped++
        continue
    }

    # Check SKILL.md exists
    if (-not (Test-Path -LiteralPath $skill.SkillMd)) {
        $missing++
        Write-Warning ('Missing: ' + $skill.SkillMd)
        continue
    }

    # Determine tier
    $tier = if ($PRIME_SET.ContainsKey($id)) { 'prime' } else { 'reserve' }
    $destDir = Join-Path $skillsOut "tools\$tier\$id"
    $null = New-Item -ItemType Directory -Force -Path $destDir

    # Copy SKILL.md as instruction_manual.md
    Copy-Item -LiteralPath $skill.SkillMd -Destination (Join-Path $destDir 'instruction_manual.md') -Force

    # Read metadata for manifest
    $desc    = Get-FirstParagraph  -FilePath $skill.SkillMd
    $trigger = Get-SkillTrigger    -FilePath $skill.SkillMd

    # Escape for JSON
    $descJson    = $desc    -replace '\\', '\\' -replace '"', '\"'
    $triggerJson = $trigger -replace '\\', '\\' -replace '"', '\"'
    $nameJson    = ($id -replace '-', ' ') -replace '\\', '\\' -replace '"', '\"'

    $manifest = @"
{
  "id": "$id",
  "name": "$nameJson",
  "description": "$descJson",
  "version": "1.0.0",
  "scope": "both",
  "category": "tools",
  "trigger": "$triggerJson",
  "runner": null
}
"@
    $manifest | Set-Content -LiteralPath (Join-Path $destDir 'manifest.json') -Encoding UTF8

    $registryEntries.Add(@{
        id       = $id
        name     = ($id -replace '-', ' ')
        category = 'tools'
        tier     = $tier
        trigger  = $trigger
        path     = $destDir
    })

    if ($tier -eq 'prime') { $primeCopied++ } else { $reserveCopied++ }
}

# ── Write _registry.json ──────────────────────────────────────────────────────
# Minimal format — SkillManager.ts rebuilds the full registry from disk.
# This file just gives SkillManager a fast-path index on startup.

$regLines = New-Object System.Collections.Generic.List[string]
$regLines.Add('{')
$regLines.Add('  "version": "1.0",')
$regLines.Add('  "generated": "' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ') + '",')
$regLines.Add('  "note": "core/ skills are seeded separately by seed-skills.js",')
$regLines.Add('  "skills": [')

$entryCount = $registryEntries.Count
$entryIdx   = 0
foreach ($entry in $registryEntries) {
    $entryIdx++
    $comma = if ($entryIdx -lt $entryCount) { ',' } else { '' }
    $pathJson    = ($entry.path    -replace '\\', '/') -replace '"', '\"'
    $triggerJson = ($entry.trigger -replace '\\', '\\') -replace '"', '\"'
    $regLines.Add('    { "id": "' + $entry.id + '", "name": "' + ($entry.name -replace '"','\"') + '", "category": "tools", "tier": "' + $entry.tier + '", "trigger": "' + $triggerJson + '", "path": "' + $pathJson + '" }' + $comma)
}

$regLines.Add('  ]')
$regLines.Add('}')
$regLines | Set-Content -LiteralPath (Join-Path $skillsOut '_registry.json') -Encoding UTF8

# ── Summary ───────────────────────────────────────────────────────────────────

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host ('  Prime skills:   ' + $primeCopied)
Write-Host ('  Reserve skills: ' + $reserveCopied)
Write-Host ('  Dropped (junk): ' + $dropped)
Write-Host ('  Missing files:  ' + $missing)
Write-Host ''
Write-Host 'Output structure:' -ForegroundColor Yellow
Write-Host ('  ' + $skillsOut + '\core\         <- populated by seed-skills.js')
Write-Host ('  ' + $skillsOut + '\tools\prime\  <- ' + $primeCopied + ' skills')
Write-Host ('  ' + $skillsOut + '\tools\reserve\ <- ' + $reserveCopied + ' skills')
Write-Host ('  ' + $skillsOut + '\_registry.json')
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Yellow
Write-Host '  1. Copy phobos/ folder into your project root (alongside dual-reasoning/)'
Write-Host '  2. node scripts/seed-skills.js    <- installs 4 core skills'
Write-Host '  3. Start the server               <- SkillManager loads everything'
Write-Host ''
