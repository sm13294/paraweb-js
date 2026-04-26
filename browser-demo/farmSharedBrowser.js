import {
  createWorkerUrl,
  ensureSharedArrayBuffer,
  initSharedFloat64,
  initSharedFloat64FromArray,
  initSharedInt32,
} from "./workerUtils.js";

export class FarmSharedBrowser {
  async farm(fn, inputData, numThreads) {
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
    const { buffer: counterBuffer, view: counterView } = initSharedInt32(1);
    counterView[0] = 0;

    const batchSize = Math.max(1, Math.ceil(length / threads));

    const workerSource = `
      self.onmessage = (event) => {
        const { fn, inputBuffer, outputBuffer, counterBuffer, length, batchSize } = event.data;
        try {
          const inputView = new Float64Array(inputBuffer);
          const outputView = new Float64Array(outputBuffer);
          const counterView = new Int32Array(counterBuffer);
          const farmFn = new Function("value", "index", "return (" + fn + ")(value, index)");
          while (true) {
            const start = Atomics.add(counterView, 0, batchSize);
            if (start >= length) break;
            const end = start + batchSize > length ? length : start + batchSize;
            for (let i = start; i < end; i++) {
              outputView[i] = farmFn(inputView[i], i);
            }
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
      const promises = workers.map((worker) => {
        worker.postMessage({
          fn: fn.toString(),
          inputBuffer,
          outputBuffer,
          counterBuffer,
          length,
          batchSize,
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
