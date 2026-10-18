import { describe, expect, it } from "vitest";
import { voiceCommandDefinitions } from "./commands.js";

describe("Voice Bot commands", () => {
  it("registers help, voice control, and TTS commands", () => {
    const commands = voiceCommandDefinitions().map((command) =>
      command.toJSON(),
    );
    expect(commands.map((command) => command.name)).toEqual([
      "help",
      "ping",
      "join",
      "vc-lock",
      "vc-limit",
      "vc-move",
      "vc-stats",
      "leave",
      "stop",
      "tts",
      "music-play",
      "music-queue",
      "music-skip",
      "music-pause",
      "music-resume",
      "music-stop",
      "music-loop",
      "music-effect",
      "music-volume",
      "music-shuffle",
      "music-remove",
      "music-clear",
      "music-now-playing",
      "music-ranking",
      "music-favorite-add",
      "music-favorites",
      "music-favorite-remove",
      "music-playlist-save",
      "music-playlist-list",
      "music-playlist-play",
    ]);
    expect(commands[9].options?.[0]).toMatchObject({
      name: "text",
      required: true,
      type: 3,
      max_length: 500,
    });
    expect(commands[10].options?.map((option) => option.name)).toEqual([
      "url",
      "query",
    ]);
    expect(commands[16].options?.[0]).toMatchObject({
      name: "enabled",
      required: true,
      type: 5,
    });
    expect(commands[17].options?.[0]).toMatchObject({
      name: "effect",
      required: true,
      type: 3,
    });
    expect(commands[18].options?.[0]).toMatchObject({
      name: "percent",
      required: true,
      type: 4,
      min_value: 0,
      max_value: 200,
    });
  });

  it("registers separate command sets for TTS and music instances", () => {
    expect(
      voiceCommandDefinitions("tts").map((command) => command.toJSON().name),
    ).toEqual([
      "help",
      "ping",
      "join",
      "vc-lock",
      "vc-limit",
      "vc-move",
      "vc-stats",
      "leave",
      "stop",
      "tts",
    ]);
    expect(
      voiceCommandDefinitions("music").map((command) => command.toJSON().name),
    ).toEqual([
      "help",
      "ping",
      "join",
      "leave",
      "stop",
      "music-play",
      "music-queue",
      "music-skip",
      "music-pause",
      "music-resume",
      "music-stop",
      "music-loop",
      "music-effect",
      "music-volume",
      "music-shuffle",
      "music-remove",
      "music-clear",
      "music-now-playing",
      "music-ranking",
      "music-favorite-add",
      "music-favorites",
      "music-favorite-remove",
      "music-playlist-save",
      "music-playlist-list",
      "music-playlist-play",
    ]);
  });
});
