#!/usr/bin/env node
// ISP Speed Logger - LAN speed test server
//
// Run this on a second device on your home network (another PC, a Raspberry Pi, a NAS...).
// The extension then measures real download/upload speed between this computer and that device,
// which shows what your home network (Wi-Fi, cables, switch, router) can do, independent of the ISP.
//
//   node server.js            # listens on port 8787
//   node server.js 9000       # custom port
//
// No dependencies. Speaks the same tiny protocol as the public LibreSpeed servers.

const http = require('http');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || 8787;
const CHUNK = crypto.randomBytes(1024 * 1024); // 1 MB of incompressible data, reused
const MAX_MB = 2048;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Private-Network': 'true', // Chrome Private Network Access preflight
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // Download: stream N megabytes
  if (url.pathname === '/garbage.php') {
    const mb = Math.min(MAX_MB, Math.max(1, Number(url.searchParams.get('ckSize')) || 100));
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/octet-stream', 'Content-Length': mb * CHUNK.length });
    let sent = 0;
    let closed = false;
    res.on('close', () => { closed = true; });
    const pump = () => {
      while (!closed && sent < mb) {
        sent++;
        if (!res.write(CHUNK)) { res.once('drain', pump); return; } // respect backpressure
      }
      if (!closed) res.end();
    };
    return pump();
  }

  // Upload sink / ping: read and discard the body, answer immediately afterwards
  if (url.pathname === '/empty.php') {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(200, { ...CORS, 'Content-Length': 0 }); res.end(); });
    req.on('error', () => res.destroy());
    return;
  }

  if (url.pathname === '/getIP.php') {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end(ip);
  }

  res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' });
  res.end('ISP Speed Logger LAN server is running.\n');
});

server.keepAliveTimeout = 30000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('ISP Speed Logger LAN server running. Put one of these addresses in the extension settings:\n');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${PORT}`);
    }
  }
  console.log('\nThe device running this must be on your home network, not this PC. Press Ctrl+C to stop.');
});
