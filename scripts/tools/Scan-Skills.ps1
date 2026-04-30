# Scan-Skills.ps1
# PowerShell 5 compatible (Windows default shell).
# No ?? operator, no em-dashes, no curly braces inside double-quoted strings.
#
# Walks a directory of agent skill repos, finds every SKILL.md,
# extracts metadata, and writes:
#
#   scan-report.txt      -- human-readable list of what was found
#   seed-user-skills.js  -- Node.js script that installs skills into
#                           ~/.phobos/skills/tools/
#
# Usage:
#   .\Scan-Skills.ps1 -SkillsRoot "C:\Users\armyo\Phobos\agentskills\actualskills"
#
# After scanning:
#   1. Review scan-report.txt
#   2. Comment out unwanted skills in seed-user-skills.js
#   3. node seed-user-skills.js

param(
    [Parameter(Mandatory=$true)]
    [string]$SkillsRoot,

    [string]$OutputDir = $PSScriptRoot,

    [int]$MaxDepth = 6
)

$ErrorActionPreference = 'Stop'

# ── Exclusion lists ───────────────────────────────────────────────────────────

$ExcludeFolders = @(
    '.claude-plugin', '.claude', '.github', 'docs', 'references',
    'resources', 'examples', 'demos', 'scripts', 'agents', 'commands',
    'spec', 'dev_data', 'packages', 'assets', '.git', 'plugins'
)

$ExcludeRepos = @(
    'openai', 'gemini', 'fal-ai-community', 'replicate',
    'binance-skills-hub', 'googleworkspace', 'stripe', 'supabase',
    'cloudflare', 'cloudflare-skill', 'hashicorp', 'composiohq',
    'firecrawl', 'notion', 'whatsapp', 'wordpress', 'typefully',
    'sanity.io', 'netlify', 'vercel-labs', 'remotion', 'transloadit',
    'huggingface', 'linear-claude-skill', 'Rootly-MCP-server',
    'tinybird-agent-skills', 'ClickHouse', 'neondatabase', 'postgres',
    'aws-skills', 'terraform', 'terraform-skill', 'microsoft',
    'anthropics', 'n8n-skills', 'nutrient-agent-skill',
    'app-store-connect-cli-skills', 'claude-win11-speckit-update-skill',
    'claude-skill-homeassistant', 'ios-simulator-skill',
    'makepad-skills', 'SwiftUI-Agent-Skill', 'swift', 'swift-patterns-skill',
    'expo', 'callstackincubator', 'claude-apple-bridges',
    'pypict-claude-skill', 'screenshot', 'opc-skills',
    'VMware-AIops', 'materials-simulation-skills',
    'notebooklm-skill', 'videodb', 'tts', 'photogen'
)

# ── Helpers ───────────────────────────────────────────────────────────────────

function Get-SkillName {
    param([string]$FilePath)
    $folder = Split-Path (Split-Path $FilePath -Parent) -Leaf
    try {
        $lines = Get-Content -LiteralPath $FilePath -TotalCount 20 -Encoding UTF8
        foreach ($line in $lines) {
            if ($line -match '^#\s+(.+)') {
                return $Matches[1].Trim()
            }
        }
    } catch { }
    $name = ($folder -replace '-', ' ' -replace '_', ' ').ToLower()
    return (Get-Culture).TextInfo.ToTitleCase($name)
}

function Get-SkillDescription {
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
            if ($desc.Count -ge 3) { break }
        }
        if ($desc.Count -gt 0) {
            $joined = ($desc -join ' ') -replace '\s+', ' '
            if ($joined.Length -gt 200) { return $joined.Substring(0, 197) + '...' }
            return $joined
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

function Get-RepoName {
    param([string]$FullPath, [string]$Root)
    $rel = $FullPath.Substring($Root.Length).TrimStart('\', '/')
    return ($rel -split '[/\\]')[0]
}

function Test-IsExcluded {
    param([string]$RelPath, [string[]]$Excluded)
    $parts = $RelPath -split '[/\\]'
    foreach ($part in $parts) {
        if ($Excluded -contains $part) { return $true }
    }
    return $false
}

function ConvertTo-SafeId {
    param([string]$Name)
    return ($Name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
}

function Escape-JsSingle {
    # Escape for a JS single-quoted string literal
    param([string]$Text)
    $t = $Text -replace '\\', '\\\\'
    $t = $t -replace "'", "\'"
    $t = $t -replace "`r`n", ' '
    $t = $t -replace "`r", ' '
    $t = $t -replace "`n", ' '
    return $t
}

function Escape-JsTemplate {
    # Escape for a JS backtick template literal
    param([string]$Text)
    $t = $Text -replace '\\', '\\\\'
    $t = $t -replace '`', '\`'
    # Prevent JS template interpolation of ${...} sequences in skill content
    $t = $t -replace '\$\{', '`${'
    return $t
}

# ── Scan ──────────────────────────────────────────────────────────────────────

Write-Host ''
Write-Host "Scanning: $SkillsRoot" -ForegroundColor Cyan

$allFiles = Get-ChildItem -Path $SkillsRoot -Filter 'SKILL.md' -Recurse -ErrorAction SilentlyContinue

$skills  = New-Object System.Collections.Generic.List[hashtable]
$skipped = New-Object System.Collections.Generic.List[string]

foreach ($file in $allFiles) {
    $fullPath = $file.FullName
    $rel      = $fullPath.Substring($SkillsRoot.Length).TrimStart('\', '/')

    $depth = ($rel -split '[/\\]').Count
    if ($depth -gt $MaxDepth) {
        $skipped.Add('DEEP(' + $depth + '): ' + $rel)
        continue
    }

    if (Test-IsExcluded -RelPath $rel -Excluded $ExcludeFolders) {
        $skipped.Add('FOLDER: ' + $rel)
        continue
    }

    $repo = Get-RepoName -FullPath $fullPath -Root $SkillsRoot
    if ($ExcludeRepos -contains $repo) {
        $skipped.Add('REPO: ' + $rel)
        continue
    }

    $folderName = Split-Path (Split-Path $fullPath -Parent) -Leaf
    $id         = ConvertTo-SafeId -Name $folderName
    $name       = Get-SkillName       -FilePath $fullPath
    $desc       = Get-SkillDescription -FilePath $fullPath
    $trigger    = Get-SkillTrigger    -FilePath $fullPath

    $rawContent = ''
    try {
        $rawContent = Get-Content -LiteralPath $fullPath -Raw -Encoding UTF8
    } catch { }

    $skills.Add(@{
        Id         = $id
        Name       = $name
        Desc       = $desc
        Trigger    = $trigger
        Repo       = $repo
        FolderName = $folderName
        RelPath    = $rel
        Content    = $rawContent
    })
}

# Deduplicate by id, keeping the entry with the most content
$byId = @{}
foreach ($s in $skills) {
    $existing = $byId[$s.Id]
    if ($null -eq $existing -or $existing.Content.Length -lt $s.Content.Length) {
        $byId[$s.Id] = $s
    }
}

$deduped = $byId.Values | Sort-Object { $_.Repo + '/' + $_.FolderName }
$total   = @($deduped).Count

# ── scan-report.txt ───────────────────────────────────────────────────────────

$reportPath = Join-Path $OutputDir 'scan-report.txt'
$report = New-Object System.Collections.Generic.List[string]

$report.Add('PHOBOS Skill Scan Report')
$report.Add('Generated: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
$report.Add('Source:    ' + $SkillsRoot)
$report.Add('Found:     ' + $total + ' skills after dedup and exclusions')
$report.Add('Skipped:   ' + $skipped.Count + ' items')
$report.Add('')
$sep = '=' * 80
$report.Add($sep)
$report.Add('ACCEPTED SKILLS')
$report.Add($sep)

$i = 1
foreach ($s in $deduped) {
    $report.Add('')
    $report.Add('[' + $i + '] ' + $s.Id)
    $report.Add('    Name:    ' + $s.Name)
    $report.Add('    Repo:    ' + $s.Repo)
    $report.Add('    Path:    ' + $s.RelPath)
    $report.Add('    Desc:    ' + $s.Desc)
    $report.Add('    Trigger: ' + $s.Trigger)
    $i++
}

$report.Add('')
$report.Add($sep)
$report.Add('SKIPPED (' + $skipped.Count + ')')
$report.Add($sep)
foreach ($s in ($skipped | Sort-Object)) {
    $report.Add('  ' + $s)
}

$report | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host ('Report:    ' + $reportPath) -ForegroundColor Green

# ── seed-user-skills.js ───────────────────────────────────────────────────────

$seedPath = Join-Path $OutputDir 'seed-user-skills.js'
$js = New-Object System.Collections.Generic.List[string]

$js.Add('#!/usr/bin/env node')
$js.Add('// seed-user-skills.js')
$js.Add('// AUTO-GENERATED by Scan-Skills.ps1 on ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
$js.Add('// Skills: ' + $total)
$js.Add('//')
$js.Add('// 1. Review scan-report.txt')
$js.Add('// 2. Comment out skills you do not want')
$js.Add('// 3. node seed-user-skills.js')
$js.Add('')
$js.Add("import fs from 'fs/promises';")
$js.Add("import path from 'node:path';")
$js.Add("import os from 'node:os';")
$js.Add('')
$js.Add("const SKILLS_ROOT = path.join(os.homedir(), '.phobos', 'skills');")
$js.Add("const REGISTRY_PATH = path.join(SKILLS_ROOT, '_registry.json');")
$js.Add('')

# Emit each SKILL.md body as a JS const using a template literal
$js.Add('// Raw SKILL.md content for each skill')
foreach ($s in $deduped) {
    $varName   = 'SKILL_' + ($s.Id -replace '-', '_')
    $safebody  = Escape-JsTemplate -Text $s.Content
    $js.Add('const ' + $varName + ' = `' + $safebody + '`;')
    $js.Add('')
}

# Emit the SKILLS array
$js.Add('// Skill definitions -- comment out any you do not want')
$js.Add('const SKILLS = [')

foreach ($s in $deduped) {
    $varName     = 'SKILL_' + ($s.Id -replace '-', '_')
    $safeId      = Escape-JsSingle -Text $s.Id
    $safeName    = Escape-JsSingle -Text $s.Name
    $safeDesc    = Escape-JsSingle -Text $s.Desc
    $safeTrigger = Escape-JsSingle -Text $s.Trigger

    $js.Add('')
    $js.Add('  // ' + $s.Repo + ' / ' + $s.FolderName)
    $js.Add('  {')
    $js.Add("    dir: 'tools/" + $safeId + "',")
    $js.Add('    manifest: {')
    $js.Add("      id: '" + $safeId + "',")
    $js.Add("      name: '" + $safeName + "',")
    $js.Add("      description: '" + $safeDesc + "',")
    $js.Add("      version: '1.0.0',")
    $js.Add("      scope: 'both',")
    $js.Add("      category: 'tools',")
    $js.Add("      trigger: '" + $safeTrigger + "',")
    $js.Add('      runner: null,')
    $js.Add('    },')
    $js.Add('    sayon_context: ' + $varName + ',')
    $js.Add('    seren_context: null,')
    $js.Add('  },')
}

$js.Add('];')
$js.Add('')

# Emit the writer
$js.Add('async function main() {')
$js.Add("  await fs.mkdir(SKILLS_ROOT, { recursive: true });")
$js.Add('')
$js.Add('  var existing = { version: "1.0", generated: new Date().toISOString(), skills: [] };')
$js.Add('  try {')
$js.Add("    var raw = await fs.readFile(REGISTRY_PATH, 'utf-8');")
$js.Add('    existing = JSON.parse(raw);')
$js.Add('  } catch (e) { /* first run */ }')
$js.Add('')
$js.Add('  var newTools = [];')
$js.Add('')
$js.Add('  for (var i = 0; i < SKILLS.length; i++) {')
$js.Add('    var skill = SKILLS[i];')
$js.Add("    var skillDir = path.join(SKILLS_ROOT, skill.dir);")
$js.Add("    await fs.mkdir(skillDir, { recursive: true });")
$js.Add("    await fs.writeFile(path.join(skillDir, 'manifest.json'), JSON.stringify(skill.manifest, null, 2), 'utf-8');")
$js.Add('    if (skill.sayon_context) {')
$js.Add("      await fs.writeFile(path.join(skillDir, 'sayon_context.md'), skill.sayon_context, 'utf-8');")
$js.Add('    }')
$js.Add('    if (skill.seren_context) {')
$js.Add("      await fs.writeFile(path.join(skillDir, 'seren_context.md'), skill.seren_context, 'utf-8');")
$js.Add('    }')
$js.Add('    var entry = Object.assign({}, skill.manifest, { path: skillDir });')
$js.Add('    newTools.push(entry);')
$js.Add("    console.log('+ ' + skill.manifest.name + '  ->  ' + skillDir);")
$js.Add('  }')
$js.Add('')
$js.Add("  var coreSkills = (existing.skills || []).filter(function(s) { return s.category === 'core'; });")
$js.Add('  var merged = {')
$js.Add('    version: "1.0",')
$js.Add('    generated: new Date().toISOString(),')
$js.Add('    skills: coreSkills.concat(newTools),')
$js.Add('  };')
$js.Add('')
$js.Add("  await fs.writeFile(REGISTRY_PATH, JSON.stringify(merged, null, 2), 'utf-8');")
$js.Add("  console.log('Registry -> ' + REGISTRY_PATH);")
$js.Add("  console.log(SKILLS.length + ' tool skills installed.');")
$js.Add('}')
$js.Add('')
$js.Add('main().catch(function(err) { console.error(err); process.exit(1); });')

$js | Set-Content -LiteralPath $seedPath -Encoding UTF8
Write-Host ('Seed:      ' + $seedPath) -ForegroundColor Green

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Yellow
Write-Host '  1. Open scan-report.txt and review the skill list'
Write-Host '  2. Comment out any entries in seed-user-skills.js you do not want'
Write-Host '  3. node seed-user-skills.js'
Write-Host ''
