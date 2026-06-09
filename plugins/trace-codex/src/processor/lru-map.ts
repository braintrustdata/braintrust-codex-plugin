// A tiny LRU map. Insertion/access order is tracked by the underlying Map
// (JS Maps preserve insertion order); on access we re-insert to mark the key as
// most-recently-used. When over capacity, the oldest entry is evicted.

export interface LruMapOptions<V> {
  capacity: number;
  /** Optional callback invoked when an entry is evicted (not on delete). */
  onEvict?: (key: string, value: V) => void;
}

export class LruMap<V> {
  private readonly map = new Map<string, V>();
  private readonly capacity: number;
  private readonly onEvict?: (key: string, value: V) => void;

  constructor(options: LruMapOptions<V>) {
    if (options.capacity < 1) throw new Error("LruMap capacity must be >= 1");
    this.capacity = options.capacity;
    this.onEvict = options.onEvict;
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Get a value and mark it most-recently-used. */
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Re-insert to move to the end (most-recently-used).
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Insert/update a value, marking it most-recently-used, evicting if needed. */
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      // The first key in iteration order is the least-recently-used.
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldestValue = this.map.get(oldestKey) as V;
      this.map.delete(oldestKey);
      this.onEvict?.(oldestKey, oldestValue);
    }
  }

  /** Iterate values (oldest-first); used for cleanup on shutdown. */
  values(): IterableIterator<V> {
    return this.map.values();
  }

  clear(): void {
    this.map.clear();
  }
}
