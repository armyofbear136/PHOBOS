# Verify-PostSeed.ps1
# PowerShell 5 compatible.
#
# Run this AFTER seed-skills.js to confirm all 4 core skills were installed.
# Checks that instruction_manual.md, manifest.json, and _registry.json are correct.
#
# Usage:
#   .\Verify-PostSeed.ps1 -SkillsRoot ".\phobos\skills"

param(
    [string]$SkillsRoot = (Join-Path $PSScriptRoot 'phobos\skills')
)

$ErrorActionPreference = 'Stop'
$pass = 0
$fail = 0

function Write-Pass { param([string]$msg) Write-Host ('  PASS  ' + $msg) -ForegroundColor Green; $script:pass++ }
function Write-Fail { param([string]$msg) Write-Host ('  FAIL  ' + $msg) -ForegroundColor Red;  $script:fail++ }
function Write-Info { param([string]$msg) Write-Host ('        ' + $msg) -ForegroundColor Gray }

Write-Host ''
Write-Host 'Post-seed verification' -ForegroundColor Cyan
Write-Host ('Root: ' + $SkillsRoot)
Write-Host ''

# ── 1. All 4 core skills present ─────────────────────────────────────────────
Write-Host 'Checking 4 core skills...' -ForegroundColor Cyan

$coreSkills = @(
    'context-compression',
    'interleaved-thinking',
    'llm-as-judge',
    'reflexion-critique'
)

$coreDir = Join-Path $SkillsRoot 'core'
foreach ($id in $coreSkills) {
    $skillDir         = Join-Path $coreDir $id
    $manifestPath     = Join-Path $skillDir 'manifest.json'
    $instructionsPath = Join-Path $skillDir 'instruction_manual.md'

    if (-not (Test-Path $skillDir)) {
        Write-Fail ('Core skill directory missing: ' + $id)
        continue
    }
    if (-not (Test-Path $manifestPath)) {
        Write-Fail ('Core skill missing manifest.json: ' + $id)
    } else {
        try {
            $m = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($m.id -ne $id) {
                Write-Fail ('Core skill manifest id mismatch: ' + $id + ' vs ' + $m.id)
            } else {
                Write-Pass ('Core skill manifest valid: ' + $id)
            }
        } catch {
            Write-Fail ('Core skill manifest not valid JSON: ' + $id)
        }
    }

    if (-not (Test-Path $instructionsPath)) {
        Write-Fail ('Core skill missing instruction_manual.md: ' + $id)
    } else {
        $content = Get-Content -LiteralPath $instructionsPath -Raw -Encoding UTF8
        if ($content.Trim().Length -lt 50) {
            Write-Fail ('Core skill instruction_manual.md appears empty: ' + $id)
        } else {
            Write-Pass ('Core skill instruction_manual.md has content: ' + $id + ' (' + $content.Trim().Length + ' chars)')
        }
    }
}

# ── 2. _registry.json contains core skills ────────────────────────────────────
Write-Host ''
Write-Host 'Checking _registry.json...' -ForegroundColor Cyan

$regPath = Join-Path $SkillsRoot '_registry.json'
if (Test-Path $regPath) {
    try {
        $reg    = Get-Content -LiteralPath $regPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $ids    = $reg.skills | ForEach-Object { $_.id }
        $total  = ($ids | Measure-Object).Count
        Write-Pass ('_registry.json has ' + $total + ' total skills')

        foreach ($id in $coreSkills) {
            if ($ids -contains $id) {
                Write-Pass ('Registry contains core skill: ' + $id)
            } else {
                Write-Fail ('Registry missing core skill: ' + $id)
            }
        }

        # Check prime and reserve entries are also present
        $coreCount    = ($reg.skills | Where-Object { $_.category -eq 'core' } | Measure-Object).Count
        $toolsCount   = ($reg.skills | Where-Object { $_.category -eq 'tools' } | Measure-Object).Count
        Write-Pass ('Registry core entries: ' + $coreCount)
        Write-Pass ('Registry tools entries: ' + $toolsCount)

    } catch {
        Write-Fail ('_registry.json not valid JSON: ' + $_.Exception.Message)
    }
} else {
    Write-Fail '_registry.json missing'
}

# ── 3. Spot-check a core skill content is the right skill ────────────────────
Write-Host ''
Write-Host 'Content spot-checks...' -ForegroundColor Cyan

$checks = @(
    @{ id = 'context-compression';  keyword = 'compression' },
    @{ id = 'interleaved-thinking'; keyword = 'reasoning' },
    @{ id = 'llm-as-judge';         keyword = 'rubric' },
    @{ id = 'reflexion-critique';   keyword = 'reflexion' }
)
foreach ($check in $checks) {
    $skillCheckDir = Join-Path $coreDir $check.id
    $instructionsPath = Join-Path $skillCheckDir 'instruction_manual.md'
    if (Test-Path $instructionsPath) {
        $content = (Get-Content -LiteralPath $instructionsPath -Raw -Encoding UTF8).ToLower()
        if ($content.Contains($check.keyword)) {
            Write-Pass ('Content check OK: ' + $check.id + ' contains "' + $check.keyword + '"')
        } else {
            Write-Fail ('Content mismatch: ' + $check.id + ' does not contain "' + $check.keyword + '"')
        }
    } else {
        Write-Fail ('instruction_manual.md missing for: ' + $check.id)
    }
}

# ── 4. Quick prime/reserve sanity ─────────────────────────────────────────────
Write-Host ''
Write-Host 'Prime/reserve sanity...' -ForegroundColor Cyan

$primeFolders   = @(Get-ChildItem -Path (Join-Path $SkillsRoot 'tools\prime')   -Directory -ErrorAction SilentlyContinue)
$reserveFolders = @(Get-ChildItem -Path (Join-Path $SkillsRoot 'tools\reserve') -Directory -ErrorAction SilentlyContinue)

Write-Info ('Prime skill count:   ' + $primeFolders.Count)
Write-Info ('Reserve skill count: ' + $reserveFolders.Count)

if ($primeFolders.Count -ge 80) {
    Write-Pass ('Prime count in range (' + $primeFolders.Count + ')')
} else {
    Write-Fail ('Prime count low: ' + $primeFolders.Count + ' (expected 80+)')
}

if ($reserveFolders.Count -ge 500) {
    Write-Pass ('Reserve count in range (' + $reserveFolders.Count + ')')
} else {
    Write-Fail ('Reserve count low: ' + $reserveFolders.Count + ' (expected 500+)')
}

# Check a couple of prime skills have instruction_manual.md (not old sayon_context.md)
$oldNameFound = 0
foreach ($folder in $primeFolders) {
    $oldPath = Join-Path $folder.FullName 'sayon_context.md'
    if (Test-Path $oldPath) { $oldNameFound++ }
}
if ($oldNameFound -eq 0) {
    Write-Pass ('No legacy sayon_context.md files found in prime (correct)')
} else {
    Write-Fail ($oldNameFound.ToString() + ' prime skills still have sayon_context.md instead of instruction_manual.md')
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host ('Results: ' + $pass + ' passed, ' + $fail + ' failed') -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Yellow' })

if ($fail -eq 0) {
    Write-Host ''
    Write-Host 'All checks passed. Skills are ready. Start the server.' -ForegroundColor Green
    Write-Host '  npm run dev   (or however you start dual-reasoning)'
} else {
    Write-Host ''
    Write-Host ($fail.ToString() + ' check(s) failed. Review output above.') -ForegroundColor Red
}
Write-Host ''
