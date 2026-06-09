// Mutable server state, shared across route handlers and the idle watchdog.

export class ServerState {
  readonly version: string;
  /** Monotonic-ish wall clock of the last activity, in ms. */
  private lastHeartbeat: number;
  /** Once true, /health and /enqueue return 503 and the server is stopping. */
  private shuttingDown = false;

  constructor(version: string, now: number = Date.now()) {
    this.version = version;
    this.lastHeartbeat = now;
  }

  /** Record activity. Called on every request. */
  bump(now: number = Date.now()): void {
    this.lastHeartbeat = now;
  }

  getLastHeartbeat(): number {
    return this.lastHeartbeat;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Mark the server as shutting down. Idempotent. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /** True when the idle window has elapsed with no activity. */
  isIdleExpired(idleTimeoutMs: number, now: number = Date.now()): boolean {
    return now - this.lastHeartbeat >= idleTimeoutMs;
  }
}
