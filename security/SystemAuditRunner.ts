/**
 * SystemAuditRunner.ts — Platform-native system hardening audit.
 *
 * No external binary dependency. All checks use Node.js child_process.execFile
 * with platform-branched commands. Produces SecurityFinding[] directly — no
 * raw text parsing via shell string interpolation.
 *
 * Supported platforms: linux, darwin, win32.
 * Unknown platforms return a single info finding.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify }              from 'node:util';
import { readFile }               from 'node:fs/promises';
import { existsSync }             from 'node:fs';
import type { Severity, SecurityFinding, ScanType } from '../db/SecurityStore.js';

const execFile = promisify(execFileCb);

const SCAN_TYPE: ScanType   = 'system_audit';
const EXEC_TIMEOUT_MS       = 30_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function finding(
  runId:    string,
  severity: Severity,
  title:    string,
  detail:   string | null = null,
  target:   string | null = null,
): Omit<SecurityFinding, 'id' | 'created_at'> {
  return { run_id: runId, scan_type: SCAN_TYPE, severity, title, detail, target, cve_id: null, is_new: true };
}

async function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, encoding: 'utf-8' });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

// ── Linux checks ──────────────────────────────────────────────────────────────

async function checkLinux(runId: string): Promise<Omit<SecurityFinding, 'id' | 'created_at'>[]> {
  const findings: Omit<SecurityFinding, 'id' | 'created_at'>[] = [];

  // SSH config — PermitRootLogin and PasswordAuthentication
  const sshConfig = '/etc/ssh/sshd_config';
  if (existsSync(sshConfig)) {
    try {
      const content = await readFile(sshConfig, 'utf-8');
      const rootLogin = content.match(/^\s*PermitRootLogin\s+(\S+)/mi);
      if (rootLogin && rootLogin[1].toLowerCase() !== 'no') {
        findings.push(finding(runId, 'high', 'SSH PermitRootLogin is not disabled',
          `Current value: ${rootLogin[1]}. Set PermitRootLogin no in /etc/ssh/sshd_config.`,
          sshConfig));
      }
      const pwAuth = content.match(/^\s*PasswordAuthentication\s+(\S+)/mi);
      if (pwAuth && pwAuth[1].toLowerCase() !== 'no') {
        findings.push(finding(runId, 'medium', 'SSH PasswordAuthentication is enabled',
          `Current value: ${pwAuth[1]}. Prefer key-based authentication.`,
          sshConfig));
      }
    } catch { /* non-fatal — file may require elevated read */ }
  }

  // Firewall — ufw or firewalld
  const ufw = await exec('which', ['ufw']);
  if (ufw.stdout.trim()) {
    const status = await exec('ufw', ['status']);
    if (!status.stdout.toLowerCase().includes('active')) {
      findings.push(finding(runId, 'high', 'ufw firewall is not active',
        'Run: sudo ufw enable'));
    }
  } else {
    const firewalld = await exec('which', ['firewall-cmd']);
    if (firewalld.stdout.trim()) {
      const status = await exec('firewall-cmd', ['--state']);
      if (!status.stdout.trim().toLowerCase().includes('running')) {
        findings.push(finding(runId, 'high', 'firewalld is not running',
          'Run: sudo systemctl start firewalld'));
      }
    } else {
      findings.push(finding(runId, 'info', 'No recognised firewall manager found',
        'ufw and firewalld were not detected. Ensure iptables rules are configured.'));
    }
  }

  // Disk encryption — check for LUKS volumes
  const lsblk = await exec('lsblk', ['-o', 'NAME,TYPE', '--json']);
  if (!lsblk.stdout.includes('crypt')) {
    const luks = await exec('which', ['cryptsetup']);
    if (luks.stdout.trim()) {
      findings.push(finding(runId, 'medium', 'No LUKS encrypted volumes detected',
        'Consider enabling full-disk encryption with cryptsetup.'));
    }
  }

  // Pending updates — apt, dnf, pacman
  const apt = await exec('which', ['apt']);
  if (apt.stdout.trim()) {
    const updates = await exec('apt-get', ['-s', 'upgrade']);
    const upgradable = (updates.stdout.match(/^Inst /gm) ?? []).length;
    if (upgradable > 0) {
      findings.push(finding(runId, 'low', `${upgradable} pending apt package update(s)`,
        'Run: sudo apt-get upgrade'));
    }
  } else {
    const dnf = await exec('which', ['dnf']);
    if (dnf.stdout.trim()) {
      const updates = await exec('dnf', ['check-update', '--quiet']);
      const lines = updates.stdout.trim().split('\n').filter(l => l && !l.startsWith('Last'));
      if (lines.length > 0) {
        findings.push(finding(runId, 'low', `${lines.length} pending dnf package update(s)`,
          'Run: sudo dnf upgrade'));
      }
    }
  }

  // Root-owned world-writable directories in common paths
  const wwCheck = await exec('find', ['/tmp', '/var/tmp', '-maxdepth', '1',
    '-perm', '-o+w', '-not', '-perm', '-1000', '-type', 'd']);
  for (const p of wwCheck.stdout.trim().split('\n').filter(Boolean)) {
    findings.push(finding(runId, 'medium', 'World-writable directory without sticky bit',
      'Add sticky bit: chmod +t <path>', p));
  }

  return findings;
}

// ── macOS checks ──────────────────────────────────────────────────────────────

async function checkDarwin(runId: string): Promise<Omit<SecurityFinding, 'id' | 'created_at'>[]> {
  const findings: Omit<SecurityFinding, 'id' | 'created_at'>[] = [];

  // SSH config
  const sshConfig = '/etc/ssh/sshd_config';
  if (existsSync(sshConfig)) {
    try {
      const content = await readFile(sshConfig, 'utf-8');
      const rootLogin = content.match(/^\s*PermitRootLogin\s+(\S+)/mi);
      if (rootLogin && rootLogin[1].toLowerCase() !== 'no') {
        findings.push(finding(runId, 'high', 'SSH PermitRootLogin is not disabled',
          `Current value: ${rootLogin[1]}.`, sshConfig));
      }
    } catch { /* non-fatal */ }
  }

  // Firewall — Application Firewall (socketfilterfw)
  const fw = await exec('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']);
  if (!fw.stdout.toLowerCase().includes('enabled')) {
    findings.push(finding(runId, 'high', 'macOS Application Firewall is disabled',
      'Enable in System Settings → Network → Firewall.'));
  }

  // FileVault — disk encryption
  const fv = await exec('fdesetup', ['status']);
  if (!fv.stdout.toLowerCase().includes('on')) {
    findings.push(finding(runId, 'medium', 'FileVault disk encryption is not enabled',
      'Enable in System Settings → Privacy & Security → FileVault.'));
  }

  // Gatekeeper
  const gk = await exec('spctl', ['--status']);
  if (!gk.stdout.toLowerCase().includes('enabled') && !gk.stderr.toLowerCase().includes('enabled')) {
    findings.push(finding(runId, 'high', 'Gatekeeper is disabled',
      'Enable with: sudo spctl --master-enable'));
  }

  // SIP — System Integrity Protection
  const sip = await exec('csrutil', ['status']);
  if (!sip.stdout.toLowerCase().includes('enabled')) {
    findings.push(finding(runId, 'high', 'System Integrity Protection (SIP) is disabled',
      'Boot into Recovery Mode and run: csrutil enable'));
  }

  // Software updates
  const updates = await exec('softwareupdate', ['-l']);
  if (updates.stdout.includes('*') || updates.stdout.toLowerCase().includes('recommended')) {
    findings.push(finding(runId, 'low', 'Pending macOS software updates available',
      'Run: softwareupdate --install --all'));
  }

  return findings;
}

// ── Windows checks ────────────────────────────────────────────────────────────

async function checkWin32(runId: string): Promise<Omit<SecurityFinding, 'id' | 'created_at'>[]> {
  const findings: Omit<SecurityFinding, 'id' | 'created_at'>[] = [];

  // Windows Defender Firewall — all three profiles
  const fw = await exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-NetFirewallProfile | Select-Object Name,Enabled | ConvertTo-Json',
  ]);
  if (fw.stdout.trim()) {
    try {
      const profiles: { Name: string; Enabled: boolean }[] = JSON.parse(fw.stdout);
      for (const p of (Array.isArray(profiles) ? profiles : [profiles])) {
        if (!p.Enabled) {
          findings.push(finding(runId, 'high', `Windows Defender Firewall disabled: ${p.Name} profile`,
            'Enable via: Set-NetFirewallProfile -Profile ' + p.Name + ' -Enabled True'));
        }
      }
    } catch { /* parse failure — non-fatal */ }
  }

  // BitLocker — OS drive encryption status
  const bl = await exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction SilentlyContinue).ProtectionStatus',
  ]);
  const blStatus = bl.stdout.trim().toLowerCase();
  if (blStatus === '0' || blStatus === 'off') {
    findings.push(finding(runId, 'medium', 'BitLocker disk encryption is not enabled on the OS drive',
      'Enable via: Manage-bde -on C: -RecoveryPassword'));
  }

  // Windows Defender real-time protection
  const wd = await exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-MpPreference -ErrorAction SilentlyContinue).DisableRealtimeMonitoring',
  ]);
  if (wd.stdout.trim().toLowerCase() === 'true') {
    findings.push(finding(runId, 'high', 'Windows Defender real-time protection is disabled',
      'Enable via: Set-MpPreference -DisableRealtimeMonitoring $false'));
  }

  // UAC status
  const uac = await exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System).EnableLUA',
  ]);
  if (uac.stdout.trim() === '0') {
    findings.push(finding(runId, 'high', 'User Account Control (UAC) is disabled',
      'Enable via: Set-ItemProperty -Path HKLM:\\...\\System -Name EnableLUA -Value 1'));
  }

  // Pending Windows Updates
  const wu = await exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search("IsInstalled=0").Updates.Count',
  ]);
  const count = parseInt(wu.stdout.trim(), 10);
  if (!isNaN(count) && count > 0) {
    findings.push(finding(runId, 'low', `${count} pending Windows Update(s)`,
      'Install via Settings → Windows Update.'));
  }

  return findings;
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function runSystemAudit(
  runId: string,
): Promise<Omit<SecurityFinding, 'id' | 'created_at'>[]> {
  const platform = process.platform;

  if (platform === 'linux')  return checkLinux(runId);
  if (platform === 'darwin') return checkDarwin(runId);
  if (platform === 'win32')  return checkWin32(runId);

  return [
    finding(runId, 'info', `System audit not implemented for platform: ${platform}`,
      'Supported platforms: linux, darwin, win32.'),
  ];
}
