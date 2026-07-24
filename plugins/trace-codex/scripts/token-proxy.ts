// Token-counting proxy for verifying trace-codex's token accounting.
//
// Codex has no per-session token readout we can compare against, so this is a
// standalone debugging tool: a local HTTP proxy that sits between Codex and the
// real OpenAI API. It forwards every request through unchanged and tees the
// streaming response, parsing each model call's `usage` straight off the wire.
// You then compare these ground-truth numbers against what trace-codex records
// in Braintrust.
//
// It is NOT part of either plugin's runtime — purely a manual verification aid.
//
// ── Usage ──────────────────────────────────────────────────────────────────
//   1. Run the proxy:
//        pnpm exec tsx scripts/token-proxy.ts
//      It listens on http://127.0.0.1:53800 and, by default, forwards to the
//      ChatGPT backend (https://chatgpt.com) — for ChatGPT-login Codex, the
//      common case. It logs every request it receives.
//
//   2. Point Codex at it via a custom provider in ~/.codex/config.toml. These
//      keys are USER-LEVEL only and MUST go ABOVE any [table] headers (in TOML,
//      keys after a `[table]` header belong to that table), e.g. at the very top
//      of the file:
//
//      For ChatGPT login (auth_mode=chatgpt — check ~/.codex/auth.json):
//        model_provider = "token-proxy"
//        [model_providers.token-proxy]
//        name = "token-proxy"
//        # base_url must contain "/backend-api" so Codex uses ChatGPT path style;
//        # the proxy forwards this exact path to https://chatgpt.com.
//        base_url = "http://127.0.0.1:53800/backend-api/codex"
//        requires_openai_auth = true   # relay the ChatGPT token + account headers
//        wire_api = "responses"
//
//      For API-key login instead: run the proxy with
//        TOKEN_PROXY_UPSTREAM=https://api.openai.com pnpm exec tsx scripts/token-proxy.ts
//      and use:
//        model_provider = "token-proxy"
//        [model_providers.token-proxy]
//        name = "token-proxy"
//        base_url = "http://127.0.0.1:53800/v1"
//        env_key = "OPENAI_API_KEY"
//        wire_api = "responses"
//
//   3. Run a Codex session as usual. Each model call prints a usage line, and a
//      running session total is kept. A machine-readable NDJSON log is written to
//      TOKEN_PROXY_OUT (default: token-proxy.ndjson) — one line per call plus a
//      final totals line — so you can diff against the trace.
//
// ── How usage is read ────────────────────────────────────────────────────────
// Codex uses the Responses API with SSE streaming. The terminal
// `response.completed` event carries `response.usage`:
//   { input_tokens, output_tokens, total_tokens,
//     input_tokens_details: { cached_tokens },
//     output_tokens_details: { reasoning_tokens } }
// We pass the stream through byte-for-byte to Codex while parsing a copy, so the
// proxy is transparent. Non-streaming JSON responses are handled too (we read
// `usage` from the parsed body) for completeness.

import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

const PORT = Number(process.env.TOKEN_PROXY_PORT || "53800");
// Upstream ORIGIN the proxy forwards to (scheme://host, no path). The proxy is a
// transparent tunnel: it forwards the exact request path Codex builds onto this
// origin. Default is the ChatGPT host Codex uses when logged in via ChatGPT
// (auth_mode=chatgpt) — the common case. For an API-key login, set
// TOKEN_PROXY_UPSTREAM=https://api.openai.com (and use the api-key provider).
const UPSTREAM = (
  process.env.TOKEN_PROXY_UPSTREAM ||
  process.env.OPENAI_BASE_URL ||
  "https://chatgpt.com"
).replace(/\/+$/, "");
const OUT = process.env.TOKEN_PROXY_OUT || "/tmp/token-proxy.ndjson";
// When set, dump the raw upstream SSE event blocks to TOKEN_PROXY_DEBUG_OUT so we
// can inspect the exact event shape (the ChatGPT backend may differ from the
// public Responses API).
const DEBUG = process.env.TOKEN_PROXY_DEBUG === "1";
const DEBUG_OUT = process.env.TOKEN_PROXY_DEBUG_OUT || "token-proxy-raw.log";

/** Per-call usage, normalized to the keys we care about. */
interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

const ZERO_USAGE: Usage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
};

// Running totals across the proxy's lifetime (one session, typically).
let callCount = 0;
const sessionTotal: Usage = { ...ZERO_USAGE };

function log(message: string): void {
  process.stderr.write(`token-proxy: ${message}\n`);
}

// Truncate the NDJSON log on startup so each run is a fresh capture.
try {
  writeFileSync(OUT, "");
} catch (err) {
  log(`could not open ${OUT}: ${String(err)} (file logging disabled)`);
}

if (DEBUG) {
  try {
    writeFileSync(DEBUG_OUT, "");
    log(`DEBUG on: dumping raw upstream SSE blocks to ${DEBUG_OUT}`);
  } catch {
    // ignore
  }
}

function record(line: unknown): void {
  try {
    appendFileSync(OUT, `${JSON.stringify(line)}\n`);
  } catch {
    // best-effort; the stderr line is the primary output
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Pull usage out of a Responses API `response` object (the shape under both the
 * `response.completed` SSE event and a non-streaming JSON body). Returns null if
 * there is no usage block.
 */
function usageFromResponse(response: unknown): Usage | null {
  if (response === null || typeof response !== "object") return null;
  const usage = (response as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const inputDetails = (u.input_tokens_details ?? {}) as Record<string, unknown>;
  const outputDetails = (u.output_tokens_details ?? {}) as Record<string, unknown>;
  return {
    input_tokens: num(u.input_tokens),
    cached_input_tokens: num(inputDetails.cached_tokens),
    output_tokens: num(u.output_tokens),
    reasoning_output_tokens: num(outputDetails.reasoning_tokens),
    total_tokens: num(u.total_tokens),
  };
}

/** Record a call's usage: bump totals, print a line, append to the NDJSON log. */
function reportUsage(usage: Usage, model: string | undefined): void {
  callCount += 1;
  sessionTotal.input_tokens += usage.input_tokens;
  sessionTotal.cached_input_tokens += usage.cached_input_tokens;
  sessionTotal.output_tokens += usage.output_tokens;
  sessionTotal.reasoning_output_tokens += usage.reasoning_output_tokens;
  sessionTotal.total_tokens += usage.total_tokens;

  log(
    `call #${callCount}${model ? ` (${model})` : ""}: ` +
      `input=${usage.input_tokens} (cached=${usage.cached_input_tokens}) ` +
      `output=${usage.output_tokens} (reasoning=${usage.reasoning_output_tokens}) ` +
      `total=${usage.total_tokens}  ||  session total=${sessionTotal.total_tokens}`,
  );
  record({ kind: "call", call: callCount, model, usage, sessionTotal: { ...sessionTotal } });
}

/**
 * A TransformStream that passes bytes through untouched while scanning the SSE
 * text for the terminal usage. Codex receives the exact upstream bytes; we just
 * watch a copy. We look for `response.completed` (and tolerate `response.usage`
 * appearing on other terminal events) and parse the embedded JSON object's
 * usage. The model id is pulled from the same event when present.
 */
function makeUsageSniffer(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let reported = false;

  const tryParseEvent = (block: string): void => {
    if (block.trim().length === 0) return;
    if (DEBUG) {
      try {
        appendFileSync(DEBUG_OUT, `${block}\n---\n`);
      } catch {
        // ignore
      }
    }
    // An SSE event block is lines like "event: ...\ndata: {json}". Concatenate
    // all data: lines (the Responses API sends single-line JSON, but be safe).
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("");
    if (data === "[DONE]" || data.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // not JSON we can read; ignore
    }
    if (parsed === null || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;
    // Find a usage block wherever it lives: nested under `response` (the
    // completed/incomplete events) or at the top level. Report each one we see —
    // a single model call's stream carries usage once, so the last one wins if
    // there are several. (Don't short-circuit on the first: some backends emit a
    // partial usage earlier in the stream.)
    const response = (obj.response ?? obj) as Record<string, unknown>;
    const usage = usageFromResponse(response) ?? usageFromResponse(obj);
    if (usage === null) return;
    const model =
      typeof response.model === "string"
        ? response.model
        : typeof obj.model === "string"
          ? obj.model
          : undefined;
    reportUsage(usage, model);
    reported = true;
  };

  // Whole-body accumulator for the non-SSE JSON fallback, capped so a huge
  // response can't balloon memory (usage lives in the small completed event /
  // top-level object, so a few MB is plenty).
  let fullBody = "";
  const FULL_BODY_CAP = 4_000_000;

  // Last-resort: try to parse the entire body as one JSON object and pull usage
  // from it (covers non-streaming JSON responses).
  const tryParseWholeBody = (): void => {
    if (reported || fullBody.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fullBody);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;
    const response = (obj.response ?? obj) as Record<string, unknown>;
    const usage = usageFromResponse(response) ?? usageFromResponse(obj);
    if (usage === null) return;
    const model =
      typeof response.model === "string"
        ? response.model
        : typeof obj.model === "string"
          ? obj.model
          : undefined;
    reportUsage(usage, model);
    reported = true;
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk); // pass through immediately, unmodified
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      if (fullBody.length < FULL_BODY_CAP) fullBody += text;
      // SSE events are separated by a blank line. Process complete blocks.
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        tryParseEvent(block);
        sep = buffer.indexOf("\n\n");
      }
    },
    flush() {
      if (buffer.length > 0) tryParseEvent(buffer);
      // SSE parsing found nothing — try the whole body as a single JSON object.
      tryParseWholeBody();
      if (!reported) {
        log(`call completed with no usage found in response (path may be non-model)`);
      }
    },
  });
}

/** Build the upstream URL: UPSTREAM + the request path + query, verbatim. */
function upstreamUrl(reqPath: string): string {
  // Transparent tunnel: forward the exact path + query Codex built onto the
  // upstream origin. (The provider's base_url is configured so Codex builds the
  // correct downstream path; the proxy never rewrites it.) req.url is just the
  // path here (Node), so parse it against a dummy base.
  const { pathname, search } = new URL(reqPath, "http://127.0.0.1");
  return `${UPSTREAM}${pathname}${search}`;
}

async function handleProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reqPath = req.url ?? "/";
  const method = req.method ?? "GET";
  const target = upstreamUrl(reqPath);
  const path = new URL(reqPath, "http://127.0.0.1").pathname;
  // Log every request so it's obvious when Codex is (or isn't) hitting us.
  log(`${method} ${path} -> ${target}`);

  // Forward the request verbatim (method, headers, body). Codex already set the
  // Authorization header (ChatGPT token or API key) and the account/session
  // headers, so we just relay them. Drop `host` so fetch derives the correct
  // upstream host (otherwise it carries our 127.0.0.1:PORT and breaks routing).
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  headers.delete("host");

  const hasBody = method !== "GET" && method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      // Stream the request body through as a web ReadableStream.
      body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
      // `duplex: "half"` is required to stream a request body; not in the DOM
      // RequestInit type, so widen via a cast.
      ...({ duplex: "half" } as Record<string, unknown>),
      redirect: "manual",
    });
  } catch (err) {
    log(`upstream fetch failed for ${method} ${path}: ${String(err)}`);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_upstream_failed" }));
    return;
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  log(`  <- ${upstream.status} ${contentType || "(no content-type)"}`);

  // Copy upstream response headers back to the client verbatim.
  const outHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  res.writeHead(upstream.status, outHeaders);

  // Always tee the body through the usage sniffer. We do NOT gate on
  // content-type: the ChatGPT backend streams SSE with no (or an unexpected)
  // content-type header, so matching "text/event-stream" misses it. The sniffer
  // passes bytes through unchanged and looks for usage in either SSE `data:`
  // events or a whole-body JSON object, so it's safe for any response.
  if (upstream.body) {
    const teed = upstream.body.pipeThrough(makeUsageSniffer());
    Readable.fromWeb(teed as unknown as ReadableStream<Uint8Array>).pipe(res);
    return;
  }

  // No body (e.g. a HEAD or 204): nothing to stream.
  res.end();
}

const server = createServer((req, res) => {
  void handleProxy(req, res);
});
// Generous: model calls can stream for minutes; disable the request/socket
// timeouts so a long stream isn't torn down mid-flight.
server.requestTimeout = 0;
server.timeout = 0;

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr !== null ? addr.port : PORT;
  log(`listening on http://127.0.0.1:${boundPort} -> ${UPSTREAM}`);
  log(`writing per-call usage to ${OUT}`);
});

function summarize(): void {
  log(
    `SESSION TOTAL over ${callCount} call(s): ` +
      `input=${sessionTotal.input_tokens} (cached=${sessionTotal.cached_input_tokens}) ` +
      `output=${sessionTotal.output_tokens} (reasoning=${sessionTotal.reasoning_output_tokens}) ` +
      `total=${sessionTotal.total_tokens}`,
  );
  record({ kind: "session_total", calls: callCount, sessionTotal: { ...sessionTotal } });
  server.close();
  process.exit(0);
}

process.on("SIGTERM", summarize);
process.on("SIGINT", summarize);
