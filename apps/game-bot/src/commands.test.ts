import { describe, expect, it } from "vitest";
import { gameCommandDefinitions } from "./commands.js";

describe("Game Bot commands", () => {
  it("defines the implemented game, points, rewards, redemption, and raffle commands", () => {
    const commands = gameCommandDefinitions().map((command) =>
      command.toJSON(),
    );
    expect(commands.map((command) => command.name)).toEqual([
      "help",
      "ping",
      "coinflip",
      "dice",
      "rps",
      "slots",
      "eightball",
      "random",
      "game-stats",
      "game-ranking",
      "points",
      "balance",
      "daily",
      "leaderboard",
      "point-history",
      "point-transfer",
      "period-leaderboard",
      "achievement",
      "work",
      "crime",
      "fortune",
      "rewards",
      "shop",
      "redeem",
      "buy",
      "raffle",
    ]);
    expect(
      commands.find((command) => command.name === "buy")?.options?.[0],
    ).toMatchObject({
      name: "reward_id",
      required: true,
      type: 4,
      min_value: 1,
    });
    expect(
      commands
        .find((command) => command.name === "raffle")
        ?.options?.map((option) => option.name),
    ).toEqual([
      "create",
      "list",
      "start",
      "enter",
      "close",
      "draw",
      "redraw",
      "history",
    ]);
  });
});
