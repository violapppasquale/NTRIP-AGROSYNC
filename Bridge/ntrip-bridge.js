// ntrip-bridge.js
const net = require('net');
const tls = require('tls');
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8081 }, () =>
  console.log('WS bridge pronto su ws://localhost:8081')
);

wss.on('connection', (ws) => {
  let sock = null;
  let lastGGA = null;
  let ggaTimer = null;

  function cleanup() {
    if (ggaTimer) clearInterval(ggaTimer), (ggaTimer = null);
    if (sock) sock.destroy(), (sock = null);
  }

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  ws.on('message', (raw) => {
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch { /* ignore non-JSON */ }

    if (!msg) return;

    if (msg.type === 'connect') {
      const { host, port, mountpoint, user, password, ssl } = msg;
      if (sock) cleanup();

      const connect = ssl ? tls.connect : net.connect;
      sock = connect({ host, port: Number(port) || 2101 }, () => {
        const auth = Buffer.from(`${user || ''}:${password || ''}`).toString('base64');
        const req =
`GET /${mountpoint} HTTP/1.0\r
User-Agent: NTRIP AgroSync/2.1\r
Accept: */*\r
Ntrip-Version: NTRIP/2.0\r
Authorization: Basic ${auth}\r
Connection: keep-alive\r
\r
`;
        sock.write(req);
      });

      let header = '';
      let headersDone = false;

      sock.on('data', (chunk) => {
        if (!headersDone) {
          header += chunk.toString('binary');
          const ix = header.indexOf('\r\n\r\n');
          if (ix === -1) return;
          const head = header.slice(0, ix);
          headersDone = true;

          const ok = head.startsWith('ICY 200') || head.includes('200 OK');
          if (!ok) {
            ws.send(JSON.stringify({ type: 'error', message: head.slice(0, 200) }));
            cleanup();
            return;
          }
          ws.send(JSON.stringify({ type: 'status', message: 'CONNECTED' }));

          const rest = Buffer.from(header.slice(ix + 4), 'binary');
          if (rest.length) ws.send(rest);

          ggaTimer = setInterval(() => {
            if (lastGGA && sock) sock.write(lastGGA + '\r\n');
          }, 10000);
          return;
        }
        ws.send(chunk);
      });

      sock.on('close', () => { ws.send(JSON.stringify({ type: 'status', message: 'DISCONNECTED' })); cleanup(); });
      sock.on('error', (e) => { ws.send(JSON.stringify({ type: 'error', message: String(e) })); cleanup(); });
    }

    if (msg.type === 'gga') {
      if (sock && msg.sentence && msg.sentence.startsWith('$')) {
        lastGGA = msg.sentence.trim();
        try { sock.write(lastGGA + '\r\n'); } catch {}
      }
    }

    if (msg.type === 'disconnect') {
      ws.send(JSON.stringify({ type: 'status', message: 'DISCONNECTING' }));
      cleanup();
    }
  });
});
