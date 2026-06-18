import { describe, expect, test } from "bun:test";
import { Mutex } from "./mutex.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Mutex", () => {
  test("runs sections one at a time, in order, with no interleaving", async () => {
    const mutex = new Mutex();
    const events: string[] = [];

    const section = (name: string, delay: number) =>
      mutex.runExclusive(async () => {
        events.push(`${name}:start`);
        await sleep(delay);
        events.push(`${name}:end`);
      });

    // Start three "concurrently". Without the lock, their start/end would
    // interleave; with it, each must complete before the next starts.
    await Promise.all([section("a", 20), section("b", 1), section("c", 5)]);

    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  test("returns the function's result", async () => {
    const mutex = new Mutex();
    const result = await mutex.runExclusive(async () => 42);
    expect(result).toBe(42);
  });

  test("releases the lock even when the section throws", async () => {
    const mutex = new Mutex();
    await expect(
      mutex.runExclusive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The next acquirer must still be able to run.
    const after = await mutex.runExclusive(async () => "ok");
    expect(after).toBe("ok");
  });

  test("serializes read-modify-write without lost updates", async () => {
    const mutex = new Mutex();
    let counter = 0;

    // Each section reads, awaits (a yield point), then writes back. Without the
    // lock this classic pattern loses updates; with it, the final value is N.
    const bump = () =>
      mutex.runExclusive(async () => {
        const current = counter;
        await sleep(1);
        counter = current + 1;
      });

    await Promise.all(Array.from({ length: 25 }, () => bump()));
    expect(counter).toBe(25);
  });
});
