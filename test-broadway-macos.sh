#!/usr/bin/env bash
# test-broadway-macos.sh
# PHOBOS — Broadway + GIMP feasibility probe for macOS
#
# What it does:
#   1. Checks for Homebrew
#   2. Installs gtk+3 and gimp via Homebrew (if not present)
#   3. Checks whether the Homebrew gtk+3 bottle includes Broadway
#      (it usually does NOT — explains why and gives the build-from-source path)
#   4. If broadwayd is available, runs the same two-stage test as the Windows script
#   5. Prints a summary with concrete notes for SubprocessManager.ts
#
# Usage:
#   chmod +x test-broadway-macos.sh
#   ./test-broadway-macos.sh

set -euo pipefail

# ── colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'
YELLOW='\033[1;33m'; WHITE='\033[1;37m'; NC='\033[0m'

pass() { echo -e "  ${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "  ${RED}[FAIL]${NC} $*"; }
info() { echo -e "  ${CYAN}[INFO]${NC} $*"; }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $*"; }
head() { echo -e "\n${WHITE}=== $* ===${NC}"; }

BROADWAY_PORT=8085
BROADWAY_DISPLAY=':5'
BROADWAY_URL="http://localhost:${BROADWAY_PORT}"

# ── Step 1: Homebrew ──────────────────────────────────────────────────────────
head "Step 1 — Checking Homebrew"

if ! command -v brew &>/dev/null; then
    fail "Homebrew not found."
    info "Install from https://brew.sh then re-run."
    exit 1
fi

BREW_PREFIX="$(brew --prefix)"
pass "Homebrew found at $BREW_PREFIX"

# ── Step 2: Install gtk+3 and gimp ────────────────────────────────────────────
head "Step 2 — Installing gtk+3 and gimp via Homebrew"

for pkg in gtk+3 gimp; do
    if brew list "$pkg" &>/dev/null; then
        pass "$pkg already installed"
    else
        info "Installing $pkg (this may take several minutes)..."
        brew install "$pkg" || { warn "brew install $pkg failed — continuing"; }
    fi
done

# ── Step 3: Check for broadwayd ───────────────────────────────────────────────
head "Step 3 — Checking for broadwayd"

# Homebrew's pre-built gtk+3 bottle is compiled with the Quartz backend only.
# Broadway is a compile-time option (-Dbroadway-backend=true in meson).
# The bottle does NOT include broadwayd. We need to check.

GTK3_BIN="$BREW_PREFIX/bin"
BROADWAYD="$GTK3_BIN/broadwayd"
GTK3_DEMO="$GTK3_BIN/gtk3-demo"
GIMP_EXE=""

# GIMP from Homebrew is a cask (pre-built .app), not a formula binary.
# The .app bundles its own GTK and does NOT use the Homebrew gtk+3 install.
# We need to find the gimp binary inside the .app.
GIMP_APP_CANDIDATES=(
    "/Applications/GIMP.app/Contents/MacOS/gimp"
    "/Applications/GIMP-3.app/Contents/MacOS/gimp"
    "$HOME/Applications/GIMP.app/Contents/MacOS/gimp"
    "$HOME/Applications/GIMP-3.app/Contents/MacOS/gimp"
    "/Applications/GIMP 2.app/Contents/MacOS/gimp"
)
for candidate in "${GIMP_APP_CANDIDATES[@]}"; do
    if [ -f "$candidate" ]; then
        GIMP_EXE="$candidate"
        break
    fi
done

# Check broadwayd
BROADWAY_AVAILABLE=false
if [ -f "$BROADWAYD" ]; then
    pass "broadwayd found at $BROADWAYD"
    BROADWAY_AVAILABLE=true
else
    warn "broadwayd NOT found at $BROADWAYD"
    info ""
    info "The Homebrew gtk+3 bottle is compiled WITHOUT the Broadway backend."
    info "Broadway is a meson compile-time option: -Dbroadway-backend=true"
    info "The pre-built bottle uses only the Quartz (macOS native) backend."
    info ""
    info "To get broadwayd on macOS, you must build gtk+3 from source with Broadway enabled:"
    info ""
    info "  brew uninstall gtk+3  # remove the bottle"
    info "  brew install gtk+3 --build-from-source --with-broadway"
    info ""
    info "However, --with-broadway is NOT a standard Homebrew option for gtk+3."
    info "You need to pass the meson flag directly. Here's the full procedure:"
    info ""
    info "  STEP A: Get the gtk+3 source"
    info "    brew fetch --build-from-source gtk+3"
    info "    cd \$(brew --cache)/downloads  # find the .tar.xz"
    info ""
    info "  STEP B: Edit the Homebrew formula to add Broadway"
    info "    brew edit gtk+3"
    info "    # Add this inside the def install block:"
    info "    #   args << \"-Dbroadway-backend=true\""
    info ""
    info "  STEP C: Build and install"
    info "    brew install --build-from-source gtk+3"
    info ""
    info "  ALTERNATIVE: Build GTK3 manually alongside Homebrew"
    info "    GTK_VER=3.24.52"
    info "    curl -O https://download.gnome.org/sources/gtk+/3.24/gtk+-\${GTK_VER}.tar.xz"
    info "    tar xf gtk+-\${GTK_VER}.tar.xz && cd gtk+-\${GTK_VER}"
    info "    PKG_CONFIG_PATH=\"\$BREW_PREFIX/lib/pkgconfig\" \\"
    info "    meson setup build \\"
    info "      --prefix=\$HOME/.phobos/gtk3-broadway \\"
    info "      -Dbroadway-backend=true \\"
    info "      -Dx11-backend=false \\"
    info "      -Dwayland-backend=false"
    info "    ninja -C build && ninja -C build install"
    info "    # broadwayd will be at: \$HOME/.phobos/gtk3-broadway/bin/broadwayd"
    info ""
    info "  RECOMMENDATION FOR PHOBOS:"
    info "  Bundle a pre-built broadwayd binary for macOS (arm64 + x86_64)"
    info "  in the phobos-core release package. Ship it alongside the app."
    info "  Users should not need to build GTK3 from source."
    info ""
fi

# Check GIMP
if [ -n "$GIMP_EXE" ]; then
    pass "gimp found at $GIMP_EXE"
else
    warn "GIMP.app not found in /Applications or ~/Applications"
    info "Install GIMP from https://www.gimp.org/downloads/ or: brew install --cask gimp"
fi

# ── Step 4: Determine the GIMP + Broadway strategy for macOS ─────────────────
head "Step 4 — macOS Broadway + GIMP architecture analysis"

info "IMPORTANT macOS-specific constraint:"
info ""
info "The Homebrew 'gimp' cask installs a pre-built .app bundle."
info "This bundle ships its OWN copy of GTK3, compiled for Quartz."
info "Setting GDK_BACKEND=broadway on the cask's gimp binary will FAIL"
info "because that bundled GTK3 was not compiled with Broadway support."
info ""
info "To run GIMP under Broadway on macOS, you have two options:"
info ""
info "OPTION A: Build GIMP from source with a Broadway-enabled GTK3 (complex)"
info "  - Follow https://developer.gimp.org/core/setup/build/macos/"
info "  - Build gtk+3 from source with -Dbroadway-backend=true first"
info "  - Then build GIMP against that GTK3 using PKG_CONFIG_PATH"
info "  - Estimated: 2-4 hours of build time, ~10 GB disk"
info ""
info "OPTION B (RECOMMENDED): Use a standalone broadcast-aware GTK3 binary (lean)"
info "  - Build ONLY broadwayd + libgtk-3 with Broadway enabled"
info "  - Build a thin GTK3-based wrapper binary that acts as the GIMP bridge"
info "  - Ship broadwayd as a pre-built fat binary (arm64+x86_64) in the PHOBOS release"
info "  - For GIMP itself, use the standard .app but launch it natively"
info "    and use AppleScript/osascript for file open/save control"
info "    (not Broadway-embedded, but functional)"
info ""
info "OPTION C (PRAGMATIC): Native window capture via screenshot API"
info "  - Launch GIMP as a normal .app"
info "  - Capture its window via CGWindowListCreateImage or ScreenCaptureKit"
info "  - Stream frames to the PHOBOS frontend via a WebSocket MJPEG feed"
info "  - Requires screen recording permission but works with the stock .app"
info "  - This is essentially a lightweight RDP/VNC with zero X11 dependency"
info ""
warn "CONCLUSION: Broadway on macOS is NOT plug-and-play with the Homebrew stack."
warn "It requires either a custom GTK3 build or the MJPEG capture approach."

# ── Step 5: Test broadwayd if available ───────────────────────────────────────
if [ "$BROADWAY_AVAILABLE" = true ]; then
    head "Step 5 — Test broadwayd (available)"

    # Check port
    if lsof -i :"$BROADWAY_PORT" &>/dev/null; then
        warn "Port $BROADWAY_PORT already in use. Kill the process and re-run."
        exit 1
    fi

    info "Starting broadwayd on port $BROADWAY_PORT..."
    export GDK_BACKEND=broadway
    export BROADWAY_DISPLAY="$BROADWAY_DISPLAY"
    "$BROADWAYD" "$BROADWAY_DISPLAY" &
    BROADWAY_PID=$!

    # Wait for port to open
    ATTEMPTS=0
    while ! lsof -i :"$BROADWAY_PORT" &>/dev/null; do
        sleep 0.2
        ATTEMPTS=$((ATTEMPTS + 1))
        if [ $ATTEMPTS -gt 40 ]; then
            fail "broadwayd did not open port $BROADWAY_PORT after 8s"
            kill "$BROADWAY_PID" 2>/dev/null || true
            exit 1
        fi
    done
    pass "broadwayd listening on $BROADWAY_PORT (PID $BROADWAY_PID)"

    if [ -f "$GTK3_DEMO" ]; then
        info "Starting gtk3-demo..."
        "$GTK3_DEMO" &
        DEMO_PID=$!
        sleep 1

        info "Opening $BROADWAY_URL in browser..."
        open "$BROADWAY_URL"

        echo ""
        echo -e "  ${YELLOW}>> Verify: does gtk3-demo render in the browser?${NC}"
        echo -e "  ${YELLOW}>> Press ENTER when done...${NC}"
        read -r

        kill "$DEMO_PID" 2>/dev/null || true
    else
        warn "gtk3-demo not found — skipping demo test"
    fi

    kill "$BROADWAY_PID" 2>/dev/null || true
    pass "Test complete"
else
    head "Step 5 — broadwayd not available, skipping live test"
    info "Follow the instructions above to build GTK3 with Broadway support."
fi

# ── Step 6: Summary ───────────────────────────────────────────────────────────
head "Step 6 — Summary for SubprocessManager.ts (macOS)"

info "Homebrew prefix:  $BREW_PREFIX"
info "broadwayd:        $( [ -f "$BROADWAYD" ] && echo "$BROADWAYD" || echo 'NOT AVAILABLE (build from source)' )"
info "GIMP.app:         $( [ -n "$GIMP_EXE" ] && echo "$GIMP_EXE" || echo 'not found' )"

echo ""
cat <<'EOF'
  SubprocessManager.ts macOS config (if broadwayd is available):

  // broadwayd — must be built from source or bundled by PHOBOS
  SubprocessManager.spawn('broadway', {
    cmd:       broadwaydPath,  // e.g. path.join(os.homedir(), '.phobos', 'bin', 'broadwayd')
    args:      [':5'],
    port:      8085,
    readyLine: '',             // no stdout signal — use port-open detection
    env:       {
      DYLD_LIBRARY_PATH: path.join(broadwaydDir, '..', 'lib'),
    },
  });

  // GIMP — OPTION A (Broadway, requires custom GTK3 build)
  // Set GDK_BACKEND and point to the Broadway-enabled GTK3 libs:
  SubprocessManager.spawn('gimp', {
    cmd:  gimpBinaryPath,
    args: ['--no-splash'],
    env:  {
      GDK_BACKEND:        'broadway',
      BROADWAY_DISPLAY:   ':5',
      DYLD_LIBRARY_PATH:  path.join(broadwayGtk3LibDir),  // custom build libs
      GIMP_DIRECTORY:     path.join(os.homedir(), '.phobos', 'gimp-config'),
    },
    readyLine: 'Script-Fu',
  });

  // GIMP — OPTION C (native .app, no Broadway; use AppleScript for control)
  // For file open:
  //   execFile('osascript', ['-e', `tell application "GIMP" to open POSIX file "${filePath}"`])
  // For visibility:
  //   execFile('osascript', ['-e', 'tell application "GIMP" to activate'])

EOF

pass "macOS Broadway probe complete."
