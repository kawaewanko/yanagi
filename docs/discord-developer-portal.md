# Discord Developer Portal設定ガイド

このリポジトリでは、Discordアプリを次の9個に分けて運用します。

- Community Bot
- Game Bot
- AI Bot
- TTS Bot 1〜3
- Music Bot 1〜3

各アプリは別々のBot User、Bot Token、Application IDを持たせてください。特にTTS 1〜3とMusic 1〜3で同じTokenを共有すると、Discord Gatewayのセッション競合やログイン失敗の原因になります。

## 1. アプリを作成する

1. [Discord Developer Portal](https://discord.com/developers/applications)を開き、`New Application`を選択します。
2. 表示名を設定します。推奨名は次のとおりです。
   - `夜凪鯖 Community`
   - `夜凪鯖 Game`
   - `夜凪鯖 AI`
   - `夜凪鯖 TTS 1`〜`3`
   - `夜凪鯖 Music 1`〜`3`
3. `General Information`でアイコンとヘッダーを登録します。対応する画像は[Botブランドアセット](../assets/discord-bots/descriptions.md)にあります。
4. `Description`には、同じアセット一覧にある各Botのプロフィール説明文をコピーします。
5. `Bot`ページで`Add Bot`を実行し、Tokenを一度だけ発行・更新します。Tokenは`.env`へ保存し、Gitへ追加しないでください。

DiscordのBot認証では、Botをギルドへ追加するOAuth2 URLに`bot`スコープを含め、スラッシュコマンドを使う場合は`applications.commands`も含めます。[1]

## 2. Privileged Gateway Intents

`Bot`ページの`Privileged Gateway Intents`で、コードが要求するものだけを有効にします。設定していないPrivileged IntentをGatewayへ送ると接続が拒否されるため、Portalとコードの両方を一致させてください。[2]

### Community Bot

有効化するもの:

- `Server Members Intent`
- `Message Content Intent`

コードで使用するGateway Intentsは`Guilds`、`Guild Members`、`Guild Moderation`、`Guild Messages`、`Message Content`、`Guild Voice States`です。`Guild Moderation`と`Guild Voice States`はPrivileged Intentではありません。

### AI Bot

有効化するもの:

- `Message Content Intent`

AI Botはチャンネル会話の要約でメッセージ本文を扱うため、このIntentが必要です。コードで使用するGateway Intentsは`Guilds`、`Guild Messages`、`Message Content`です。

### Game Bot、TTS Bot 1〜3、Music Bot 1〜3

Privileged Intentは不要です。各Botは`Guilds`、`Guild Messages`、必要に応じて`Guild Voice States`を使用します。

Guild MembersやMessage Contentを使うBotは、未認証の小規模アプリでもPortalで有効化が必要です。大規模・認証済みアプリはDiscordの審査要件も確認してください。[2]

## 3. OAuth2 URL Generator

各アプリの`Installation`または`OAuth2`のURL Generatorで、次を設定します。

### Scopes

- `bot`
- `applications.commands`

URLを手作業で作る場合の形式は次です。`CLIENT_ID`を各アプリのApplication IDに置き換えます。

```text
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=PERMISSION_INTEGER
```

`permissions`はBot権限のビット値です。まずPortalのチェックボックスで設定し、生成されたURLを利用する方法を推奨します。Discordの権限は整数で表現され、チャンネル単位のPermission Overwriteによってさらに制限されることがあります。[1] [3]

### Bot権限の共通項目

全Botで次を基本に設定します。

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Use Application Commands

各通知先、AI要約対象、ゲーム用チャンネル、VCチャンネルでは、Botロールに加えてチャンネルのPermission Overwriteも確認してください。

## 4. Bot別の推奨Permissions

### Community Bot

共通項目に加えて次を有効にします。

- Manage Channels: 一時VCの作成・削除、チャンネル設定変更、レート制限
- Manage Roles: 自動ロール、認証ロール、ロール操作
- Manage Nicknames: ニックネーム管理
- Manage Messages: 招待リンクを含むメッセージの削除
- View Audit Log: 監査ログの取得
- Mute Members: VC自動ミュート
- Move Members: AFK移動、VC管理

`Administrator`は不要です。最初は上記の明示権限だけを与え、動作確認後に不足権限がないか監査ログとBotログで確認してください。

### Game Bot

共通項目だけで動作します。ポイント付与のために`Guild Messages`と`Guild Voice States`を使用しますが、Botに`Manage Guild`を付与する必要はありません。抽選や管理コマンドの実行可否は、コードが実行者の権限を確認します。

### AI Bot

共通項目だけで動作します。AIコマンドの入力と会話要約に必要なチャンネルの閲覧・履歴読み取り権限を付与してください。`Administrator`、`Manage Messages`、`Manage Guild`は不要です。

### TTS Bot 1〜3

共通項目に加えて、読み上げ対象のVCで次を有効にします。

- Connect
- Speak
- Use Voice Activity

TTS Botは`VOICE_BOT_MODE=tts`で起動するため、音楽キュー操作やVCロック操作のための追加管理権限は不要です。

### Music Bot 1〜3

共通項目に加えて、音楽再生対象のVCで次を有効にします。

- Connect
- Speak
- Use Voice Activity

音楽Botは`VOICE_BOT_MODE=music`で起動するため、`Manage Channels`や`Move Members`は通常不要です。

### 旧Voice Bot（VOICE_BOT_MODE=all）

旧来の全機能Voice Botを起動する場合は、TTS・Musicの権限に加えて次を有効にします。

- Manage Channels
- Move Members

## 5. チャンネル単位の設定

ギルドへインストールした後、Botロールを次のように分けて設定します。

- 通知Bot: 通知を投稿するチャンネルだけView、Send、Embed、Read Historyを許可
- AI Bot: `/ai`や要約を許可するチャンネルだけView、Send、Embed、Read Historyを許可
- Game Bot: ゲーム・ポイント用チャンネルと対象VCだけ許可
- TTS Bot: 読み上げ対象VCと操作コマンド用テキストチャンネルだけ許可
- Music Bot: 音楽再生対象VCと操作コマンド用テキストチャンネルだけ許可
- Community Bot: Welcome、監査、VC管理、通知の各チャンネルだけ必要権限を許可

Botロールは、操作対象のロールより上位に置いてください。特にManage Rolesは、Bot自身より下にあるロールだけを操作できます。

## 6. `.env`への対応表

```text
Community Bot  -> COMMUNITY_BOT_TOKEN / CORE_API_KEY_COMMUNITY
Game Bot       -> GAME_BOT_TOKEN / CORE_API_KEY_GAME
AI Bot         -> AI_BOT_TOKEN / CORE_API_KEY_AI
TTS Bot 1      -> VOICE_TTS_BOT_TOKEN_1 / CORE_API_KEY_VOICE
TTS Bot 2      -> VOICE_TTS_BOT_TOKEN_2 / CORE_API_KEY_VOICE
TTS Bot 3      -> VOICE_TTS_BOT_TOKEN_3 / CORE_API_KEY_VOICE
Music Bot 1    -> VOICE_MUSIC_BOT_TOKEN_1 / CORE_API_KEY_VOICE
Music Bot 2    -> VOICE_MUSIC_BOT_TOKEN_2 / CORE_API_KEY_VOICE
Music Bot 3    -> VOICE_MUSIC_BOT_TOKEN_3 / CORE_API_KEY_VOICE
```

TTS 1〜3とMusic 1〜3はDiscord Tokenを分けます。Core APIのサービスキーは同じVoiceサービス権限を共有しますが、Discord Tokenは必ず個別に設定します。

## 7. 起動・停止

全Botを同時に起動するには、`.env`に上記のTokenとCore APIキーを設定してから実行します。

```sh
cp .env.example .env
chmod +x scripts/start-all-bots.sh scripts/stop-all-bots.sh
./scripts/start-all-bots.sh
```

このスクリプトは、PostgreSQL、Core API、Community Bot、Game Bot、AI Bot、TTS Bot 1〜3、Music Bot 1〜3、TTS Worker、Background Workerを起動します。`AI_ENABLED=true`の場合はOllamaとモデル取得用サービスも起動します。Core APIのヘルスチェックが通るまで最大120秒待機し、最後にComposeの状態を表示します。

停止する場合:

```sh
./scripts/stop-all-bots.sh
```

通常のAI無効構成でもAI Botプロセス自体は起動しますが、AIコマンドはCore APIで無効化されます。AIを実際に利用する場合だけ、`.env`で`AI_ENABLED=true`にしてから起動してください。

## References

[1]: https://discord.com/developers/docs/topics/oauth2 "Discord OAuth2 Documentation"
[2]: https://discord.com/developers/docs/events/gateway#privileged-intents "Discord Gateway Intents Documentation"
[3]: https://discord.com/developers/docs/topics/permissions "Discord Permissions Documentation"
