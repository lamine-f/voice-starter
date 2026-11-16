import { BrokerError } from "@lamine-f/voice-broker";
import type { ToolDeclaration } from "@lamine-f/voice-protocol";
import { describe, expect, it } from "vitest";
import {
  AGENT_URL,
  buildSettings,
  deepgramBackend,
  deepgramConfigFromEnv,
  grantToken,
} from "../src/server.ts";

const TOOLS: ToolDeclaration[] = [
  { name: "ping", description: "d", parameters: { type: "object" }, runsOn: "client" },
];

const config = (env: Record<string, string> = {}) =>
  deepgramConfigFromEnv({ DEEPGRAM_API_KEY: "k", ...env });

type Settings = ReturnType<typeof buildSettings>;
const agent = (s: Settings) => s.agent;

describe("configuration", () => {
  it("defaults to multilingual Flux, gpt-5.4-mini and a French Flux voice", () => {
    expect(deepgramConfigFromEnv({})).toEqual({
      apiKey: "",
      listenModel: "flux-general-multi",
      languageHints: ["fr", "en"],
      thinkProvider: "open_ai",
      thinkModel: "gpt-5.4-mini",
      thinkVersion: "ai-studio-v1beta",
      speakModel: "flux-thierry-fr",
    });
  });

  it("parses language hints", () => {
    expect(config({ DEEPGRAM_LANGUAGE_HINTS: " de , en ," }).languageHints).toEqual(["de", "en"]);
    expect(config({ DEEPGRAM_LANGUAGE_HINTS: " , " }).languageHints).toEqual(["fr"]);
  });
});

describe("settings", () => {
  it("serves Flux models through v2, with hints for the multilingual model", () => {
    const a = agent(buildSettings(config(), "p", TOOLS));
    expect(a.listen.provider).toEqual({
      type: "deepgram",
      model: "flux-general-multi",
      version: "v2",
      language_hints: ["fr", "en"],
    });
    expect(a.speak.provider.version).toBe("v2");
    expect(a).not.toHaveProperty("language"); // deprecated by Deepgram
  });

  it("serves other models through v1 with an explicit language", () => {
    const a = agent(
      buildSettings(
        config({ DEEPGRAM_LISTEN_MODEL: "nova-3", DEEPGRAM_SPEAK_MODEL: "aura-2-agathe-fr" }),
        "p",
        TOOLS,
      ),
    );
    expect(a.listen.provider).toEqual({
      type: "deepgram",
      model: "nova-3",
      version: "v1",
      language: "fr",
    });
    expect(a.speak.provider.version).toBe("v1");
  });

  it("sends a think version for Google only", () => {
    const google = config({
      DEEPGRAM_THINK_PROVIDER: "google",
      DEEPGRAM_THINK_MODEL: "gemini-2.5-flash",
    });
    expect(agent(buildSettings(google, "p", TOOLS)).think.provider).toHaveProperty("version");
    expect(agent(buildSettings(config(), "p", TOOLS)).think.provider).not.toHaveProperty("version");
  });

  it("holds every tool until end of turn and keeps runsOn to itself", () => {
    const think = agent(buildSettings(config(), "the prompt", TOOLS)).think;
    expect(think.prompt).toBe("the prompt");
    expect(think.functions).toEqual([
      { name: "ping", description: "d", parameters: { type: "object" }, defer_until_eot: true },
    ]);
  });

  it("uses raw PCM both ways", () => {
    const { audio } = buildSettings(config(), "p", TOOLS);
    expect(audio.input).toEqual({ encoding: "linear16", sample_rate: 16000 });
    expect(audio.output).toEqual({ encoding: "linear16", sample_rate: 24000, container: "none" });
  });
});

describe("tokens", () => {
  const respond = (status: number, body: unknown) =>
    (async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;

  it("requires an API key", async () => {
    await expect(grantToken(deepgramConfigFromEnv({}))).rejects.toMatchObject({ status: 500 });
  });

  it("asks for a 60-second token with the API key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchSpy = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 60 }));
    }) as unknown as typeof fetch;
    expect(await grantToken(config(), fetchSpy)).toBe("tok");
    expect(calls[0]?.url).toBe("https://api.deepgram.com/v1/auth/grant");
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Token k" });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ ttl_seconds: 60 });
  });

  it("relays Deepgram's refusals with their status", async () => {
    const err = await grantToken(config(), respond(401, "bad key")).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err).toMatchObject({ status: 401, message: "Deepgram : bad key" });
  });

  it("reports an unreachable Deepgram as 502", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(grantToken(config(), down)).rejects.toMatchObject({ status: 502 });
  });

  it("plugs into the relay as its provider", async () => {
    const backend = deepgramBackend(config(), respond(200, { access_token: "tok" }));
    expect(backend).toMatchObject({
      name: "deepgram",
      url: AGENT_URL,
      audio: { inputRate: 16000, outputRate: 24000 },
    });
    expect(await backend.grantToken()).toBe("tok");
  });
});
