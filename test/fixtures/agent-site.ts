// A stand-in for the site's /api/agent/* on loopback, for the connect and account tests:
// connect/start, connect/poll (answers taken from a script, one per poll) and status. Every
// request is recorded with its time, headers and body.

import http from "node:http";
import type net from "node:net";
import type { TestContext } from "node:test";

export const TOKEN = `mma_${"T".repeat(21)}-_${"k".repeat(20)}`;
export const DEVICE_CODE = `mmd_${"d".repeat(43)}`;
export const USER_CODE = "BCDF-2345";

export interface Answer {
  status: number;
  body: unknown;
  /** Raw text instead of JSON. */
  text?: string;
  headers?: Record<string, string>;
}

export interface Seen {
  method: string;
  path: string;
  authorization?: string;
  body: string;
  at: number;
}

export interface SiteOptions {
  /** The catalog at /agent/catalog.json, when the MCP server is started on this site. */
  catalog?: unknown;
  /** connect/start's answer; by default a good one on this site's own origin. */
  start?: (origin: string) => Answer;
  /** connect/poll's answers in order; the last one repeats. */
  polls?: Answer[];
  /** status's answer for a bearer. */
  status?: (authorization: string | undefined) => Answer;
}

export interface Site {
  origin: URL;
  seen: Seen[];
  polls: () => Seen[];
}

export const pending: Answer = { status: 200, body: { status: "pending" } };
export const approved = (token = TOKEN, label = "Agent on 20 November 2026"): Answer => ({ status: 200, body: { status: "approved", token, label } });
export const slowDown: Answer = { status: 429, body: { status: "slow_down", error: "Poll at most every 5 seconds." } };
export const denied: Answer = { status: 403, body: { status: "denied", error: "The connection was declined." } };
export const expired: Answer = { status: 410, body: { status: "expired", error: "This sign-in code has expired. Start again." } };
export const consumed: Answer = { status: 410, body: { status: "consumed", error: "This sign-in code was already used." } };
export const unavailable: Answer = { status: 503, body: { error: "Accounts are unavailable." } };

export const goodStart =
  (overrides: Record<string, unknown> = {}) =>
  (origin: string): Answer => ({
    status: 200,
    body: {
      device_code: DEVICE_CODE,
      user_code: USER_CODE,
      verification_uri: `${origin}/connect`,
      verification_uri_complete: `${origin}/connect?code=${USER_CODE}`,
      expires_in: 600,
      interval: 5,
      ...overrides,
    },
  });

export const statusFor =
  (pro: boolean, label = "Agent on 20 November 2026") =>
  (authorization: string | undefined): Answer =>
    authorization === `Bearer ${TOKEN}`
      ? { status: 200, body: { signedIn: true, pro, label } }
      : { status: 401, body: { error: "This agent is no longer connected. Connect it again." } };

export async function agentSite(t: TestContext, options: SiteOptions = {}): Promise<Site> {
  const seen: Seen[] = [];
  let pollIndex = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      seen.push({
        method: req.method ?? "",
        path: url.pathname,
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        body,
        at: performance.now(),
      });
      const send = (answer: Answer) => {
        res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
        res.end(answer.text ?? JSON.stringify(answer.body));
      };
      const origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
      if (req.method === "GET" && url.pathname === "/agent/catalog.json" && options.catalog) return send({ status: 200, body: options.catalog });
      if (req.method === "POST" && url.pathname === "/api/agent/connect/start") return send((options.start ?? goodStart())(origin));
      if (req.method === "POST" && url.pathname === "/api/agent/connect/poll") {
        const polls = options.polls ?? [pending];
        const answer = polls[Math.min(pollIndex, polls.length - 1)]!;
        pollIndex++;
        return send(answer);
      }
      if (req.method === "GET" && url.pathname === "/api/agent/status")
        return send((options.status ?? statusFor(true))(req.headers.authorization));
      send({ status: 404, body: { error: "There's no such route." } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const origin = new URL(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  return { origin, seen, polls: () => seen.filter((s) => s.path === "/api/agent/connect/poll") };
}
