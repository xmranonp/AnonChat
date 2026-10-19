# Third-Party Licenses & Attribution

AnonChat itself is licensed under **AGPL-3.0-or-later** (see [LICENSE](LICENSE)).
It bundles or depends on the third-party components below. Each remains under its
own license; this file provides attribution and points to those licenses. When
redistributing binaries, include the full license texts of the bundled
components alongside this notice.

---

## Bundled at runtime (shipped inside the app)

### globe.gl — `public/vendor/globe.gl/`
- Version 2.46.1 · https://github.com/vasturiano/globe.gl
- License: **MIT** © Vasco Asturiano
- Renders the relay-map globe. Bundles **three.js** (r155, https://threejs.org),
  also **MIT** © three.js authors.

### Noto Emoji — `public/emoji/`
- https://github.com/googlefonts/noto-emoji
- Emoji artwork © Google, 128×128 PNG, shrunk to 256-colour PNG, under the **Apache License 2.0**. The pack is rebuilt into `public/emoji/` by `tools/build-emoji.mjs`.
- Country flags (`public/flags/`) are the pack's flag images, cropped to the flag and shrunk the same way.

### Unicode CLDR emoji annotations — `public/emoji-names.js`
- https://github.com/unicode-org/cldr-json (`cldr-annotations-full` and `cldr-annotations-derived-full`, English)
- The English names and keywords the emoji search uses, © Unicode, Inc., under the **Unicode License v3** (https://www.unicode.org/license.txt). Rebuilt by `tools/build-emoji-names.mjs`.

### Inter, Noto Sans Devanagari and IBM Plex Mono — `public/fonts/`, `desktop/splash/fonts/`
- **Inter** © The Inter Project Authors (https://github.com/rsms/inter), **Noto Sans Devanagari** © The Noto Project Authors (https://github.com/notofonts/devanagari) and **IBM Plex Mono** © IBM Corp. (https://github.com/IBM/plex), all under the **SIL Open Font License 1.1** (texts in `public/fonts/`). Shipped as script subsets (WOFF) so the interface looks the same on every system.

### Anyone Protocol `anon` daemon — `desktop/resources/runtime/anon[.exe]`
- Version v0.4.10.2 · https://github.com/anyone-protocol
- A fork of **Tor**; license: **BSD 3-Clause** © The Tor Project, Inc. and
  contributors. Provides the onion transport / hidden-service layer. Shipped as
  an unmodified upstream binary staged at build time (not part of this source
  tree); include its own LICENSE with any redistribution of the binary.

### Node.js runtime — `desktop/resources/runtime/node[.exe]`
- https://nodejs.org · License: **MIT** (Node.js contributors), with bundled
  components under their own licenses (see Node's own LICENSE). Staged at build
  time to run the backend inside the packaged app.

---

## Data (bundled)

### Natural Earth — `lib/country-centroids.json`, `lib/country-names.json`
- https://www.naturalearthdata.com
- **Public Domain.** Country centroids/names derived from Natural Earth vector
  data, used to place relay markers on the globe.

### IPFire libloc location database (downloaded at runtime, not bundled)
- https://location.ipfire.org
- Database content: **CC BY-SA 4.0** © IPFire Project.
- The DB is fetched over the anon SOCKS proxy on first run and cached locally; it
  is not part of this repository. AnonChat's reader (`lib/libloc.js`) and xz
  decompressor (`lib/xz.js`) are original AnonChat code under AGPL-3.0.

---

## Runtime npm dependencies

| Package | Version | License |
|---|---|---|
| express | 4.21.2 | MIT |
| axios | 1.18.1 | MIT |
| ws | 8.21.0 | MIT |
| socks-proxy-agent | 8.0.5 | MIT |

(Transitive dependencies are resolved via the committed lockfiles; `path-to-regexp`
and `qs` are pinned via `overrides` to patched versions. Run `npm ls` /
`npx license-checker` for the complete transitive list and their MIT/ISC/BSD
licenses.)

## Build-time tooling (not shipped in the app)

| Tool | Version | License |
|---|---|---|
| Electron | 42.4.1 | MIT |
| electron-builder | ^26.15.3 | MIT |

---

*Versions reflect the current lockfiles/vendored files at the time of writing;
verify against your build before publishing. If you add or update a bundled
component, update this file and include its license text in release artifacts.*

### Country flags — `public/flags/`
- Flag images shown in the picker and the exit-country list, one per country, taken
  from the **Noto Emoji** pack above (© Google; Apache License 2.0).

### Anyone logo — `public/anyone-logo.png`
- Shown on the welcome screen to identify the network AnonChat runs on. The Anyone
  name and logo are trademarks of their respective owner.
