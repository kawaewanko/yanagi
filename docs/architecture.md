# 🏗️ アーキテクチャ

## 🚀 現在起動可能な構成

```text
apps/community-bot（Welcome・監査/VCログ） -- Community key --\
apps/game-bot（ゲーム・ポイント・抽選） --- Game key ---------+--> Core API ---> Ollama（任意）
apps/ai-bot（質問・翻訳・要約） --------- AI key -----------+
apps/background-worker（保持期間整理） ----- Worker key -------+       |
apps/voice-bot（読み上げ3台・音楽再生3台） --- Voice key --------+       +--> PostgreSQL
apps/tts-worker（VOICEVOX・FIFO処理） ------- TTS key ----------+
```

Core API が業務ルールとデータアクセスを担います。Bot から PostgreSQL へ直接接続しないでください。Community/Game/AI/Voice/Worker/TTSの認証キーは分離され、サービス範囲ごとのAPI権限を確認します。キー比較にはタイミング差を抑える比較関数を使用し、リクエストログでは Authorization ヘッダーを伏せます。

## 🔐 データ整合性と競合制御

`database/init.sql` とCore API起動時のMigration Runnerが、番号付きSQLを順に適用します。Core API起動時はPostgreSQL advisory lockで排他し、マイグレーション台帳へ適用版とSHA-256を記録します。既存DBにも未適用SQLを番号順に適用し、台帳に記録済みのファイル内容が変わっていれば起動を拒否します。外部キー、CHECK/UNIQUE制約、検索用インデックスを定義しています。通知機能の事前準備として`010_notifications_and_feeds.sql`にRSS、誕生日、共通予約通知のキューを追加しました。RSS取得はCommunity Botの定期ポーリングへ接続し、Core APIのrss_feeds/rss_itemsで重複排除と通知済み状態を永続化します。予約通知・誕生日通知もCommunity Bot起動時に復元します。AIユーティリティはAI BotからCore APIのローカルAI基盤へ接続します。

日次上限とおみくじの日付は UTC 基準です。メッセージ付与は1回1ポイント、前回付与から30秒以上、日次100ポイントまでです。VC付与は1回1ポイント、前回付与から5分以上、日次60ポイントまでです。日付変更直後もクールダウンを維持し、メンバー行ロック中に上限を判定します。

## 🔌 実装済み API

- `GET /health` — 認証不要。DB接続を含むヘルスチェック。
- `POST /v1/points/message` — Game サービス。本文 `{ "guildId", "userId", "messageId" }`。`Idempotency-Key` は `messageId` と同じ値にします。
- `GET /v1/points/balance?guildId=...&userId=...` — Game サービス。ポイント残高を取得します。
- `POST /v1/points/voice-tick` — Game サービス。本文 `{ "guildId", "userId", "tickId" }`。`Idempotency-Key` は `tickId` と同じ値にします。
- `POST /v1/fortune/draw` — Game サービス。本文 `{ "guildId", "userId" }`。`Idempotency-Key` が必要です。
- `POST /v1/ai/chat` — AI サービス。本文 `{ "guildId", "userId", "message" }`、`Idempotency-Key` 必須。AI_ENABLEDが有効なときのみ、直近6往復の会話履歴と共に内部Ollamaへ問い合わせます。入力1000文字、タイムアウト30秒、出力1900文字に制限します。
- `GET /v1/rewards?guildId=...` — Game サービス。
- `POST /v1/rewards/:rewardId/redeem` — Game サービス。本文 `{ "guildId", "userId" }`。`Idempotency-Key` が必要です。
- `POST /v1/raffles`、`GET /v1/raffles?guildId=...` — Game サービス。抽選の作成（冪等キー必須）と一覧。
- `POST /v1/raffles/:raffleId/start`、`/close` — Game サービス。作成者のみが受付を開始/終了できます。開始時の受付時間（分）は任意です。
- `POST /v1/raffles/:raffleId/entries` — Game サービス。1人1口の参加、参加費の残高確認・減算・台帳記録を同一トランザクションで実行します。`Idempotency-Key` が必要です。
- `POST /v1/raffles/:raffleId/draw`、`/redraw` — Game サービス。受付終了後に当選者を選び、履歴を保存します。再抽選は過去当選者を除外します。
- `GET /v1/raffles/:raffleId/history?guildId=...` — Game サービス。抽選、参加者、当選結果を取得します。
- `POST /v1/maintenance/retention` — Worker サービス専用。監査/VCログ、365日超のポイント取引、期限切れまたは7日超の管理者セッション、完了/失敗から30日超のTTSメタデータと音声、最終利用から30日を超えたAI会話とAI冪等性記録を整理します。
- `POST /v1/tts/jobs` — Voiceサービス。最大500文字のジョブを冪等に登録します。
- `GET /v1/tts/jobs/:jobId`、`GET /v1/tts/jobs/:jobId/audio` — Voiceサービス。依頼者に一致するジョブ状態と成功済み音声を取得します。
- `POST /v1/tts/jobs/claim`、`POST /v1/tts/jobs/:jobId/complete`、`/fail` — TTSサービス。FIFO/`SKIP LOCKED`でジョブを確保し、音声完成/失敗と最大3回の試行を管理します。実行中Workerが停止した場合は2分後に再取得可能です。
- `POST /v1/community/voice-events` — Community サービス。VCの参加/退出/移動を記録します。
- `POST /v1/community/audit-events` — Community サービス。監査イベントを記録します。
- `POST /v1/community/temporary-voice-channels`、`GET /v1/community/temporary-voice-channels?guildId=...` — Community サービス。一時VCの登録と一覧を扱います。
- `POST /v1/community/temporary-voice-channels/:channelId/empty`、`/active`、`DELETE /v1/community/temporary-voice-channels/:channelId?guildId=...` — 空室期限・再入室・チャンネル削除に伴う状態更新を行います。
- `GET /v1/community/guild-settings?guildId=...` — Community サービス専用。サーバーごとのWelcome送信先、待機VC、一時VC作成先カテゴリを取得します。
- `GET /v1/community/vc-recruitments?guildId=...`、`POST /v1/community/vc-recruitments` — Communityサービス。期限内のVC募集一覧取得と募集作成を行います。募集作成は`Idempotency-Key`必須です。
- `POST /v1/community/vc-recruitments/:recruitmentId/participants`、`POST /v1/community/vc-recruitments/:recruitmentId/close` — Communityサービス。参加・参加取消・締切を永続化します。
- `PATCH /v1/raffles/:raffleId/prize` — Gameサービス。抽選作成者が賞品情報を更新します。`Idempotency-Key`必須です。

ヘルスチェック以外はすべて `Authorization: Bearer <サービスキー>` が必要です。Fastify のスキーマで入力形式を検証します。APIエラー応答にDB接続情報は含めません。

## 🧩 今後のサービス境界

- RSS取得はCommunity Botから直接実行せず、将来の通知Workerが`rss_feeds.next_poll_at`を`FOR UPDATE SKIP LOCKED`で取得し、Core API経由で記事保存・重複排除を行う。
- 誕生日判定と予約通知送信は同じ通知Workerに集約し、Discord送信失敗は`scheduled_notifications.attempts`と`last_error`へ記録する。
- 外部RSS本文は信頼しない。URL allow/deny、HTTPタイムアウト、リダイレクト上限、レスポンスサイズ上限、HTMLサニタイズをWorker境界で適用する。
- Guild固有の有効化・設定は`guild_feature_settings`、ユーザーのタイムゾーン/通知設定は`user_preferences`に集約し、機能ごとに新しい設定テーブルを増やさない。
- RSS、誕生日、予約告知、障害通知の送信は`notification_outbox`へ集約する。生成側とDiscord送信Workerを分離し、`dedupe_key`、`processing`、再試行回数で二重送信を防ぐ。
- YouTube/Twitch/Webhook/RSSは`external_subscriptions`の共通ライフサイクルを使い、秘密情報は`secret_ref`だけをDBに保存する。
- 警告・タイムアウト・BAN等は`moderation_cases`へ統一し、`metric_buckets`で低カーディナリティの集計値を保存する。詳細イベントは既存の監査ログへ記録する。

## 🗃️ 保持期間と運用

Background Workerが起動時および24時間ごとに、監査ログ90日、VCログ180日、ポイント取引365日、期限切れまたは7日超の管理者セッション、完了/失敗後30日超のTTSジョブと音声、最終利用から30日超のAI会話と冪等性記録を整理します。ポイント残高は別カラムで保持し、景品交換・抽選履歴は削除しません。一時VCは`delete_after`から10分以上経過したレコードを整理します。

本番の秘密情報はホスト環境または Secret Manager から渡してください。`.env.example` の値は開発用です。PostgreSQL の永続化とバックアップ/復元手順はルート README に記載しています。
