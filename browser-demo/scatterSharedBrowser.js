import {
  buildRanges,
  createWorkerUrl,
  ensureSharedArrayBuffer,
  initSharedFloat64,
  initSharedFloat64FromArray,
  initSharedInt32,
  initSharedInt32FromArray,
} from "./workerUtils.js";
import { ScatterBrowser } from "./scatterBrowser.js";

export class ScatterSharedBrowser {
  async scatter(inputData, indexData, defaultValue, conflictFn, numThreads, mapFn) {
    // conflictFn requires cross-worker atomic combine on Float64 (no native op);
    // we fall back to MP only when conflictFn is supplied. mapFn is applied
    // inside the shared worker before the atomic write.
    if (conflictFn) {
      const fallback = new ScatterBrowser();
      return fallback.scatter(inputData, indexData, defaultValue, conflictFn, numThreads, mapFn);
    }

    if (!Array.isArray(inputData) || !Array.isArray(indexData)) {
      throw new Error("inputData and indexData must be arrays");
    }
    if (inputData.length !== indexData.length) {
      throw new Error("inputData and indexData must have the same length");
    }
    if (inputData.length === 0) {
      return [];
    }

    ensureSharedArrayBuffer();

    let maxIndex = -1;
    for (const index of indexData) {
      if (!Number.isInteger(index) || index < 0) {
        throw new Error("indexData must contain non-negative integers");
      }
      if (index > maxIndex) {
        maxIndex = index;
      }
    }

    const outputLength = maxIndex + 1;
    if (outputLength === 0) {
      return [];
    }

    const threads =
      numThreads || (navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4);
    const length = inputData.length;
    const { buffer: inputBuffer } = initSharedFloat64FromArray(inputData);
    const { buffer: indexBuffer } = initSharedInt32FromArray(indexData);
    const { buffer: outputBuffer, view: outputView } = initSharedFloat64(
      outputLength,
      defaultValue
    );
    const { buffer: lastIndexBuffer } = initSharedInt32(outputLength, -1);
    const ranges = buildRanges(length, threads);

    const workerSource = `
      self.onmessage = (event) => {
        const { inputBuffer, indexBuffer, outputBuffer, lastIndexBuffer, start, end, mapFnStr } = event.data;
        try {
          const inputView = new Float64Array(inputBuffer);
          const indexView = new Int32Array(indexBuffer);
          const outputView = new Float64Array(outputBuffer);
          const lastIndexView = new Int32Array(lastIndexBuffer);
          const mapFn = mapFnStr ? new Function("return " + mapFnStr)() : null;
          for (let i = start; i < end; i++) {
            const outIndex = indexView[i];
            if (outIndex < 0) continue;
            const v = mapFn ? mapFn(inputView[i]) : inputView[i];
            while (true) {
              const current = Atomics.load(lastIndexView, outIndex);
              if (i <= current) break;
              const prev = Atomics.compareExchange(lastIndexView, outIndex, current, i);
              if (prev === current) {
                outputView[outIndex] = v;
                break;
              }
            }
          }
          self.postMessage("done");
        } catch (error) {
          self.postMessage({ error: true, message: String(error) });
        }
      };
    `;

    const workerUrl = createWorkerUrl(workerSource);
    const mapFnStr = mapFn ? mapFn.toString() : null;

    try {
      const workers = Array.from({ length: threads }, () => new Worker(workerUrl));
      const promises = workers.map((worker, i) => {
        const { start, end } = ranges[i];
        worker.postMessage({
          inputBuffer,
          indexBuffer,
          outputBuffer,
          lastIndexBuffer,
          start,
          end,
          mapFnStr,
        });
        return new Promise((resolve, reject) => {
          worker.onmessage = (event) => {
            const data = event.data;
            if (data && data.error) {
              reject(new Error(data.message));
            } else {
              resolve();
            }
          };
          worker.onerror = reject;
        }).finally(() => {
          worker.terminate();
        });
      });

      await Promise.all(promises);
      return Array.from(outputView);
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  }
}
