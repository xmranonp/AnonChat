'use strict';
// Names for files saved from messages (desktop/main.js save_file_to_downloads). Kept apart from main.js so the tests can load it.
const path = require('path');

// A received file's name is the sender's to choose. Only the last part is kept (no folders, with either slash), and what Windows would
// read as something else is replaced on every system, so a file saved anywhere behaves the same:
//   ':' (on Windows "x.exe::$DATA" is x.exe itself, and the mark below would then fail: the program would carry no download warning),
//   the other characters Windows forbids, control and direction-changing characters ("photo\u202Egpj.exe" shows as photo…exe.jpg),
//   dots and spaces at the ends (Windows drops trailing ones, so "x.exe." becomes x.exe), and device names such as CON or NUL.
function safeFileName(raw) {
  let n = String(raw || '').split(/[\\/]/).pop();
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_');
  n = n.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(n)) n = '_' + n;
  if (n.length > 200) { const ext = path.extname(n).slice(0, 16); n = n.slice(0, 200 - ext.length) + ext; }
  return n || 'download';
}

module.exports = { safeFileName };
