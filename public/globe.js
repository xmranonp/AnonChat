// Relay globe for the Map tab (globe.gl): the current relay path as arcs and markers.

const VENDOR_SRC    = 'vendor/globe.gl/globe.gl.min.js';
const COUNTRIES_URL = 'vendor/globe.gl/data/countries-50m-lite.geojson';

const PALETTE = {
  ocean:            '#9fb0cc',
  oceanEmissiveInt: 0.7,
  shininess:        1,
  dotColor:         '#0a0a0a',
  dotHi:            '#0a8fc0',
  hexRes:           3,
  hexMargin:        0.22,
  hexAltitude:      0.006,
  labelColor:       'rgba(40,40,46,0.85)',
  labelSize:        0.42,
  labelAltitude:    0.012,
  circuitArc:       '#0a8fc0',
  circuitPoint:     '#0a8fc0',
  circuitExit:      '#06527a',
};

let _libPromise = null;
let _geoPromise = null;

/** Lazy-inject the vendored globe.gl UMD bundle (same-origin, CSP-safe). */
function loadGlobeLib() {
  if (window.Globe) return Promise.resolve(window.Globe);
  if (_libPromise) return _libPromise;
  _libPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = VENDOR_SRC;
    s.async = true;
    s.dataset.globeLib = '1';
    s.onload = () => window.Globe
      ? resolve(window.Globe)
      : reject(new Error('globe.gl loaded but window.Globe is undefined'));
    s.onerror = () => { _libPromise = null; s.remove(); reject(new Error('failed to load ' + VENDOR_SRC)); };
    document.head.appendChild(s);
  });
  return _libPromise;
}

function fetchCountries() {
  if (_geoPromise) return _geoPromise;
  _geoPromise = fetch(COUNTRIES_URL)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .catch(e => { _geoPromise = null; throw e; });
  return _geoPromise;
}

export function warmUpRelayGlobe() {
  try { loadGlobeLib().catch(() => {}); } catch {}
  try { fetchCountries().catch(() => {}); } catch {}
}

/** Cheap WebGL capability probe — fail clearly instead of throwing in three.js. */
function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
      (c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch { return false; }
}

const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export async function mountRelayGlobe(container, opts = {}) {
  if (!container) throw new Error('mountRelayGlobe: container is required');
  if (!hasWebGL())  throw new Error('webgl-unavailable');

  // Swallow only the benign DOMException some virtual GPUs throw during init; the globe still renders.
  if (!window.__globeErrSuppressor) {
    window.__globeErrSuppressor = true;
    const isBenign = m => typeof m === 'string' && /more specific error is not available/.test(m);
    window.addEventListener('error', (e) => {
      if (isBenign(e && e.message) && e.filename && /globe\.gl/.test(e.filename)) e.preventDefault();
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason;
      if (isBenign(r && (r.message || String(r)))) e.preventDefault();
    });
  }

  const Globe = await loadGlobeLib();

  const autoRotate = opts.autoRotate === true && !prefersReducedMotion();
  const autoRotateSpeed = opts.autoRotateSpeed ?? 0.35;

  const world = new Globe(container, { animateIn: false })
    .backgroundColor('rgba(0,0,0,0)')
    .showGlobe(true)
    .showAtmosphere(false)
    .showGraticules(false)
    .width(container.clientWidth || 600)
    .height(container.clientHeight || 480);

  function applyOcean() {
    try {
      const m = world.globeMaterial();
      if (!m) return;
      m.color && m.color.set(PALETTE.ocean);
      m.emissive && m.emissive.set(PALETTE.ocean);
      if ('emissiveIntensity' in m) m.emissiveIntensity = PALETTE.oceanEmissiveInt;
      if ('shininess' in m) m.shininess = PALETTE.shininess;
      m.needsUpdate = true;
    } catch {}
  }
  applyOcean();

  let destroyed = false;
  const circuitCountries = new Set();
  const hexColorFn = d =>
    (d && d.properties && circuitCountries.has(d.properties.name)) ? PALETTE.dotHi : PALETTE.dotColor;

  if (opts.land !== false) {
    fetchCountries()
      .then(geo => {
        if (destroyed) return;
        const feats = (geo && geo.features) || [];
        world
          .hexPolygonsData(feats)
          .hexPolygonResolution(PALETTE.hexRes)
          .hexPolygonUseDots(true)
          .hexPolygonMargin(PALETTE.hexMargin)
          .hexPolygonColor(hexColorFn)
          .hexPolygonAltitude(PALETTE.hexAltitude)
          .hexPolygonsTransitionDuration(0);
        wake();                     // the land arrived: draw it, also when the globe had paused meanwhile
        const signalReady = () => { try { opts.onReady && opts.onReady(); } catch {} };
        (window.requestAnimationFrame || ((f) => setTimeout(f, 0)))(signalReady);
        if (opts.labels === true) {
          const labelled = feats.filter(f => f.properties && f.properties.name &&
            Number.isFinite(f.properties.labelLat) && Number.isFinite(f.properties.labelLng));
          world
            .labelsData(labelled)
            .labelLat(f => f.properties.labelLat)
            .labelLng(f => f.properties.labelLng)
            .labelText(f => f.properties.name.toUpperCase())
            .labelSize(PALETTE.labelSize)
            .labelColor(() => PALETTE.labelColor)
            .labelResolution(2)
            .labelDotRadius(0)
            .labelAltitude(PALETTE.labelAltitude)
            .labelsTransitionDuration(0);
        }
      })
      .catch((err) => {
        // Surface data-load failures: a bare ocean sphere is easy to mistake for a broken globe.
        try { opts.onError && opts.onError(err); } catch {}
      });
  }

  let controls = null;
  try {
    controls = world.controls();
    if (controls) {
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = autoRotateSpeed;
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      controls.enableZoom = true;
      controls.minDistance = 180;
      controls.maxDistance = 520;
      if ('minPolarAngle' in controls) controls.minPolarAngle = 0.22;
      if ('maxPolarAngle' in controls) controls.maxPolarAngle = Math.PI - 0.22;
      controls.addEventListener?.('start', () => { controls.autoRotate = false; });
      controls.addEventListener?.('end',   () => { controls.autoRotate = autoRotate; });
    }
  } catch {}

  // globe.gl renders every frame, which can freeze a VM on a software GPU, so rendering pauses ~1.2 s after the last interaction and wakes on input or new data.
  let idleTimer = null;
  function wake() {
    if (destroyed) return;
    try { world.resumeAnimation?.(); } catch {}
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { try { world.pauseAnimation?.(); } catch {} }, 1200);
  }
  ['pointerdown', 'pointermove', 'pointerup', 'wheel'].forEach(ev =>
    container.addEventListener(ev, wake, { passive: true }));
  wake();

  const DEFAULT_POV = opts.pointOfView || { lat: 20, lng: -4, altitude: 2.0 };
  try { world.pointOfView(DEFAULT_POV, 0); } catch {}
  world.onGlobeReady?.(() => { try { world.pointOfView(DEFAULT_POV, 0); } catch {} });

  // A new size clears the canvas: draw again, or a paused globe stays blank (the panel's rows above it filling in after it was drawn).
  let lastW = 0, lastH = 0;
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (w && h) { world.width(w); world.height(h); if (w !== lastW || h !== lastH) { lastW = w; lastH = h; wake(); } }
  }
  let ro = null;
  if ('ResizeObserver' in window) { ro = new ResizeObserver(() => resize()); ro.observe(container); }
  else window.addEventListener('resize', resize);

  let canvas = null;
  try { canvas = world.renderer && world.renderer().domElement; } catch {}
  const onCtxLost = (e) => e.preventDefault();
  canvas && canvas.addEventListener('webglcontextlost', onCtxLost, false);

  return {
    globe: world,
    pause()  { try { world.pauseAnimation?.(); } catch {} clearTimeout(idleTimer); },
    resume() { if (destroyed) return; try { world.resumeAnimation?.(); } catch {} resize(); wake(); },
    resize,
    resetView(ms = 600) { try { world.pointOfView(DEFAULT_POV, ms); } catch {} },
    setPointOfView(pov, ms = 800) { try { world.pointOfView(pov, ms); } catch {} },

    setCircuit(hops) {
      if (destroyed) return;
      const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
      const toRad = x => x * Math.PI / 180;
      const arcAlt = s => {
        const dLat = toRad(s.endLat - s.startLat), dLng = toRad(s.endLng - s.startLng);
        const a = Math.sin(dLat/2)**2 + Math.cos(toRad(s.startLat))*Math.cos(toRad(s.endLat))*Math.sin(dLng/2)**2;
        return 0.12 + (2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) / Math.PI) * 0.4;
      };
      const label = d => {
        const role = d.role ? d.role[0].toUpperCase() + d.role.slice(1) : '';
        return [role, d.nickname || '', d.country || ''].filter(Boolean).map(esc).join(' &middot; ');
      };
      const codeToFlag = cc => {
        if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return '';
        const A = 0x1F1E6, u = cc.toUpperCase();
        return String.fromCodePoint(A + u.charCodeAt(0) - 65) + String.fromCodePoint(A + u.charCodeAt(1) - 65);
      };
      const makeLabel = d => {
        const el = document.createElement('div');
        const stagger = (path.indexOf(d) % 2) ? ' gnl-down' : ' gnl-up';
        el.className = 'globe-node-label' + (d === exit ? ' is-exit' : '') + stagger;
        const flag = codeToFlag(d.country);
        const roleMap = { guard: 'Guard', relay: 'Relay', middle: 'Middle', exit: 'Exit', rendezvous: 'Rend' };
        const role = roleMap[d.role] || (d.role ? d.role[0].toUpperCase() + d.role.slice(1) : '');
        // The app's own flag picture (flags/XX.png, the emoji picker's set): Windows has no flag emoji in its fonts and showed two
        // letters instead. The emoji stays as the fallback if a picture is missing.
        const cc = flag ? d.country.toUpperCase() : '';
        el.innerHTML =
          (flag ? '<span class="gnl-flag"><img class="gnl-flag-img" src="flags/' + cc + '.png" alt="' + esc(cc) + '" width="16" height="16" draggable="false"></span>' : '') +
          '<span class="gnl-nick">' + esc(d.nickname || '?') + '</span>' +
          (role ? '<span class="gnl-role">' + esc(role) + '</span>' : '');
        const img = el.querySelector('.gnl-flag-img');
        if (img) img.onerror = () => { img.replaceWith(document.createTextNode(flag)); };
        return el;
      };
      const path = Array.isArray(hops) ? hops.filter(h => h && isFinite(h.lat) && isFinite(h.lng)) : [];
      const uniqCountries = new Set(path.map(h => h.country || h.countryName || '')).size;
      const segs = [];
      if (uniqCountries > 1) {
        for (let i = 0; i < path.length - 1; i++) {
          const a = path[i], b = path[i + 1];
          segs.push({ startLat: a.lat, startLng: a.lng, endLat: b.lat, endLng: b.lng });
        }
      }
      const exit = path.length ? path[path.length - 1] : null;
      circuitCountries.clear();
      for (const h of path) if (h.countryName) circuitCountries.add(h.countryName);
      try { world.hexPolygonColor(hexColorFn); } catch {}
      // Core path (static arcs + points) — must always render, so it's
      // isolated from the newer shading/label layers below.
      try {
        world.arcsData(segs)
          .arcStartLat(d => d.startLat).arcStartLng(d => d.startLng)
          .arcEndLat(d => d.endLat).arcEndLng(d => d.endLng)
          .arcColor(() => PALETTE.circuitArc).arcStroke(0.6).arcAltitude(arcAlt)
          .arcDashLength(1).arcDashGap(0).arcDashAnimateTime(0).arcsTransitionDuration(300);
        world.pointsData(path)
          .pointLat(d => d.lat).pointLng(d => d.lng)
          .pointColor(d => d === exit ? PALETTE.circuitExit : PALETTE.circuitPoint)
          .pointRadius(d => d === exit ? 0.6 : 0.4).pointAltitude(0.006)
          .pointLabel(label).pointsTransitionDuration(300);
        world.ringsData([]);   // no pulse — static markers only, so the globe can idle
      } catch (e) { try { console.warn('[globe] circuit path render failed:', e); } catch {} }

      try { world.polygonsData([]); } catch {}

      try {
        world.htmlElementsData(path)
          .htmlLat(d => d.lat).htmlLng(d => d.lng).htmlAltitude(0.02)
          .htmlElement(makeLabel);
      } catch (e) { try { console.warn('[globe] node labels failed:', e); } catch {} }
      wake();
    },
    clearCircuit() {
      if (destroyed) return;
      circuitCountries.clear();
      try { world.hexPolygonColor(hexColorFn); } catch {}
      try { world.arcsData([]).pointsData([]).ringsData([]).polygonsData([]).htmlElementsData([]); } catch {}
      wake();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try { ro ? ro.disconnect() : window.removeEventListener('resize', resize); } catch {}
      try { canvas && canvas.removeEventListener('webglcontextlost', onCtxLost); } catch {}
      try { world.pauseAnimation?.(); } catch {}
      try { world._destructor?.(); } catch {}
      try { container.replaceChildren(); } catch { container.innerHTML = ''; }
    },
  };
}

