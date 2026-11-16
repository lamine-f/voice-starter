import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { httpBroker } from "../src/client.ts";
import {
  BrokerError,
  brokerRoutes,
  createBroker,
  declaration,
  implement,
  type ProviderBackend,
  parseArgs,
  type ToolResult,
  tool,
} from "../src/index.ts";

const display = tool({
  name: "display_card",
  description: "Show a card.",
  runsOn: "client",
  parameters: z.object({
    title: z.string().describe("Short card title"),
    kind: z.enum(["info", "warning"]).optional(),
    rows: z.array(z.array(z.string())).optional(),
  }),
});

const add = tool({
  name: "add",
  description: "Add two numbers.",
  runsOn: "server",
  parameters: z.object({ a: z.number(), b: z.number() }),
});

const provider: ProviderBackend = {
  name: "fake",
  url: "wss://agent.test",
  audio: { inputRate: 16000, outputRate: 24000 },
  grantToken: async () => "tok",
  buildSettings: (prompt, tools) => ({ prompt, functions: tools.map((t) => t.name) }),
};

const broker = createBroker<{ user: string }>({
  provider,
  prompt: "Tu es un assistant.",
  tools: [display, implement(add, ({ a, b }, ctx) => ({ sum: a + b, by: ctx.user }))],
});

describe("tool registry", () => {
  it("checks the agent's arguments the same way for server and client tools", () => {
    expect(parseArgs(display, { title: "Ventes", kind: "info" })).toEqual({
      success: true,
      data: { title: "Ventes", kind: "info" },
    });
    const refused = parseArgs(display, { kind: "nope" });
    expect(refused.success).toBe(false);
    expect(!refused.success && refused.error).toMatch(/^arguments invalides pour display_card : /);
  });

  it("refuses at declaration what the core could not check", () => {
    const dated = tool({
      name: "since",
      description: "d",
      runsOn: "client",
      parameters: z.object({ day: z.iso.date(), tags: z.array(z.string()).refine(() => true) }),
    });
    expect(() => declaration(dated)).not.toThrow();
    const tuple = tool({
      name: "pair",
      description: "d",
      runsOn: "client",
      parameters: z.object({ pair: z.tuple([z.string(), z.number()]) }),
    });
    expect(() => declaration(tuple)).toThrow(
      /mot-clé JSON Schema non pris en charge dans parameters\.pair : prefixItems/,
    );
  });

  it("keeps what a server tool returns, for the host's page", () => {
    const sales = implement(add, async ({ a, b }) => ({ total: a + b, currency: "XOF" as const }));
    expectTypeOf<ToolResult<typeof sales>>().toEqualTypeOf<{ total: number; currency: "XOF" }>();
  });

  it("is importable in a browser without the relay: its entry needs only Zod", () => {
    for (const file of ["tools-entry.ts", "tools.ts"]) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      const imports = [...source.matchAll(/^(?:import|export)[^"]*from "([^"]+)"/gm)].map(
        (m) => m[1] ?? "",
      );
      expect(imports.length).toBeGreaterThan(0);
      for (const i of imports)
        expect(["zod", "@lamine-f/voice-protocol", "./tools.ts"]).toContain(i);
    }
  });
});

describe("declarations", () => {
  it("publish the JSON Schema of the input, without $schema nor additionalProperties", () => {
    expect(declaration(display)).toEqual({
      name: "display_card",
      description: "Show a card.",
      runsOn: "client",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short card title" },
          kind: { type: "string", enum: ["info", "warning"] },
          rows: { type: "array", items: { type: "array", items: { type: "string" } } },
        },
        required: ["title"],
      },
    });
  });

  it("refuse union types", () => {
    const bad = tool({
      name: "bad",
      description: "",
      runsOn: "client",
      parameters: z.object({ cell: z.union([z.string(), z.number()]) }),
    });
    expect(() => declaration(bad)).toThrow(/union/);
  });
});

describe("broker", () => {
  it("refuses a server tool without handler, a handler on a client tool, and duplicates", () => {
    expect(() => createBroker({ provider, prompt: "", tools: [add] })).toThrow(/sans gestionnaire/);
    expect(() => implement(display, () => null)).toThrow(/outil client/);
    expect(() => createBroker({ provider, prompt: "", tools: [display, display] })).toThrow(
      /deux fois/,
    );
  });

  it("grants a session with a fresh token, the settings and the declarations", async () => {
    expect(await broker.openSession()).toEqual({
      provider: "fake",
      url: "wss://agent.test",
      token: "tok",
      settings: { prompt: "Tu es un assistant.", functions: ["display_card", "add"] },
      audio: { inputRate: 16000, outputRate: 24000 },
      tools: broker.tools,
    });
  });

  it("runs server tools with validated arguments and the caller's context", async () => {
    expect(await broker.callTool("add", { a: 2, b: 3 }, { user: "lamine" })).toEqual({
      sum: 5,
      by: "lamine",
    });
    await expect(broker.callTool("add", { a: "2" }, { user: "x" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(broker.callTool("display_card", {}, { user: "x" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(broker.callTool("nope", {}, { user: "x" })).rejects.toBeInstanceOf(BrokerError);
  });
});

describe("routes", () => {
  const app = brokerRoutes(broker, { authorize: (c) => ({ user: c.req.header("x-user") ?? "?" }) });
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("serve sessions and server tools", async () => {
    expect(await (await post("/session")).json()).toMatchObject({ token: "tok" });
    const res = await post("/tools/add", { a: 1, b: 1 }, { "x-user": "web" });
    expect(await res.json()).toEqual({ sum: 2, by: "web" });
  });

  it("answer errors with their status", async () => {
    expect((await post("/tools/nope", {})).status).toBe(404);
    const invalid = await post("/tools/add", { a: 1 });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toMatch(/arguments invalides pour add/);
    const notJson = await app.request("/tools/add", { method: "POST", body: "{oops" });
    expect(notJson.status).toBe(400);
  });

  it("keep an internal failure's message on the server", async () => {
    const failing = createBroker({
      provider: {
        ...provider,
        grantToken: async () => Promise.reject(new Error("pg: mot de passe refusé")),
      },
      prompt: "p",
      tools: [],
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await brokerRoutes(failing).request("/session", { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "erreur interne du relais" });
    expect(String(log.mock.calls[0]?.[1])).toContain("pg: mot de passe refusé");
    log.mockRestore();
  });

  it("refuse sessions and tools alike when authorize throws", async () => {
    const guarded = brokerRoutes(broker, {
      authorize: (c) => {
        if (!c.req.header("x-user")) throw new BrokerError(401, "connexion requise");
        return { user: c.req.header("x-user") ?? "" };
      },
    });
    const call = (path: string, headers: Record<string, string> = {}) =>
      guarded.request(path, { method: "POST", headers, body: JSON.stringify({ a: 1, b: 2 }) });
    for (const path of ["/session", "/tools/add"]) {
      const refused = await call(path);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: "connexion requise" });
    }
    expect((await call("/session", { "x-user": "web" })).status).toBe(200);
  });

  it("are what httpBroker talks to", async () => {
    vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
      app.request(url.replace("http://relay.test/voice", ""), init),
    );
    const client = httpBroker("http://relay.test/voice", { headers: { "x-user": "page" } });
    expect((await client.open()).token).toBe("tok");
    expect(await client.callTool("add", { a: 4, b: 4 })).toEqual({ sum: 8, by: "page" });
    await expect(client.callTool("nope", {})).rejects.toThrow("outil inconnu : nope");
    vi.unstubAllGlobals();
  });
});
