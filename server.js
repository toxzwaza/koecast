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
  const url = req.url.split('?')[0];

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
// rooms = { roomId: { host: ws|null, listeners: Map<ws, {name}>, speakingListener: ws|null } }
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = { host: null, listeners: new Map(), speakingListener: null };
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
  const names = [];
  for (const [, info] of room.listeners) {
    names.push(info.name);
  }
  const msg = JSON.stringify({ type: 'listener_count', count, names });

  if (room.host && room.host.readyState === 1) {
    room.host.send(msg);
  }
  for (const [listener] of room.listeners) {
    if (listener.readyState === 1) {
      listener.send(msg);
    }
  }
}

function notifyListeners(roomId, message) {
  const room = rooms[roomId];
  if (!room) return;

  const msg = JSON.stringify(message);
  for (const [listener] of room.listeners) {
    if (listener.readyState === 1) {
      listener.send(msg);
    }
  }
}

function broadcastToAll(roomId, message) {
  const room = rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(message);
  if (room.host && room.host.readyState === 1) {
    room.host.send(msg);
  }
  for (const [listener] of room.listeners) {
    if (listener.readyState === 1) {
      listener.send(msg);
    }
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || 'default';
  const role = url.searchParams.get('role');
  const name = decodeURIComponent(url.searchParams.get('name') || '匿名');

  const room = getRoom(roomId);

  if (role === 'host') {
    if (room.host) {
      ws.send(JSON.stringify({ type: 'error', message: 'このルームには既に説明者が接続しています' }));
      ws.close();
      return;
    }
    room.host = ws;
    ws.roomId = roomId;
    ws.role = 'host';

    console.log(`[Room ${roomId}] 説明者が接続しました`);

    ws.send(JSON.stringify({ type: 'listener_count', count: room.listeners.size }));

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // 音声データ → 全聴講者にブロードキャスト
        for (const [listener] of room.listeners) {
          if (listener.readyState === 1) {
            listener.send(data, { binary: true });
          }
        }
      } else {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'start_broadcast') {
            notifyListeners(roomId, { type: 'broadcast_started' });
            console.log(`[Room ${roomId}] 配信開始`);

          } else if (msg.type === 'stop_broadcast') {
            notifyListeners(roomId, { type: 'broadcast_stopped' });
            console.log(`[Room ${roomId}] 配信停止`);

          } else if (msg.type === 'allow_speak') {
            // 説明者が聴講者の発言を許可
            const targetName = msg.name;
            for (const [listener, info] of room.listeners) {
              if (info.name === targetName) {
                room.speakingListener = listener;
                listener.send(JSON.stringify({ type: 'speak_allowed' }));
                broadcastToAll(roomId, { type: 'speaker_changed', name: targetName });
                console.log(`[Room ${roomId}] ${targetName} の発言を許可`);
                break;
              }
            }

          } else if (msg.type === 'revoke_speak') {
            // 発言権を取り消す
            if (room.speakingListener) {
              const info = room.listeners.get(room.speakingListener);
              const speakerName = info ? info.name : '不明';
              room.speakingListener.send(JSON.stringify({ type: 'speak_revoked' }));
              room.speakingListener = null;
              broadcastToAll(roomId, { type: 'speaker_changed', name: null });
              console.log(`[Room ${roomId}] ${speakerName} の発言権を取り消し`);
            }

          } else if (msg.type === 'transcription') {
            // 説明者からの文字おこしを全員に配信
            broadcastToAll(roomId, {
              type: 'transcription',
              name: '説明者',
              text: msg.text,
              isFinal: msg.isFinal
            });
          }
        } catch (e) {
          // 無視
        }
      }
    });

    ws.on('close', () => {
      room.host = null;
      room.speakingListener = null;
      console.log(`[Room ${roomId}] 説明者が切断しました`);
      notifyListeners(roomId, { type: 'host_disconnected' });
      notifyListeners(roomId, { type: 'speaker_changed', name: null });
      broadcastListenerCount(roomId);
      cleanupRoom(roomId);
    });

  } else {
    // 聴講者
    room.listeners.set(ws, { name });
    ws.roomId = roomId;
    ws.role = 'listener';
    ws.listenerName = name;

    console.log(`[Room ${roomId}] 聴講者「${name}」が接続しました（計 ${room.listeners.size} 人）`);

    if (room.host) {
      ws.send(JSON.stringify({ type: 'host_connected' }));
    }

    broadcastListenerCount(roomId);

    // ホストに新規参加を通知
    if (room.host && room.host.readyState === 1) {
      room.host.send(JSON.stringify({ type: 'listener_joined', name }));
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // 発言許可中の聴講者の音声 → 全員にブロードキャスト
        if (room.speakingListener === ws) {
          // ホストに送信
          if (room.host && room.host.readyState === 1) {
            room.host.send(data, { binary: true });
          }
          // 他の聴講者に送信
          for (const [listener] of room.listeners) {
            if (listener !== ws && listener.readyState === 1) {
              listener.send(data, { binary: true });
            }
          }
        }
      } else {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'hand_raise') {
            // 挙手通知をホストに送信
            if (room.host && room.host.readyState === 1) {
              room.host.send(JSON.stringify({ type: 'hand_raised', name }));
            }
            console.log(`[Room ${roomId}] ${name} が挙手しました`);

          } else if (msg.type === 'hand_lower') {
            // 挙手取り消しをホストに送信
            if (room.host && room.host.readyState === 1) {
              room.host.send(JSON.stringify({ type: 'hand_lowered', name }));
            }
            console.log(`[Room ${roomId}] ${name} が挙手を取り消しました`);

          } else if (msg.type === 'transcription') {
            // 発言中の聴講者からの文字おこしを全員に配信
            if (room.speakingListener === ws) {
              broadcastToAll(roomId, {
                type: 'transcription',
                name: name,
                text: msg.text,
                isFinal: msg.isFinal
              });
            }
          }
        } catch (e) {
          // 無視
        }
      }
    });

    ws.on('close', () => {
      // 発言中の聴講者が切断した場合
      if (room.speakingListener === ws) {
        room.speakingListener = null;
        broadcastToAll(roomId, { type: 'speaker_changed', name: null });
      }

      room.listeners.delete(ws);
      console.log(`[Room ${roomId}] 聴講者「${name}」が切断しました（計 ${room.listeners.size} 人）`);

      // ホストに退出を通知
      if (room.host && room.host.readyState === 1) {
        room.host.send(JSON.stringify({ type: 'listener_left', name }));
      }

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
