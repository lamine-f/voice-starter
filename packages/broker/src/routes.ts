/**
 * The relay over HTTP, as a Hono sub-application (Node, Vercel, Cloudflare…):
 *
 *   POST /session       → SessionGrant
 *   POST /tools/:name   → the server tool's result (body: its arguments)
 *
 * Mount it behind the host's own access control; `authorize` turns a request
 * into the context server tools receive (the signed-in user, for instance).
 */
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type Broker, BrokerError } from "./broker.ts";

export interface BrokerRoutesOptions<Ctx> {
  authorize?: (c: Context) => Ctx | Promise<Ctx>;
}

export function brokerRoutes<Ctx = void>(
  broker: Broker<Ctx>,
  options: BrokerRoutesOptions<Ctx> = {},
): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    const status = err instanceof BrokerError ? err.status : 500;
    return c.json({ error: err.message }, status as ContentfulStatusCode);
  });

  app.post("/session", async (c) => c.json(await broker.openSession()));

  app.post("/tools/:name", async (c) => {
    const ctx = (options.authorize ? await options.authorize(c) : undefined) as Ctx;
    const args: unknown = await c.req.json().catch(() => {
      throw new BrokerError(400, "corps JSON invalide");
    });
    return c.json((await broker.callTool(c.req.param("name"), args, ctx)) ?? null);
  });

  return app;
}
