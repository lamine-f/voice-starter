/**
 * The relay over HTTP, as a Hono sub-application (Node, Vercel, Cloudflare…):
 *
 *   POST /session       → SessionGrant
 *   POST /tools/:name   → the server tool's result (body: its arguments)
 *
 * `authorize` guards both: a session spends the provider's credit as surely
 * as a tool reaches the host's data.
 */
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type Broker, BrokerError } from "./broker.ts";

export interface BrokerRoutesOptions<Ctx> {
  /**
   * Runs before every route. Throw to refuse (a BrokerError carries its
   * status: 401, 403…); the value returned is the context server tools
   * receive (the signed-in user, for instance).
   */
  authorize?: (c: Context) => Ctx | Promise<Ctx>;
}

export function brokerRoutes<Ctx = void>(
  broker: Broker<Ctx>,
  options: BrokerRoutesOptions<Ctx> = {},
): Hono {
  const app = new Hono();

  // A BrokerError is meant for the client. Anything else is an internal
  // failure (database, service): its message would reach the agent, which
  // reads it aloud. It stays in the server's log.
  app.onError((err, c) => {
    if (err instanceof BrokerError) {
      return c.json({ error: err.message }, err.status as ContentfulStatusCode);
    }
    console.error("voice-broker :", err);
    return c.json({ error: "erreur interne du relais" }, 500);
  });

  const authorize = async (c: Context) =>
    (options.authorize ? await options.authorize(c) : undefined) as Ctx;

  app.post("/session", async (c) => {
    await authorize(c);
    return c.json(await broker.openSession());
  });

  app.post("/tools/:name", async (c) => {
    const ctx = await authorize(c);
    const args: unknown = await c.req.json().catch(() => {
      throw new BrokerError(400, "corps JSON invalide");
    });
    return c.json((await broker.callTool(c.req.param("name"), args, ctx)) ?? null);
  });

  return app;
}
