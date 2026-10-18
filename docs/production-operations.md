# 本番運用・監視・負荷制御

## 本番デプロイの前提

現在のセッションで認証済みの実行環境はManus Sandboxのみで、本番サーバーのホスト名、SSH鍵、Docker実行環境は提供されていません。そのため本番サーバーへの実際のSSH接続・コンテナ起動は実施していません。本書とCompose・スクリプトは、Docker Compose v2が利用できるLinux本番サーバーへそのまま持ち込める構成です。

本番サーバーでは、まず次を実行します。

```sh
git clone https://github.com/kawaewanko/yanagi.git /opt/yanagi
cd /opt/yanagi
cp .env.example .env
chmod 600 .env
```

`.env`には、9個のDiscord Bot Token、6個のCore APIサービスキー、PostgreSQLパスワード、必要な通知・AI・VOICEVOX設定を入力します。TTS 1〜3とMusic 1〜3には異なるDiscord Tokenを設定してください。

初回起動は次のコマンドです。

```sh
./scripts/start-all-bots.sh
```

このスクリプトは、Core APIのヘルスチェックが通るまで待機します。`AI_ENABLED=true`の場合はOllamaと指定モデルをBot起動前に準備します。TTS WorkerはVOICEVOXのHealth Checkが通ってから起動し、各BotはCore APIがhealthyになってから起動します。

Docker Compose側では、PostgreSQL、Core API、VOICEVOX、OllamaにHealth Checkを設定し、Bot・Workerには`restart: unless-stopped`を設定しています。Discord Gateway接続そのものはコンテナのTCP Health Checkだけでは判定できないため、各BotのHeartbeatをCore APIの`/v1/dashboard/status`で監視します。

## Health Check

手動またはcronから次を実行します。

```sh
./scripts/health-check.sh
```

Health Checkは次を確認します。

1. Core APIの`/health`が200を返すこと
2. Community、Game、AI、TTS 1〜3、Music 1〜3、Background Worker、TTS WorkerのHeartbeatが存在すること
3. 各Heartbeatが既定の90秒以内であること

1分ごとのcron例:

```cron
* * * * * cd /opt/yanagi && ./scripts/health-check.sh >> /var/log/yanagi-health.log 2>&1
```

systemdを使う場合は、`deploy/yanagi-bots.service`、`deploy/yanagi-healthcheck.service`、`deploy/yanagi-healthcheck.timer`を`/etc/systemd/system/`へコピーし、`systemctl enable --now yanagi-bots.service yanagi-healthcheck.timer`を実行します。Health Checkが失敗した場合はsystemd journalへ記録されます。

TTS 1〜3とMusic 1〜3は、Composeの`BOT_SERVICE_NAME`で`tts-1`、`tts-2`、`tts-3`、`music-1`、`music-2`、`music-3`としてHeartbeatを送信します。これにより、1号機だけが停止した場合も全体稼働中と誤判定しません。

## 負荷分散とレートリミット設計

Discord BotはDiscord Gatewayの接続をBot Token単位で持ちます。TTS 1〜3とMusic 1〜3を別Tokenで動かすことで、Gateway接続とVoice接続を機能・インスタンス単位に分散します。同じTokenを複数コンテナで起動する構成にはしません。

各Voice Botは、1つのプロセス内でGuildごとの音楽キューとVoice Connectionを保持します。そのため、同じBot Tokenを水平スケールしてはいけません。負荷を増やす場合は、別Discordアプリ・別Tokenへ分割し、Guild単位で担当Botを割り当てます。現在はTTS 3台とMusic 3台をその分割単位として構成しています。

Discord REST APIのコマンド登録は、Game Botが逐次登録し、AI BotとVoice Botも逐次登録へ統一しました。これにより、ログイン直後にGuildごとの`applicationGuildCommands`更新を同時発行して429を誘発するリスクを抑えます。Discord.jsのREST層によるルート別Rate Limit処理も有効です。

Core APIはPostgreSQL Poolを最大10接続に制限しています。BotからCore APIへのHTTPタイムアウトは用途別に設定され、AI処理・TTS処理・外部通知ポーリングは無期限待機しません。Core APIへさらに負荷制御を追加する場合は、複数レプリカ間で共有できるRedis等を使った分散Rate Limitを採用し、プロセス内Mapだけで制限しないでください。

通知ポーリングはBackground Workerを1インスタンスに固定し、Core APIのDB Claimで`FOR UPDATE SKIP LOCKED`を使って購読を分担します。Workerを複数起動しても同じ購読を同時処理しない設計です。TTS JobもDB Claimと試行回数制限で重複処理を抑制します。

本番での推奨制限は次のとおりです。

- Core API: 1レプリカから開始し、DB Pool上限10を超えない範囲で増やす
- Background Worker: 1〜2レプリカ。購読ClaimはDBで排他する
- TTS Worker: 音声合成エンジンのCPU・メモリに合わせて1〜3レプリカ
- Community・Game・AI Bot: Discord Tokenごとに1レプリカ
- TTS・Music Bot: 各Tokenごとに1レプリカ
- Discordの429受信時は、Discord.jsのRESTキューに任せ、独自の無制限リトライを追加しない

## スラッシュコマンドのルーティング状況

### Community Bot

`apps/community-bot/src/index.ts`で`interaction.commandName`を直接ルーティングしています。Welcome、通知、RSS、予約通知、監査、モデレーション、Ticket、提案、VC募集、Health管理を同一Botが担当します。`slowmode`、`lock`、`unlock`、`purge`は共通の管理コマンドブロックで処理され、`purge`も登録済み・実装済みです。

### Game Bot

`gameCommandDefinitions()`が登録定義を生成し、`handleGameCommand()`の`switch`が処理します。ゲーム、ランキング、ポイント経済、実績、仕事、犯罪、占い、報酬、ショップ、抽選を担当します。AIコマンドはAI Botへ分離済みです。

### AI Bot

`aiCommandDefinitions()`が登録定義を生成し、`handleAiCommand()`の`switch`が処理します。`help`、`ping`、`ai`、`ask`、`translate`、`summarize`、`summarize-channel`、`ai-feedback`、`ai-feedback-stats`を担当します。

### TTS・Music Bot

`voiceCommandDefinitions(mode)`が`all`、`tts`、`music`のモードに応じて登録コマンドを絞り込みます。TTS Bot 1〜3は読み上げ系コマンド、Music Bot 1〜3は音楽系コマンドだけを登録します。共通の`join`、`leave`、`stop`、`ping`、`help`はモードに応じて利用できます。モード分離により、読み上げBotへ音楽操作コマンドが表示される問題を防いでいます。

コマンド登録はGuild単位で逐次実行されます。Guild数が多い本番環境では、更新が完了するまで数分かかる可能性があります。Bot起動時に一度だけ登録し、通常のメッセージ処理と同じループで再登録しない構成です。

## 運用時の確認コマンド

```sh
docker compose ps
curl --fail http://127.0.0.1:3000/health
./scripts/health-check.sh
git status --short --branch
```

停止は`./scripts/stop-all-bots.sh`を使用します。Discord Tokenの更新、Core APIキーの更新、Bot権限の変更後は、対象サービスだけでなくHeartbeatとスラッシュコマンド登録のログも確認してください。
