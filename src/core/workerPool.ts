import { Worker } from "node:worker_threads";

interface PooledWorker {
  worker: Worker;
  busy: boolean;
}

interface WorkerTask {
  message: any;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

/**
 * WorkerPool manages a pool of reusable worker threads to avoid the overhead
 * of creating and destroying workers on every parallel operation call.
 *
 * Workers are lazily created and reused across calls. The pool can be
 * explicitly destroyed when no longer needed.
 */
class WorkerPool {
  private static pools: Map<string, WorkerPool> = new Map();

  private workers: PooledWorker[] = [];
  private taskQueue: WorkerTask[] = [];
  private workerScript: string;
  private maxWorkers: number;
  private destroyed: boolean = false;

  constructor(workerScript: string, maxWorkers: number) {
    this.workerScript = workerScript;
    this.maxWorkers = maxWorkers;
  }

  /**
   * Get or create a shared pool for a given worker script and max size.
   */
  static getPool(workerScript: string, maxWorkers: number): WorkerPool {
    const key = `${workerScript}:${maxWorkers}`;
    let pool = WorkerPool.pools.get(key);
    if (!pool || pool.destroyed) {
      pool = new WorkerPool(workerScript, maxWorkers);
      WorkerPool.pools.set(key, pool);
    }
    return pool;
  }

  /**
   * Destroy all shared pools. Call during cleanup/shutdown.
   */
  static destroyAll(): void {
    for (const pool of WorkerPool.pools.values()) {
      pool.destroy();
    }
    WorkerPool.pools.clear();
  }

  private createWorker(): PooledWorker {
    const worker = new Worker(this.workerScript);
    // unref so pooled workers don't prevent process exit
    worker.unref();
    const pooled: PooledWorker = { worker, busy: false };

    worker.on("error", (err) => {
      console.error(`Worker error in pool (${this.workerScript}):`, err);
      // Remove broken worker from pool and create replacement if needed
      const idx = this.workers.indexOf(pooled);
      if (idx !== -1) {
        this.workers.splice(idx, 1);
      }
    });

    this.workers.push(pooled);
    return pooled;
  }

  private getAvailableWorker(): PooledWorker | null {
    for (const pw of this.workers) {
      if (!pw.busy) {
        return pw;
      }
    }
    if (this.workers.length < this.maxWorkers) {
      return this.createWorker();
    }
    return null;
  }

  /**
   * Execute a task on a pooled worker. Sends message, waits for response.
   * Returns the worker's response message.
   */
  exec(message: any): Promise<any> {
    if (this.destroyed) {
      return Promise.reject(new Error("WorkerPool has been destroyed"));
    }

    return new Promise((resolve, reject) => {
      const available = this.getAvailableWorker();
      if (available) {
        this.runTask(available, message, resolve, reject);
      } else {
        // Queue the task for later execution
        this.taskQueue.push({ message, resolve, reject });
      }
    });
  }

  /**
   * Execute N tasks in parallel using up to N workers from the pool.
   * Returns an array of results in the same order as messages.
   */
  async execAll(messages: any[]): Promise<any[]> {
    if (this.destroyed) {
      throw new Error("WorkerPool has been destroyed");
    }
    return Promise.all(messages.map((msg) => this.exec(msg)));
  }

  private runTask(
    pooledWorker: PooledWorker,
    message: any,
    resolve: (value: any) => void,
    reject: (reason: any) => void
  ): void {
    pooledWorker.busy = true;
    const { worker } = pooledWorker;

    const cleanup = () => {
      worker.removeListener("message", onMessage);
      worker.removeListener("error", onError);
      pooledWorker.busy = false;
      this.processQueue();
    };

    const onMessage = (result: any) => {
      cleanup();
      if (result === "error") {
        reject(new Error("Worker reported an error"));
      } else {
        resolve(result);
      }
    };

    const onError = (err: Error) => {
      cleanup();
      // Remove broken worker and replace
      const idx = this.workers.indexOf(pooledWorker);
      if (idx !== -1) {
        this.workers.splice(idx, 1);
      }
      reject(err);
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.postMessage(message);
  }

  private processQueue(): void {
    while (this.taskQueue.length > 0) {
      const available = this.getAvailableWorker();
      if (!available) break;
      const task = this.taskQueue.shift()!;
      this.runTask(available, task.message, task.resolve, task.reject);
    }
  }

  /**
   * Destroy the pool and terminate all workers.
   */
  destroy(): void {
    this.destroyed = true;
    for (const pw of this.workers) {
      pw.worker.removeAllListeners();
      pw.worker.terminate();
    }
    this.workers = [];
    // Reject any pending tasks
    for (const task of this.taskQueue) {
      task.reject(new Error("WorkerPool destroyed"));
    }
    this.taskQueue = [];
  }
}

export { WorkerPool };
