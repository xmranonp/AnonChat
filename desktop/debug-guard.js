// A packaged AnonChat cannot be opened up for debugging from outside. Chromium accepts switches that open a debugging port or pipe,
// start a program in front of every process it creates, or inject code; any program running as the same user could use them to read
// the window's memory and storage, bypassing the PIN lock and the Keychain / DPAPI binding. Packaged builds refuse to start with them.
// (Electron's fuses, set in package.json "electronFuses", also switch off --inspect for the main process, RunAsNode and NODE_OPTIONS.)

const REFUSED = [
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins',
  'inspect', 'inspect-brk', 'inspect-port', 'inspect-publish-uid', 'inspect-brk-node', 'debug-port',
  'js-flags', 'renderer-cmd-prefix', 'utility-cmd-prefix', 'gpu-launcher', 'ppapi-plugin-launcher', 'plugin-launcher', 'zygote-cmd-prefix',
  'load-extension', 'disable-extensions-except', 'load-and-launch-app', 'enable-automation', 'enable-remote-extensions', 'remote-debugging-targets',
  'host-rules', 'proxy-server', 'proxy-pac-url', 'proxy-bypass-list', 'no-proxy-server',        // the network lock owns the routes
  'disable-web-security', 'allow-running-insecure-content', 'ignore-certificate-errors', 'allow-file-access-from-files',
];

// Returns the first refused switch found in argv, or null. Chromium reads a switch written with two dashes or one ("--name", "-name",
// with or without "=value"), and on Windows also with a slash ("/name"); every one of those spellings is checked, in any case. Chromium
// stops reading switches after a bare "--", and so does this.
function refusedSwitch(argv, platform = process.platform) {
  for (const a of argv || []) {
    if (typeof a !== 'string') continue;
    if (a === '--') break;
    let rest;
    if (a.startsWith('--')) rest = a.slice(2);
    else if (a.startsWith('-')) rest = a.slice(1);
    else if (platform === 'win32' && a.startsWith('/')) rest = a.slice(1);
    else continue;
    const name = rest.split('=')[0].toLowerCase();
    if (REFUSED.includes(name)) return name;
  }
  return null;
}

// Second check on what Chromium itself parsed (app.commandLine), so a spelling not covered above is caught as well. Electron adds
// --allow-file-access-from-files itself when the GrantFileProtocolExtraPrivileges fuse is on, so that one is checked on argv only.
const ADDED_BY_ELECTRON = new Set(['allow-file-access-from-files']);
function refusedParsedSwitch(commandLine) {
  if (!commandLine || typeof commandLine.hasSwitch !== 'function') return null;
  for (const name of REFUSED) if (!ADDED_BY_ELECTRON.has(name) && commandLine.hasSwitch(name)) return name;
  return null;
}

module.exports = { REFUSED, refusedSwitch, refusedParsedSwitch };
