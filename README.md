# 夜凪鯖 Bot システム

PostgreSQLとCore APIを中心に、Community Bot、Game Bot、AI Bot、Voice Bot、TTS Worker、Background Workerを構成するnpm workspacesプロジェクトです。RSS/Atom、YouTube、Twitch、Webhook通知、ローカルAI、音声合成、ポイント経済、VC管理を提供します。

## Botの視聴中表示

各Discord Botは15秒ごとにWebSocket遅延を更新し、次の内容を`視聴中`として表示します。

| Bot           | 表示内容の形式                                |
| ------------- | --------------------------------------------- |
| Community Bot | `/help \| <遅延>ms \| RSS・Webhook・管理`     |
| Game Bot      | `/help \| <遅延>ms \| ゲーム・ポイント・抽選` |
| AI Bot        | `/help \| <遅延>ms \| AI・翻訳・要約`         |
| TTS Bot       | `/help \| <遅延>ms \| 読み上げ`               |
| Music Bot     | `/help \| <遅延>ms \| 音楽再生`               |

通常の処理エラーでは`不具合発生`、Discordセッションの重大障害では`インシデント発生`を表示し、復旧まで状態を保持します。

## 必要環境

- Node.js 22以上
- npm 10以上
- Docker Compose v2
- Discord Botトークンと対象Guildへの招待権限

PostgreSQLをDocker外で起動する場合はPostgreSQL 16が必要です。

## 初期セットアップ

```sh
cp .env.example .env
openssl rand -hex 32
npm ci
npm run typecheck
npm test
npm run build
```

生成したランダム値を、`.env`の`CORE_API_KEY_COMMUNITY`、`CORE_API_KEY_GAME`、`CORE_API_KEY_AI`、`CORE_API_KEY_VOICE`、`CORE_API_KEY_WORKER`、`CORE_API_KEY_TTS`へそれぞれ設定してください。値はすべて異なるものにし、`.env`をGitへ追加しないでください。

`TWITCH_CLIENT_ID`と`TWITCH_CLIENT_SECRET`はTwitch通知を使う場合だけ設定します。Webhook通知では`WEBHOOK_SECRET_DEFAULT`に秘密値を設定し、購読作成時の`secretRef`に`WEBHOOK_SECRET_DEFAULT`を指定します。秘密値そのものをDBの`config`や`secretRef`へ保存しないでください。

## Docker Composeで起動

DBとCore APIを起動します。

```sh
docker compose up --build -d
curl --fail http://localhost:3000/health
```

BotとWorkerは用途に応じてprofileを有効化します。

全Botを同時に起動する場合は、TokenとCore APIキーを`.env`へ設定したうえで次を実行します。スクリプトはCommunity、Game、AI、TTS 1〜3、Music 1〜3、TTS Worker、Background Workerをまとめて起動し、Core APIのヘルスチェック完了後に状態を表示します。`AI_ENABLED=true`の場合はOllamaも起動します。

```sh
./scripts/start-all-bots.sh
```

停止する場合は次を実行します。

```sh
./scripts/stop-all-bots.sh
```

本番監視では、Core APIと各BotのHeartbeatを確認するHealth Checkを実行します。

```sh
./scripts/health-check.sh
```

本番デプロイ、systemd timer、Heartbeat監視、負荷分散、レートリミット、コマンドルーティングの詳細は[本番運用・監視ガイド](./docs/production-operations.md)を参照してください。

個別profileで起動する場合は次のコマンドを使えます。

```sh
docker compose --profile bots up --build -d community-bot
docker compose --profile game up --build -d game-bot
docker compose --profile ai-bot up --build -d ai-bot
docker compose --profile voice --profile tts up --build -d voice-bot tts-worker
docker compose --profile voice-tts --profile voice-music --profile tts up --build -d tts-bot-1 tts-bot-2 tts-bot-3 music-bot-1 music-bot-2 music-bot-3 voicevox
docker compose --profile maintenance up --build -d background-worker
docker compose --profile backup up -d db-backup
```

AIを有効にする場合は`.env`で`AI_ENABLED=true`を指定し、次を実行します。

```sh
docker compose --profile ai up -d ollama ollama-model
docker compose --profile ai --profile ai-bot up --build -d ai-bot
```

初回のモデル取得には時間とディスク容量が必要です。AI処理はOllamaコンテナ内で実行されます。

## ローカル開発

Compose上のDBだけを起動し、Node.jsプロセスを直接実行する場合は、各コマンドへ`.env`を明示的に読み込ませます。

```sh
docker compose up -d db
node --env-file=.env --import tsx --watch apps/core-api/src/index.ts
node --env-file=.env --import tsx --watch apps/community-bot/src/index.ts
node --env-file=.env --import tsx --watch apps/game-bot/src/index.ts
node --env-file=.env --import tsx --watch apps/ai-bot/src/index.ts
node --env-file=.env --import tsx --watch apps/voice-bot/src/index.ts
node --env-file=.env --import tsx --watch apps/tts-worker/src/index.ts
node --env-file=.env --import tsx --watch apps/background-worker/src/index.ts
```

`node --env-file`はNode.js 20.6以降で利用できます。`npm run dev:*`を使う場合は、シェルへ必要な環境変数を設定してください。VOICEVOXを別途起動する場合は`VOICEVOX_URL`を接続先へ変更します。

読み上げBotと音楽再生Botを分離して3台ずつ稼働させる場合は、`VOICE_TTS_BOT_TOKEN_1`〜`3`と`VOICE_MUSIC_BOT_TOKEN_1`〜`3`へ、それぞれ異なるDiscord Botトークンを設定してください。各Botは`VOICE_BOT_MODE=tts`または`VOICE_BOT_MODE=music`で起動し、Discord Gatewayの同一トークンを共有しないようにします。詳細は[Voice Botコマンドリファレンス](./docs/commands-voice.md)を参照してください。

## Discord設定

Community BotにはServer Members、Guild Voice States、Guild Moderation、Guild Members intentsが必要です。Game BotにはGuilds、Guild Messages、Guild Voice States intentsが必要です。AI BotにはGuilds、Guild Messages、Message Content intentsが必要です。TTS・Music BotにはGuilds、Guild Voice States intentsと対象VCの閲覧・接続・発言権限が必要です。すべてのBotへ`bot`と`applications.commands` OAuth2スコープを付与してください。詳細なPermissions、Privileged Gateway Intents、チャンネル単位の設定は[Discord Developer Portal設定ガイド](./docs/discord-developer-portal.md)を参照してください。

利用可能なコマンドは[Botコマンドリファレンス](./docs/commands.md)を参照してください。通知API、環境変数、マイグレーションの詳細は[API利用ガイド](./docs/api.md)と[要件・実装状況](./docs/requirements.md)を参照してください。

各Discord Botのアイコン、ヘッダー、個別説明文は[Discord Botブランドアセット](./assets/discord-bots/descriptions.md)を参照してください。

## マイグレーション

新規DBの初期化時はPostgreSQLの`database/init.sql`を空の初期化フックとして使用し、Core API起動時に`schema_migrations`を確認して、advisory lock下で番号付きSQLを順番に適用します。スキーマ作成はCore APIのMigration Runnerに一本化しています。適用済みファイルのチェックサムが変わると起動を停止するため、適用済みSQLは変更せず、新しい番号のファイルを追加してください。

外部通知マイグレーションは`020_external_notifications.sql`です。番号の重複を避けるため、追加時は既存の最大番号を確認してください。

## 検証と整形

```sh
npm run format
npm run format:check
npm run typecheck
npm test
npm run build
```

## バックアップと復元

バックアップはアクセス制御された場所へ保存し、本番環境では暗号化とオフサイト保管を追加してください。

```sh
./scripts/backup-db.sh
CONFIRM_RESTORE=YES ./scripts/restore-db.sh backups/yanagi-<timestamp>.dump
```

復元は既存データを上書きするため、書き込み処理を停止し、対象ファイルと接続先を確認してから実行してください。

## ポートと永続ボリューム

Core APIは`127.0.0.1:3000`、PostgreSQLは`127.0.0.1:5432`、VOICEVOXは`127.0.0.1:50021`に公開されます。PostgreSQL、TTS音声、OllamaモデルはDocker volumeへ保存されます。バックアップファイルは`./backups`へ作成され、Git管理対象外です。
