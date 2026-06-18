import { describe, expect, test } from "bun:test";
import { LruMap } from "./lru-map.ts";

describe("LruMap", () => {
  test("stores and retrieves values", () => {
    const m = new LruMap<number>({ capacity: 3 });
    m.set("a", 1);
    expect(m.get("a")).toBe(1);
    expect(m.has("a")).toBe(true);
    expect(m.size).toBe(1);
  });

  test("evicts the least-recently-used entry over capacity", () => {
    const evicted: string[] = [];
    const m = new LruMap<number>({ capacity: 2, onEvict: (k) => evicted.push(k) });
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3); // evicts "a"
    expect(m.has("a")).toBe(false);
    expect(m.has("b")).toBe(true);
    expect(m.has("c")).toBe(true);
    expect(evicted).toEqual(["a"]);
  });

  test("get() marks an entry most-recently-used", () => {
    const evicted: string[] = [];
    const m = new LruMap<number>({ capacity: 2, onEvict: (k) => evicted.push(k) });
    m.set("a", 1);
    m.set("b", 2);
    m.get("a"); // now "b" is the LRU
    m.set("c", 3); // evicts "b"
    expect(m.has("a")).toBe(true);
    expect(m.has("b")).toBe(false);
    expect(evicted).toEqual(["b"]);
  });

  test("set() on an existing key refreshes recency without growing", () => {
    const m = new LruMap<number>({ capacity: 2 });
    m.set("a", 1);
    m.set("b", 2);
    m.set("a", 10); // refresh "a"; "b" becomes LRU
    m.set("c", 3); // evicts "b"
    expect(m.get("a")).toBe(10);
    expect(m.has("b")).toBe(false);
    expect(m.has("c")).toBe(true);
  });

  test("rejects invalid capacity", () => {
    expect(() => new LruMap<number>({ capacity: 0 })).toThrow();
  });
});
