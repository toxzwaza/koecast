const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Murakami0819';

// --- JSONファイルベース永続ストレージ ---
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const DB_FILE = path.join(dataDir, 'koecast.json');

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { rooms: {}, transcriptions: {}, logs: {} };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

let store = loadDB();

function nowStr() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

// --- ルーム有効期限チェック ---
function isRoomAccessible(room) {
  if (!room) return false;
  if (!room.is_active) return false;
  const now = new Date();
  if (room.starts_at && new Date(room.starts_at) > now) return false;
  if (room.expires_at && new Date(room.expires_at) < now) return false;
  return true;
}

// --- HTTP サーバー ---
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function checkAuth(req) {
  const auth = req.headers.authorization;
  return auth === `Bearer ${ADMIN_PASSWORD}`;
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const urlPath = urlObj.pathname;
  const method = req.method;

  // --- REST API ---
  if (urlPath.startsWith('/api/')) {
    if (!checkAuth(req)) {
      sendJSON(res, 401, { error: '認証が必要です' });
      return;
    }

    try {
      // GET /api/rooms
      if (method === 'GET' && urlPath === '/api/rooms') {
        const result = Object.values(store.rooms).map(r => {
          const live = liveRooms[r.id];
          return {
            ...r,
            live_listeners: live ? live.listeners.size : 0,
            live_host_connected: live ? !!live.host : false,
            is_accessible: isRoomAccessible(r),
          };
        }).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        sendJSON(res, 200, result);
        return;
      }

      // POST /api/rooms
      if (method === 'POST' && urlPath === '/api/rooms') {
        const body = await parseBody(req);
        const id = body.id || Date.now().toString(36);
        if (store.rooms[id]) {
          sendJSON(res, 409, { error: 'このルームIDは既に存在します' });
          return;
        }
        store.rooms[id] = {
          id,
          name: body.name || id,
          description: body.description || '',
          starts_at: body.starts_at || null,
          expires_at: body.expires_at || null,
          created_at: nowStr(),
          is_active: true,
        };
        store.transcriptions[id] = store.transcriptions[id] || [];
        store.logs[id] = store.logs[id] || [];
        saveDB(store);
        sendJSON(res, 201, store.rooms[id]);
        return;
      }

      // PUT /api/rooms/:id
      const putMatch = urlPath.match(/^\/api\/rooms\/([^/]+)$/);
      if (method === 'PUT' && putMatch) {
        const id = decodeURIComponent(putMatch[1]);
        const existing = store.rooms[id];
        if (!existing) { sendJSON(res, 404, { error: 'ルームが見つかりません' }); return; }
        const body = await parseBody(req);
        store.rooms[id] = {
          ...existing,
          name: body.name ?? existing.name,
          description: body.description ?? existing.description,
          starts_at: body.starts_at !== undefined ? body.starts_at : existing.starts_at,
          expires_at: body.expires_at !== undefined ? body.expires_at : existing.expires_at,
          is_active: body.is_active !== undefined ? body.is_active : existing.is_active,
        };
        saveDB(store);
        sendJSON(res, 200, store.rooms[id]);
        return;
      }

      // DELETE /api/rooms/:id
      const delMatch = urlPath.match(/^\/api\/rooms\/([^/]+)$/);
      if (method === 'DELETE' && delMatch) {
        const id = decodeURIComponent(delMatch[1]);
        delete store.rooms[id];
        delete store.transcriptions[id];
        delete store.logs[id];
        saveDB(store);
        sendJSON(res, 200, { ok: true });
        return;
      }

      // GET /api/rooms/:id/transcriptions
      const transMatch = urlPath.match(/^\/api\/rooms\/([^/]+)\/transcriptions$/);
      if (method === 'GET' && transMatch) {
        const id = decodeURIComponent(transMatch[1]);
        const all = (store.transcriptions[id] || []).slice().reverse();
        const limit = parseInt(urlObj.searchParams.get('limit')) || 100;
        const offset = parseInt(urlObj.searchParams.get('offset')) || 0;
        sendJSON(res, 200, { rows: all.slice(offset, offset + limit), total: all.length });
        return;
      }

      // GET /api/rooms/:id/logs
      const logsMatch = urlPath.match(/^\/api\/rooms\/([^/]+)\/logs$/);
      if (method === 'GET' && logsMatch) {
        const id = decodeURIComponent(logsMatch[1]);
        const all = (store.logs[id] || []).slice().reverse();
        const limit = parseInt(urlObj.searchParams.get('limit')) || 100;
        const offset = parseInt(urlObj.searchParams.get('offset')) || 0;
        sendJSON(res, 200, { rows: all.slice(offset, offset + limit), total: all.length });
        return;
      }

      // GET /api/stats
      if (method === 'GET' && urlPath === '/api/stats') {
        const mem = process.memoryUsage();
        let totalListeners = 0;
        let totalHosts = 0;
        for (const r of Object.values(liveRooms)) {
          totalListeners += r.listeners.size;
          if (r.host) totalHosts++;
        }
        sendJSON(res, 200, {
          uptime: process.uptime(),
          memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
          activeRooms: Object.keys(liveRooms).length,
          totalHosts,
          totalListeners,
          totalConnections: totalHosts + totalListeners,
        });
        return;
      }

      sendJSON(res, 404, { error: 'APIが見つかりません' });
    } catch (e) {
      console.error('API Error:', e);
      sendJSON(res, 500, { error: 'サーバーエラー' });
    }
    return;
  }

  // --- ルーム情報API（認証不要 - host/listen用） ---
  if (method === 'GET' && urlPath.startsWith('/room-info/')) {
    const id = decodeURIComponent(urlPath.replace('/room-info/', ''));
    const room = store.rooms[id];
    if (!room) {
      sendJSON(res, 404, { error: 'ルームが見つかりません' });
    } else {
      sendJSON(res, 200, { id: room.id, name: room.name, is_accessible: isRoomAccessible(room) });
    }
    return;
  }

  // --- 静的ファイル配信 ---
  let filePath;
  if (urlPath === '/' || urlPath === '/host' || urlPath === '/host.html') {
    filePath = path.join(__dirname, 'host.html');
  } else if (urlPath === '/listen' || urlPath === '/listen.html') {
    filePath = path.join(__dirname, 'listen.html');
  } else if (urlPath === '/admin' || urlPath === '/admin.html') {
    filePath = path.join(__dirname, 'admin.html');
  } else {
    filePath = path.join(__dirname, urlPath);
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

// ルームごとのインメモリ管理（リアルタイム接続）
const liveRooms = {};

function getLiveRoom(roomId) {
  if (!liveRooms[roomId]) {
    liveRooms[roomId] = { host: null, listeners: new Map(), speakingListener: null };
  }
  return liveRooms[roomId];
}

function cleanupLiveRoom(roomId) {
  const room = liveRooms[roomId];
  if (room && !room.host && room.listeners.size === 0) {
    delete liveRooms[roomId];
  }
}

function broadcastListenerCount(roomId) {
  const room = liveRooms[roomId];
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
  const room = liveRooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(message);
  for (const [listener] of room.listeners) {
    if (listener.readyState === 1) {
      listener.send(msg);
    }
  }
}

function broadcastToAll(roomId, message) {
  const room = liveRooms[roomId];
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

function addLog(roomId, userName, role, action) {
  if (!store.logs[roomId]) store.logs[roomId] = [];
  store.logs[roomId].push({ user_name: userName, role, action, created_at: nowStr() });
  saveDB(store);
}

function addTranscription(roomId, speakerName, text) {
  if (!store.transcriptions[roomId]) store.transcriptions[roomId] = [];
  store.transcriptions[roomId].push({ speaker_name: speakerName, text, created_at: nowStr() });
  saveDB(store);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || 'default';
  const role = url.searchParams.get('role');
  const name = decodeURIComponent(url.searchParams.get('name') || '匿名');

  // 管理者WebSocket（リアルタイム状態監視用）
  if (role === 'admin') {
    ws.isAdmin = true;
    ws.on('close', () => {});
    return;
  }

  // ルーム有効期限チェック
  const dbRoom = store.rooms[roomId];
  if (dbRoom && !isRoomAccessible(dbRoom)) {
    ws.send(JSON.stringify({ type: 'error', message: 'このルームは現在利用できません（期限切れま���は無効）' }));
    ws.close();
    return;
  }

  const room = getLiveRoom(roomId);

  if (role === 'host') {
    if (room.host) {
      ws.send(JSON.stringify({ type: 'error', message: 'この��ームには既に���明者が接続しています' }));
      ws.close();
      return;
    }
    room.host = ws;
    ws.roomId = roomId;
    ws.role = 'host';

    addLog(roomId, '説明者', 'host', 'connect');
    console.log(`[Room ${roomId}] 説明者が接続しました`);

    const roomName = dbRoom ? dbRoom.name : roomId;
    ws.send(JSON.stringify({ type: 'room_info', name: roomName }));
    ws.send(JSON.stringify({ type: 'listener_count', count: room.listeners.size }));
    broadcastAdminUpdate();

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
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
            if (room.speakingListener) {
              const info = room.listeners.get(room.speakingListener);
              const speakerName = info ? info.name : '不明';
              room.speakingListener.send(JSON.stringify({ type: 'speak_revoked' }));
              room.speakingListener = null;
              broadcastToAll(roomId, { type: 'speaker_changed', name: null });
              console.log(`[Room ${roomId}] ${speakerName} の発言権を取り消���`);
            }

          } else if (msg.type === 'transcription') {
            broadcastToAll(roomId, {
              type: 'transcription',
              name: '説明者',
              text: msg.text,
              isFinal: msg.isFinal
            });
            if (msg.isFinal && msg.text.trim()) {
              addTranscription(roomId, '説明者', msg.text.trim());
            }
          }
        } catch (e) {}
      }
    });

    ws.on('close', () => {
      room.host = null;
      room.speakingListener = null;
      addLog(roomId, '説明者', 'host', 'disconnect');
      console.log(`[Room ${roomId}] 説明者が切断しました`);
      notifyListeners(roomId, { type: 'host_disconnected' });
      notifyListeners(roomId, { type: 'speaker_changed', name: null });
      broadcastListenerCount(roomId);
      cleanupLiveRoom(roomId);
      broadcastAdminUpdate();
    });

  } else {
    // 聴講者
    room.listeners.set(ws, { name });
    ws.roomId = roomId;
    ws.role = 'listener';
    ws.listenerName = name;

    addLog(roomId, name, 'listener', 'connect');
    console.log(`[Room ${roomId}] 聴講者「${name}」が接続しました（計 ${room.listeners.size} 人）`);

    const roomName = dbRoom ? dbRoom.name : roomId;
    ws.send(JSON.stringify({ type: 'room_info', name: roomName }));

    if (room.host) {
      ws.send(JSON.stringify({ type: 'host_connected' }));
    }

    broadcastListenerCount(roomId);
    broadcastAdminUpdate();

    if (room.host && room.host.readyState === 1) {
      room.host.send(JSON.stringify({ type: 'listener_joined', name }));
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (room.speakingListener === ws) {
          if (room.host && room.host.readyState === 1) {
            room.host.send(data, { binary: true });
          }
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
            if (room.host && room.host.readyState === 1) {
              room.host.send(JSON.stringify({ type: 'hand_raised', name }));
            }
            console.log(`[Room ${roomId}] ${name} が挙手しました`);

          } else if (msg.type === 'hand_lower') {
            if (room.host && room.host.readyState === 1) {
              room.host.send(JSON.stringify({ type: 'hand_lowered', name }));
            }
            console.log(`[Room ${roomId}] ${name} が挙手を取り消しました`);

          } else if (msg.type === 'transcription') {
            if (room.speakingListener === ws) {
              broadcastToAll(roomId, {
                type: 'transcription',
                name: name,
                text: msg.text,
                isFinal: msg.isFinal
              });
              if (msg.isFinal && msg.text.trim()) {
                addTranscription(roomId, name, msg.text.trim());
              }
            }
          }
        } catch (e) {}
      }
    });

    ws.on('close', () => {
      if (room.speakingListener === ws) {
        room.speakingListener = null;
        broadcastToAll(roomId, { type: 'speaker_changed', name: null });
      }

      room.listeners.delete(ws);
      addLog(roomId, name, 'listener', 'disconnect');
      console.log(`[Room ${roomId}] 聴講者「${name}」が切断しました（計 ${room.listeners.size} 人）`);

      if (room.host && room.host.readyState === 1) {
        room.host.send(JSON.stringify({ type: 'listener_left', name }));
      }

      broadcastListenerCount(roomId);
      cleanupLiveRoom(roomId);
      broadcastAdminUpdate();
    });
  }

  ws.on('error', (err) => {
    console.error(`[Room ${roomId}] WebSocketエラー:`, err.message);
  });
});

// 管理者WebSocketへの状態更新配信
function broadcastAdminUpdate() {
  const data = [];
  // DB登録済みルーム
  for (const r of Object.values(store.rooms)) {
    const live = liveRooms[r.id];
    data.push({
      ...r,
      live_listeners: live ? live.listeners.size : 0,
      live_host_connected: live ? !!live.host : false,
    });
  }
  // DB未登録だがライブ接続ありのルーム
  for (const [id, live] of Object.entries(liveRooms)) {
    if (!store.rooms[id]) {
      data.push({
        id,
        name: id,
        description: '',
        starts_at: null,
        expires_at: null,
        created_at: null,
        is_active: true,
        live_listeners: live.listeners.size,
        live_host_connected: !!live.host,
      });
    }
  }

  const msg = JSON.stringify({ type: 'admin_update', rooms: data });
  wss.clients.forEach(client => {
    if (client.isAdmin && client.readyState === 1) {
      client.send(msg);
    }
  });
}

// --- サーバー起動 ---
server.listen(PORT, () => {
  console.log(`=== KoeCast 音声配信サーバー ===`);
  console.log(`HTTP   : http://localhost:${PORT}`);
  console.log(`説明者 : http://localhost:${PORT}/host.html`);
  console.log(`聴講者 : http://localhost:${PORT}/listen.html`);
  console.log(`管理画面: http://localhost:${PORT}/admin.html`);
  console.log(`================================`);
});
