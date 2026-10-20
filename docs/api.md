# Yanagi API・新機能利用ガイド

このドキュメントは、今回追加したVC募集永続化、抽選参加条件、抽選賞品更新、保持処理、バックアップの利用方法をまとめたものです。

## 認証

Core APIの内部APIは`Authorization: Bearer <service-key>`で認証します。サービスごとにキーが分かれており、エンドポイントごとに利用可能なサービスが異なります。

| API                         | 利用サービス      |
| --------------------------- | ----------------- |
| `/v1/community/*`           | Community Bot     |
| `/v1/raffles/*`             | Game Bot          |
| `/v1/ai/*`                  | AI Bot            |
| `/v1/maintenance/retention` | Background Worker |

`POST`・`PATCH`で冪等性が必要なAPIは`Idempotency-Key`ヘッダーも送信します。

## 通知機能（RSS / YouTube / Twitch / Webhook）

RSS購読、誕生日通知、予約告知は`010_notifications_and_feeds.sql`、YouTube/Twitch/Webhookは`020_external_notifications.sql`で永続化します。Community Botの`/rss-add`・`/rss-list`・`/rss-remove`でRSS/Atom購読を管理できます。外部購読は下記のCommunity APIで管理し、Background WorkerがポーリングしてDiscord Outboxへ登録します。

- `rss_feeds`: Guildごとの購読URL、通知先、ポーリング間隔、ETag/Last-Modified、失敗回数、次回取得時刻を保持します。
- `rss_items`: フィード単位の外部IDで重複排除し、未通知記事だけを配信対象にできます。
- `birthdays`: Guild・ユーザーごとの月日、IANAタイムゾーン、通知先、年度内の通知済み情報を保持します。誕生日の年は保持しません。
- `scheduled_notifications`: RSS・誕生日・予約告知・既存リマインダーを同じ実行キューで扱える共通エンベロープです。

RSS取得は`etag`と`last_modified`を条件付きリクエストへ使い、同一記事は`(feed_id, external_id)`で一度だけ保存します。予約通知Workerは`run_at`のインデックスを使い、処理取得時に`processing`へ遷移させて二重送信を防ぎます。外部URLの取得、タイムゾーンの妥当性、Discord権限は実装時にサービス層で検証します。

## 拡張機能の共通契約（事前設計）

マイグレーション`011_extensible_features.sql`では、今後の機能が共通のライフサイクルを使えるようにしました。いずれもテーブルを追加しただけで、現時点ではBotコマンドやWorkerから利用していません。

- `guild_feature_settings`: `feature_key`単位の有効化とJSON設定。更新者・更新時刻を必須にします。
- `user_preferences`: Guildごとのタイムゾーン、ロケール、通知設定。誕生日・リマインダー・イベントで再利用します。
- `notification_outbox`: 通知生成とDiscord送信を分離するOutbox。`dedupe_key`、状態、ロック時刻、claim token、再試行回数を持ち、完了更新時は取得時のclaim tokenを検証します。
- `external_subscriptions`: RSS、YouTube、Twitch、Webhookの購読共通モデル。アクセストークンやWebhook秘密値は保存せず、Secret Manager/環境変数の参照名だけを`secret_ref`に保存します。
- `external_notification_events`: 購読単位の外部イベントIDで再送・再ポーリングを重複排除します。新規イベントは`notification_outbox`へ同一トランザクションで登録します。
- `moderation_cases`: note、warn、timeout、kick、ban、unbanを共通ケース番号で管理します。
- `metric_buckets`: コマンド数・再生数・エラー数などを時間バケットへ集約します。ユーザー本文やURLなどの高カーディナリティ値は保存しません。

YouTube購読の`target`はチャンネルID、Twitch購読の`target`はユーザー名、Webhook購読の`target`は表示用URLまたは送信元名です。Twitchポーリングには`TWITCH_CLIENT_ID`と`TWITCH_CLIENT_SECRET`を設定してください。YouTube AtomフィードはAPIキー不要です。

```http
POST /v1/community/external-subscriptions
Authorization: Bearer <community-key>
Content-Type: application/json
```

```json
{
  "guildId": "123456789",
  "kind": "youtube",
  "target": "UCxxxxxxxxxxxxxxxxxxxxxx",
  "channelId": "123456790",
  "createdBy": "123456793",
  "intervalSeconds": 300
}
```

WebhookはBearer認証ではなく、`X-Webhook-Signature: sha256=<HMAC-SHA256(JSON.stringify(body))>`で検証します。`secretRef`には秘密値ではなく環境変数名を設定し、Core APIプロセスにその環境変数を渡してください。

```http
POST /v1/notifications/webhooks/<subscription-id>
X-Webhook-Signature: sha256=<hex>
Content-Type: application/json
```

```sh
curl -X GET \\
  -H "Authorization: Bearer $CORE_API_KEY_COMMUNITY" \\
  "http://localhost:3000/v1/community/vc-recruitments?guildId=123456789"
```

## VC募集の永続化

`/vc-recruit`を実行すると入力モーダルが表示されます。作成後の募集情報はPostgreSQLの次のテーブルに保存されます。

- `vc_recruitments`
- `vc_recruitment_participants`

Botは作成時に自動でDBへ登録し、ボタン操作時に参加・参加取消・締切をDBへ反映します。

### 有効な募集一覧

```http
GET /v1/community/vc-recruitments?guildId=<guild-id>
Authorization: Bearer <community-key>
```

Bot起動時にもこのAPIを呼び出し、期限内の募集をDiscordメッセージへ再紐付けします。

### 作成

```http
POST /v1/community/vc-recruitments
Authorization: Bearer <community-key>
Idempotency-Key: <discord-message-id>
Content-Type: application/json
```

```json
{
  "guildId": "123456789",
  "postChannelId": "123456790",
  "messageId": "123456791",
  "voiceChannelId": "123456792",
  "creatorId": "123456793",
  "title": "ゲーム募集",
  "activity": "一緒に遊びます",
  "maxParticipants": 5,
  "expiresAt": "2026-10-18T12:00:00.000Z"
}
```

### 参加・参加取消

```http
POST /v1/community/vc-recruitments/<recruitment-id>/participants
Authorization: Bearer <community-key>
Content-Type: application/json
```

```json
{
  "guildId": "123456789",
  "userId": "123456794",
  "action": "join"
}
```

`action`は`join`または`leave`です。募集人数超過、期限切れ、締切済みの場合は`409`になります。

### 締切

```http
POST /v1/community/vc-recruitments/<recruitment-id>/close
Authorization: Bearer <community-key>
Content-Type: application/json
```

```json
{ "guildId": "123456789" }
```

## 抽選の参加条件

Game Botの抽選作成コマンドでは最低ポイント条件を指定できます。

```text
/raffle create title:景品抽選 prize:ギフトカード cost:10 min_points:100
```

APIで作成する場合は`eligibility`を指定します。

```json
{
  "guildId": "123456789",
  "createdBy": "123456793",
  "title": "月例抽選",
  "prize": { "name": "ギフトカード", "description": "1,000円分" },
  "entryCost": 10,
  "eligibility": {
    "minPoints": 100,
    "roleIds": ["123456795"]
  }
}
```

参加時には以下を検証します。

- `minPoints`: 参加時点のDB残高が条件以上であること
- `roleIds`: 参加者が指定されたDiscordロールをすべて保有していること

条件未達時は次のエラーになります。

- `raffle_eligibility_not_met`
- `raffle_role_eligibility_not_met`

## 抽選賞品の更新

抽選作成者は、抽選賞品を更新できます。

```http
PATCH /v1/raffles/<raffle-id>/prize
Authorization: Bearer <game-key>
Idempotency-Key: <unique-key>
Content-Type: application/json
```

```json
{
  "guildId": "123456789",
  "actorId": "123456793",
  "prize": {
    "name": "新しい景品名",
    "description": "景品説明"
  }
}
```

作成者以外は`403 raffle_creator_required`になります。

## 保持処理と一時VC整理

Background Workerは起動時に保持処理を実行し、成功時は24時間周期、失敗時は1分後に再試行します。

一時VCについては、`delete_after`から10分以上経過したDBレコードを削除します。削除件数はレスポンスの`deleted.temporaryVoiceChannels`で確認できます。

```sh
docker compose --profile maintenance up --build -d background-worker
```

## バックアップと復元

### 単発バックアップ

```sh
./scripts/backup-db.sh
```

出力先は`./backups/yanagi-<UTC timestamp>.dump`です。保持期間は`BACKUP_RETENTION_DAYS`で指定します。

### 定期バックアップコンテナ

```sh
BACKUP_INTERVAL_SECONDS=86400 \\
BACKUP_RETENTION_DAYS=30 \\
docker compose --profile backup up --build -d db-backup
```

バックアップファイルにはDB全体が含まれるため、Git管理外のアクセス制限されたストレージへ保存してください。本番環境では暗号化・オフサイト保管・復元演習を必ず追加してください。

### 復元

```sh
CONFIRM_RESTORE=YES ./scripts/restore-db.sh backups/yanagi-<timestamp>.dump
```

復元前に書き込み系サービスを停止し、対象DBとバックアップファイルを確認してください。復元は既存データを上書きする可能性があります。
