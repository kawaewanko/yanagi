export class TtsSynthesisError extends Error {
  constructor(
    readonly code:
      | "engine_timeout"
      | "engine_unavailable"
      | "engine_rejected"
      | "invalid_audio",
  ) {
    super(code);
    this.name = "TtsSynthesisError";
  }
}

export async function synthesizeVoicevox(
  text: string,
  engineUrl: string,
  speakerId: number,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const baseUrl = new URL(engineUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol))
    throw new TypeError("VOICEVOX_URL must use HTTP or HTTPS");
  const deadline = AbortSignal.timeout(30_000);
  const query = new URLSearchParams({ text, speaker: String(speakerId) });

  try {
    const queryResponse = await fetcher(
      `${baseUrl.toString().replace(/\/+$/, "")}/audio_query?${query}`,
      {
        method: "POST",
        signal: deadline,
      },
    );
    if (!queryResponse.ok) throw new TtsSynthesisError("engine_rejected");
    const audioQuery: unknown = await queryResponse.json();
    if (
      !audioQuery ||
      typeof audioQuery !== "object" ||
      Array.isArray(audioQuery)
    ) {
      throw new TtsSynthesisError("engine_rejected");
    }

    const synthesisQuery = new URLSearchParams({ speaker: String(speakerId) });
    const synthesisResponse = await fetcher(
      `${baseUrl.toString().replace(/\/+$/, "")}/synthesis?${synthesisQuery}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(audioQuery),
        signal: deadline,
      },
    );
    if (!synthesisResponse.ok) throw new TtsSynthesisError("engine_rejected");
    const audio = new Uint8Array(await synthesisResponse.arrayBuffer());
    if (
      audio.byteLength < 12 ||
      String.fromCharCode(...audio.slice(0, 4)) !== "RIFF" ||
      String.fromCharCode(...audio.slice(8, 12)) !== "WAVE"
    ) {
      throw new TtsSynthesisError("invalid_audio");
    }
    return audio;
  } catch (error) {
    if (
      error instanceof TtsSynthesisError ||
      (error instanceof TypeError && error.message.includes("VOICEVOX_URL"))
    ) {
      throw error;
    }
    if (deadline.aborted) throw new TtsSynthesisError("engine_timeout");
    if (error instanceof TypeError)
      throw new TtsSynthesisError("engine_unavailable");
    throw error;
  }
}
