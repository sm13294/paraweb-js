/**
 * Persistent worker pool for ParaWeb's resident runtime.
 *
 * ParaWeb's original patterns (src/patterns, src/core/workerPool.ts) take
 * their input with every call: data is copied or shared per call and the
 * result is returned. Interactive use instead queries the same data many
 * times per second with new parameters. The resident pool therefore keeps
 *   - workers alive for the lifetime of the pool,
 *   - columns resident in workers (sent once, as SharedArrayBuffers),
 *   - compiled kernels cached in workers,
 * and schedules work by priority, so background work (index builds) never
 * delays interactive queries by more than one short chunk.
 *
 * Works with Web Workers (browser), worker_threads (Node.js), or inline on
 * the calling thread (a no-parallelism baseline with the same code path).
 */
import { RESIDENT_WORKER_SOURCE } from "./residentWorker";

declare const require: any;

function nodeRequire(): any {
  return typeof require === "function" ? require : (globalThis as any).require;
}

export interface WorkerLike {
  postMessage(msg: any): void;
  onmessage: ((ev: { data: any }) => void) | null;
  onerror: ((ev: any) => void) | null;
  terminate(): void;
}

export type WorkerFactory = () => WorkerLike;

/** Web Worker started from a Blob URL holding the worker source. */
export function browserWorkerFactory(source: string = RESIDENT_WORKER_SOURCE): WorkerFactory {
  const blob = new Blob([source], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  return () => new (globalThis as any).Worker(url) as WorkerLike;
}

/** worker_threads adapter exposing the Web Worker interface. */
export function nodeWorkerFactory(source: string = RESIDENT_WORKER_SOURCE): WorkerFactory {
  // Resolved lazily so browser bundles never touch worker_threads.
  const { Worker } = nodeRequire()("node:worker_threads");
  const prelude =
    "const { parentPort } = require('node:worker_threads');" +
    "const self = { postMessage: m => parentPort.postMessage(m) };" +
    "parentPort.on('message', data => self.onmessage({ data }));";
  return () => {
    const w = new Worker(prelude + source, { eval: true });
    w.unref();
    const like: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (m: any) => w.postMessage(m),
      terminate: () => { w.terminate(); },
    };
    w.on("message", (data: any) => like.onmessage && like.onmessage({ data }));
    w.on("error", (e: any) => like.onerror && like.onerror(e));
    return like;
  };
}

/**
 * Runs the worker code on the calling thread. Same kernels and data layout
 * as real workers, but no parallelism and no offloading: the caller blocks
 * for the whole computation. Replies arrive on a microtask to keep the
 * asynchronous protocol.
 */
export function inlineWorkerFactory(source: string = RESIDENT_WORKER_SOURCE): WorkerFactory {
  return () => {
    const like: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (m: any) => fake.onmessage({ data: m }),
      terminate: () => {},
    };
    const fake: any = {
      postMessage: (m: any) => queueMicrotask(() => like.onmessage && like.onmessage({ data: m })),
    };
    new Function("self", source)(fake);
    return like;
  };
}

/** Web Workers in a browser, worker_threads in Node.js. */
export function defaultWorkerFactory(): WorkerFactory {
  return typeof (globalThis as any).Worker === "function" && typeof (globalThis as any).Blob === "function"
    ? browserWorkerFactory() : nodeWorkerFactory();
}

export function defaultThreads(): number {
  const nav = (globalThis as any).navigator;
  if (nav && nav.hardwareConcurrency) return nav.hardwareConcurrency;
  try {
    return nodeRequire()("node:os").cpus().length;
  } catch {
    return 4;
  }
}

/**
 * Task priorities. Interactive queries use High; background work such as
 * index builds uses Low and is split into short chunks, so a query waits for
 * at most one chunk. Lowest is for housekeeping (dropping columns) that must
 * run after all queued work.
 */
export const Priority = { High: 0, Low: 1, Lowest: 2 } as const;
export type PriorityLevel = 0 | 1 | 2;

/**
 * Share of worker time given to Low tasks while High tasks are waiting: after
 * a High task that ran d ms, Low tasks may run for up to LOW_SHARE * d ms
 * before the next High task. Without it a background build starves under a
 * steady stream of queries.
 */
export const LOW_SHARE = 0.5;

export type ColumnType = "f64" | "f32" | "i32" | "u32" | "u8";

interface Pending {
  resolve: (v: any) => void; reject: (e: any) => void; worker: number;
  priority: PriorityLevel; started: number;
}

export class ResidentPool {
  readonly size: number;
  private workers: WorkerLike[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** Column keys already shipped to each worker. */
  private loaded: Set<string>[] = [];
  /** Per-worker task queues, one per priority; one task in flight per worker. */
  private queues: any[][][] = [];
  private busy: boolean[] = [];
  /** Per-worker time (ms) Low tasks may still use ahead of waiting High tasks. */
  private lowCredit: number[] = [];
  /** Moving average of Low task duration (ms), for build-time estimates. */
  lowTaskMs = 2;
  /** Low tasks announced but not queued yet (later phases of a build). */
  private reservedLow = 0;

  constructor(size: number = defaultThreads(), factory: WorkerFactory = defaultWorkerFactory()) {
    this.size = Math.max(1, size | 0);
    for (let i = 0; i < this.size; i++) {
      const w = factory();
      w.onmessage = ev => this.onReply(ev.data);
      w.onerror = ev => this.failAll(ev);
      this.workers.push(w);
      this.loaded.push(new Set());
      this.queues.push([[], [], []]);
      this.busy.push(false);
      this.lowCredit.push(0);
    }
  }

  private dispatch(w: number) {
    if (this.busy[w] || !this.workers[w]) return;
    const [high, low, lowest] = this.queues[w];
    let q: any[] | null = null;
    if (low.length && high.length && this.lowCredit[w] > 0) q = low; // fair share
    else if (high.length) q = high;
    else if (low.length) q = low;
    else if (lowest.length) q = lowest;
    if (!q) return;
    this.busy[w] = true;
    const msg = q.shift();
    const p = this.pending.get(msg.id);
    if (p) p.started = performance.now();
    this.workers[w].postMessage(msg);
  }

  /** Estimated time (ms) until all queued and announced Low tasks are done. */
  lowPendingMs(): number {
    let n = 0;
    for (const q of this.queues) n += q[Priority.Low].length;
    for (const p of this.pending.values()) if (p.priority === Priority.Low && p.started) n++;
    return ((n + this.reservedLow) / this.size) * this.lowTaskMs;
  }

  /**
   * Announce n Low tasks that will be queued later (after an earlier phase
   * finishes), so lowPendingMs() counts them. Release them when queued.
   */
  reserveLow(n: number) { this.reservedLow += n; }
  releaseLow(n: number) { this.reservedLow = Math.max(0, this.reservedLow - n); }

  private onReply(data: any) {
    const p = this.pending.get(data.id);
    if (!p) return;
    this.pending.delete(data.id);
    const ms = performance.now() - p.started;
    if (p.priority === Priority.High) {
      // Credit only accrues while background work is actually waiting.
      this.lowCredit[p.worker] = this.queues[p.worker][Priority.Low].length
        ? Math.min(this.lowCredit[p.worker] + LOW_SHARE * ms, 1000) : 0;
    } else if (p.priority === Priority.Low) {
      this.lowCredit[p.worker] = Math.max(0, this.lowCredit[p.worker] - ms);
      this.lowTaskMs = 0.8 * this.lowTaskMs + 0.2 * ms;
    }
    // Start the next task before resolving, so the worker is not idle while
    // the caller handles the result.
    this.busy[p.worker] = false;
    this.dispatch(p.worker);
    if (data.error !== undefined) p.reject(new Error(data.error));
    else p.resolve(data.result);
  }

  private failAll(ev: any) {
    const err = new Error("paraweb resident worker error: " + ((ev && ev.message) || ev));
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const q of this.queues) for (const level of q) level.length = 0;
    this.busy = this.busy.map(() => false);
  }

  /**
   * Make a shared column available on every worker. Messages to a worker are
   * delivered in order, so later requests can use the column without waiting
   * for an acknowledgement.
   */
  ensureColumn(key: string, type: ColumnType, buffer: SharedArrayBuffer) {
    for (let i = 0; i < this.size; i++) {
      if (this.loaded[i].has(key)) continue;
      this.workers[i].postMessage({ op: "column", key, type, buffer });
      this.loaded[i].add(key);
    }
  }

  hasColumn(key: string): boolean {
    return this.loaded.length > 0 && this.loaded[0].has(key);
  }

  /** Queued behind all other work, so tasks already queued can still use the columns. */
  dropColumns(keys: string[]) {
    for (let i = 0; i < this.size; i++) {
      this.run(i, { op: "drop", keys }, Priority.Lowest).catch(() => {});
      for (const k of keys) this.loaded[i].delete(k);
    }
  }

  /** Queue one request on one worker. */
  run(worker: number, msg: any, priority: PriorityLevel = Priority.High): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker, priority, started: 0 });
      this.queues[worker][priority].push({ ...msg, id });
      this.dispatch(worker);
    });
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.failAll("terminated");
  }
}
