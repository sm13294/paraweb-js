import {
  buildRanges,
  createWorkerUrl,
  detectIdentityElement,
  ensureSharedArrayBuffer,
  initSharedFloat64,
  initSharedFloat64FromArray,
} from "./workerUtils.js";

/**
 * Inclusive prefix-scan (SharedArrayBuffer variant).
 *
 * Mirrors src/patterns/scanShared.ts: workers operate directly on shared
 * Float64Array buffers (no per-chunk copies). `op` must be an associative
 * binary operator `(a, b) => T`.
 */
export class ScanSharedBrowser {
  async scan(op, inputData, identity, numThreads, mapFn) {
    if (!Array.isArray(inputData)) {
      throw new Error("inputData must be an array");
    }
    if (inputData.length === 0) return [];

    ensureSharedArrayBuffer();

    const threads =
      numThreads || (navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4);
    const effectiveThreads = Math.min(threads, inputData.length);
    const n = inputData.length;
    const { buffer: inputBuffer } = initSharedFloat64FromArray(inputData);
    const { buffer: outputBuffer } = initSharedFloat64(n);
    const { buffer: totalsBuffer } = initSharedFloat64(effectiveThreads);
    const detectedIdentity = detectIdentityElement(op, identity);
    const ranges = buildRanges(n, effectiveThreads);
    const opStr = op.toString();

    const workerSource = `
      self.onmessage = (event) => {
        const { phase, fn, mapFnStr, inputBuffer, outputBuffer, totalsBuffer, start, end, workerId, identity, offset } = event.data;
        try {
          const applyFn = new Function("a", "b", "return (" + fn + ")(a, b)");
          const outputView = new Float64Array(outputBuffer);
          if (phase === 1) {
            const mapFn = mapFnStr ? new Function("return " + mapFnStr)() : null;
            const inputView = new Float64Array(inputBuffer);
            const totalsView = new Float64Array(totalsBuffer);
            if (start >= end) {
              totalsView[workerId] = identity;
              self.postMessage("done");
              return;
            }
            let acc = identity;
            if (mapFn) {
              for (let i = start; i < end; i++) {
                acc = applyFn(acc, mapFn(inputView[i]));
                outputView[i] = acc;
              }
            } else {
              for (let i = start; i < end; i++) {
                acc = applyFn(acc, inputView[i]);
                outputView[i] = acc;
              }
            }
            totalsView[workerId] = acc;
            self.postMessage("done");
          } else {
            for (let i = start; i < end; i++) {
              outputView[i] = applyFn(offset, outputView[i]);
            }
            self.postMessage("done");
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
          else resolve();
        };
        worker.onerror = (err) => { worker.terminate(); reject(err); };
        worker.postMessage(message);
      });
    };

    const mapFnStr = mapFn ? mapFn.toString() : null;

    try {
      // Phase 1: local scans writing into the shared output buffer.
      await Promise.all(
        ranges.map(({ start, end }, workerId) =>
          runWorker({
            phase: 1,
            fn: opStr,
            mapFnStr,
            inputBuffer,
            outputBuffer,
            totalsBuffer,
            start,
            end,
            workerId,
            identity: detectedIdentity,
          })
        )
      );

      // Main thread: per-chunk offsets from exclusive scan of totals.
      const totalsView = new Float64Array(totalsBuffer);
      const offsets = new Array(ranges.length);
      offsets[0] = identity;
      for (let k = 1; k < ranges.length; k++) {
        offsets[k] = op(offsets[k - 1], totalsView[k - 1]);
      }

      // Phase 2: reapply offsets in parallel for chunks that need it.
      const phase2 = [];
      for (let k = 0; k < ranges.length; k++) {
        if (offsets[k] !== detectedIdentity && ranges[k].start < ranges[k].end) {
          phase2.push(
            runWorker({
              phase: 2,
              fn: opStr,
              outputBuffer,
              start: ranges[k].start,
              end: ranges[k].end,
              offset: offsets[k],
            })
          );
        }
      }
      if (phase2.length > 0) await Promise.all(phase2);

      const outputView = new Float64Array(outputBuffer);
      return Array.from(outputView);
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  }
}
