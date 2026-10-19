'use strict';

// Chooses the SOCKS and control ports for anon. SOCKS prefers 9050 and moves only when "dynamic port" is on; the control port moves whenever it is busy.

const net = require('net');

const HOST = '127.0.0.1';

function isFree(port, host = HOST) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

function ephemeralPort(host = HOST) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, host, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function firstFree(from, to, taken, check) {
  for (let p = from; p <= to; p++) {
    if (taken.includes(p)) continue;
    if (await check(p)) return p;
  }
  return await ephemeralPort();
}

async function choosePorts({ socksPref = 9050, ctrlPref = 9051, dynamic = true, check = isFree } = {}) {
  let socks = socksPref, socksMoved = false, socksBlocked = false;
  if (!(await check(socksPref))) {
    if (dynamic) { socks = await firstFree(9052, 9199, [ctrlPref], check); socksMoved = true; }
    else socksBlocked = true;
  }
  let ctrl = ctrlPref;
  if (ctrl === socks || !(await check(ctrl))) ctrl = await firstFree(9200, 9299, [socks], check);
  return { socks, ctrl, socksMoved, socksBlocked };
}

module.exports = { isFree, choosePorts };
