# 工場見学用リアルタイム音声配信WEBアプリ

説明者（1人）のマイク音声を、聴講者（10〜30人）のスマホブラウザにリアルタイム配信するシステムです。

## ファイル構成

```
工場見学用システム/
├── server.js      # WebSocketサーバー（音声中継＋静的ファイル配信）
├── host.html      # 説明者用ページ
├── listen.html    # 聴講者用ページ
├── package.json   # npm設定
└── README.md      # 本ファイル
```

## ルーム機能

複数の見学グループが同時に利用できるよう、URLパラメータでルームを分けられます。

- 説明者：`/host.html?room=A`
- 聴講者：`/listen.html?room=A`

`?room=` を省略した場合は `default` ルームに接続されます。

---

## ローカルテスト手順

### 1. Node.js のインストール

公式サイトからLTS版をダウンロード・インストールしてください。
https://nodejs.org/

インストール確認：
```bash
node -v
npm -v
```

### 2. 依存パッケージのインストール

プロジェクトディレクトリで以下を実行：
```bash
cd 工場見学用システム
npm install
```

### 3. サーバーをローカル起動

```bash
npm start
```

起動すると以下が表示されます：
```
=== 工場見学用音声配信サーバー ===
HTTP  : http://localhost:3000
説明者: http://localhost:3000/host.html
聴講者: http://localhost:3000/listen.html
（ルーム指定例: /listen.html?room=A）
================================
```

### 4. PCブラウザで動作確認

1. ブラウザで `http://localhost:3000/host.html` を開く
2. 「配信開始」をクリック → マイク許可を求められるので「許可」
3. 別タブで `http://localhost:3000/listen.html` を開く
4. 説明者の音声が聴講者側で再生されることを確認

> **注意**: `localhost` は特別扱いされるため、HTTPでもマイクが使えます。

### 5. ngrok を使ったスマホ実機テスト

LAN内のスマホから `http://192.168.x.x` でアクセスすると、HTTPSでないためブラウザがマイクを許可しません。ngrok を使えばHTTPS経由でアクセスできます。

#### ngrok のインストール

1. https://ngrok.com/ でアカウント作成（無料）
2. ngrok をダウンロード・インストール
3. 認証トークンを設定：
```bash
ngrok config add-authtoken YOUR_TOKEN
```

#### ngrok の起動

サーバーを起動した状態で、別のターミナルで：
```bash
ngrok http 3000
```

以下のようなURLが発行されます：
```
Forwarding  https://xxxx-xxx-xxx.ngrok-free.app -> http://localhost:3000
```

#### スマホでテスト

1. スマホのブラウザで以下のURLを開く：
   - 説明者：`https://xxxx.ngrok-free.app/host.html`
   - 聴講者：`https://xxxx.ngrok-free.app/listen.html`
2. 説明者側で「配信開始」→ 聴講者側で音声が再生されることを確認

> **Tips**: ngrok の URL が長い場合は、QRコード生成サイト（例：qr.io など）でQRコードにすると共有が楽です。

---

## 本番環境（VPS）セットアップ手順

### 1. VPS の準備

Ubuntu 22.04 以上を推奨。SSH でログインできる状態にしておく。

### 2. Node.js のインストール

```bash
# NodeSource からLTS版をインストール
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 確認
node -v
npm -v
```

### 3. アプリケーションの配置

```bash
# アプリ用ディレクトリ作成
sudo mkdir -p /opt/factory-tour-audio
cd /opt/factory-tour-audio

# ファイルをアップロード（scpの例）
# scp server.js host.html listen.html package.json user@your-server:/opt/factory-tour-audio/

# 依存パッケージインストール
npm install
```

### 4. SSL証明書の取得（Let's Encrypt）

HTTPS が必須のため、SSL証明書を取得します。

#### 方法A: Nginx をリバースプロキシとして使う（推奨）

```bash
# Nginx と Certbot をインストール
sudo apt-get install -y nginx certbot python3-certbot-nginx

# Nginx 設定
sudo tee /etc/nginx/sites-available/factory-tour <<'EOF'
server {
    listen 80;
    server_name your-domain.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
EOF

# 有効化
sudo ln -s /etc/nginx/sites-available/factory-tour /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# SSL証明書を取得（ドメイン名を実際のものに変更）
sudo certbot --nginx -d your-domain.example.com
```

Certbot が自動的にNginx設定をHTTPS対応に書き換えます。

#### 方法B: Node.js で直接HTTPS（小規模向け）

```bash
# 証明書取得
sudo certbot certonly --standalone -d your-domain.example.com

# server.js の先頭を以下に変更してHTTPS化：
# const https = require('https');
# const options = {
#   cert: fs.readFileSync('/etc/letsencrypt/live/your-domain.example.com/fullchain.pem'),
#   key: fs.readFileSync('/etc/letsencrypt/live/your-domain.example.com/privkey.pem'),
# };
# const server = https.createServer(options, (req, res) => { ... });
```

### 5. サーバー起動

#### 手動起動
```bash
cd /opt/factory-tour-audio
node server.js
```

#### systemd でサービス化（推奨）
```bash
sudo tee /etc/systemd/system/factory-tour.service <<'EOF'
[Unit]
Description=Factory Tour Audio Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/factory-tour-audio
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable factory-tour
sudo systemctl start factory-tour

# ステータス確認
sudo systemctl status factory-tour
```

### 6. ファイアウォール設定

```bash
# HTTP/HTTPS を許可
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

### 7. SSL証明書の自動更新

Certbot はデフォルトで自動更新の cron/timer が設定されますが、確認：
```bash
sudo certbot renew --dry-run
```

---

## 聴講者へのURL共有方法

### QRコードの活用

聴講者用URLをQRコードにして配布すると便利です。

- **URLの例**: `https://your-domain.example.com/listen.html?room=A`
- **QRコード生成**: 
  - Google Chart API: `https://chart.googleapis.com/chart?chs=300x300&cht=qr&chl=YOUR_URL`
  - 無料QRコード生成サイトを利用
  - スマホアプリで生成

### 運用のヒント

- 見学グループごとにルーム名を変える（例: `?room=group1`, `?room=group2`）
- QRコードを印刷して見学者に配布、またはタブレットで表示
- 説明者は有線イヤホンマイクの使用を推奨（Bluetooth は遅延が大きい）
- 聴講者はイヤホン使用を推奨（スピーカーだとハウリングの可能性）

---

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| マイクが使えない | HTTPSでアクセスしているか確認。ブラウザのマイク許可設定を確認 |
| 音が出ない | 聴講者側で「タップして音声を有効にする」ボタンを押す（iOS/Android制限） |
| 音が途切れる | ネットワーク品質を確認。Wi-Fi推奨 |
| 接続できない | サーバーが起動しているか確認。ファイアウォール設定を確認 |
| 遅延が大きい | 有線イヤホンマイクを使用。ネットワーク品質を確認 |
