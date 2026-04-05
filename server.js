const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// --- HTTP サーバー（静的ファイル配信） ---
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let filePath;
  const url = req.url.split('?')[0]; // クエリパラメータを除去

  if (url === '/' || url === '/host' || url === '/host.html') {
    filePath = path.join(__dirname, 'host.html');
  } else if (url === '/listen' || url === '/listen.html') {
    filePath = path.join(__dirname, 'listen.html');
  } else {
    filePath = path.join(__dirname, url);
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// --- WebSocket サーバー ---
const wss = new WebSocketServer({ server });

// ルームごとの管理
// rooms = { roomId: { host: ws|null, listeners: Set<ws> } }
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = { host: null, listeners: new Set() };
  }
  return rooms[roomId];
}

function cleanupRoom(roomId) {
  const room = rooms[roomId];
  if (room && !room.host && room.listeners.size === 0) {
    delete rooms[roomId];
  }
}

function broadcastListenerCount(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const count = room.listeners.size;
  const msg = JSON.stringify({ type: 'listener_count', count });

  // ホストにも聴講者数を通知
  if (room.host && room.host.readyState === 1) {
    room.host.send(msg);
  }
  // 全聴講者にも通知
  for (const listener of room.listeners) {
    if (listener.readyState === 1) {
      listener.send(msg);
    }
  }
}

function notifyListeners(roomId, message) {
  const room = rooms[roomId];
  if (!room) return;

  const msg = JSON.stringify(message);
  for (const listener of room.listeners) {
    if (listener.readyState === 1) {
      listener.send(msg);
    }
  }
}

wss.on('connection', (ws, req) => {
  // URLからroomパラメータとroleを取得
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || 'default';
  const role = url.searchParams.get('role'); // 'host' or 'listener'

  const room = getRoom(roomId);

  if (role === 'host') {
    // 既にホストがいる場合は拒否
    if (room.host) {
      ws.send(JSON.stringify({ type: 'error', message: 'このルームには既に説明者が接続しています' }));
      ws.close();
      return;
    }
    room.host = ws;
    ws.roomId = roomId;
    ws.role = 'host';

    console.log(`[Room ${roomId}] 説明者が接続しました`);

    // 現在の聴講者数を通知
    ws.send(JSON.stringify({ type: 'listener_count', count: room.listeners.size }));

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // 音声データ → 全聴講者にブロードキャスト
        for (const listener of room.listeners) {
          if (listener.readyState === 1) {
            listener.send(data, { binary: true });
          }
        }
      } else {
        // テキストメッセージ（制御用）
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'start_broadcast') {
            notifyListeners(roomId, { type: 'broadcast_started' });
            console.log(`[Room ${roomId}] 配信開始`);
          } else if (msg.type === 'stop_broadcast') {
            notifyListeners(roomId, { type: 'broadcast_stopped' });
            console.log(`[Room ${roomId}] 配信停止`);
          }
        } catch (e) {
          // 無視
        }
      }
    });

    ws.on('close', () => {
      room.host = null;
      console.log(`[Room ${roomId}] 説明者が切断しました`);
      notifyListeners(roomId, { type: 'host_disconnected' });
      broadcastListenerCount(roomId);
      cleanupRoom(roomId);
    });

  } else {
    // 聴講者
    room.listeners.add(ws);
    ws.roomId = roomId;
    ws.role = 'listener';

    console.log(`[Room ${roomId}] 聴講者が接続しました（計 ${room.listeners.size} 人）`);

    // ホストが接続中かどうかを通知
    if (room.host) {
      ws.send(JSON.stringify({ type: 'host_connected' }));
    }

    broadcastListenerCount(roomId);

    ws.on('close', () => {
      room.listeners.delete(ws);
      console.log(`[Room ${roomId}] 聴講者が切断しました（計 ${room.listeners.size} 人）`);
      broadcastListenerCount(roomId);
      cleanupRoom(roomId);
    });
  }

  ws.on('error', (err) => {
    console.error(`[Room ${roomId}] WebSocketエラー:`, err.message);
  });
});

// --- サーバー起動 ---
server.listen(PORT, () => {
  console.log(`=== 工場見学用音声配信サーバー ===`);
  console.log(`HTTP  : http://localhost:${PORT}`);
  console.log(`説明者: http://localhost:${PORT}/host.html`);
  console.log(`聴講者: http://localhost:${PORT}/listen.html`);
  console.log(`（ルーム指定例: /listen.html?room=A）`);
  console.log(`================================`);
});
