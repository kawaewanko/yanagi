import { describe, expect, it } from "vitest";
import { aiCommandDefinitions } from "./commands.js";

describe("AI Bot commands", () => {
  it("defines only AI-related commands", () => {
    const names = aiCommandDefinitions().map(
      (command) => command.toJSON().name,
    );
    expect(names).toEqual([
      "help",
      "ping",
      "ai",
      "ask",
      "translate",
      "summarize",
      "summarize-channel",
      "ai-feedback",
      "ai-feedback-stats",
    ]);
  });
});
