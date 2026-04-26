import {
  buildRanges,
  createWorkerUrl,
  ensureSharedArrayBuffer,
  initSharedFloat64,
  initSharedFloat64FromArray,
} from "./workerUtils.js";

export class MapSharedBrowser {
  async map(fn, inputData, numThreads) {
    if (!Array.isArray(inputData)) {
      throw new Error("inputData must be an array");
    }
    if (inputData.length === 0) {
      return [];
    }

    ensureSharedArrayBuffer();

    const threads =
      numThreads || (navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4);
    const length = inputData.length;
    const { buffer: inputBuffer } = initSharedFloat64FromArray(inputData);
    const { buffer: outputBuffer } = initSharedFloat64(length);
    const ranges = buildRanges(length, threads);

    const workerSource = `
      self.onmessage = (event) => {
        const { fn, inputBuffer, outputBuffer, start, end } = event.data;
        try {
          const mapFn = new Function("value", "index", "return (" + fn + ")(value, index)");
          const inputView = new Float64Array(inputBuffer);
          const outputView = new Float64Array(outputBuffer);
          for (let i = start; i < end; i++) {
            outputView[i] = mapFn(inputView[i], i);
          }
          self.postMessage("done");
        } catch (error) {
          self.postMessage({ error: true, message: String(error) });
        }
      };
    `;

    const workerUrl = createWorkerUrl(workerSource);

    try {
      const workers = Array.from({ length: threads }, () => new Worker(workerUrl));
      const promises = workers.map((worker, i) => {
        const { start, end } = ranges[i];
        worker.postMessage({
          fn: fn.toString(),
          inputBuffer,
          outputBuffer,
          start,
          end,
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
      return Array.from(new Float64Array(outputBuffer));
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  }
}
