# Game Bot コマンド一覧

Game Botは、ミニゲーム・ポイント経済・景品交換・抽選を担当します。

## ミニゲーム

| コマンド                        | 内容                 |
| ------------------------------- | -------------------- |
| `/coinflip`                     | コイン投げ           |
| `/dice sides:<面数>`            | サイコロ             |
| `/rps choice:<手>`              | じゃんけん           |
| `/slots`                        | スロット             |
| `/eightball question:<質問>`    | 8ボール              |
| `/random min:<最小> max:<最大>` | 数字抽選             |
| `/game-stats`                   | ミニゲーム統計       |
| `/game-ranking`                 | ミニゲームランキング |

## ポイント経済

| コマンド               | 内容                              |
| ---------------------- | --------------------------------- |
| `/points` / `/balance` | ポイント残高                      |
| `/daily`               | 1日1回の100ptボーナス             |
| `/leaderboard`         | サーバー内ポイントランキング      |
| `/work`                | 1時間ごとに20〜50pt               |
| `/crime`               | 3時間ごとのリスク型ポイントゲーム |
| `/fortune`             | 1日1回のおみくじ                  |

ポイントとクールダウンはCore API・PostgreSQLへ保存されます。

## ショップ・抽選

| コマンド                                         | 内容               |
| ------------------------------------------------ | ------------------ |
| `/shop` / `/rewards`                             | 景品・ショップ一覧 |
| `/buy reward_id:<ID>` / `/redeem reward_id:<ID>` | ポイント交換       |
| `/raffle create`                                 | 抽選作成           |
| `/raffle start`                                  | 受付開始           |
| `/raffle enter`                                  | 抽選参加           |
| `/raffle list`                                   | 抽選一覧           |
| `/raffle close`                                  | 受付終了           |
| `/raffle draw`                                   | 当選者決定         |
| `/raffle redraw`                                 | 再抽選             |
| `/raffle history`                                | 抽選履歴           |
