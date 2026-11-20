// Scans asked for while one runs, or many at once: Sonarr imports a season as
// one call per episode. The queue waits a little, takes them together per
// library, and starts each when the scanner is free, so none is lost.

import type { ScanRequest } from './scanner/scanner.js';

export interface ScanStarter {
  start(request?: ScanRequest): boolean;
}

/** Wait this long after the last request (a season pack arrives as many). */
const SETTLE_MS = 15_000;
/** Look again this often while a scan runs. */
const RETRY_MS = 10_000;

export class ScanQueue {
  /** Library ids to scan; `all` when one request was for every library. */
  private wanted = new Set<string>();
  private all = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly scanner: ScanStarter;
  private readonly settleMs: number;
  private readonly retryMs: number;

  constructor(scanner: ScanStarter, options: { settleMs?: number; retryMs?: number } = {}) {
    this.scanner = scanner;
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.retryMs = options.retryMs ?? RETRY_MS;
  }

  /** A scan of these libraries (none: all of them), soon. */
  request(libraryIds: string[] = []) {
    if (libraryIds.length === 0) this.all = true;
    for (const id of libraryIds) this.wanted.add(id);
    this.schedule(this.settleMs);
  }

  /** What is still waiting (for tests and logs). */
  pending(): { all: boolean; libraryIds: string[] } {
    return { all: this.all, libraryIds: [...this.wanted] };
  }

  stop() {
    clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), ms);
    this.timer.unref?.();
  }

  private fire() {
    if (!this.all && this.wanted.size === 0) return;
    if (this.all) {
      if (!this.scanner.start()) return this.schedule(this.retryMs);
      this.all = false;
      this.wanted.clear();
      return;
    }
    const [first] = this.wanted;
    if (first === undefined || !this.scanner.start({ libraryId: first })) {
      return this.schedule(this.retryMs);
    }
    this.wanted.delete(first);
    if (this.wanted.size > 0) this.schedule(this.retryMs);
  }
}
