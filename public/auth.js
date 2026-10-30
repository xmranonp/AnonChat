// Browser mode only (the desktop app's window gets its token from the app itself, and finds none here).
// The start link carries the token in its fragment (http://localhost:PORT/#t=...). A fragment is never sent to a server and never
// leaves this tab; it is moved into this tab's own storage, removed from the address bar, and added as a header to every request
// the page makes to its own server (and offered as a WebSocket sub-protocol, since a browser can't set headers there).
// There is no cookie: browsers send cookies to every port on the same host name, so another local web server would receive it.
(() => {
  const KEY = 'anonchat.t';
  let token = null;
  try {
    const m = /(?:^|[#&])t=([0-9a-f]{64})(?:&|$)/.exec(location.hash);
    if (m) {
      token = m[1];
      sessionStorage.setItem(KEY, token);
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      token = sessionStorage.getItem(KEY);
    }
  } catch { /* storage unavailable: nothing to add */ }
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.origin === location.origin) {
        const headers = new Headers((init && init.headers) || (typeof input !== 'string' && input.headers) || undefined);
        headers.set('x-anonchat-token', token);
        init = Object.assign({}, init, { headers });
      }
    } catch { /* leave the request as it is */ }
    return nativeFetch(input, init);
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      let same = false;
      try { same = new URL(url, location.href).host === location.host; } catch {}
      super(url, same ? ['anonchat', 'anonchat.' + token] : protocols);
    }
  };
})();
