# AI Bot コマンド一覧

AI Botは、ローカルAIへの質問、翻訳、要約、応答評価を担当します。Game BotからAI機能を分離しているため、AI Botを起動しない場合でもゲーム・ポイント・抽選機能は利用できます。

## AIユーティリティ

| コマンド                                 | 内容                         |
| ---------------------------------------- | ---------------------------- |
| `/ai message:<質問>`                     | 会話履歴付きのローカルAI応答 |
| `/ask message:<質問>`                    | ローカルAIへの質問           |
| `/translate text:<文章> language:<言語>` | 指定言語への翻訳             |
| `/summarize text:<文章>`                 | 日本語要約                   |
| `/summarize-channel [limit:<件数>]`      | チャンネル会話の要約         |

## 評価・管理

| コマンド                                        | 内容                                     |
| ----------------------------------------------- | ---------------------------------------- |
| `/ai-feedback interaction_id:<ID> rating:<1-5>` | AI応答の評価保存                         |
| `/ai-feedback-stats`                            | AI評価の集計表示。サーバー管理権限が必要 |

`AI_ENABLED=true`とOllama設定が必要です。入力は最大1000文字で、応答にはDiscordメンションを許可しません。AI BotにはGuilds、Guild Messages、Message Content intentsと`applications.commands`スコープを付与してください。

## 起動

```sh
docker compose --profile ai up -d ollama ollama-model
docker compose --profile ai --profile ai-bot up --build -d ai-bot
```

環境変数は`AI_BOT_TOKEN`と`CORE_API_KEY_AI`を使用します。ローカル開発では次を実行します。

```sh
node --env-file=.env --import tsx --watch apps/ai-bot/src/index.ts
```
