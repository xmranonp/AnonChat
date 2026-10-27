// Electron main process: starts the backend, shows a splash while anon bootstraps, then opens the UI.

const { app, BrowserWindow, ipcMain, session, dialog, shell, Menu, safeStorage } = require('electron');
const path  = require('path');
const fs    = require('fs');
const http  = require('http');
const { spawn } = require('child_process');

// On native Wayland the compositor ignores client-side window placement (the splash can't be centred). The ozone platform is chosen before app.commandLine can affect it, so the app re-execs itself with --ozone-platform=x11. ANONCHAT_WAYLAND=1 opts out.
if (process.platform === 'linux' && process.env.ANONCHAT_WAYLAND !== '1') {
  const onWayland  = !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland';
  const alreadyX11 = process.argv.slice(1).includes('--ozone-platform=x11');
  if (onWayland && !alreadyX11) {
    try {
      const child = spawn(process.execPath, ['--ozone-platform=x11', ...process.argv.slice(1)], {
        stdio: 'inherit', detached: true, env: process.env,
      });
      child.unref();
      process.exit(0);
    } catch (e) { console.error('[main] X11 re-exec failed, staying on Wayland:', e && e.message); }
  }
}

// One folder for everything: the window's own storage (keys, history, media) is the 'window' subfolder of the data folder, so erasing,
// backing up or removing AnonChat deals with a single place. Set before Chromium opens it; the single-instance lock lives in it too.
const DATA_ROOT  = dataDir();
// Restarted by "Restore from a backup" in Settings: the backup file the person chose, offered to the window once (see pending_restore).
// Taken out of the environment at once, so the backend and the Anyone network program never see it.
let RESTORE_FILE = typeof process.env.ANONCHAT_RESTORE_FILE === 'string' && process.env.ANONCHAT_RESTORE_FILE ? process.env.ANONCHAT_RESTORE_FILE : null;
delete process.env.ANONCHAT_RESTORE_FILE;
const WINDOW_DIR = path.join(DATA_ROOT, 'window');
try { fs.mkdirSync(WINDOW_DIR, { recursive: true, mode: 0o700 }); } catch {}
if (process.platform !== 'win32') { try { fs.chmodSync(WINDOW_DIR, 0o700); } catch {} }
app.setPath('userData', WINDOW_DIR);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); }
});

process.stdout.on('error', (e) => { if (e.code !== 'EIO' && e.code !== 'EPIPE') throw e; });

// Keep the Electron main process alive on stray errors — log rather than crash
// the whole app (which would take the UI down with it).
process.on('unhandledRejection', (reason) => { console.error('[main] unhandledRejection:', reason); });
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EIO' || err.code === 'EPIPE')) return;
  console.error('[main] uncaughtException:', err && err.stack ? err.stack : err);
});
process.stderr.on('error', (e) => { if (e.code !== 'EIO' && e.code !== 'EPIPE') throw e; });

// Chromium's OS-level sandbox stays on everywhere: it contains a renderer exploit via the untrusted content (images, audio, video,
// text from peers) the page displays. It can't be switched from here: on Linux Chromium sets it up before this file runs. The .deb
// and pacman packages install the setuid chrome-sandbox helper it needs; Windows and macOS need nothing. Dev runs use it too
// (npm start); only `npm run start:nosandbox` / launch-nosandbox.sh turn it off, for machines where it can't start.
// Write shared memory to /tmp instead of /dev/shm — fixes the
// "Unable to access /dev/shm: No such process" fatal crash on VMs/containers.
app.commandLine.appendSwitch('disable-dev-shm-usage');
// No 'password-store=basic': Chromium (and safeStorage, which keeps the data key) use the system keyring on Linux where there is one.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('no-pings');
// Belt and braces for voice calls (which use no WebRTC at all): if any page ever created an RTCPeerConnection, Chromium itself must not send UDP outside the proxy.
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.commandLine.appendSwitch('webrtc-ip-handling-policy', 'disable_non_proxied_udp');
if (process.env.ANONCHAT_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}
// SwiftShader software-WebGL fallback: if the GPU is unavailable or on Chromium's
// blocklist, the globe still renders instead of failing outright.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder,VaapiOnNvidiaGPUs,OptimizationHints');
// Stop Chromium's own background clearnet requests (component updater, Safe Browsing, error reports, field trials, sync, crash upload): they would bypass the SOCKS proxy and leak the host's IP.
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-sync');

const UI_PORT     = 47821;
const PUBLIC_PORT = 47822;

// Per-launch secret for the local UI server. The backend gets it through its environment; the window gets it as a request header
// added below, so page scripts never hold it and no other program or browser tab can reach the UI API.
const UI_TOKEN = require('crypto').randomBytes(32).toString('hex');
const UI_TOKEN_HEADER = 'X-AnonChat-Token';
function isUiServerUrl(u) {
  try {
    const x = new URL(u);
    return (x.protocol === 'http:' || x.protocol === 'ws:')
      && (x.hostname === '127.0.0.1' || x.hostname === 'localhost')
      && x.port === String(UI_PORT);
  } catch { return false; }
}

// The renderer must never open a connection of its own: everything it needs comes from the local backend, so any other request is cancelled. Traffic that must leave the machine is made by the backend through the Anyone proxy.
function isLocalUrl(u) {
  try {
    const x = new URL(u);
    if (['file:', 'data:', 'blob:', 'devtools:', 'about:'].includes(x.protocol)) return true;
    if (!['http:', 'ws:'].includes(x.protocol)) return false;
    return ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname);
  } catch { return false; }
}

function resolveResource(rel) {
  const candidates = [
    path.join(process.resourcesPath || '', rel),
    path.join(__dirname, 'resources', rel),
    path.join(__dirname, rel),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  // Nothing found: report the staged location (desktop/resources/...), which is
  // where prepare-resources puts it, rather than Electron's own resources dir.
  return candidates[1];
}

function dataDir() {
  const home = require('os').homedir();
  let base;
  if (process.platform === 'win32') {
    base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support');
  } else {
    const xdg = process.env.XDG_DATA_HOME;
    base = xdg && xdg.length ? xdg : path.join(home, '.local', 'share');
  }
  const d = path.join(base, 'anonchat');
  // Owner-only on Linux and macOS: contacts, keys and the hidden-service key live here. Tightened on every start, so folders
  // created by older builds with default permissions are fixed too. (Windows: %APPDATA% is already per-user.)
  for (const sub of ['', 'data', 'anon']) {
    const p = path.join(d, sub);
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') { try { fs.chmodSync(p, 0o700); } catch {} }
  }
  return d;
}

// macOS needs an application menu: without one, Cmd+C / Cmd+V / Cmd+A in the message box and Cmd+Q don't work.
// Elsewhere the window has no menu bar.
function installMacMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

let backendChild = null;
let backendPid   = null;
let proctree     = null;

function spawnBackend(splash, dataKey) {
  const dd      = dataDir();
  const EXE     = process.platform === 'win32' ? '.exe' : '';
  const nodeBin = resolveResource('runtime/node' + EXE);
  const anonOverride = process.env.ANON_BINARY || process.env.ANON_BIN;
  const anonBin = (anonOverride && fs.existsSync(anonOverride))
    ? anonOverride
    : resolveResource('runtime/anon' + EXE);
  const startJs = resolveResource('app/start.js');
  const appRoot = resolveResource('app');

  const proctreeJs = resolveResource('app/lib/proctree.js');
  const missing = [
    ['app/start.js', startJs], ['app/lib/proctree.js', proctreeJs],
    ['runtime/node' + EXE, nodeBin], ['runtime/anon' + EXE, anonBin],
  ].filter(([, p]) => !fs.existsSync(p));
  if (missing.length) {
    const { dialog } = require('electron');
    const list = missing.map(([name, p]) => `  • ${name}\n    expected at ${p}`).join('\n');
    console.error('[main] missing staged resources:\n' + list);
    dialog.showErrorBox(
      'Resources not prepared',
      'These required files are missing:\n\n' + list + '\n\n' +
      'Run this from the desktop/ directory, then restart:\n\n' +
      '    ANON_BIN=/path/to/anon ./prepare-resources.sh'
    );
    app.quit();
    return;
  }

  proctree = require(proctreeJs);

  for (const b of [nodeBin, anonBin]) {
    try { fs.chmodSync(b, 0o755); } catch {}
  }

  const child = spawn(nodeBin, [startJs], {
    cwd: appRoot,
    detached: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DATA_DIR:    path.join(dd, 'data'),
      ANON_DIR:    path.join(dd, 'anon'),
      ANON_BINARY: anonBin,
      ANONCHAT_PARENT_PID: String(process.pid),
      ANONCHAT_UI_TOKEN:   UI_TOKEN,
      ANONCHAT_KEY_STDIN:  '1',
      UI_PORT:     String(UI_PORT),
      PUBLIC_PORT: String(PUBLIC_PORT),
    },
  });

  const wire = (stream) => stream.on('data', buf => {
    const text = buf.toString();
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try { console.log('[backend]', line); } catch {}
      if (splash && !splash.isDestroyed()) try { splash.webContents.send('backend-log', line); } catch {}
      const m = line.match(/Bootstrapped (\d+)/);
      if (m && splash && !splash.isDestroyed()) {
        try { if (splash && !splash.isDestroyed()) splash.webContents.send('bootstrap-progress', Number(m[1])); } catch {}
      }
    }
  });
  wire(child.stdout); wire(child.stderr);
  // The data key goes over stdin (never the command line or the environment, which other programs can list), then stdin is closed.
  child.stdin.on('error', () => {});
  child.stdin.end(dataKey.toString('hex') + '\n');

  child.on('exit', (code, sig) => {
    console.log('[backend] exited code=' + code + ' sig=' + sig);
    backendChild = null;
    // Still on the start screen: say it stopped, instead of "connecting" for the next twelve minutes.
    if (!stopping && splash && !splash.isDestroyed()) {
      try { splash.webContents.send('backend-error', 'exit ' + (code != null ? code : sig)); } catch {}
    }
    // Already in the window: the backend or the Anyone network program stopped on its own (start.js stops both together, so nothing is
    // ever sent through a port another program could take). Say so and quit, rather than leave a window that can do nothing.
    else if (!stopping && mainWin && !mainWin.isDestroyed()) {
      const detail = code === 7
        ? U('stopped.anon', 'The Anyone network program stopped unexpectedly. Nothing is sent until AnonChat starts again.')
        : U('stopped.other', 'AnonChat\u2019s background service stopped unexpectedly.') + ' (' + (code != null ? 'code ' + code : sig) + ')';
      dialog.showMessageBox(mainWin, { type: 'error', noLink: true, buttons: ['OK'], title: 'AnonChat',
        message: U('stopped.title', 'AnonChat stopped'), detail })
        .catch(() => {}).finally(() => app.quit());
    }
  });

  backendChild = child;
  backendPid   = child.pid;
  return child;
}

let stopping = null;
function stopBackend() {
  if (!stopping) {
    stopping = (proctree && backendPid)
      ? proctree.terminateTree(backendPid).catch(() => false)
      : Promise.resolve(true);
  }
  return stopping;
}

function waitForReady(splash, onReady, onTimeout) {
  const start = Date.now();
  const MIN_SPLASH_MS = 5000;
  const MAX_WAIT_MS   = 12 * 60 * 1000;

  // Before the launch token is sent anywhere, the server on the UI port must prove it is our backend: it answers a fresh random
  // challenge with an HMAC keyed by the token, which only the backend we started knows. Another program that took the port first
  // (M3) never sees the token, and the window is never shown its page.
  let proven = false;
  function prove(next) {
    const nonce = require('crypto').randomBytes(16).toString('hex');
    const want = require('crypto').createHmac('sha256', UI_TOKEN).update('anonchat-hello|' + nonce).digest('hex');
    const req = http.get({ host: '127.0.0.1', port: UI_PORT, path: '/api/hello?n=' + nonce, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      res.on('end', () => {
        let mac = null; try { mac = JSON.parse(body).mac; } catch {}
        if (typeof mac === 'string' && mac.length === want.length && require('crypto').timingSafeEqual(Buffer.from(mac), Buffer.from(want))) { proven = true; next(); }
        else { if (res.statusCode === 200) console.error('[main] the UI port answered, but not as our backend'); setTimeout(poll, 1000); }
      });
    });
    req.on('error', () => setTimeout(poll, 1000));
    req.on('timeout', () => { req.destroy(); setTimeout(poll, 1000); });
  }

  function poll() {
    if (!app.isReady()) return;
    if (Date.now() - start > MAX_WAIT_MS) { onTimeout && onTimeout(); return; }
    if (!proven) return prove(poll);

    const req = http.get({ host: '127.0.0.1', port: UI_PORT, path: '/api/whoami', timeout: 3000, headers: { [UI_TOKEN_HEADER]: UI_TOKEN } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (body.includes('"address"') && body.includes('.anyone')) {
          const elapsed = Date.now() - start;
          const wait = Math.max(0, MIN_SPLASH_MS - elapsed);
          setTimeout(onReady, wait);
        } else {
          setTimeout(poll, 1000);
        }
      });
    });
    req.on('error', () => setTimeout(poll, 1000));
    req.on('timeout', () => { req.destroy(); setTimeout(poll, 1000); });
  }
  setTimeout(poll, 800);
}

let splashWin = null;
let mainWin   = null;

function createSplash() {
  splashWin = new BrowserWindow({
    width: 460, height: 320,
    resizable: false, frame: false, center: true,
    show: false,
    backgroundColor: '#1A1A1A',
    webPreferences: {
      preload: path.join(__dirname, 'preload-splash.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const lang = savedUiLang();
  splashWin.loadFile(path.join(__dirname, 'splash', 'index.html'), lang ? { query: { lang } } : undefined);
  splashWin.once('ready-to-show', () => {
    try {
      const { screen } = require('electron');
      const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const wa = disp.workArea;
      const [w, h] = splashWin.getSize();
      splashWin.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + (wa.height - h) / 2));
    } catch { try { splashWin.center(); } catch {} }
    splashWin.show();
  });
  return splashWin;
}

function createMain() {
  mainWin = new BrowserWindow({
    width: 1180, height: 760,
    minWidth: 800, minHeight: 460,                 // below 760 px the stylesheet hides the whole left panel (contacts, network, settings)
    center: true,
    show: false,
    backgroundColor: '#1A1A1A',
    icon: path.join(__dirname, 'build', 'icons', '512x512.png'),
    title: 'AnonChat',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,                 // a call must keep running (timers, audio) while the window is minimised
    },
  });
  mainWin.removeMenu();
  // The app doesn't use WebRTC, but a stray RTCPeerConnection could bypass the SOCKS proxy and leak the real IP, so WebRTC may never use non-proxied UDP. Set before loadURL.
  try { mainWin.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); } catch {}
  mainWin.loadURL('http://127.0.0.1:' + UI_PORT);

  mainWin.webContents.on('will-navigate', (evt, url) => {
    try {
      if (!isUiServerUrl(url)) evt.preventDefault();     // the app's own page only, never another local server
    } catch { evt.preventDefault(); }
  });

  mainWin.on('focus', clearNotices);
  mainWin.once('ready-to-show', () => {
    mainWin.center();
    mainWin.show();
    mainWin.focus();
  });

  // Always log renderer failures so a crash on boot can be diagnosed. DevTools is not opened here because it masks GPU/timing races.
  mainWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load: ${code} ${desc} (${url})`);
  });
  mainWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] render-process-gone:', JSON.stringify(details));
  });
  mainWin.webContents.on('preload-error', (_e, p, err) => {
    console.error('[renderer] preload-error:', p, err && err.message ? err.message : err);
  });

  if (process.env.ANONCHAT_DEBUG === '1' || !app.isPackaged) {
    mainWin.webContents.on('console-message', (evt) => {
      const { level, message, sourceId, lineNumber } = evt;
      console.log(`[renderer:${level}] ${sourceId || '?'}:${lineNumber || 0} ${message}`);
    });
    mainWin.webContents.openDevTools({ mode: 'detach' });
  }
  return mainWin;
}

// Unread total from the window. Only a small whole number is accepted; anything else is ignored.
let unreadOverlay = null;
function unreadDotImage() {
  if (unreadOverlay) return unreadOverlay;
  const { nativeImage } = require('electron');
  const size = 16, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5), a = Math.max(0, Math.min(1, 7.5 - d));   // anti-aliased filled circle
    const i = (y * size + x) * 4;
    buf[i] = 0x6a; buf[i + 1] = 0x6a; buf[i + 2] = 0xe8; buf[i + 3] = Math.round(a * 255);   // BGRA: the app's red
  }
  unreadOverlay = nativeImage.createFromBitmap(buf, { width: size, height: size });
  return unreadOverlay;
}
// The language chosen in the app (Settings → Language) and the words for the dialogs shown from here, sent by the window. The language
// code alone is kept (DATA_ROOT/ui-lang, two letters) so the start screen, shown before anything is unlocked, uses it too.
const UI_LANG_FILE = path.join(DATA_ROOT, 'ui-lang');
let uiStrings = {};
const U = (k, fallback) => (typeof uiStrings[k] === 'string' ? uiStrings[k] : fallback);
function savedUiLang() {
  try { const v = fs.readFileSync(UI_LANG_FILE, 'utf8').trim(); return /^[a-z]{2}$/.test(v) ? v : null; } catch { return null; }
}
ipcMain.on('ui_language', (evt, data) => {
  if (!mainWin || evt.sender !== mainWin.webContents || !data || typeof data !== 'object') return;
  const next = {};
  if (data.strings && typeof data.strings === 'object') {
    for (const [k, v] of Object.entries(data.strings)) if (/^[a-z.]{1,40}$/i.test(k) && typeof v === 'string' && v.length < 600) next[k] = v;
  }
  uiStrings = next;
  if (typeof data.lang === 'string' && /^[a-z]{2}$/.test(data.lang) && data.lang !== savedUiLang()) {
    try { fs.mkdirSync(DATA_ROOT, { recursive: true }); fs.writeFileSync(UI_LANG_FILE, data.lang); } catch {}
  }
});

// Linux: the count on the launcher icon (Ubuntu Dock, Dash to Dock, KDE's task manager, Plank…), through the launcher-entry D-Bus
// signal those docks listen to. Electron 44 no longer sends it itself, so it is sent here with gdbus (part of GLib, present on every
// desktop that has such a dock); without gdbus, or without a dock that listens, nothing happens and the window title still has it.
const LINUX_DESKTOP_ID = 'anonchat.desktop';
let _gdbusMissing = false;
function linuxBadge(count, sync = false) {
  if (process.platform !== 'linux' || _gdbusMissing) return;
  const args = ['emit', '--session', '--object-path', '/network/anyone/anonchat/launcherentry',
    '--signal', 'com.canonical.Unity.LauncherEntry.Update', 'application://' + LINUX_DESKTOP_ID,
    `{'count': <int64 ${count}>, 'count-visible': <${count > 0 ? 'true' : 'false'}>}`];
  try {
    if (sync) { require('child_process').spawnSync('gdbus', args, { stdio: 'ignore', timeout: 800 }); return; }
    const p = spawn('gdbus', args, { stdio: 'ignore' });
    p.on('error', (e) => { if (e && e.code === 'ENOENT') _gdbusMissing = true; });
  } catch {}
}
let _lastBadge = 0;

ipcMain.on('set_unread_count', (evt, n) => {
  if (!mainWin || evt.sender !== mainWin.webContents) return;
  const count = Number.isInteger(n) && n >= 0 && n < 100000 ? n : 0;
  _lastBadge = count;
  // macOS: a number on the dock icon. Windows: a dot on the taskbar icon. Linux: a number on the launcher icon where the dock shows
  // one (above), and the window title ("(3) AnonChat") everywhere.
  if (process.platform === 'darwin') { try { app.setBadgeCount(count); } catch {} }
  linuxBadge(count);
  if (process.platform === 'win32') {
    try { mainWin.setOverlayIcon(count ? unreadDotImage() : null, count ? String(count) + ' unread' : ''); } catch {}
  }
});

// System notifications, shown from here so they work the same on Windows, macOS and Linux and a click can bring the window forward.
// Only the main window may ask; title and body are plain text and cut short. On Linux the notification server may read the body as
// markup, so the characters that would start a tag or an entity are replaced with look-alikes: a message can't add links or formatting.
const NOTICE_TAG_RE = /^(req|grp:[A-Za-z0-9-]{1,64}|(call:)?[a-z2-7]{56}\.anyone)$/;
const notices = new Map();                // tag -> the notice on screen for it (a newer one replaces it; also keeps it from being collected)
function noticeText(v, max) {
  let s = String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
  if (process.platform === 'linux') s = s.replace(/&/g, '\uFF06').replace(/</g, '\u2039').replace(/>/g, '\u203A');
  return s;
}
ipcMain.on('notify', (evt, n) => {
  if (!fromMainWindow(evt) || !n || typeof n !== 'object') return;
  const { Notification } = require('electron');
  const tag = typeof n.tag === 'string' && NOTICE_TAG_RE.test(n.tag) ? n.tag : null;
  const isCall = !!tag && tag.startsWith('call:');
  // A ringing call makes the taskbar or dock ask for attention even where notices can't be shown (no notification service, or blocked).
  if (isCall) callAttention(true);
  if (!Notification.isSupported()) return;
  const note = new Notification({
    title: noticeText(n.title, 80) || 'AnonChat',
    body: noticeText(n.body, 160),
    silent: true,                                        // the window plays its own sound (the bell, the ringtone)
    icon: path.join(__dirname, 'build', 'icons', '512x512.png'),
    // A ringing call stays on screen until it's answered, declined or missed (the window then takes it away).
    ...(isCall ? { urgency: 'critical', timeoutType: 'never' } : {}),
  });
  note.on('failed', (_e, err) => console.error('[notify] the system did not show the notice:', String(err || '').slice(0, 200)));
  if (tag) { const old = notices.get(tag); if (old) { try { old.close(); } catch {} } notices.set(tag, note); }
  const forget = () => { if (tag && notices.get(tag) === note) notices.delete(tag); };
  note.on('click', () => {
    forget();
    if (!mainWin || mainWin.isDestroyed()) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show(); mainWin.focus();
    if (tag) mainWin.webContents.send('notice-click', tag);
  });
  note.on('close', forget);
  note.show();
});
ipcMain.on('notice_close', (evt, tag) => {
  if (!fromMainWindow(evt) || typeof tag !== 'string' || !NOTICE_TAG_RE.test(tag)) return;
  const n = notices.get(tag); if (n) { notices.delete(tag); try { n.close(); } catch {} }
  if (tag.startsWith('call:')) callAttention(false);
});
// While a call rings in the background: the taskbar button flashes (Windows), the window asks for attention (Linux docks and task
// bars highlight it), the dock icon bounces until the app is opened (macOS). Works even where the notice itself is blocked.
let _bounceId = null;
function callAttention(on) {
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    if (process.platform === 'darwin') {
      if (on && !mainWin.isFocused() && _bounceId == null) _bounceId = app.dock?.bounce('critical') ?? null;
      if (!on && _bounceId != null) { app.dock?.cancelBounce(_bounceId); _bounceId = null; }
    } else mainWin.flashFrame(on && !mainWin.isFocused());
  } catch {}
}
// The window came forward: notices about it are no longer news.
function clearNotices() { for (const n of notices.values()) { try { n.close(); } catch {} } notices.clear(); callAttention(false); }

// Erase everything: the identity, keys, contacts, messages and the window's storage. Asked for from Settings (the page has the person
// type ERASE first). The backend is stopped, the window's storage cleared, and the folder removed. Files Chromium still holds open (on
// Windows they can't be deleted while this process runs) are removed by a small detached job right after the app has exited.
let erasing = false;
function eraseTargets() {
  return path.basename(DATA_ROOT) === 'anonchat' && path.isAbsolute(DATA_ROOT) ? [DATA_ROOT] : [];
}
// Removes what Chromium still holds open once this process is gone. With `relaunch`, the job then starts AnonChat again (restore from a
// backup), so the new instance never sees a folder that is about to be deleted under it.
function removeAfterExit(dirs, relaunch = null) {
  if (!dirs.length) return;
  try {
    if (process.platform === 'win32') {
      // Paths and arguments travel as environment variables, never inside the command text: cmd expands a variable only once, so a
      // folder name with %, & or ^ (C:\Users\100%Joe) is used exactly as it is.
      const env = { ...process.env, ...(relaunch ? relaunch.env : {}) };
      const refs = (prefix, list) => list.map((v, i) => { env[`${prefix}${i}`] = String(v).replace(/"/g, ''); return `"%${prefix}${i}%"`; });
      let cmd = 'ping -n 4 127.0.0.1 >nul & ' + refs('ANONCHAT_ERASE_', dirs).map((r) => `rmdir /s /q ${r}`).join(' & ');
      if (relaunch) cmd += ' & start "" ' + refs('ANONCHAT_RUN_', [process.execPath, ...relaunch.args]).join(' ');
      spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env }).unref();
    } else if (relaunch) {
      spawn('/bin/sh', ['-c', 'sleep 2; rm -rf -- "$ANONCHAT_ERASE_DIR"; exec "$0" "$@"', process.execPath, ...relaunch.args],
        { detached: true, stdio: 'ignore', env: { ...process.env, ...relaunch.env, ANONCHAT_ERASE_DIR: dirs[0] } }).unref();
    } else {
      spawn('/bin/sh', ['-c', 'sleep 2; rm -rf -- "$@"', 'sh', ...dirs], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) { console.error('[main] erase: could not schedule the final cleanup:', e && e.message); }
}
// The erase itself, shared by "Erase everything" and "Restore from a backup": windows hidden, the window's storage cleared, the backend
// stopped, the data folder removed. Returns what couldn't be removed while running (Windows keeps Chromium's files locked).
async function eraseData() {
  erasing = true;
  for (const w of BrowserWindow.getAllWindows()) { try { w.hide(); } catch {} }
  try { await session.defaultSession.clearStorageData(); } catch {}
  try { await session.defaultSession.clearCache(); } catch {}
  await stopBackend();
  backendStopped = true;
  const dirs = eraseTargets();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 2 }); } catch {} }
  console.log('[main] erased', dirs.join(', '));
  return dirs.filter((d) => fs.existsSync(d));
}
ipcMain.handle('erase_everything', async (evt, labels) => {
  if (!mainWin || evt.sender !== mainWin.webContents || erasing) return false;
  // A second, native confirmation: script in the page alone can't erase anything (the page passes only the words to show).
  const L = (k, d) => (labels && typeof labels[k] === 'string' && labels[k].length < 400 ? labels[k] : d);
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'warning', noLink: true, defaultId: 0, cancelId: 0,
    buttons: [L('cancel', 'Cancel'), L('ok', 'Erase everything')],
    title: 'AnonChat', message: L('title', 'Erase everything?'),
    detail: L('detail', 'Your identity, contacts, messages and groups will be deleted from this computer. This can\u2019t be undone.'),
  });
  if (response !== 1 || erasing) return false;
  removeAfterExit(await eraseData());
  app.exit(0);
  return true;
});

// ---- Restore from a backup (Settings) ----
// The window has already opened the file with its passphrase. Here: the same native confirmation and erase as above, then a restart
// that opens the restore on the fresh start with the same file (the passphrase is asked again: it is never kept anywhere).
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
function backupFileOk(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || !path.isAbsolute(p)) return false;
  const rel = path.relative(DATA_ROOT, path.resolve(p));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return false;         // inside the folder about to be erased
  try { const st = fs.statSync(p); return st.isFile() && st.size > 0 && st.size <= MAX_BACKUP_BYTES; } catch { return false; }
}
// The window sends the very bytes it opened and checked with the passphrase (not a path to read again later, when the file on disk could
// have changed or gone). They are kept in a private temporary folder outside the data folder, which the erase can't touch, and the
// restart reads them from there once and removes them.
function stageBackup(data) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anonchat-restore-'));      // owner-only (0700) where the system has permissions
  const file = path.join(dir, 'restore.anonchat');
  fs.writeFileSync(file, Buffer.from(data.buffer, data.byteOffset, data.byteLength), { mode: 0o600 });
  return file;
}
function unstageBackup(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
  const dir = path.dirname(file);
  if (path.basename(dir).startsWith('anonchat-restore-')) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}
ipcMain.handle('erase_for_restore', async (evt, args) => {
  if (!fromMainWindow(evt) || erasing) return { error: 'denied' };
  const data = args && args.data;
  if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > MAX_BACKUP_BYTES) return { error: 'file' };
  const labels = (args && args.labels) || {};
  const L = (k, d) => (typeof labels[k] === 'string' && labels[k].length < 400 ? labels[k] : d);
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'warning', noLink: true, defaultId: 0, cancelId: 0,
    buttons: [L('cancel', 'Cancel'), L('ok', 'Erase and restore')],
    title: 'AnonChat', message: L('title', 'Replace everything on this computer?'),
    detail: L('detail', 'Everything on this computer is erased first. AnonChat then restarts and restores the backup.'),
  });
  if (response !== 1 || erasing) return { error: 'cancelled' };
  let filePath;
  try { filePath = stageBackup(data); } catch (e) { console.error('[restore] could not keep the backup aside:', e && e.message); return { error: 'file' }; }
  const left = await eraseData();
  const relaunch = { args: process.argv.slice(1), env: { ANONCHAT_RESTORE_FILE: filePath } };
  if (left.length) { removeAfterExit(left, relaunch); app.exit(0); return { ok: true }; }
  process.env.ANONCHAT_RESTORE_FILE = filePath;
  app.relaunch();
  app.exit(0);
  return { ok: true };
});
// After that restart: the chosen backup file, once.
ipcMain.handle('pending_restore', (evt) => {
  if (!fromMainWindow(evt) || !RESTORE_FILE) return null;
  const p = RESTORE_FILE; RESTORE_FILE = null;
  if (!backupFileOk(p)) return null;
  let data = null;
  try { data = new Uint8Array(fs.readFileSync(p)); } catch {}
  if (path.basename(path.dirname(p)).startsWith('anonchat-restore-')) unstageBackup(p);    // our own copy: read once, then gone
  return data ? { name: path.basename(p), path: '', data } : null;
});
// After a restore on a fresh start: restart so the Anyone network program starts with the restored key, i.e. the restored address.
ipcMain.handle('relaunch_app', async (evt) => {
  if (!fromMainWindow(evt) || erasing) return false;
  erasing = true;
  for (const w of BrowserWindow.getAllWindows()) { try { w.hide(); } catch {} }
  await stopBackend();
  backendStopped = true;
  app.relaunch();
  app.exit(0);
  return true;
});

// A saved file came from someone else: mark it the way browsers mark downloads, so the system warns before opening a program or a
// document with macros (Windows: the Zone.Identifier stream; macOS: the quarantine attribute). Linux has no such mark.
function markFromInternet(file) {
  try {
    if (process.platform === 'win32') {
      fs.writeFileSync(file + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n');
    } else if (process.platform === 'darwin') {
      const stamp = Math.floor(Date.now() / 1000).toString(16);
      spawn('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0081;${stamp};AnonChat;`, file], { stdio: 'ignore' }).on('error', () => {});
    }
  } catch (e) { console.error('[main] could not mark the download:', e && e.message); }
}

const { safeFileName } = require('./filename');
// Received attachments are at most 5 MB; anything far bigger, or anything that isn't raw bytes, didn't come from a message.
const MAX_SAVE_BYTES = 25 * 1024 * 1024;
ipcMain.handle('save_file_to_downloads', async (evt, args) => {
  if (!mainWin || mainWin.isDestroyed() || evt.sender !== mainWin.webContents) throw new Error('denied');
  const { name, data } = args || {};
  if (!(data instanceof Uint8Array)) throw new Error('nothing to save');
  if (data.byteLength > MAX_SAVE_BYTES) throw new Error('file too large to save');
  if (name != null && (typeof name !== 'string' || name.length > 255)) throw new Error('bad file name');
  const home = require('os').homedir();
  const dir  = path.join(home, 'Downloads');
  fs.mkdirSync(dir, { recursive: true });

  const safeName = safeFileName(name);
  const parsed = path.parse(safeName);
  const stem = parsed.name || 'file';
  const ext  = parsed.ext  || '';

  let target = path.join(dir, safeName);
  let n = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${stem} (${n})${ext}`);
    n++;
  }

  // An identity backup holds every private key (encrypted with its passphrase): readable by this user only. Received files keep the default.
  const own = /\.anonchat$/i.test(target);
  fs.writeFileSync(target, Buffer.from(data.buffer, data.byteOffset, data.byteLength), { mode: own ? 0o600 : 0o666 });
  if (!own) markFromInternet(target);
  return target;
});

// ---- The data key (desktop/keystore.js) ----
// Obtained before the backend starts: from the OS vault without asking, or with the passphrase typed on the start screen. Kept in this
// process only, to hand to the backend (stdin) and the window's share of it to the page.
const keystore = require('./keystore');
let DATA_KEY = null;
let keyMode = null;                  // 'os' | 'passphrase'

let _splashLoaded = null;
function splashLoaded(splash) {
  if (!_splashLoaded) _splashLoaded = new Promise((r) => { if (!splash.webContents.isLoading()) r(); else splash.webContents.once('did-finish-load', r); });
  return _splashLoaded;
}
let _promptReply = null;
// Shows a step on the start screen and waits for the answer: { pass, confirm } or { action: 'quit' | 'erase' }.
async function askSplash(splash, step) {
  await splashLoaded(splash);
  if (splash.isDestroyed()) throw new Error('start screen closed');
  try { splash.setSize(460, step.mode === 'choose' ? 470 : 400); splash.center(); } catch {}
  try { splash.focus(); } catch {}
  return new Promise((resolve) => { _promptReply = resolve; splash.webContents.send('key-prompt', step); });
}
ipcMain.handle('key-submit', (evt, data) => {
  if (!splashWin || splashWin.isDestroyed() || evt.sender !== splashWin.webContents || !_promptReply) return false;
  const r = _promptReply; _promptReply = null;
  r(data && typeof data === 'object' ? data : {});
  return true;
});

async function obtainDataKey(splash) {
  const vault = keystore.vaultAvailable(safeStorage);
  let ks;
  try { ks = keystore.load(DATA_ROOT); }
  catch (e) {
    await keyFailure(splash, 'damaged');
    throw e;
  }
  if (!ks) {                                        // first start, or the first start after this update
    const dk = keystore.newDataKey();
    if (vault) {
      keystore.wrapOs(DATA_ROOT, safeStorage, dk);
      keyMode = 'os';
    } else {
      let error = null;
      for (;;) {
        const a = await askSplash(splash, { mode: 'choose', reason: 'nokeyring', error, min: keystore.MIN_PASSPHRASE });
        if (a.action === 'quit') { app.exit(0); throw new Error('quit'); }
        if (typeof a.pass !== 'string' || a.pass.length < keystore.MIN_PASSPHRASE) { error = 'short'; continue; }
        if (a.pass !== a.confirm) { error = 'mismatch'; continue; }
        await keystore.wrapPassphrase(DATA_ROOT, a.pass, dk);
        break;
      }
      keyMode = 'passphrase';
    }
    DATA_KEY = dk;
  } else if (ks.mode === 'os') {
    if (!vault) { await keyFailure(splash, 'novault'); throw new Error('vault unavailable'); }
    try { DATA_KEY = keystore.unwrapOs(ks, safeStorage); }
    catch (e) { await keyFailure(splash, 'vault'); throw e; }
    keyMode = 'os';
  } else {
    let error = null, tries = 0;
    for (;;) {
      const a = await askSplash(splash, { mode: 'enter', error });
      if (a.action === 'quit') { app.exit(0); throw new Error('quit'); }
      if (a.action === 'erase') { await eraseBeforeStart(); throw new Error('erased'); }
      if (typeof a.pass !== 'string' || !a.pass) { error = 'empty'; continue; }
      splash.webContents.send('key-busy');
      let dk;
      try { dk = await keystore.unwrapPassphrase(ks, a.pass); }
      catch (e) { await keyFailure(splash, 'damaged'); throw e; }   // anything unexpected: say so, never stay on "Unlocking…"

      if (dk) { DATA_KEY = dk; break; }
      tries++;
      error = 'wrong';
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** Math.max(0, tries - 3))));   // slows guessing at the screen
    }
    keyMode = 'passphrase';
  }
  try { splash.setSize(460, 320); splash.center(); } catch {}
  splash.webContents.send('key-done');
  return DATA_KEY;
}
// The key can't be obtained: say why on the start screen; it offers Quit (and, for a forgotten or lost key, starting over).
async function keyFailure(splash, reason) {
  const a = await askSplash(splash, { mode: 'error', reason });
  if (a.action === 'erase') await eraseBeforeStart();
  app.exit(0);
}
// "Start over" from the start screen: nothing is running yet, so the folder can go now (Chromium's own files are removed after exit).
async function eraseBeforeStart() {
  const dirs = eraseTargets();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 2 }); } catch {} }
  removeAfterExit(dirs.filter((d) => fs.existsSync(d)));
  app.exit(0);
}

// For the window: how the data key is kept, and the window's share of it. Only the main window, only from our own page.
function fromMainWindow(evt) { return mainWin && !mainWin.isDestroyed() && evt.sender === mainWin.webContents; }
ipcMain.handle('security_info', (evt) => {
  if (!fromMainWindow(evt) || !DATA_KEY) return null;
  return {
    mode: keyMode,
    vault: keystore.vaultAvailable(safeStorage) ? keystore.vaultName(safeStorage) : null,
    windowKey: keystore.windowKey(DATA_KEY).toString('base64'),
    minPassphrase: keystore.MIN_PASSPHRASE,
  };
});
// Settings: protect with a passphrase, or change it. Same data key, wrapped differently; nothing is re-encrypted. In passphrase mode the
// passphrase in use now must be given too (checked here, not only in the page): anyone at the unlocked computer could otherwise replace
// it and lock the owner out. From PIN mode the window checks the PIN first (the PIN lives in the window, not here).
ipcMain.handle('set_passphrase', async (evt, arg) => {
  if (!fromMainWindow(evt) || !DATA_KEY) return { error: 'denied' };
  const pass = arg && typeof arg === 'object' ? arg.pass : arg;
  if (typeof pass !== 'string' || pass.length < keystore.MIN_PASSPHRASE) return { error: 'short' };
  if (keyMode === 'passphrase') {
    const c = await checkCurrentPassphrase(arg && typeof arg === 'object' ? arg.current : null);
    if (!c.ok) return c;
  }
  try { await keystore.wrapPassphrase(DATA_ROOT, pass, DATA_KEY); keyMode = 'passphrase'; return { ok: true }; }
  catch (e) { return { error: 'failed' }; }
});
// The passphrase in use now, typed again: it must unlock this computer's data key. Five wrong tries lock it for 30 seconds (shared by
// every place that asks: Create backup, Change passphrase, Use the PIN instead).
let _passTries = 0, _passLockUntil = 0;
async function checkCurrentPassphrase(pass) {
  if (Date.now() < _passLockUntil) return { error: 'locked', wait: Math.ceil((_passLockUntil - Date.now()) / 1000) };
  if (typeof pass !== 'string' || !pass || pass.length > 1024) return { error: 'wrong' };
  let ks = null; try { ks = keystore.load(DATA_ROOT); } catch {}
  if (!ks || ks.mode !== 'passphrase') return { error: 'nomode' };
  let dk = null;
  try { dk = await keystore.unwrapPassphrase(ks, pass); } catch {}
  const good = !!dk && dk.length === DATA_KEY.length && require('crypto').timingSafeEqual(dk, DATA_KEY);
  if (dk) dk.fill(0);
  if (good) { _passTries = 0; return { ok: true }; }
  if (++_passTries >= 5) { _passTries = 0; _passLockUntil = Date.now() + 30000; return { error: 'locked', wait: 30 }; }
  return { error: 'wrong' };
}
// Confirms it is really the person at the keyboard before something sensitive (Create backup), in passphrase mode, where the window has
// no PIN of its own to check.
ipcMain.handle('verify_passphrase', async (evt, pass) => {
  if (!fromMainWindow(evt) || !DATA_KEY) return { error: 'denied' };
  return checkCurrentPassphrase(pass);
});
// Settings: back to the OS vault (the PIN unlocks the app again). From passphrase mode, only with the passphrase in use now.
ipcMain.handle('use_os_vault', async (evt, arg) => {
  if (!fromMainWindow(evt) || !DATA_KEY) return { error: 'denied' };
  if (!keystore.vaultAvailable(safeStorage)) return { error: 'novault' };
  if (keyMode === 'passphrase') {
    const c = await checkCurrentPassphrase(arg && typeof arg === 'object' ? arg.current : null);
    if (!c.ok) return c;
  }
  try { keystore.wrapOs(DATA_ROOT, safeStorage, DATA_KEY); keyMode = 'os'; return { ok: true }; }
  catch { return { error: 'failed' }; }
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  // Windows shows notifications only for an app with an identity; the installer registers this one (build.appId).
  if (process.platform === 'win32') { try { app.setAppUserModelId('network.anyone.anonchat'); } catch {} }
  installMacMenu();
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = isLocalUrl(details.url);
    if (!ok) console.error('[net-lock] blocked non-local request:', details.url.slice(0, 120));
    cb({ cancel: !ok });
  });
  // Every request the window makes to the UI server (page, assets, fetch, WebSocket upgrades) carries the launch token.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    if (!isUiServerUrl(details.url)) return cb({ requestHeaders: details.requestHeaders });
    cb({ requestHeaders: { ...details.requestHeaders, [UI_TOKEN_HEADER]: UI_TOKEN } });
  });

  // Only what the app uses: the microphone (never the camera), notifications, and writing to the clipboard (Copy buttons).
  const ALLOWED_PERMS = ['media', 'notifications', 'clipboard-sanitized-write'];
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => {
    if (perm === 'media') {
      const types = (details && details.mediaTypes) || [];
      return cb(types.length > 0 && types.every((t) => t === 'audio'));
    }
    cb(ALLOWED_PERMS.includes(perm));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, perm, _origin, details) => {
    if (perm === 'media') return !details || !details.mediaType || details.mediaType === 'audio';
    return ALLOWED_PERMS.includes(perm);
  });

  // The will-navigate guard lives on the main window (createMain), not globally: a global one would also block the splash, which loads from file://.
  app.on('web-contents-created', (_evt, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      // Only http(s) and mailto links go to the OS: peer-supplied file:/smb:/other schemes through shell.openExternal are a known Electron risk.
      try {
        const scheme = new URL(url).protocol;
        if (scheme === 'https:' || scheme === 'http:' || scheme === 'mailto:') {
          const win = BrowserWindow.fromWebContents(wc) || undefined;
          dialog.showMessageBox(win, {
            type: 'warning',
            buttons: [U('link.cancel', 'Cancel'), U('link.open', 'Open in browser')],
            defaultId: 0, cancelId: 0, noLink: true,
            title: U('link.title', 'Open in your browser?'),
            message: U('link.message', 'This link opens in your default browser, outside AnonChat.'),
            detail: U('link.detail', 'If your browser uses the SOCKS5 proxy shown in AnonChat\u2019s Circuits tab, the connection goes through the Anyone network. If it doesn\u2019t, the connection is made directly and the site can see your IP address.') + '\n\n' + url.slice(0, 200),
          }).then(({ response }) => { if (response === 1) shell.openExternal(url); }).catch(() => {});
        }
      } catch {}
      return { action: 'deny' };
    });
  });

  const splash = createSplash();
  let dataKey;
  try { dataKey = await obtainDataKey(splash); }
  catch (e) {
    console.error('[keys] could not get the data key:', e && e.message);
    return;                                   // the splash shows what happened and offers Quit
  }
  try { spawnBackend(splash, dataKey); }
  catch (e) {
    console.error('Failed to spawn backend:', e);
    try { if (splash && !splash.isDestroyed()) splash.webContents.send('backend-error', String(e?.message || e)); } catch {}
    return;
  }

  waitForReady(splash,
() => {
      createMain();
      if (splash && !splash.isDestroyed()) {
        try { if (splash && !splash.isDestroyed()) splash.webContents.send('backend-ready'); } catch {}
        // Brief beat so the user sees the "connected" state, then close.
        setTimeout(() => { if (splash && !splash.isDestroyed()) splash.close(); }, 600);
      }
    },
() => {
      if (splash && !splash.isDestroyed()) try { splash.webContents.send('backend-timeout'); } catch {}
    },
  );
});

app.on('window-all-closed', () => app.quit());

// Quit only after the backend has really stopped: the first request is held back (windows hidden) and quit is requested again afterwards.
let backendStopped = false;
app.on('before-quit', (e) => {
  if (_lastBadge) { _lastBadge = 0; linuxBadge(0, true); }      // the dock would otherwise keep showing the last count
  clearNotices();
  if (backendStopped) return;
  e.preventDefault();
  for (const w of BrowserWindow.getAllWindows()) { try { w.hide(); } catch {} }
  stopBackend().then(() => { backendStopped = true; app.quit(); });
});

// If we go down some other way, still don't leave the backend group behind.
process.on('exit', () => {
  if (proctree && backendPid && proctree.groupAlive(backendPid)) proctree.killTreeSync(backendPid);
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { stopBackend().then(() => process.exit(0)); });
}
