import { describe, expect, it, vi } from "vitest";
import { synthesizeVoicevox, TtsSynthesisError } from "./engine.js";

describe("synthesizeVoicevox", () => {
  it("uses the local Voicevox API and returns validated WAV bytes", async () => {
    const audio = Buffer.from("RIFF0000WAVEcontent");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "hello" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(audio, { status: 200 }));

    await expect(
      synthesizeVoicevox("hello world", "http://voicevox:50021/", 3, fetcher),
    ).resolves.toEqual(new Uint8Array(audio));
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://voicevox:50021/audio_query?text=hello+world&speaker=3",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://voicevox:50021/synthesis?speaker=3",
      expect.objectContaining({ method: "POST", body: '{"text":"hello"}' }),
    );
  });

  it("rejects invalid engine output", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "hello" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("not wav", { status: 200 }));

    await expect(
      synthesizeVoicevox("hello", "http://localhost:50021", 1, fetcher),
    ).rejects.toMatchObject({
      code: "invalid_audio",
    } satisfies Partial<TtsSynthesisError>);
  });

  it("rejects unsuccessful synthesis responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("offline", { status: 503 }));

    await expect(
      synthesizeVoicevox("hello", "http://localhost:50021", 1, fetcher),
    ).rejects.toMatchObject({
      code: "engine_rejected",
    } satisfies Partial<TtsSynthesisError>);
  });
});
