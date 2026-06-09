// A minimal async mutex: serializes async work so that only one critical
// section runs at a time, even across `await` points.
//
// JS is single-threaded, so there is no parallel execution, but multiple async
// callers can still interleave at `await` boundaries. `runExclusive` chains
// callers onto a shared promise tail so each one runs to completion before the
// next begins.

export class Mutex {
  // The tail of the queue. Each acquirer awaits the previous tail, then becomes
  // the new tail. Starts resolved so the first caller runs immediately.
  private tail: Promise<void> = Promise.resolve();

  /**
   * Run `fn` exclusively. Resolves/rejects with `fn`'s result. The lock is
   * released even if `fn` throws.
   */
  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    // Capture the current tail, then advance it to a promise that only resolves
    // once this caller finishes.
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return previous.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }
}
