import { describe, expect, test } from "vitest";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_PORT, loadConfig, serverBaseUrl } from "./config.ts";

describe("loadConfig", () => {
  test("uses defaults when env is empty", () => {
    const c = loadConfig({});
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.idleTimeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS);
  });

  test("reads port override", () => {
    const c = loadConfig({ BRAINTRUST_EVENT_SERVER_PORT: "40000" });
    expect(c.port).toBe(40000);
  });

  test("ignores invalid port and falls back", () => {
    const c = loadConfig({ BRAINTRUST_EVENT_SERVER_PORT: "nope" });
    expect(c.port).toBe(DEFAULT_PORT);
  });

  test("reads idle timeout override", () => {
    const c = loadConfig({ BRAINTRUST_EVENT_SERVER_IDLE_TIMEOUT_MS: "1000" });
    expect(c.idleTimeoutMs).toBe(1000);
  });

  test("prefers explicit log dir, then PLUGIN_DATA", () => {
    expect(loadConfig({ BRAINTRUST_EVENT_SERVER_LOG_DIR: "/a" }).dataDir).toBe("/a");
    expect(loadConfig({ PLUGIN_DATA: "/b" }).dataDir).toBe("/b");
  });
});

describe("serverBaseUrl", () => {
  test("builds a loopback URL", () => {
    expect(serverBaseUrl({ host: "127.0.0.1", port: 52734 })).toBe("http://127.0.0.1:52734");
  });
});
