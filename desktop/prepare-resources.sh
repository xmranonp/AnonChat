#!/usr/bin/env bash
# Stages everything the desktop build bundles:
#   desktop/resources/app/      server.js, start.js, package.json, lib/, public/, app_modules/
#   desktop/resources/runtime/  node (portable runtime) and anon
# Usage: ANON_BIN=~/anon-v0.4.10.2/anon ./prepare-resources.sh
# Runs on Linux (for the .deb / pacman builds) and macOS (for the .dmg); the Node runtime matches this machine's OS and CPU.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$HERE/.." && pwd)"
RES="$HERE/resources"
NODE_VERSION="${NODE_VERSION:-22.23.1}"

echo "==> AnonChat resource staging"
echo "    project root: $PROJECT_ROOT"
echo "    resources:    $RES"

if [[ -z "${ANON_BIN:-}" ]]; then
  echo "!! ANON_BIN is required. Download anon v0.4.10.2+ from" >&2
  echo "   https://github.com/anyone-protocol/ator-protocol/releases" >&2
  echo "   then: ANON_BIN=/path/to/anon ./prepare-resources.sh" >&2
  exit 1
fi
if [[ -d "$ANON_BIN" ]]; then
  if [[ -f "$ANON_BIN/anon" ]]; then
    ANON_BIN="$ANON_BIN/anon"
  else
    echo "!! ANON_BIN is a folder with no 'anon' file inside: $ANON_BIN" >&2
    echo "   Contents:" >&2; ls -1 "$ANON_BIN" | sed 's/^/     /' >&2
    echo "   Point ANON_BIN at the anon executable itself." >&2
    exit 1
  fi
fi
if [[ ! -f "$ANON_BIN" ]]; then
  echo "!! ANON_BIN not found: $ANON_BIN" >&2
  exit 1
fi
echo "    anon:         $ANON_BIN"

case "$(uname -s)" in
  Linux)  NODE_OS=linux;  NODE_EXT=tar.xz ;;
  Darwin) NODE_OS=darwin; NODE_EXT=tar.gz ;;
  *) echo "!! unsupported OS $(uname -s): use prepare-resources.ps1 on Windows" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) echo "!! unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
echo "    target:       $NODE_OS-$NODE_ARCH"

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

echo "==> staging Node runtime"
mkdir -p "$RES/runtime"
NODE_NAME="node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}.${NODE_EXT}"
if [[ -z "${NODE_TARBALL:-}" ]]; then
  NODE_TARBALL="/tmp/${NODE_NAME}"
  if [[ ! -f "$NODE_TARBALL" ]]; then
    URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_NAME}"
    echo "    downloading $URL"
    curl -fsSL "$URL" -o "$NODE_TARBALL"
  fi
fi
# Check the runtime against the SHA-256 list Node publishes for this release before bundling it.
SUMS="$(curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt")" || { echo "!! could not fetch Node's SHASUMS256.txt" >&2; exit 1; }
WANT="$(printf '%s\n' "$SUMS" | awk -v f="$NODE_NAME" '$2 == f { print $1 }')"
GOT="$(sha256_of "$NODE_TARBALL")"
if [[ -z "$WANT" || "$WANT" != "$GOT" ]]; then
  echo "!! Node runtime checksum mismatch for $NODE_NAME" >&2
  echo "   expected: ${WANT:-<not listed>}" >&2
  echo "   got:      $GOT" >&2
  echo "   Delete $NODE_TARBALL and run again." >&2
  exit 1
fi
echo "    checksum OK ($GOT)"
TMPN="$(mktemp -d)"
tar -xf "$NODE_TARBALL" -C "$TMPN"
NODE_BIN="$(find "$TMPN" -maxdepth 3 -name node -type f | head -1)"
if [[ -z "$NODE_BIN" ]]; then
  echo "!! could not find 'node' inside $NODE_TARBALL" >&2; exit 1
fi
cp "$NODE_BIN" "$RES/runtime/node"
chmod +x "$RES/runtime/node"
rm -rf "$TMPN"
BUNDLED_NODE="$RES/runtime/node"
echo "    node -> $("$BUNDLED_NODE" --version)"

echo "==> staging app code"
rm -rf "$RES/app"
mkdir -p "$RES/app"
cp "$PROJECT_ROOT/server.js" "$RES/app/"
cp "$PROJECT_ROOT/start.js"  "$RES/app/"
cp "$PROJECT_ROOT/package.json" "$RES/app/"
[[ -f "$PROJECT_ROOT/package-lock.json" ]] && cp "$PROJECT_ROOT/package-lock.json" "$RES/app/"
cp -r "$PROJECT_ROOT/lib"    "$RES/app/"
cp -r "$PROJECT_ROOT/public" "$RES/app/"

echo "==> installing production node_modules"
echo "    using node: $BUNDLED_NODE ($("$BUNDLED_NODE" --version))"

export PATH="$(dirname "$BUNDLED_NODE"):$PATH"

# npm ci when a lockfile is present (exact versions), otherwise npm install.
( cd "$RES/app" && \
  if [[ -f package-lock.json ]]; then
    echo "    lockfile found -> npm ci (reproducible, exact versions)"
    npm ci --omit=dev --no-audit --no-fund --loglevel=warn
  else
    echo "    ####################################################################"
    echo "    ## WARNING: no package-lock.json — this build is NOT reproducible. ##"
    echo "    ## Dependency versions may differ between machines/dates and cause ##"
    echo "    ## drift bugs. Fix permanently: run 'npm install' at the repo root ##"
    echo "    ## and commit package-lock.json, then rebuild.                     ##"
    echo "    ####################################################################"
    npm install --omit=dev --no-audit --no-fund --loglevel=warn
  fi )

# electron-builder strips directories named node_modules from extraResources; rename so it survives (start.js points NODE_PATH here).
if [[ -d "$RES/app/node_modules" ]]; then
  rm -rf "$RES/app/app_modules"
  mv "$RES/app/node_modules" "$RES/app/app_modules"
  echo "    node_modules -> app_modules (survives electron-builder packaging)"
fi

echo "==> staging anon binary"
cp "$ANON_BIN" "$RES/runtime/anon"
chmod +x "$RES/runtime/anon"
if [[ "$NODE_OS" == darwin ]]; then
  xattr -c "$RES/runtime/anon" 2>/dev/null || true          # drop the download quarantine flag; the app build signs it
  # The bundled anon must run on Macs without Homebrew: it may link only to macOS's own libraries.
  FOREIGN="$(otool -L "$RES/runtime/anon" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)' || true)"
  if [[ -n "$FOREIGN" ]]; then
    echo "!! WARNING: this anon binary links to libraries that other Macs won't have:" >&2
    printf '     %s\n' $FOREIGN >&2
    echo "   Use a self-contained anon build for macOS, or the app will fail to start on machines without them." >&2
  fi
  ANON_ARCH="$(lipo -archs "$RES/runtime/anon" 2>/dev/null || true)"
  [[ -n "$ANON_ARCH" ]] && echo "    anon architectures: $ANON_ARCH (this Mac: $NODE_ARCH)"
fi
echo "    anon staged"

echo ""
echo "==> done. Resources ready under $RES"
echo ""
echo "    Next steps:"
echo "      cd $HERE"
echo "      npm ci             # one-time: fetches Electron + electron-builder (exact versions)"
echo "      npm start          # dev mode (sandboxed; npm run start:nosandbox only if the sandbox can't start)"
if [[ "$NODE_OS" == darwin ]]; then
  echo "      npm run build:mac  # produces dist/AnonChat-*.dmg"
else
  echo "      npm run build      # produces dist/*.deb and dist/*.pacman (or: npm run build:deb / build:pacman)"
fi
