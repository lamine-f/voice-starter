/**
 * Deepgram Voice Agent, server side: short-lived tokens and session settings.
 *
 * The browser opens the agent WebSocket itself, so audio never transits
 * through the relay. Deepgram chains three stages: `listen` (speech-to-text),
 * `think` (the LLM that converses and calls tools) and `speak` (text-to-speech).
 */
import { BrokerError, type ProviderBackend } from "@lamine-f/voice-broker";
import type { ToolDeclaration } from "@lamine-f/voice-protocol";

export const AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse";
const GRANT_URL = "https://api.deepgram.com/v1/auth/grant";
// The token only has to be valid at the WebSocket handshake.
const TOKEN_TTL_SECONDS = 60;
// Raw 16-bit PCM both ways: the client captures and plays at these rates.
const AUDIO = { inputRate: 16000, outputRate: 24000 } as const;

export interface DeepgramConfig {
  apiKey: string;
  listenModel: string;
  languageHints: string[];
  thinkProvider: string;
  thinkModel: string;
  /** Only sent for Google models. */
  thinkVersion: string;
  speakModel: string;
}

export function deepgramConfigFromEnv(env: Record<string, string | undefined>): DeepgramConfig {
  const hints = (env.DEEPGRAM_LANGUAGE_HINTS ?? "fr,en")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return {
    apiKey: env.DEEPGRAM_API_KEY ?? "",
    listenModel: env.DEEPGRAM_LISTEN_MODEL ?? "flux-general-multi",
    languageHints: hints.length ? hints : ["fr"],
    // Measured on real tool-calling sessions: never announces an action
    // without calling its tool (Gemini 2.5 Flash missed ~1 in 5), fast first reply.
    thinkProvider: env.DEEPGRAM_THINK_PROVIDER ?? "open_ai",
    thinkModel: env.DEEPGRAM_THINK_MODEL ?? "gpt-5.4-mini",
    thinkVersion: env.DEEPGRAM_THINK_VERSION ?? "ai-studio-v1beta",
    speakModel: env.DEEPGRAM_SPEAK_MODEL ?? "flux-thierry-fr",
  };
}

/** Flux models (listen and speak) are served by the v2 API, others by v1. */
const isFlux = (model: string) => model.startsWith("flux-");

/** The `Settings` message the client sends right after the agent's Welcome. */
export function buildSettings(
  config: DeepgramConfig,
  prompt: string,
  tools: readonly ToolDeclaration[],
) {
  const listen: Record<string, unknown> = { type: "deepgram", model: config.listenModel };
  if (isFlux(config.listenModel)) {
    listen.version = "v2";
    // Flux reads the language from the model name; only the multilingual model takes hints.
    if (config.listenModel.endsWith("-multi")) listen.language_hints = config.languageHints;
  } else {
    Object.assign(listen, { version: "v1", language: config.languageHints[0] });
  }

  const think: Record<string, unknown> = { type: config.thinkProvider, model: config.thinkModel };
  if (config.thinkProvider === "google") think.version = config.thinkVersion;

  const speak = {
    type: "deepgram",
    model: config.speakModel,
    version: isFlux(config.speakModel) ? "v2" : "v1",
  };

  return {
    type: "Settings",
    audio: {
      input: { encoding: "linear16", sample_rate: AUDIO.inputRate },
      output: { encoding: "linear16", sample_rate: AUDIO.outputRate, container: "none" },
    },
    agent: {
      listen: { provider: listen },
      think: {
        provider: think,
        prompt,
        // Tools act on the machine or the screen: hold each call until the
        // user's turn is confirmed instead of running it while they may still
        // be talking. `runsOn` is ours, not Deepgram's: the core routes calls.
        functions: tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
          defer_until_eot: true,
        })),
      },
      speak: { provider: speak },
    },
  };
}

export async function grantToken(
  config: DeepgramConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.apiKey) {
    throw new BrokerError(
      500,
      "DEEPGRAM_API_KEY manquant : la clé Deepgram du serveur n'est pas configurée.",
    );
  }
  let res: Response;
  try {
    res = await fetchImpl(GRANT_URL, {
      method: "POST",
      headers: { Authorization: `Token ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new BrokerError(
      502,
      `Deepgram injoignable : ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!res.ok) throw new BrokerError(res.status, `Deepgram : ${(await res.text()).slice(0, 300)}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

/** Deepgram as the relay's provider. */
export function deepgramBackend(
  config: DeepgramConfig,
  fetchImpl: typeof fetch = fetch,
): ProviderBackend {
  return {
    name: "deepgram",
    url: AGENT_URL,
    audio: AUDIO,
    grantToken: () => grantToken(config, fetchImpl),
    buildSettings: (prompt, tools) => buildSettings(config, prompt, tools),
  };
}
