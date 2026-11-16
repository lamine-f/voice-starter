/**
 * Browser side of the relay: the core's SessionBroker port over HTTP.
 * Depends on nothing but `fetch`, so it bundles small.
 */
import type { SessionGrant } from "@lamine-f/voice-protocol";

export interface HttpBrokerOptions {
  /** Sent with every request: the host's own credentials (token, CSRF header…). */
  headers?: Record<string, string>;
}

export function httpBroker(baseUrl: string, options: HttpBrokerOptions = {}) {
  const post = async (path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...options.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = (data as { error?: unknown } | null)?.error;
      throw new Error(typeof error === "string" ? error : `relais : HTTP ${res.status}`);
    }
    return data;
  };
  return {
    open: () => post("/session") as Promise<SessionGrant>,
    callTool: (name: string, args: unknown) => post(`/tools/${encodeURIComponent(name)}`, args),
  };
}
