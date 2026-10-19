// Relays backend events from the main process to the splash page as DOM events.
const { contextBridge, ipcRenderer } = require('electron');

const handlers = new Map();

function on(name, cb) {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name).add(cb);
}

for (const ch of ['bootstrap-progress', 'backend-log', 'backend-ready', 'backend-timeout', 'backend-error', 'key-prompt', 'key-busy', 'key-done']) {
  ipcRenderer.on(ch, (_evt, payload) => {
    const set = handlers.get(ch);
    if (set) for (const cb of set) try { cb(payload); } catch {}
  });
}

// The start screen's answer to a passphrase step: { pass, confirm } or { action: 'quit' | 'erase' }.
contextBridge.exposeInMainWorld('splash', { on, submit: (data) => ipcRenderer.invoke('key-submit', data) });
