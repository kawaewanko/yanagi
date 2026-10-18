# Voice Bot コマンド一覧

Voice Botは、読み上げ・ボイスチャンネル操作・音楽再生を担当します。既存の`voice-bot`は全機能を持つ互換モードで、分離運用では読み上げBot 3台と音楽再生Bot 3台を別トークンで起動できます。

## ボイス・読み上げ

| コマンド           | 内容                  |
| ------------------ | --------------------- |
| `/ping`            | 応答速度の確認        |
| `/join`            | 実行者のVCへ参加      |
| `/leave`           | VCから退出            |
| `/stop`            | 読み上げ停止          |
| `/tts text:<文章>` | 最大500文字の読み上げ |

## 音楽再生

| コマンド                         | 内容                           |
| -------------------------------- | ------------------------------ | ---------- |
| `/music-play url:<URL>`          | URL・YouTubeプレイリストを再生 |
| `/music-play query:<検索語>`     | YouTube検索から再生            |
| `/music-queue`                   | キュー表示                     |
| `/music-skip`                    | 現在曲をスキップ               |
| `/music-pause` / `/music-resume` | 一時停止・再開                 |
| `/music-stop`                    | 再生停止・キュー消去           |
| `/music-loop enabled:<true       | false>`                        | ループ再生 |
| `/music-effect effect:<種類>`    | 音声エフェクト                 |
| `/music-volume percent:<0〜200>` | 音量設定                       |
| `/music-shuffle`                 | キューをシャッフル             |
| `/music-remove position:<位置>`  | キューから曲を削除             |
| `/music-clear`                   | 待機キューを消去               |
| `/music-now-playing`             | 現在曲と設定を表示             |

## 音楽ライブラリ

| コマンド                           | 内容                       |
| ---------------------------------- | -------------------------- |
| `/music-ranking days:<日数>`       | 再生ランキング             |
| `/music-favorite-add`              | 現在曲をお気に入り登録     |
| `/music-favorites`                 | お気に入り一覧             |
| `/music-favorite-remove url:<URL>` | お気に入り削除             |
| `/music-playlist-save name:<名前>` | 現在曲をプレイリスト保存   |
| `/music-playlist-list`             | プレイリスト一覧           |
| `/music-playlist-play name:<名前>` | プレイリストをキューへ追加 |

## 分離運用

読み上げBotは`VOICE_BOT_MODE=tts`、音楽再生Botは`VOICE_BOT_MODE=music`で起動します。各Botには異なるDiscordアプリケーションとトークンを用意してください。同じトークンを複数プロセスで共有するとDiscord Gatewayのセッション競合が発生します。

`.env`に次の6トークンを設定します。

```dotenv
VOICE_TTS_BOT_TOKEN_1=
VOICE_TTS_BOT_TOKEN_2=
VOICE_TTS_BOT_TOKEN_3=
VOICE_MUSIC_BOT_TOKEN_1=
VOICE_MUSIC_BOT_TOKEN_2=
VOICE_MUSIC_BOT_TOKEN_3=
```

Docker Composeでは次のコマンドで6台をまとめて起動できます。

```sh
docker compose --profile voice-tts --profile voice-music --profile tts up --build -d \
  tts-bot-1 tts-bot-2 tts-bot-3 \
  music-bot-1 music-bot-2 music-bot-3 voicevox
```
