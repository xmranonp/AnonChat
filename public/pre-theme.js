// Applies the saved theme before first paint. A separate file, not inline, so the CSP needs no 'unsafe-inline' for scripts.
try {
  var th = localStorage.getItem('anyonechat.theme');
  if (th === 'light') document.documentElement.classList.add('light');
} catch (e) {}
