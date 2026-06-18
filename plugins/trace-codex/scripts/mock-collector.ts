// Mock Braintrust collector for the smoke test.
//
// The smoke test runs a real Codex session with the trace plugin enabled, but
// points the Braintrust SDK at this local server instead of the real backend.
// It implements just enough of the Braintrust HTTP API for a span flush to
// succeed, and counts the trace rows it receives so the smoke test can assert
// that tracing actually reported something.
//
// The Braintrust SDK (v3.x) makes these calls during initLogger + flush:
//   POST {BRAINTRUST_APP_URL}/api/apikey/login       -> org_info handshake
//   POST {BRAINTRUST_APP_URL}/api/project/register   -> resolves the project id
//   GET  {BRAINTRUST_API_URL}/version                -> payload-limit probe (tolerated)
//   POST {BRAINTRUST_API_URL}/logs3                  -> the actual span data
// Pointing both BRAINTRUST_APP_URL and BRAINTRUST_API_URL at this one origin
// captures the whole flow.
//
// On shutdown (SIGTERM/SIGINT) it writes a JSON summary to MOCK_COLLECTOR_OUT:
//   { "logs3Requests": <n>, "totalRows": <n> }
// so the smoke test can read the result after the Codex session ends.

import { writeFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_COLLECTOR_PORT || "53999");
const OUT = process.env.MOCK_COLLECTOR_OUT || "";

let logs3Requests = 0;
let totalRows = 0;

function log(message: string): void {
  process.stderr.write(`mock-collector: ${message}\n`);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Count the trace rows in a /logs3 body: { rows: [...], api_version: 2 }. */
function countRows(body: unknown): number {
  if (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { rows?: unknown[] }).rows)
  ) {
    return (body as { rows: unknown[] }).rows.length;
  }
  return 0;
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);

    // Login handshake. api_url/proxy_url are echoed back, but the SDK uses
    // BRAINTRUST_API_URL (set by the smoke test) for the data plane regardless.
    if (req.method === "POST" && pathname === "/api/apikey/login") {
      const self = `http://127.0.0.1:${PORT}`;
      return json({
        org_info: [{ id: "smoke-org", name: "smoke", api_url: self, proxy_url: self }],
      });
    }

    // Project registration -> returns a project id the rows reference.
    if (req.method === "POST" && pathname === "/api/project/register") {
      return json({ project: { id: "00000000-0000-0000-0000-000000000000", name: "smoke" } });
    }

    // Payload-limit probe. Tolerated by the SDK; return no limit.
    if (req.method === "GET" && pathname === "/version") {
      return json({ logs3_payload_max_bytes: null });
    }

    // The actual span data. Count the rows and acknowledge.
    if (req.method === "POST" && (pathname === "/logs3" || pathname === "/logs3/overflow")) {
      let rows = 0;
      try {
        rows = countRows(await req.json());
      } catch (err) {
        log(`failed to parse ${pathname} body: ${String(err)}`);
      }
      logs3Requests += 1;
      totalRows += rows;
      log(`received ${pathname}: ${rows} row(s) (total ${totalRows})`);
      return json({});
    }

    // Anything else: 200 with an empty object so the SDK never hard-fails.
    log(`unhandled ${req.method} ${pathname}`);
    return json({});
  },
});

log(`listening on http://127.0.0.1:${server.port}`);

function writeSummaryAndExit(): void {
  const summary = { logs3Requests, totalRows };
  if (OUT) {
    try {
      writeFileSync(OUT, JSON.stringify(summary));
      log(`wrote summary to ${OUT}: ${JSON.stringify(summary)}`);
    } catch (err) {
      log(`failed to write summary to ${OUT}: ${String(err)}`);
    }
  } else {
    log(`summary: ${JSON.stringify(summary)}`);
  }
  server.stop(true);
  process.exit(0);
}

process.on("SIGTERM", writeSummaryAndExit);
process.on("SIGINT", writeSummaryAndExit);
