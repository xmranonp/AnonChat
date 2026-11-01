# Building AnonChat

How to build the installers and check them. Each package is built **on the OS it is for**: electron-builder doesn't reliably cross-compile. Build the `.deb` on Ubuntu/Debian, the `.pacman` on Arch, the `.rpm` on Fedora (or anywhere with `rpmbuild`), the `.exe` on Windows and the `.dmg` on a Mac of the same CPU type as your target.

The installer is self-contained: it carries its own Node and `anon`, so end users install nothing else.

## What you need

- **Node.js 22.12 or newer** (`node --version`). On Ubuntu, take Node 22 from NodeSource, not apt's older one.
- The **`anon` binary** for the target OS (Anyone Protocol, v0.4.10.4-beta). On Windows also `anon.exe`'s companion files (`geoip`, `geoip6`) if your build ships them. On macOS it must be self-contained: the prepare script warns if it links to Homebrew libraries.
- The source (`git clone` or the project archive), checked out at the release tag.
- Extra tools: Arch needs `fakeroot base-devel libxcrypt-compat` (without `libxcrypt-compat` the build fails with "libcrypt.so.1: cannot open shared object file"); Fedora needs `rpm-build libxcrypt-compat` (openSUSE: `rpm-build libcrypt1`); macOS needs Xcode command-line tools (`xcode-select --install`).

Use **`npm ci`**, not `npm install`: it installs exactly what the lockfile records, so every build uses the same, already-checked packages. `npm install <package>` is only for adding or updating one on purpose; it rewrites the lockfile, which you then commit.

## 1. Check the code

From the repository root:

```bash
npm ci
npm audit --omit=dev      # runtime packages; never release with an unresolved HIGH/CRITICAL
npm test                  # all code checks
python3 tests/browser/run.py   # optional, about 40 minutes: real nodes and windows in Chromium

cd desktop
npm ci
npm audit                 # build tools
```

## 2. Stage and build

The `anon` binary must be listed in `desktop/anon-sha256.txt` (SHA-256, platform, version); the prepare scripts refuse any other. The first time for a release and platform, the script stops and prints the line to add: check the download against the digest on the release page first, then add the line and commit it. The Node runtime is checked against Node's published SHA-256 list on every platform.

Run these in `desktop/`:

| Platform | Stage | Build | Output in `dist/` |
|---|---|---|---|
| Ubuntu / Debian | `ANON_BIN=/path/to/anon ./prepare-resources.sh` | `npm run build:deb` | `.deb` |
| Arch / CachyOS | `ANON_BIN=/path/to/anon ./prepare-resources.sh` | `npm run build:pacman` | `.pacman` |
| Fedora / openSUSE | `ANON_BIN=/path/to/anon ./prepare-resources.sh` | `npm run build:rpm` | `.rpm` |
| Windows (PowerShell) | `$env:ANON_BIN="C:\path\anon.exe"; .\prepare-resources.ps1` | `npm run build:win` | `Setup .exe` |
| macOS | `ANON_BIN=/path/to/anon ./prepare-resources.sh` | `npm run build:mac` | `.dmg` |

On Windows, if PowerShell blocks the script, run `Set-ExecutionPolicy -Scope Process -Bypass` first. `$env:NODE_ZIP` can point to a local Node zip if downloading isn't possible (it is still checked).

Then check that the Electron fuses were applied. `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` must read **Disabled**; `OnlyLoadAppFromAsar` and `EnableEmbeddedAsarIntegrityValidation` **Enabled**:

```bash
npx @electron/fuses read --app dist/linux-unpacked/anonchat      # Windows: dist\win-unpacked\AnonChat.exe
                                                                   # macOS: dist/mac-arm64/AnonChat.app (Intel: dist/mac/AnonChat.app)
```

## 3. Install and check on a new machine

| Platform | Install |
|---|---|
| Ubuntu / Debian | `sudo apt install ./anonchat-desktop_<version>_amd64.deb` |
| Arch / CachyOS | `sudo pacman -U AnonChat-<version>.pacman` |
| Fedora | `sudo dnf install ./anonchat-desktop-<version>.x86_64.rpm` |
| openSUSE | `sudo zypper install ./anonchat-desktop-<version>.x86_64.rpm` |
| Windows | double-click the installer |
| macOS | drag the app to Applications |

Start it once from a terminal (`anonchat` on Linux) to see any errors. To remove it: `sudo apt remove anonchat-desktop` (or `dnf` / `zypper remove`, `pacman -R`); user data stays until you use Settings → Erase everything.

**Sandbox.** Chromium runs sandboxed unless started with `--no-sandbox`, so if the installed app starts, it is sandboxed. The Linux packages set this up on install: user namespaces where they work, an AppArmor profile on Ubuntu 23.10 and later (`ls /etc/apparmor.d/anonchat`), a setuid `chrome-sandbox` where there are no user namespaces. Don't test with the unpacked build in `dist/linux-unpacked/`: it has none of that and needs `--no-sandbox`. When running from source (`npm start` in `desktop/`) on a Linux machine where that fails, `npm run start:nosandbox` runs without it, for development only.

**Unsigned builds.** The installers are not signed yet. On Windows, SmartScreen says "More info → Run anyway". On macOS (ad-hoc signed), the first launch needs right-click → **Open**, or System Settings → Privacy & Security → **Open Anyway**. To sign for public releases on macOS, put a Developer ID certificate in the build Mac's keychain, set `"notarize": true` under `build.mac` in `desktop/package.json`, and export `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` before `npm run build:mac`.

**First run.** The first launch takes about a minute while `anon` joins the network and publishes the address. On Linux the key vault needs a running keyring (GNOME Keyring, or KWallet on KDE); without one, the first start asks for a passphrase. On macOS an unsigned build may ask once for access to "AnonChat Safe Storage" in the Keychain: choose **Always Allow**. To check that storage is encrypted, Settings → Security shows "Encrypted on this device", and `head -c 4 ~/.local/share/anonchat/data/contacts.json` prints `ACE1` instead of `[{`.
