// Bridge/ntrip-bridge.js
const http = require('http');
const net = require('net');
const tls = require('tls');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8081; // <- fondamentale per Render

// Server HTTP (serve per health-check e per l'upgrade WS)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK\n');
});

// WebSocket su *quello stesso* server HTTP
const wss = new WebSocket.Server({ server });

wss.on('listening', () => {
  console.log(`HTTP/WS server listening on :${PORT}`);
});

wss.on('connection', (ws) => {
  console.log('WS client connected');

  let casterSocket = null;
  let connected = false;

  const cleanup = () => {
    try { casterSocket?.end(); } catch {}
    casterSocket = null;
    connected = false;
  };

  ws.on('close', cleanup);
  ws.on('error', (e) => { console.error('WS error:', e.message); cleanup(); });

  ws.on('message', (raw) => {
    if (raw instanceof Buffer || raw instanceof ArrayBuffer) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'connect' && !connected) {
      connected = true;
      const { host, port, mountpoint, user, password, ssl } = msg;
      const useTLS = !!ssl;
      console.log(`Connecting to caster ${host}:${port} mp=${mountpoint} TLS=${useTLS}`);

      const opts = { host, port: Number(port) || (useTLS ? 443 : 2101) };
      const sock = useTLS ? tls.connect(opts) : net.connect(opts);

      sock.on('connect', () => {
        casterSocket = sock;

        const auth = Buffer.from(`${user || ''}:${password || ''}`).toString('base64');
        const req =
          `GET /${mountpoint} HTTP/1.1\r\n` +
          `Host: ${host}\r\n` +
          `User-Agent: NTRIP AgroSync-Bridge/1.0\r\n` +
          (user ? `Authorization: Basic ${auth}\r\n` : '') +
          `Connection: keep-alive\r\n` +
          `Ntrip-Version: Ntrip/2.0\r\n\r\n`;

        sock.write(req);

        // parse header iniziale
        let buf = Buffer.alloc(0), headerDone = false;
        const onData = (chunk) => {
          if (!headerDone) {
            buf = Buffer.concat([buf, chunk]);
            const s = buf.toString('utf8');
            const i = s.indexOf('\r\n\r\n');
            if (i >= 0) {
              headerDone = true;
              const header = s.slice(0, i);
              const rest = buf.slice(i + 4);
              const ok = header.includes('200') || header.includes('ICY 200');
              if (!ok) {
                console.error('NTRIP handshake failed:', header);
                try { ws.send(JSON.stringify({ type:'error', message:'NTRIP handshake failed' })); } catch {}
                try { ws.close(); } catch {}
                try { sock.end(); } catch {}
                return;
              }
              try { ws.send(JSON.stringify({ type:'status', message:'CONNECTED' })); } catch {}
              if (rest.length && ws.readyState === WebSocket.OPEN) ws.send(rest);
              sock.off('data', onData);
              sock.on('data', (b) => { if (ws.readyState === WebSocket.OPEN) ws.send(b); });
            }
          }
        };
        sock.on('data', onData);
      });

      sock.on('error', (e) => {
        console.error('Caster error:', e.message);
        try { ws.send(JSON.stringify({ type:'error', message:e.message })); } catch {}
        try { ws.close(); } catch {}
      });

      sock.on('close', () => {
        console.log('Caster closed');
        try { ws.close(); } catch {}
      });
    }

    if (msg.type === 'gga' && casterSocket && msg.sentence) {
      const line = msg.sentence.trim().replace(/\n+$/,'') + '\r\n';
      casterSocket.write(line);
    }

    if (msg.type === 'disconnect') {
      try { ws.close(); } catch {}
    }
  });
});

server.listen(PORT, () => {
  console.log(`Ready on :${PORT}`);
});
