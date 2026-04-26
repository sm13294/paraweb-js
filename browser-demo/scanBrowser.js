import { buildChunks, createWorkerUrl, detectIdentityElement } from "./workerUtils.js";

/**
 * Inclusive prefix-scan (Web Worker variant).
 *
 * Two-pass algorithm mirrors src/patterns/scan.ts:
 *   Phase 1: each worker computes a local inclusive scan of its chunk and
 *            returns { scanned, total }.
 *   Main:    compute an exclusive scan of chunk totals on the main thread.
 *   Phase 2: chunks with a non-identity offset reapply the offset to every
 *            element of their local scan.
 *
 * `op` must be an associative binary operator `(a, b) => T`. Non-associative
 * folds produce incorrect results once per-chunk offsets are applied.
 */
export class ScanBrowser {
  async scan(op, inputData, identity, numThreads, mapFn) {
    if (!Array.isArray(inputData)) {
      throw new Error("inputData must be an array");
    }
    if (inputData.length === 0) return [];

    const threads =
      numThreads || (navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4);
    const effectiveThreads = Math.min(threads, inputData.length);
    const chunks = buildChunks(inputData, effectiveThreads);
    const detectedIdentity = detectIdentityElement(op, identity);
    const opStr = op.toString();

    const workerSource = `
      self.onmessage = (event) => {
        const { phase, fn, mapFnStr, chunk, identity, offset } = event.data;
        try {
          const applyFn = new Function("a", "b", "return (" + fn + ")(a, b)");
          if (phase === 1) {
            const mapFn = mapFnStr ? new Function("return " + mapFnStr)() : null;
            const scanned = new Array(chunk.length);
            let acc = identity;
            if (mapFn) {
              for (let i = 0; i < chunk.length; i++) {
                acc = applyFn(acc, mapFn(chunk[i]));
                scanned[i] = acc;
              }
            } else {
              for (let i = 0; i < chunk.length; i++) {
                acc = applyFn(acc, chunk[i]);
                scanned[i] = acc;
              }
            }
            self.postMessage({ scanned, total: acc });
          } else {
            const scanned = new Array(chunk.length);
            for (let i = 0; i < chunk.length; i++) {
              scanned[i] = applyFn(offset, chunk[i]);
            }
            self.postMessage({ scanned });
          }
        } catch (error) {
          self.postMessage({ error: true, message: String(error) });
        }
      };
    `;
    const workerUrl = createWorkerUrl(workerSource);

    const runWorker = (message) => {
      return new Promise((resolve, reject) => {
        const worker = new Worker(workerUrl);
        worker.onmessage = (event) => {
          const data = event.data;
          worker.terminate();
          if (data && data.error) reject(new Error(data.message));
          else resolve(data);
        };
        worker.onerror = (err) => { worker.terminate(); reject(err); };
        worker.postMessage(message);
      });
    };

    const mapFnStr = mapFn ? mapFn.toString() : null;

    try {
      // Phase 1: local scans in parallel (with optional per-element transform).
      const phase1 = await Promise.all(
        chunks.map((chunk) =>
          runWorker({ phase: 1, fn: opStr, mapFnStr, chunk, identity: detectedIdentity })
        )
      );

      // Main thread: compute per-chunk offsets via exclusive scan of totals.
      const offsets = new Array(chunks.length);
      offsets[0] = identity;
      for (let k = 1; k < chunks.length; k++) {
        offsets[k] = op(offsets[k - 1], phase1[k - 1].total);
      }

      // Phase 2: reapply offset for chunks where it is not the identity.
      const phase2 = await Promise.all(
        chunks.map((_, k) => {
          if (offsets[k] === detectedIdentity) {
            return Promise.resolve({ scanned: phase1[k].scanned });
          }
          return runWorker({
            phase: 2,
            fn: opStr,
            chunk: phase1[k].scanned,
            offset: offsets[k],
          });
        })
      );

      const output = [];
      for (const r of phase2) {
        for (const v of r.scanned) output.push(v);
      }
      return output;
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  }
}
