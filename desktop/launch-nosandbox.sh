#!/usr/bin/env bash
# launch-nosandbox.sh — start AnonChat in dev mode WITHOUT the Chromium sandbox (same as `npm run start:nosandbox`).
# Only for Linux machines where the sandbox can't start at all (nosuid filesystems, restricted VMs, AppArmor blocking user
# namespaces). Without the sandbox, a bug in the page's image, audio or text handling is much more dangerous, and AnonChat shows
# content from other people: prefer `npm start`, and never use this for real conversations. Installed packages always use the sandbox.
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ELECTRON_DISABLE_SANDBOX=1
exec "$HERE/node_modules/.bin/electron" "$HERE" \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-gpu-sandbox
