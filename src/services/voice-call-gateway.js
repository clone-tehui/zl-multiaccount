import { WebSocketServer, WebSocket } from 'ws';

export function installVoiceCallGateway(server, { authorize, calls }) {
  const gateway = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/api/calls/media') throw new Error('Not found');
      if (!req.headers.origin || new URL(req.headers.origin).host !== req.headers.host) throw new Error('Forbidden origin');
      const scope = authorize(req, url.searchParams);
      gateway.handleUpgrade(req, socket, head, (connection) => gateway.emit('connection', connection, req, scope, url.searchParams));
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });
  gateway.on('connection', (connection, req, scope, query) => {
    let lease = null;
    let starting = false;
    let closed = false;
    let alive = true;
    let packetCount = 0;
    let packetWindow = Date.now();
    calls.diagnose?.('gateway.open', scope);
    const valid = () => {
      const current = authorize(req, query);
      if (current.ownerId !== scope.ownerId || current.accountId !== scope.accountId || current.threadId !== scope.threadId) throw new Error('Forbidden');
    };
    const send = (message) => {
      try {
        valid();
        if (connection.readyState !== WebSocket.OPEN) return;
        if (Buffer.isBuffer(message) && connection.bufferedAmount >= 4096) return;
        if (connection.bufferedAmount > 65536) { connection.close(1013, 'Slow connection'); return; }
        connection.send(Buffer.isBuffer(message) ? message : JSON.stringify(message));
      } catch {
        connection.close(1008, 'Access revoked');
      }
    };
    const close = () => {
      if (closed) return;
      closed = true;
      calls.diagnose?.('gateway.closed', scope);
      clearInterval(heartbeat);
      void calls.close(lease);
    };
    const heartbeat = setInterval(() => {
      if (!alive) return connection.terminate();
      try { valid(); } catch { connection.close(1008, 'Access revoked'); return; }
      alive = false;
      connection.ping();
    }, 15000);
    heartbeat.unref?.();
    connection.on('pong', () => { alive = true; });
    connection.on('close', close);
    connection.on('error', close);
    connection.on('message', async (data, binary) => {
      try {
        valid();
        if (Date.now() - packetWindow >= 1000) { packetCount = 0; packetWindow = Date.now(); }
        if (++packetCount > 100) throw new Error('Quá nhiều dữ liệu cuộc gọi.');
        if (binary) {
          if (!lease || lease.ended || data.length > 4096) return;
          lease.sendAudioFrame(data);
          return;
        }
        const message = JSON.parse(data.toString());
        if (message.type === 'start' || message.type === 'accept') {
          if (lease || starting || closed) throw new Error('Cuộc gọi đã bắt đầu.');
          starting = true;
          try {
            lease = await calls.open({ ...scope, mediaVersion: query.get('mediaVersion') === '2' ? 2 : 1, incoming: message.type === 'accept', send, onLease: (reserved) => { lease = reserved; } });
            if (closed) await calls.close(lease);
          } finally { starting = false; }
        } else if (message.type === 'reject') {
          await calls.reject(scope);
          connection.close(1000);
        } else if (message.type === 'end') {
          closed = true;
          await calls.close(lease);
          clearInterval(heartbeat);
          connection.close(1000);
        } else throw new Error('Thao tác cuộc gọi không hợp lệ.');
      } catch {
        calls.diagnose?.('gateway.error', scope);
        send({ type: 'error', message: 'Không thực hiện được cuộc gọi. Kiểm tra account đã kết nối và thử lại.' });
        connection.close(1011, 'Call failed');
      }
    });
    send({ type: 'ready' });
  });
  return gateway;
}
