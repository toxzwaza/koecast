# KoeCast 工場見学用音声配信システム

## 概要
説明者の音声をリアルタイムで聴講者のスマホに配信するWebアプリ。

## 本番環境
- URL: https://koecast.akioka-sub.com
- VPS: 210.131.211.154（Xserver VPS）
- サービス: systemd `koecast.service`

## KoeCast 管理API

管理APIを使って、ルームの作成・確認・操作が可能。
全APIリクエストに認証ヘッダーが必要。

### 認証
```
Authorization: Bearer Murakami0819
```

### API一覧

#### ルーム一覧取得
```bash
curl -s -H "Authorization: Bearer Murakami0819" https://koecast.akioka-sub.com/api/rooms | python -m json.tool
```

#### ルーム作成
```bash
curl -s -X POST -H "Authorization: Bearer Murakami0819" -H "Content-Type: application/json" \
  -d '{"id":"room-id","name":"ルーム名","description":"説明","starts_at":"2026-04-10T09:00","expires_at":"2026-04-10T17:00"}' \
  https://koecast.akioka-sub.com/api/rooms
```
- `id`: ルームID（英数字・ハイフン）
- `name`: 表示名
- `starts_at` / `expires_at`: 任意。ISO8601形式。省略で制限なし

#### ルーム更新
```bash
curl -s -X PUT -H "Authorization: Bearer Murakami0819" -H "Content-Type: application/json" \
  -d '{"name":"新しい名前","is_active":true}' \
  https://koecast.akioka-sub.com/api/rooms/{room-id}
```

#### ルーム削除
```bash
curl -s -X DELETE -H "Authorization: Bearer Murakami0819" \
  https://koecast.akioka-sub.com/api/rooms/{room-id}
```

#### 文字おこし履歴取得
```bash
curl -s -H "Authorization: Bearer Murakami0819" \
  "https://koecast.akioka-sub.com/api/rooms/{room-id}/transcriptions?limit=50&offset=0"
```

#### 接続ログ取得
```bash
curl -s -H "Authorization: Bearer Murakami0819" \
  "https://koecast.akioka-sub.com/api/rooms/{room-id}/logs?limit=50&offset=0"
```

#### システム状態
```bash
curl -s -H "Authorization: Bearer Murakami0819" https://koecast.akioka-sub.com/api/stats
```
レスポンス: `uptime`, `memory`, `activeRooms`, `totalHosts`, `totalListeners`

### URL構造
- 説明者: `https://koecast.akioka-sub.com/host.html?room={room-id}`
- 聴講者: `https://koecast.akioka-sub.com/listen.html?room={room-id}`
- 管理画面: `https://koecast.akioka-sub.com/admin.html`

### デプロイ手順
```bash
cd "c:/業務データ/CC_会社/システム開発部門/株式会社アキオカ/工場見学用システム"
git add -A && git commit -m "変更内容" && git push origin main
ssh -i ~/.ssh/id_ed25519_vps root@210.131.211.154 "cd /opt/webapps/koecast && git pull origin main && systemctl restart koecast"
```
