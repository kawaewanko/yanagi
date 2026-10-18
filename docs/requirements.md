# 📋 要件と実装状況

この文書は、依頼で提示された夜凪鯖 Bot システムの要件と、現ワークスペースで実装済みの範囲を区別して記録します。調査時点では小規模な PostgreSQL スキーマと package manifest のみが存在し、記載のないアプリや機能があるとは仮定していません。

## 📝 合意済み要件

- Node.js 22、TypeScript、discord.js、Fastify、PostgreSQL、npm workspaces、Docker Compose、自動テスト、SQL マイグレーションを使用する。
- Bot ごとにサービス認証を分け、Bot から PostgreSQL へ直接接続せず Core API を経由する。
- Community: Welcome、監査/VCログ、一時VCの競合対策・遅延削除・再起動後の整理。
- Game: メッセージ/VCポイントの日次上限、おみくじの日次1回制限、景品交換、抽選作成/受付/参加費/当選/再抽選/履歴を実装する。
- Voice/TTS: FIFOジョブ、最大500文字、30秒タイムアウト、最大3回の再試行、冪等性を実装する。
- 残高と履歴の整合性は PostgreSQL のトランザクションと制約で保護する。

## ✅ 今回実装した範囲

- Guild/Member、ポイント取引、冪等性キー、おみくじ、景品/交換、抽選、一時VC、TTSジョブ、監査/VCログ、管理者セッションを含む PostgreSQL 初期マイグレーション。
- Community/Game/AI/Voice 別の API キーを使う Core API 認証、DBヘルスチェック、メッセージ/VCポイント付与、おみくじ、景品一覧、トランザクション付き景品交換。
- PostgreSQL 永続化と Core API を起動する Docker Compose、認証/ヘルスチェック/おみくじ確率境界のテスト。
- Core API Client パッケージと Community Bot の参加Welcome、メンバー参加/退出/更新、BAN/解除、チャンネル作成/更新/削除、ロール作成/更新/削除の監査ログ、VC参加/退出/移動ログ。一時VC生成・メンバー移動・空室60秒後削除・再入室時の削除取消・再起動時の孤児/空VC整理。Community 専用キーで保護されるAPI経由で記録。監査イベントから操作者を特定できない場合は actorId を null として記録する。
- Game Botの `/points`、`/fortune`、`/rewards`、`/redeem` コマンド、メッセージ投稿ポイント、VC滞在ポイントの定期付与。Game専用キーでCore APIを呼び出す。
- 抽選の作成、一覧、受付開始・終了、参加、抽選、再抽選、履歴のCore APIと`/raffle`コマンド。1ユーザー1口、参加費の残高確認・減算・参加記録は同一トランザクションで処理し、Discordの重複イベントは冪等性キーで防ぐ。運営操作はサーバー管理権限と抽選作成者で制限し、再抽選は既当選者を除外する。
- Worker専用認証を用いた保持期間整理APIとBackground Worker。監査ログ90日、VCログ180日、ポイント取引365日、管理者セッション7日を期限超過時に削除する。Workerは起動時に実行し、成功後は24時間周期、失敗時は1分後に再試行する。
- Voice Botの`/tts`コマンドと、VOICEVOX互換ローカルエンジンを使うTTS Worker。最大500文字、30秒タイムアウト、最大3回の試行、FIFOジョブ、冪等性、DB上の状態、共有音声ボリュームを実装する。TTSサービス専用APIキーでBot/Workerを分離する。
- 成功/失敗したTTSジョブと音声ファイルの30日保持期限処理をBackground Workerに追加する。
- Core API起動時に番号付きDBマイグレーションを追跡・適用し、advisory lockとチェックサムで並列起動や適用済みSQLの変更を検出する。
- AI Botの`/ai message:<質問>`からOllamaのローカルモデル（既定`qwen2.5:1.5b`）をCore API経由で利用する。サーバー・ユーザー単位の履歴を保存し、直近6往復を文脈に含め、入力1000文字・生成30秒・出力1900文字に制限する。AI専用サービス認証、冪等キー、同一ユーザー会話の直列化、AI無効時もGame Botへ影響させない独立性を実装する。
- Background WorkerによるAI会話と対応する冪等性記録の30日保持整理。
- 抽選の追加参加資格ルール（最低保有ポイント・必須Discordロール）と抽選賞品更新API。ロール条件はGame Botが参加者の現在のロールIDをCore APIへ渡して判定する。
- PostgreSQLバックアップ/復元の自動化。`db-backup` Composeプロファイルによる定期バックアップ、`scripts/backup-db.sh`、明示確認付きの`scripts/restore-db.sh`を提供する。暗号化・オフサイト保管・復元演習は運用環境側の対応が必要。
- 一時VCの`delete_after`が10分以上経過したレコードを保持Workerで整理する処理。

## ⚠️ 部分実装・運用上の注意

- VC募集情報はPostgreSQLへ保存され、作成・参加・参加取消・締切を永続化する。Bot起動時に期限内の募集をDBから読み込み、既存Discordメッセージへボタンを再紐付けする。削除済みメッセージ・権限不足などで再取得できない募集は復旧できない。
- バックアップはローカル`./backups`への保存が標準であり、暗号化・オフサイト転送・復旧テストは含まない。

## 🧱 通知・外部連携の設計と運用

- マイグレーション`010_notifications_and_feeds.sql`で、RSS購読・記事重複排除・誕生日・共通予約通知のテーブルとインデックスを追加した。
- RSSはGuildごとのURL重複を防ぎ、ETag/Last-Modifiedと失敗回数を保持して、条件付き取得と段階的なエラー処理を可能にする。
- 誕生日は月日だけを保持し、通知タイミングはユーザー/Guild設定のIANAタイムゾーンで決定する。生年や不要な個人情報は保存しない。
- `scheduled_notifications`はone-time、interval、cron相当を`recurrence` JSONBで表現し、Bot起動時の復元と配信後の次回時刻更新に対応する。
- RSS URLの取得元検証、リダイレクト制限、最大レスポンスサイズ、タイムアウト、Discord権限、通知失敗時の再試行を実装時の安全要件として適用する。

## 🧩 横断機能の拡張設計

- `011_extensible_features.sql`で、Guild機能設定、ユーザー設定、通知Outbox、外部購読、モデレーションケース、メトリクス集計の共通モデルを追加した。
- 新しい機能はまず`guild_feature_settings`で有効化を確認し、Guild固有設定とユーザー設定を分離する。
- Discord送信を伴う処理は`notification_outbox`へ書き込み、配信側でロック・再試行・冪等送信を行う。
- 外部サービス連携では秘密情報をPostgreSQLに保存せず、`secret_ref`経由でSecret Managerから取得する。
- モデレーション機能は`moderation_cases`と既存監査ログを併用し、対象者・実行者・理由・期限・取消を追跡可能にする。
- メトリクスは`metric_buckets`へ時間単位で集約し、個人メッセージ本文や外部URLをメトリクスのディメンションに含めない。

通知機能では予約通知・誕生日通知・RSS/Atom購読を実装済みです。AIユーティリティでは質問・翻訳・要約コマンドを実装済みです。

### YouTube / Twitch / Webhook通知

- `020_external_notifications.sql`で外部通知イベント台帳を追加し、購読単位の外部ID一意制約と`notification_outbox`の重複キーで再送・再ポーリングを冪等化します。
- YouTubeは公式Atomフィード、TwitchはHelix Streams APIをBackground Workerがポーリングし、新着動画・配信開始だけをOutboxへ登録します。
- Webhookは`POST /v1/notifications/webhooks/:id`で受信し、購読の`secret_ref`に対応するSecret Manager/環境変数の値でHMAC-SHA256署名を検証します。Bearer認証は不要ですが、署名不正は401で拒否します。
- ポーリング購読は`FOR UPDATE SKIP LOCKED`でClaimし、成功時は設定間隔、失敗時は最大24時間まで指数バックオフして再試行します。Discord配信自体も既存Outboxの最大10回再試行とロック期限回復を利用します。
