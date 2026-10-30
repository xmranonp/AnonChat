# AnonChat — Build & Install Guide (Windows, macOS, Ubuntu/Debian, Arch, Fedora/openSUSE)

Complete steps to **compile** AnonChat on a build machine and **install** it on
new machines, for all five platforms — including `npm audit` and checksum
generation/verification.

> **Golden rule:** build each native package **on the same OS** you're targeting.
> electron-builder does not reliably cross-compile between Linux and Windows
> (a Linux host can't build the Windows `.exe`, and vice-versa). Build the `.deb`
> on Ubuntu, the `.pacman` on Arch, the `.rpm` on Fedora (or any machine with `rpmbuild`), the `.exe` on Windows, and the `.dmg` on a Mac
> (on Apple silicon for Apple silicon Macs, on an Intel Mac for Intel Macs).

---

## 0. Common prerequisites (every platform)

- **Node.js ≥ 22.12.0** (hard requirement — check with `node --version`).
- The **`anon` binary** for the target OS (Anyone Protocol daemon, v0.4.10.2):
  - Linux (Ubuntu/Debian, Arch, Fedora/openSUSE): the `anon` executable.
  - Windows: `anon.exe` (plus `anon-gencert.exe` and the `geoip`/`geoip6` files if
    your anon build ships them).
  - macOS: the `anon` executable for the Mac's architecture (Apple silicon or Intel). It must be
    self-contained: `prepare-resources.sh` warns if it links to libraries outside macOS (e.g. Homebrew's).
- The **source** — `git clone` the repo or unzip the project archive.

The build stages a private copy of Node + the `anon` binary into the package, so
the resulting installer is self-contained; end users do **not** need Node or anon.

**`npm ci`, not `npm install`:** `npm ci` installs exactly the versions recorded in `package-lock.json` (and stops if the lockfile
doesn't match `package.json`), so every build uses the same, already-audited components. Use `npm install <package>` only when
you mean to add or update a component; it rewrites the lockfile, which you then keep with the source. `npm test` checks that
both lockfiles still match their `package.json`.

---

## 1. Ubuntu / Debian → `.deb`

### 1a. Install build tools (once)
```bash
# Node 22 via NodeSource (Ubuntu's apt nodejs is usually too old):
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version         # must be >= 22.12.0
```

### 1b. Get the source and install dependencies
```bash
unzip AnonChat-main.zip                 # or: git clone <repo>
cd AnonChat-main

npm ci                                  # backend deps, exact versions from package-lock.json
npm audit --omit=dev                    # <-- audit runtime deps; triage any HIGH/CRITICAL
npm test                                # all code checks (36): crypto, storage, inbox limits, error answers, backups…
python3 tests/browser/run.py            # optional, ~40 min: real nodes and windows in Chromium (see tests/browser/README.md)

cd desktop
npm ci                                  # Electron + electron-builder, exact versions
npm audit                               # <-- audit build tooling
```

### 1c. Stage resources and build
The anon binary must be listed in `desktop/anon-sha256.txt` (its SHA-256, the platform and the version); the prepare scripts refuse any
other. The first time for a release and platform, the script stops and prints the line to add: check the downloaded archive against
the digest on the release page first, then add the line and commit it. The Node runtime is checked against Node's published
SHA-256 list on every platform (on Windows too), in a new private folder each run.
```bash
# From AnonChat-main/desktop — point ANON_BIN at your Linux anon binary:
ANON_BIN=/path/to/anon-v0.4.10.2/anon ./prepare-resources.sh
npm run build:deb                       # -> dist/  (.deb)
```

Check the Electron fuses were applied to the packaged app (all of RunAsNode, EnableNodeOptionsEnvironmentVariable and
EnableNodeCliInspectArguments must read **Disabled**; OnlyLoadAppFromAsar and EnableEmbeddedAsarIntegrityValidation **Enabled**):
```bash
npx @electron/fuses read --app dist/linux-unpacked/anonchat
```

Artifacts in `AnonChat-main/desktop/dist/`:
- `anonchat-desktop_1.0.0_amd64.deb`

### 1d. Generate checksums
```bash
cd ..                                   # back to repo root
npm run checksums                       # writes desktop/dist/SHA256SUMS.txt
```

---

### 1e. Install and verify the `.deb`
```bash
sudo apt install ./desktop/dist/anonchat-desktop_1.0.0_amd64.deb     # apt resolves the dependencies
dpkg-deb -I desktop/dist/anonchat-desktop_1.0.0_amd64.deb            # control data: Depends, Homepage, Maintainer
file /opt/AnonChat/resources/runtime/anon                            # must match the machine's architecture
anonchat                                                             # launch from a terminal the first time to see any errors
```
**Sandbox check.** Chromium never runs without its sandbox unless it is started with `--no-sandbox`, so if `anonchat` starts,
it is sandboxed. The package sets this up on install: where unprivileged user namespaces work it uses them, and on Ubuntu 23.10+
(where AppArmor restricts them) it installs an AppArmor profile for the app (`ls /etc/apparmor.d/anonchat`); on systems with no
user namespaces at all it makes `/opt/AnonChat/chrome-sandbox` setuid instead. Don't run the unpacked build in
`dist/linux-unpacked/` to test this: it has none of that set up and needs `--no-sandbox`.

**Running from source.** `npm start` (in `desktop/`) runs with the sandbox, like the installed app. On Linux machines where it
can't start (Electron then exits with a message about `chrome-sandbox` or user namespaces), `npm run start:nosandbox` or
`./launch-nosandbox.sh` run without it, for development only: the sandbox is what contains a bug in how the page handles other
people's images, audio or text.
Remove with `sudo apt remove anonchat-desktop`. User data stays in `~/.local/share/anonchat` (use Settings → Erase everything first to remove it).

---

### Updating the emoji pack
The picker and the country flags are generated from an emoji image pack (Noto Emoji naming, `emoji_u1f600.png`, 128 px). To use a different resolution or a newer release:
```bash
pip install pillow numpy                                   # once; used to shrink the images
node tools/build-emoji.mjs /path/to/the/pack/png/folder    # replaces public/emoji/ and public/flags/, rewrites public/emoji-data.js
npm test                                                    # checks that every emoji and flag has an image and none is left over
```
Categories and order come from `tools/emoji-categories.json`. Country flags (and the England, Scotland and Wales flags) come from the same pack. `tools/compress-pngs.py` turns the images into 256-colour PNGs (about a third of the size); an image that would visibly lose quality stays full colour. Nothing is replaced unless the whole build succeeds.

The emoji search names (`public/emoji-names.js`) come from Unicode CLDR. After changing the emoji set, rebuild them from the English annotation files of https://github.com/unicode-org/cldr-json:
```bash
node tools/build-emoji-names.mjs <cldr-annotations-full/annotations/en/annotations.json> <cldr-annotations-derived-full/annotationsDerived/en/annotations.json>
```

## 2. Arch / CachyOS → `.pacman`

### 2a. Install build tools (once)
```bash
sudo pacman -S nodejs npm fakeroot base-devel libxcrypt-compat
#                                                ^^^^^^^^^^^^^^^ REQUIRED:
# electron-builder's packager (fpm) is a Ruby program that needs libcrypt.so.1,
# which modern Arch doesn't ship by default. Without it the build fails with
# "libcrypt.so.1: cannot open shared object file".
node --version         # must be >= 22.12.0 (CachyOS ships current Node)
```

### 2b. Source + dependencies + audit
```bash
unzip AnonChat-main.zip
cd AnonChat-main
npm ci
npm audit --omit=dev
npm test

cd desktop
npm ci
npm audit
```

### 2c. Stage and build
```bash
ANON_BIN=/path/to/anon-v0.4.10.2/anon ./prepare-resources.sh
npm run build:pacman                    # -> dist/  (.pacman)
```

Artifacts in `AnonChat-main/desktop/dist/`:
- `AnonChat-1.0.0.pacman`

### 2d. Checksums
```bash
cd ..
npm run checksums                       # writes desktop/dist/SHA256SUMS.txt
```

---

## 3. Fedora / openSUSE → `.rpm`

### 3a. Install build tools (once)
```bash
sudo dnf install nodejs npm rpm-build libxcrypt-compat      # Fedora
# openSUSE: sudo zypper install nodejs22 npm22 rpm-build libcrypt1
node --version         # must be >= 22.12.0
```
The packager (fpm) needs `rpmbuild`; on Ubuntu (`sudo apt install rpm`) or Arch (`sudo pacman -S rpm-tools`) the same build also
works, but build and test on the distribution you ship for when you can.

### 3b. Source + dependencies + audit
```bash
unzip AnonChat-main.zip
cd AnonChat-main
npm ci
npm audit --omit=dev
npm test

cd desktop
npm ci
npm audit
```

### 3c. Stage and build
```bash
ANON_BIN=/path/to/anon-v0.4.10.2/anon ./prepare-resources.sh
npm run build:rpm                       # -> dist/  (.rpm)
```

Artifacts in `AnonChat-main/desktop/dist/`:
- `anonchat-desktop-1.0.0.x86_64.rpm`

The dependencies are written so one package installs on both Fedora and openSUSE, whose library packages have different names
(`gtk3` or `libgtk-3-0`, `nss` or `mozilla-nss`…). The sandbox is set up on install exactly as for the `.deb` (see 1e): both
distributions allow unprivileged user namespaces, so no setuid helper is needed.

### 3d. Checksums
```bash
cd ..
npm run checksums                       # writes desktop/dist/SHA256SUMS.txt
```

---

## 4. Windows → NSIS installer (`.exe`)

Run these in **PowerShell**.

### 4a. Install build tools (once)
- Install **Node.js 22 LTS** from https://nodejs.org (the MSI). Reopen PowerShell.
- `node --version` must be ≥ 22.12.0.

### 4b. Source + dependencies + audit
```powershell
# unzip the archive or git clone, then:
cd AnonChat-main
npm ci
npm audit --omit=dev
npm test

cd desktop
npm ci
npm audit
```

### 4c. Stage resources and build
```powershell
# If PowerShell blocks the script ("running scripts is disabled"):
Set-ExecutionPolicy -Scope Process -Bypass

$env:ANON_BIN = "C:\path\to\anon.exe"     # must be listed in desktop\anon-sha256.txt (see 1c)
.\prepare-resources.ps1                  # $env:NODE_ZIP = a local Node zip, if downloading isn't possible (still checked)
npm run build:win                       # -> dist\  (NSIS installer)
```

Artifact in `AnonChat-main\desktop\dist\`:
- `AnonChat Setup 1.0.0.exe`

### 4d. Checksums
```powershell
cd ..
npm run checksums                       # writes desktop\dist\SHA256SUMS.txt (works without sha256sum)
```

---

## 5. macOS → `.dmg`

Run these in **Terminal** on a Mac with the same architecture as the Macs you're targeting.

### 5a. Install build tools (once)
```bash
xcode-select --install                  # Apple's command-line tools (codesign, otool, lipo)
# Node.js 22 LTS: the macOS installer from https://nodejs.org, or: brew install node@22
node --version                          # must be >= 22.12.0
```

### 5b. Source + dependencies + audit
```bash
cd AnonChat-main
npm ci && npm audit --omit=dev && npm test
cd desktop
npm ci && npm audit
```

### 5c. Stage resources and build
```bash
ANON_BIN=/path/to/anon ./prepare-resources.sh    # detects macOS and the CPU; verifies the Node download's checksum
npm run build:mac                                 # -> dist/AnonChat-1.0.0-arm64.dmg (or -x64 on Intel)
npx @electron/fuses read --app dist/mac-arm64/AnonChat.app   # Intel: dist/mac/AnonChat.app; same expected values as Linux
```

### 5d. Signing and Gatekeeper
- **Without an Apple Developer ID** (the current setup) the app is only ad-hoc signed. macOS blocks the first launch of a
  downloaded copy: the user opens it once with right-click → **Open** (or System Settings → Privacy & Security → **Open Anyway**).
- **For public releases** get a Developer ID certificate (Apple Developer Program) into the build Mac's keychain, set
  `"notarize": true` under `build.mac` in `desktop/package.json`, and export `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID` before `npm run build:mac`. electron-builder then signs the app, the bundled `node` and `anon`, and notarizes it.
- The first voice message or call asks for microphone access (the reason shown is set in `build.mac.extendInfo`).
  The app never asks for the camera.

### 5e. Checksums
```bash
cd ..
npm run checksums                       # writes desktop/dist/SHA256SUMS.txt
```

---

## 6. Reading `npm audit`

- `npm audit --omit=dev` (root) checks the **runtime** dependencies that ship in
  the app. `npm audit` (desktop) checks the build tooling.
- Runtime versions (locked): axios 1.20.0, ws 8.22.0, express 4.22.3, qs 6.16.0, socks-proxy-agent 8.0.5;
  `path-to-regexp` and `qs` are set in `overrides` in package.json. **An override
  wins over `npm audit fix`**: when an advisory names one of them, raise the
  override itself, then `npm install`. A clean tree reports **0** in the root.
- Desktop: the sprintf-js chain (moderate) stays. It is inside electron-builder's
  Electron download, never ships, and its only fix downgrades electron-builder.
- If a new advisory appears: `npm audit fix` for compatible fixes; for anything
  that requires a major bump, review the changelog before applying. Never publish
  a release with an unresolved HIGH/CRITICAL in a runtime dependency.

---

## 7. Install on a NEW machine + verify

Copy the built package **and** `SHA256SUMS.txt` to the target machine, then verify
before installing.

### Ubuntu / Debian
```bash
sha256sum -c SHA256SUMS.txt             # must print "OK" for the .deb
sudo apt install ./anonchat-desktop_1.0.0_amd64.deb
#   apt automatically pulls the runtime deps:
#   libnotify4, libnss3, libxss1, libxtst6, xdg-utils
anonchat                                 # launch
```

### Arch / CachyOS
```bash
sha256sum -c SHA256SUMS.txt
sudo pacman -U AnonChat-1.0.0.pacman
#   pulls: libnotify, nss, libxss, libxtst, xdg-utils
anonchat
```

### Fedora / openSUSE
```bash
sha256sum -c SHA256SUMS.txt
sudo dnf install ./anonchat-desktop-1.0.0.x86_64.rpm         # Fedora; openSUSE: sudo zypper install ./anonchat-desktop-1.0.0.x86_64.rpm
anonchat
```
Remove with `sudo dnf remove anonchat-desktop` (openSUSE: `sudo zypper remove anonchat-desktop`). User data stays in `~/.local/share/anonchat`.

### Windows
```powershell
# Verify (PowerShell):
(Get-FileHash '.\AnonChat Setup 1.0.0.exe' -Algorithm SHA256).Hash.ToLower()
#   compare against the matching line in SHA256SUMS.txt, then:
```
Double-click **`AnonChat Setup 1.0.0.exe`** and follow the installer. The NSIS
installer is self-contained (bundles the Node runtime + `anon.exe`); no extra
runtime dependencies are required.
Unsigned installer blocked: SmartScreen → More info → Run anyway; Smart App Control → Windows Security → App & browser
control → Off (all programs; may not be reversible).

### macOS
```bash
shasum -a 256 -c SHA256SUMS.txt --ignore-missing   # must print "OK" for the .dmg
```
Open the `.dmg` and drag **AnonChat** to Applications. Unsigned builds: the first launch needs right-click → **Open** (see 5d).

---

## 8. First-run notes (all platforms)

- On first launch, `anon` bootstraps onto the network and publishes your hidden
  service; the relay-map geo database self-provisions over the SOCKS proxy within
  the first minute (you'll see `[relaygeo] libloc DB ready` in the backend log).
- Data lives in the OS-standard per-user location (`~/.local/share/anonchat` on
  Linux, `~/Library/Application Support/anonchat` on macOS, `%APPDATA%\anonchat` on
  Windows), all in one folder: the window's storage is its `window` subfolder. On Linux and macOS the folder is kept readable by your account only (0700).
- Uninstalling keeps that folder. Settings → Erase everything deletes it; the Windows uninstaller also asks (default: keep).
- Everything in that folder is encrypted with a data key kept by the OS vault (`keystore.json` holds it wrapped, never in the clear).
  On Linux that needs a running keyring (GNOME Keyring, or KWallet on KDE/CachyOS); without one, the first start asks for a passphrase.
  On macOS, an unsigned build may ask once for permission to use "AnonChat Safe Storage" in the Keychain: choose **Always Allow**.
- To check it worked: Settings → Security shows "Encrypted on this device", and `head -c 4 ~/.local/share/anonchat/data/contacts.json`
  prints `ACE1` (encrypted) instead of `[{` (plain JSON).
- To see backend logs on Linux, launch from a terminal: `anonchat`.

---

## Quick reference

| Platform | Install tools | Stage | Build | Output |
|---|---|---|---|---|
| Ubuntu/Debian | NodeSource Node 22 | `./prepare-resources.sh` | `npm run build:deb` | `.deb` |
| Arch/CachyOS | `nodejs npm fakeroot base-devel libxcrypt-compat` | `./prepare-resources.sh` | `npm run build:pacman` | `.pacman` |
| Fedora/openSUSE | `nodejs npm rpm-build libxcrypt-compat` | `./prepare-resources.sh` | `npm run build:rpm` | `.rpm` |
| Windows | Node 22 MSI | `.\prepare-resources.ps1` | `npm run build:win` | `Setup .exe` |
| macOS | Xcode CLT + Node 22 | `./prepare-resources.sh` | `npm run build:mac` | `.dmg` |

Audit every build: `npm audit --omit=dev` (root) + `npm audit` (desktop).
Checksum every release: `npm run checksums` → distribute `SHA256SUMS.txt`.

---

## 9. Publishing a release (what "Check for updates" reads)

Settings → Updates compares the running version (`version` in `package.json`)
with the **latest published GitHub release** of the repository named in
`package.json` → `repository.url`. It only reports and shows the release link;
it never downloads or installs anything, and it never opens a browser.

**Repository:** both package files point to `github.com/xmranonp/AnonChat`. If the
repository moves, change it in both, in this form:

```json
"repository": { "type": "git", "url": "git+https://github.com/<owner>/<repo>.git" }
```

(in `desktop/package.json` also set `"homepage"` to the same repository). Without
`repository.url`, the button reports that no update source is configured.

To make an update visible to users:

1. Bump `version` in **both** `package.json` and `desktop/package.json`.
2. Build and checksum on each target OS (sections 1–5, then `npm run checksums`).
3. On GitHub, create a release whose tag is `v<version>` (for example `v1.1.0`)
   and upload the installers plus `SHA256SUMS.txt`. Draft and pre-release
   entries are not returned by the "latest release" API, so users only see a
   release once it is published as a normal release.
4. Users click **Check for updates**; if the tag is newer than their version
   they get the release link to copy, and verify the download against
   `SHA256SUMS.txt` before installing.

**Network policy.** The check goes only through the Anyone SOCKS proxy; there is
no direct fallback. If the network can't reach GitHub, the check fails and
nothing is sent outside the Anyone network. The backend refuses to start if the
`SOCKS` environment variable points anywhere but loopback.
