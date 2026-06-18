import { describe, expect, test } from "bun:test";
import { ServerState } from "./state.ts";

// Version is incidental to these tests (they exercise heartbeat/shutdown), so
// any sentinel works.
const VERSION = "test-version";

describe("ServerState", () => {
  test("stores the version it was constructed with", () => {
    expect(new ServerState(VERSION).version).toBe(VERSION);
  });

  test("starts not shutting down", () => {
    const s = new ServerState(VERSION);
    expect(s.isShuttingDown()).toBe(false);
  });

  test("beginShutdown flips the flag", () => {
    const s = new ServerState(VERSION);
    s.beginShutdown();
    expect(s.isShuttingDown()).toBe(true);
  });

  test("bump updates heartbeat", () => {
    const s = new ServerState(VERSION, 100);
    s.bump(500);
    expect(s.getLastHeartbeat()).toBe(500);
  });

  test("isIdleExpired respects the timeout window", () => {
    const s = new ServerState(VERSION, 1000);
    // 1000 + 5000 = 6000 boundary
    expect(s.isIdleExpired(5000, 5999)).toBe(false);
    expect(s.isIdleExpired(5000, 6000)).toBe(true);
    expect(s.isIdleExpired(5000, 7000)).toBe(true);
  });

  test("bump resets the idle window", () => {
    const s = new ServerState(VERSION, 1000);
    expect(s.isIdleExpired(5000, 6500)).toBe(true);
    s.bump(6500);
    expect(s.isIdleExpired(5000, 7000)).toBe(false);
  });
});
