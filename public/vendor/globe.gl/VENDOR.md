# Vendored: globe.gl

Locally vendored third-party dependency for the relay world-map feature.
Pinned and served same-origin so it loads under the renderer's strict CSP
(`script-src 'self'`, no `eval`/`unsafe-eval`).

| | |
|---|---|
| **Package** | `globe.gl` |
| **Version** | 2.46.1 |
| **File** | `globe.gl.min.js` (UMD bundle) |
| **Upstream** | https://github.com/vasturiano/globe.gl |
| **License** | MIT |

## What this bundle contains

The UMD bundle is **self-contained**: `three.js` (MIT) and `d3-*` (ISC/BSD)
are compiled in. There is **no external `three` dependency** and **no import
map** is required — loading `globe.gl.min.js` as a classic `<script>` defines
the global `Globe` factory.

For that reason only `globe.gl.min.js` is vendored. The standalone
`three.*.js` builds shipped in the upstream tarball are **not needed** and are
intentionally omitted to keep the bundle minimal.

## CSP / sandbox notes

- **No `eval` / `new Function` executes at runtime.** The bundle contains one
  lodash `Function("return this")()` global-detection fallback, but it is
  short-circuited by `self.Object === Object` in any browser-like renderer, so
  it never runs. No `'unsafe-eval'` is required.
- Runtime `<style>` injection (globe.gl tooltip/label CSS) is covered by the
  existing `style-src 'self' 'unsafe-inline'`.
- The shell loads **no remote assets** (no CDN textures, no tiles). Any future
  earth texture or country GeoJSON must also be vendored here and referenced
  same-origin (`img-src 'self'` / `connect-src 'self'`).

## License compliance (AGPL build)

globe.gl, three.js and d3 are MIT/ISC/BSD — permissive and compatible with
AnonChat's AGPL-3.0-or-later license. Their copyright/permission notices are
retained in the bundle header and source. This file documents provenance for
the source-offer obligation.

## Vendored data: `data/countries-50m-lite.geojson`

The borders layer. Natural Earth **Admin-0 1:50m country** boundaries,
sourced as quantized TopoJSON from [world-atlas](https://github.com/topojson/world-atlas)
(`countries-50m.json`) and decoded once to a plain GeoJSON `FeatureCollection`
(coordinates rounded to 3 dp ≈ 110 m). Decoding to GeoJSON at vendor time means
the renderer needs **no `topojson-client`** at runtime — it just `fetch()`es the
file (same-origin, `connect-src 'self'`) and hands the features to globe.gl's
`polygonsData`.

| | |
|---|---|
| **Source** | world-atlas `countries-50m.json` (Natural Earth Admin-0 1:50m) |
| **Derived** | 241 country features · ~26k points · ~0.46 MB · simplified ~3.8x with topology-preserving Douglas-Peucker (eps 0.08°, shared arcs → borders stay matched); rings that would collapse fall back to full detail so every country (incl. micro-states) stays a valid polygon; each feature carries a `labelLat`/`labelLng` centroid for optional labels |
| **License** | Natural Earth is **public domain**; world-atlas is ISC |

Natural Earth places no restrictions on use, so it is compatible with AnonChat's
AGPL. To increase detail later, swap in `land-50m.json` (decode the same way) or
add a countries set for per-country borders.

## Updating

Replace `globe.gl.min.js` with a newer pinned UMD build, update the version
above, and re-run the renderer-side checks (no `eval`, no remote fetches). To
refresh the land data, re-decode a world-atlas TopoJSON to GeoJSON and drop it
in `data/`.
