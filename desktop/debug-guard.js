// A packaged AnonChat cannot be opened up for debugging from outside. Chromium accepts switches that open a debugging port or pipe,
// start a program in front of every process it creates, or inject code; any program running as the same user could use them to read
// the window's memory and storage, bypassing the PIN lock and the Keychain / DPAPI binding. Packaged builds refuse to start with them.
// (Electron's own fuses already switch off --inspect for the main process, RunAsNode and NODE_OPTIONS.)

const REFUSED = [
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins',
  'inspect', 'inspect-brk', 'inspect-port', 'inspect-publish-uid', 'inspect-brk-node', 'debug-port',
  'js-flags', 'renderer-cmd-prefix', 'utility-cmd-prefix', 'gpu-launcher', 'ppapi-plugin-launcher', 'plugin-launcher', 'zygote-cmd-prefix',
  'load-extension', 'disable-extensions-except', 'load-and-launch-app', 'enable-automation', 'enable-remote-extensions', 'remote-debugging-targets',
  'host-rules', 'proxy-server', 'proxy-pac-url', 'proxy-bypass-list', 'no-proxy-server',        // the network lock owns the routes
  'disable-web-security', 'allow-running-insecure-content', 'ignore-certificate-errors', 'allow-file-access-from-files',
];

// Returns the first refused switch found in argv, or null. Both "--name" and "--name=value" (also "-name" and "/name" are not Chromium forms on our platforms).
function refusedSwitch(argv) {
  for (const a of argv || []) {
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    if (a === '--') break;
    const name = a.slice(2).split('=')[0].toLowerCase();
    if (REFUSED.includes(name)) return name;
  }
  return null;
}

module.exports = { REFUSED, refusedSwitch };
