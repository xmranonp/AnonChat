// Exposes the minimal API the chat needs (saveFile) via contextBridge; ipcRenderer and Node are never exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // Save a file to ~/Downloads. data is a Uint8Array (at most 25 MB).
  saveFile: (name, data) => ipcRenderer.invoke('save_file_to_downloads', { name, data }),
  // Total unread messages, shown on the app icon (a number on macOS and Linux docks that support it, a dot on Windows).
  setUnreadCount: (n) => ipcRenderer.send('set_unread_count', n),
  // Erase everything on this computer and quit (Settings → Erase everything, after the page's own confirmation).
  eraseEverything: (labels) => ipcRenderer.invoke('erase_everything', labels),
  // How this computer's data key is kept ('os' vault or 'passphrase') and the window's share of it, which the page combines with the PIN.
  securityInfo: () => ipcRenderer.invoke('security_info'),
  // In passphrase mode both need the passphrase in use now (current); a wrong one answers { error: 'wrong' | 'locked', wait }.
  setPassphrase: (pass, current) => ipcRenderer.invoke('set_passphrase', { pass, current }),
  useOsVault: (current) => ipcRenderer.invoke('use_os_vault', { current }),
  // Passphrase mode: checks the passphrase that opens AnonChat (before Create backup). { ok } or { error: 'wrong' | 'locked', wait }.
  verifyPassphrase: (pass) => ipcRenderer.invoke('verify_passphrase', pass),
  // The language chosen in the app, and the words for the dialogs the desktop app shows itself (opening a link outside the network).
  setLanguage: (lang, strings) => ipcRenderer.send('ui_language', { lang, strings }),
  // A system notification ({ title, body, tag }); clicking it brings the window forward and reports the tag (the chat to open).
  notify: (n) => ipcRenderer.send('notify', n),
  // Takes a notice away (an incoming call that was answered, declined or missed).
  closeNotice: (tag) => ipcRenderer.send('notice_close', tag),
  // Backup and restore (Settings → Backup).
  // data: the backup's bytes as the window opened them (a Uint8Array); they are what the restart restores.
  eraseForRestore: (data, labels) => ipcRenderer.invoke('erase_for_restore', { data, labels }),
  pendingRestore: () => ipcRenderer.invoke('pending_restore'),
  relaunch: () => ipcRenderer.invoke('relaunch_app'),
  onNoticeClick: (cb) => { if (typeof cb === 'function') ipcRenderer.on('notice-click', (_e, tag) => cb(tag)); },
});
