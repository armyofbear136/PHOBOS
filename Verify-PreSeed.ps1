# Verify-PreSeed.ps1
# PowerShell 5 compatible.
#
# Run this BEFORE seed-skills.js to confirm the Build-SkillsFolder.ps1 output
# looks correct. Checks structure, file presence, and manifests. No changes made.
#
# Usage:
#   .\Verify-PreSeed.ps1 -SkillsRoot ".\phobos\skills"

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
Write-Host 'Pre-seed verification' -ForegroundColor Cyan
Write-Host ('Root: ' + $SkillsRoot)
Write-Host ''

# ── 1. Top-level directories exist ───────────────────────────────────────────
$expectedDirs = @('core', 'tools\prime', 'tools\reserve')
foreach ($d in $expectedDirs) {
    $full = Join-Path $SkillsRoot $d
    if (Test-Path $full) {
        Write-Pass ('Directory exists: ' + $d)
    } else {
        Write-Fail ('Directory missing: ' + $d)
    }
}

# ── 2. _registry.json exists and is valid JSON ────────────────────────────────
$regPath = Join-Path $SkillsRoot '_registry.json'
if (Test-Path $regPath) {
    try {
        $reg = Get-Content -LiteralPath $regPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $count = ($reg.skills | Measure-Object).Count
        Write-Pass ('_registry.json valid JSON, ' + $count + ' skill entries')
    } catch {
        Write-Fail ('_registry.json exists but is not valid JSON: ' + $_.Exception.Message)
    }
} else {
    Write-Fail '_registry.json missing'
}

# ── 3. Count prime and reserve folders ───────────────────────────────────────
$primeDir   = Join-Path $SkillsRoot 'tools\prime'
$reserveDir = Join-Path $SkillsRoot 'tools\reserve'

if (Test-Path $primeDir) {
    $primeFolders = @(Get-ChildItem -Path $primeDir -Directory -ErrorAction SilentlyContinue)
    Write-Pass ('Prime skill folders: ' + $primeFolders.Count)
    if ($primeFolders.Count -lt 80) {
        Write-Fail ('Expected 80+ prime skills, got ' + $primeFolders.Count)
    }
} else {
    Write-Fail 'tools\prime directory missing'
    $primeFolders = @()
}

if (Test-Path $reserveDir) {
    $reserveFolders = @(Get-ChildItem -Path $reserveDir -Directory -ErrorAction SilentlyContinue)
    Write-Pass ('Reserve skill folders: ' + $reserveFolders.Count)
    if ($reserveFolders.Count -lt 500) {
        Write-Fail ('Expected 500+ reserve skills, got ' + $reserveFolders.Count)
    }
} else {
    Write-Fail 'tools\reserve directory missing'
    $reserveFolders = @()
}

# ── 4. Spot-check required files in each skill folder ────────────────────────
Write-Host ''
Write-Host 'Spot-checking skill folder contents...' -ForegroundColor Cyan

$missingManifest    = 0
$missingInstructions = 0
$checked            = 0
$allFolders         = @($primeFolders) + @($reserveFolders)

foreach ($folder in $allFolders) {
    $manifestPath     = Join-Path $folder.FullName 'manifest.json'
    $instructionsPath = Join-Path $folder.FullName 'instruction_manual.md'

    if (-not (Test-Path $manifestPath))     { $missingManifest++     }
    if (-not (Test-Path $instructionsPath)) { $missingInstructions++ }
    $checked++
}

if ($missingManifest -eq 0) {
    Write-Pass ('All ' + $checked + ' skill folders have manifest.json')
} else {
    Write-Fail ($missingManifest + ' skill folders missing manifest.json')
}

if ($missingInstructions -eq 0) {
    Write-Pass ('All ' + $checked + ' skill folders have instruction_manual.md')
} else {
    Write-Fail ($missingInstructions + ' skill folders missing instruction_manual.md')
}

# ── 5. Spot-check a few specific prime skills that must be present ────────────
Write-Host ''
Write-Host 'Checking key prime skills...' -ForegroundColor Cyan

$requiredPrime = @(
    'typescript', 'python', 'react-web', 'nodejs-backend', 'security',
    'code-review', 'git-commit', 'copywriting', 'create-prd', 'user-stories',
    'context-compression', 'multi-agent-patterns', 'kreuzberg', 'vibesec-skill'
)
foreach ($id in $requiredPrime) {
    $skillPath = Join-Path $primeDir $id
    if (Test-Path $skillPath) {
        Write-Pass ('Prime skill present: ' + $id)
    } else {
        Write-Fail ('Prime skill missing: ' + $id)
    }
}

# ── 6. Verify manifest.json fields in a sample skill ─────────────────────────
Write-Host ''
Write-Host 'Validating manifest schema...' -ForegroundColor Cyan

$sampleId  = 'typescript'
$sampleDir = Join-Path $primeDir $sampleId
if (Test-Path $sampleDir) {
    try {
        $m = Get-Content -LiteralPath (Join-Path $sampleDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $requiredFields = @('id', 'name', 'description', 'version', 'scope', 'category', 'trigger', 'runner')
        $missingFields  = @()
        foreach ($f in $requiredFields) {
            if ($null -eq $m.$f -and $f -ne 'runner') { $missingFields += $f }
        }
        if ($missingFields.Count -eq 0) {
            Write-Pass ('manifest.json schema valid for: ' + $sampleId)
        } else {
            Write-Fail ('manifest.json missing fields in ' + $sampleId + ': ' + ($missingFields -join ', '))
        }
    } catch {
        Write-Fail ('Could not parse manifest.json for: ' + $sampleId)
    }
}

# ── 7. core/ exists but is empty (seed-skills.js populates it) ───────────────
Write-Host ''
Write-Host 'Checking core directory state...' -ForegroundColor Cyan

$coreDir = Join-Path $SkillsRoot 'core'
if (Test-Path $coreDir) {
    $coreContents = @(Get-ChildItem -Path $coreDir -ErrorAction SilentlyContinue)
    if ($coreContents.Count -eq 0) {
        Write-Pass ('core/ is empty and ready for seed-skills.js')
    } else {
        Write-Info ('core/ already has ' + $coreContents.Count + ' items -- seed-skills.js will update them')
    }
} else {
    Write-Fail 'core/ directory missing'
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host ('Results: ' + $pass + ' passed, ' + $fail + ' failed') -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Yellow' })

if ($fail -eq 0) {
    Write-Host ''
    Write-Host 'All checks passed. Ready to run seed-skills.js.' -ForegroundColor Green
    Write-Host '  node scripts\seed-skills.js'
} else {
    Write-Host ''
    Write-Host ($fail.ToString() + ' check(s) failed. Review output above before proceeding.') -ForegroundColor Red
}
Write-Host ''
