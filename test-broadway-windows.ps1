# test-broadway-windows.ps1
# PHOBOS - Broadway + GIMP Windows integration test
# Updated April 2026 - matches confirmed working Session 26 configuration
#
# KEY FINDINGS from Session 26:
#   - GIMP 3.x uses GTK3 (not GTK4 despite version number)
#   - GTK3 broadwayd on Windows binds TWO ports:
#       8080 = HTTP frontend serving broadway2.html+JS to browsers
#       9090 = Raw binary protocol for GTK app connections
#   - BROADWAY_DISPLAY must be :tcp0 (not :0) to use TCP path
#       :tcp0 -> connects to 127.0.0.1:9090
#       GTK3 already has this path built in - no source patching needed
#   - broadwayd.exe takes NO display argument on Windows - run with no args
#   - GIMP requires --no-shm to suppress OpenFileMapping errors
#   - GIMP connects to port 9090, browser connects to port 8080
#   - There is no port conflict between these two

$ErrorActionPreference = 'Stop'

function Write-Pass { param($msg) Write-Host "  [PASS] $msg" -ForegroundColor Green }
function Write-Fail { param($msg) Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Write-Info { param($msg) Write-Host "  [INFO] $msg" -ForegroundColor Cyan }
function Write-Warn { param($msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Head { param($msg) Write-Host "`n=== $msg ===" -ForegroundColor White }

function Test-PortInUse {
    param([int]$Port)
    $tcp = [Net.Sockets.TcpClient]::new()
    try { $tcp.Connect('127.0.0.1', $Port); $tcp.Close(); return $true }
    catch { return $false }
}

function Wait-PortOpen {
    param([int]$Port, [int]$Secs = 20)
    $dl = (Get-Date).AddSeconds($Secs)
    while ((Get-Date) -lt $dl) {
        if (Test-PortInUse $Port) { return $true }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

function Get-PortPid {
    param([int]$Port)
    $lines = netstat -ano 2>$null | Select-String ":$Port\s"
    foreach ($line in $lines) {
        $parts = ($line.Line.Trim() -split '\s+')
        if ($parts.Count -ge 5) { return [int]$parts[-1] }
    }
    return $null
}

# ── Config ────────────────────────────────────────────────────────────────────
$MSYS2_ROOT = 'C:\msys64'
$UCRT64_BIN = "$MSYS2_ROOT\ucrt64\bin"
$BASH       = "$MSYS2_ROOT\usr\bin\bash.exe"

# GTK3 binary protocol port — GTK apps connect here
# :tcp0 display syntax = 9090 + 0 = 9090
$BROADWAY_BIN_PORT  = 9090

# GTK3 HTTP frontend port — browsers connect here
$BROADWAY_HTTP_PORT = 8080
$BROADWAY_URL       = "http://127.0.0.1:$BROADWAY_HTTP_PORT"

# BROADWAY_DISPLAY for GTK apps: :tcp0 routes to TCP 127.0.0.1:9090
# This is GTK3's built-in TCP syntax. No source patching required.
$BROADWAY_DISPLAY   = ':tcp0'

$BROADWAYD = "$UCRT64_BIN\broadwayd.exe"
$GTK3_DEMO = "$UCRT64_BIN\gtk3-demo.exe"
$GIMP_EXE  = "$UCRT64_BIN\gimp.exe"

# Full PATH for subprocess environment
$SYS_PATH  = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
$USR_PATH  = [Environment]::GetEnvironmentVariable('PATH', 'User')
$FULL_PATH = "$UCRT64_BIN;$MSYS2_ROOT\usr\bin;$SYS_PATH;$USR_PATH"

$spawnedProcs = [Collections.Generic.List[Diagnostics.Process]]::new()

function Stop-AllProcs {
    foreach ($p in $spawnedProcs) {
        if ($p -and -not $p.HasExited) {
            try {
                # Use taskkill /T to kill entire process tree (bash + children)
                & taskkill /F /T /PID $p.Id 2>$null | Out-Null
                $p.WaitForExit(2000) | Out-Null
            } catch {}
        }
    }
    $spawnedProcs.Clear()
}
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Stop-AllProcs }

# ── Spawn helper ──────────────────────────────────────────────────────────────
# NOTE: broadwayd is launched directly (not through bash)
# GIMP is launched through MSYS2 bash to inherit the full runtime environment
# including DLL search paths that GIMP depends on.
function Start-DirectProcess {
    param([string]$Exe, [string[]]$ArgList=@(), [hashtable]$Extra=@{})
    $si = [Diagnostics.ProcessStartInfo]::new()
    $si.FileName        = $Exe
    $si.Arguments       = $ArgList -join ' '
    $si.UseShellExecute = $false
    $si.CreateNoWindow  = $true
    $si.EnvironmentVariables['PATH'] = $FULL_PATH
    foreach ($kv in $Extra.GetEnumerator()) { $si.EnvironmentVariables[$kv.Key] = $kv.Value }
    $p = [Diagnostics.Process]::Start($si)
    $spawnedProcs.Add($p)
    return $p
}

function Start-GimpViaBash {
    param([string[]]$GimpArgs=@())
    # GIMP must launch through bash.exe --noprofile --norc so it inherits
    # the full MSYS2 ucrt64 runtime environment (DLL search paths, locale, etc.)
    $unixBin  = '/c/msys64/ucrt64/bin'
    $gimpArgs = ($GimpArgs | ForEach-Object { $_ }) -join ' '
    $bashCmd  = "export PATH=${unixBin}:/usr/bin:/c/msys64/usr/bin:`$PATH && ${unixBin}/gimp.exe $gimpArgs"

    $si = [Diagnostics.ProcessStartInfo]::new()
    $si.FileName        = $BASH
    $si.Arguments       = "--noprofile --norc -c `"$bashCmd`""
    $si.UseShellExecute = $false
    $si.CreateNoWindow  = $true

    # Windows PATH must include MSYS2 ucrt64 for DLL loading
    $si.EnvironmentVariables['PATH']             = $FULL_PATH
    $si.EnvironmentVariables['GDK_BACKEND']      = 'broadway'
    $si.EnvironmentVariables['BROADWAY_DISPLAY'] = $BROADWAY_DISPLAY
    $si.EnvironmentVariables['GDK_SCALE']        = '1'
    $si.EnvironmentVariables['GDK_DPI_SCALE']    = '1'

    $p = [Diagnostics.Process]::Start($si)
    $spawnedProcs.Add($p)
    return $p
}

function Stop-One {
    param([Diagnostics.Process]$p)
    if ($p -and -not $p.HasExited) {
        try { & taskkill /F /T /PID $p.Id 2>$null | Out-Null; $p.WaitForExit(2000) | Out-Null } catch {}
    }
    $spawnedProcs.Remove($p) | Out-Null
}

try {
    # ── Step 1: Verify binaries ───────────────────────────────────────────────
    Write-Head 'Step 1 - Verifying required binaries'
    $ok = $true
    foreach ($b in @($BASH, $BROADWAYD, $GTK3_DEMO, $GIMP_EXE)) {
        if (Test-Path $b) { Write-Pass "Found: $(Split-Path $b -Leaf)" }
        else {
            Write-Fail "Missing: $b"
            Write-Info "Install via MSYS2: pacman -S --noconfirm --needed mingw-w64-ucrt-x86_64-gtk3 mingw-w64-ucrt-x86_64-gimp"
            $ok = $false
        }
    }
    if (-not $ok) { exit 1 }

    # ── Step 2: Verify GTK3 broadwayd behavior ────────────────────────────────
    Write-Head 'Step 2 - Verify broadwayd (GTK3, no display arg)'
    Write-Info 'CRITICAL: GTK3 broadwayd.exe on Windows takes NO display argument'
    Write-Info "          It binds port $BROADWAY_BIN_PORT (binary/GTK) and $BROADWAY_HTTP_PORT (HTTP/browser)"
    Write-Info "          Browser connects to port $BROADWAY_HTTP_PORT"
    Write-Info "          GTK apps connect to port $BROADWAY_BIN_PORT via BROADWAY_DISPLAY=:tcp0"

    # Kill any existing processes
    Get-Process -Name 'broadwayd', 'gimp' -ErrorAction SilentlyContinue | ForEach-Object {
        & taskkill /F /T /PID $_.Id 2>$null | Out-Null
    }
    Start-Sleep -Milliseconds 500

    # Check port conflicts
    foreach ($port in @($BROADWAY_HTTP_PORT, $BROADWAY_BIN_PORT)) {
        if (Test-PortInUse $port) {
            $holder = Get-PortPid $port
            Write-Warn "Port $port is in use by PID $holder"
            Write-Warn "Free port $port before running this test"
            exit 1
        }
    }
    Write-Pass "Ports $BROADWAY_HTTP_PORT and $BROADWAY_BIN_PORT are free"

    # ── Step 3: broadwayd smoke test ──────────────────────────────────────────
    Write-Head 'Step 3 - broadwayd smoke test (no args)'
    $bdSmoke = Start-DirectProcess -Exe $BROADWAYD -Extra @{
        PATH = $FULL_PATH
    }
    Start-Sleep -Milliseconds 500

    if ($bdSmoke.HasExited) {
        Write-Fail "broadwayd exited immediately (code $($bdSmoke.ExitCode))"
        exit 1
    }
    Write-Pass "broadwayd running (PID $($bdSmoke.Id))"

    # Port 9090 is the binary protocol port — should open first
    if (Wait-PortOpen -Port $BROADWAY_BIN_PORT -Secs 10) {
        Write-Pass "Port $BROADWAY_BIN_PORT (GTK binary protocol) open"
    } else {
        Write-Fail "Port $BROADWAY_BIN_PORT not open after 10s"
        Stop-One $bdSmoke; exit 1
    }

    # Port 8080 should also open (HTTP frontend for browsers)
    if (Wait-PortOpen -Port $BROADWAY_HTTP_PORT -Secs 5) {
        Write-Pass "Port $BROADWAY_HTTP_PORT (HTTP browser frontend) open"
    } else {
        Write-Warn "Port $BROADWAY_HTTP_PORT not open - browser will not connect"
        Write-Info "This is non-fatal if port 8080 is blocked by another service"
    }

    Stop-One $bdSmoke
    Write-Pass 'broadwayd smoke test PASSED'

    # ── Step 4: gtk3-demo through Broadway ───────────────────────────────────
    Write-Head 'Step 4 - gtk3-demo through Broadway'
    Write-Info 'Starting broadwayd (no args)...'
    $bdProc = Start-DirectProcess -Exe $BROADWAYD -Extra @{ PATH = $FULL_PATH }

    if (-not (Wait-PortOpen -Port $BROADWAY_BIN_PORT -Secs 10)) {
        Write-Fail "broadwayd port $BROADWAY_BIN_PORT timeout"; exit 1
    }
    Write-Pass "broadwayd ready (PID $($bdProc.Id))"

    Write-Info "Starting gtk3-demo with BROADWAY_DISPLAY=$BROADWAY_DISPLAY..."
    $demoProc = Start-DirectProcess -Exe $GTK3_DEMO -Extra @{
        GDK_BACKEND      = 'broadway'
        BROADWAY_DISPLAY = $BROADWAY_DISPLAY
        PATH             = $FULL_PATH
    }

    Write-Info 'Waiting 4s for gtk3-demo to connect and render...'
    Start-Sleep -Seconds 4

    if ($demoProc.HasExited) {
        Write-Warn "gtk3-demo exited early (code $($demoProc.ExitCode))"
        Write-Info "This may be expected if gtk3-demo has no window to show without interaction"
    } else {
        Write-Pass "gtk3-demo running (PID $($demoProc.Id))"
    }

    Write-Info "Opening browser: $BROADWAY_URL"
    Start-Process $BROADWAY_URL
    Write-Host ''
    Write-Host '  You should see the GTK3 demo window in the browser.' -ForegroundColor Yellow
    Write-Host '  If white: wait a few seconds and press F5.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  >> Press ENTER when done' -ForegroundColor Yellow
    $null = Read-Host

    Stop-One $demoProc
    Stop-One $bdProc
    Write-Pass 'Step 4 done'

    # ── Step 5: GIMP through Broadway ─────────────────────────────────────────
    Write-Head 'Step 5 - GIMP through Broadway (the real test)'
    Write-Info 'GIMP startup takes 15-60s on first run (plugin scan).'
    Write-Info "BROADWAY_DISPLAY=$BROADWAY_DISPLAY  ->  TCP 127.0.0.1:$BROADWAY_BIN_PORT"
    Write-Info '--no-shm suppresses OpenFileMapping errors in script-fu'
    Write-Info 'Launching via bash.exe to inherit full MSYS2 DLL environment'

    # Kill anything leftover
    Get-Process -Name 'broadwayd', 'gimp' -ErrorAction SilentlyContinue | ForEach-Object {
        & taskkill /F /T /PID $_.Id 2>$null | Out-Null
    }
    Start-Sleep -Milliseconds 500

    Write-Info 'Starting broadwayd...'
    $bdProc2 = Start-DirectProcess -Exe $BROADWAYD -Extra @{ PATH = $FULL_PATH }

    if (-not (Wait-PortOpen -Port $BROADWAY_BIN_PORT -Secs 10)) {
        Write-Fail "broadwayd port $BROADWAY_BIN_PORT timeout"; exit 1
    }
    Write-Pass "broadwayd ready (PID $($bdProc2.Id))"

    # CRITICAL: wait 3 seconds after broadwayd is ready before spawning GIMP
    # broadwayd needs time to fully initialize its display after port 9090 opens
    Write-Info 'Waiting 3s for broadwayd to fully initialize display...'
    Start-Sleep -Seconds 3

    Write-Info 'Starting GIMP via bash (--no-splash --no-shm)...'
    $gimpProc = Start-GimpViaBash -GimpArgs @('--no-splash', '--no-shm')

    Write-Info 'Opening browser...'
    Start-Sleep -Seconds 2
    Start-Process $BROADWAY_URL

    Write-Host ''
    Write-Host '  GIMP is loading. Watch the browser.' -ForegroundColor Yellow
    Write-Host '  Expected timeline:' -ForegroundColor Cyan
    Write-Host '    0-5s:   Browser shows "broadway 2.0" waiting screen' -ForegroundColor Cyan
    Write-Host '    5-30s:  GIMP scanning plugins (system under load)' -ForegroundColor Cyan
    Write-Host '    30-60s: GIMP renders in browser' -ForegroundColor Cyan
    Write-Host '  Known warnings (harmless):' -ForegroundColor Cyan
    Write-Host '    - "GDK returned bogus values for the monitor resolution, using 96 dpi"' -ForegroundColor Cyan
    Write-Host '    - "window is not a native Win32 window"' -ForegroundColor Cyan
    Write-Host '    - "gdk_pixbuf_new_from_file_at_scale: assertion width > 0" (cosmetic)' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  >> Press ENTER when GIMP appears (or after 90s timeout)' -ForegroundColor Yellow
    $null = Read-Host

    if ($gimpProc.HasExited) {
        Write-Warn "GIMP exited (code $($gimpProc.ExitCode))"
        Write-Info 'Common causes:'
        Write-Info '  - Crash code 3221225620 (0xC0000094): divide-by-zero in monitor DPI probe'
        Write-Info '    -> Check GDK_SCALE=1 and GDK_DPI_SCALE=1 are set'
        Write-Info '  - Code 127: bash could not find gimp.exe'
        Write-Info '    -> Check MSYS2 ucrt64 path is correct'
        Write-Info '  - Code 1: broadwayd crashed when GIMP connected'
        Write-Info '    -> Ensure broadwayd was given 3s to initialize before GIMP spawned'
    } else {
        Write-Pass "GIMP running (PID $($gimpProc.Id)) - render confirmed"
    }

    Stop-One $gimpProc
    Stop-One $bdProc2

    # ── Step 6: DLL inventory ─────────────────────────────────────────────────
    Write-Head 'Step 6 - DLL inventory'
    foreach ($dll in @('libgtk-3-0.dll','libgdk-3-0.dll','libglib-2.0-0.dll','libgobject-2.0-0.dll','libgimp-3.0-0.dll','broadwayd.exe')) {
        $p = Join-Path $UCRT64_BIN $dll
        if (Test-Path $p) { Write-Pass "Found: $dll" }
        else { Write-Warn "Missing: $dll" }
    }

    # Verify GIMP links GTK3 (not GTK4)
    Write-Info 'Verifying GIMP links against libgtk-3-0.dll (expected for GIMP 3.x)...'
    $objdump = Join-Path $UCRT64_BIN 'objdump.exe'
    if (Test-Path $objdump) {
        $deps = & $objdump -p $GIMP_EXE 2>$null | Select-String 'libgtk'
        if ($deps -match 'libgtk-3') { Write-Pass "GIMP links libgtk-3-0.dll (correct - GIMP 3.x is GTK3)" }
        elseif ($deps -match 'libgtk-4') { Write-Warn "GIMP links libgtk-4! This is unexpected." }
        else { Write-Info "Could not determine GTK version from DLL deps" }
    }

    # ── Step 7: Write config ──────────────────────────────────────────────────
    Write-Head 'Step 7 - Writing PHOBOS broadway config'
    $cfgPath = Join-Path $env:USERPROFILE '.phobos\broadway-config.json'
    $cfgDir  = Split-Path $cfgPath
    if (-not (Test-Path $cfgDir)) { New-Item -ItemType Directory $cfgDir | Out-Null }

    $cfg = @{
        platform         = 'win32'
        msys2Root        = $MSYS2_ROOT -replace '\\','/'
        ucrt64Bin        = $UCRT64_BIN -replace '\\','/'
        bashPath         = $BASH       -replace '\\','/'
        broadwaydPath    = $BROADWAYD  -replace '\\','/'
        gimpPath         = $GIMP_EXE   -replace '\\','/'
        broadwayHttpPort = $BROADWAY_HTTP_PORT
        broadwayBinPort  = $BROADWAY_BIN_PORT
        broadwayDisplay  = $BROADWAY_DISPLAY
        gimpArgs         = @('--no-splash', '--no-shm')
        broadwaydArgs    = @()
        notes            = @(
            'broadwayd takes no display arg on Windows GTK3',
            'BROADWAY_DISPLAY=:tcp0 routes GTK apps to TCP 127.0.0.1:9090',
            'Browser connects to HTTP on port 8080',
            'GIMP must launch via bash.exe to inherit MSYS2 DLL environment',
            'Wait 3s after broadwayd ready before spawning GIMP'
        )
    } | ConvertTo-Json -Depth 5

    $cfg | Set-Content $cfgPath -Encoding UTF8
    Write-Pass "Config written to $cfgPath"

    Write-Head 'Summary'
    Write-Info "MSYS2 root:    $MSYS2_ROOT"
    Write-Info "ucrt64 bin:    $UCRT64_BIN"
    Write-Info "broadwayd:     no args -> ports $BROADWAY_HTTP_PORT (HTTP) + $BROADWAY_BIN_PORT (binary)"
    Write-Info "GIMP display:  BROADWAY_DISPLAY=$BROADWAY_DISPLAY -> TCP 127.0.0.1:$BROADWAY_BIN_PORT"
    Write-Info "Browser URL:   $BROADWAY_URL"
    Write-Pass 'Broadway Windows test complete.'

} finally {
    Stop-AllProcs
}
