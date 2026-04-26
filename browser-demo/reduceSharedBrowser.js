import {
  buildRanges,
  createWorkerUrl,
  detectIdentityElement,
  ensureSharedArrayBuffer,
  initSharedFloat64,
  initSharedFloat64FromArray,
  initSharedUint8,
} from "./workerUtils.js";

export class ReduceSharedBrowser {
  async reduce(fn, inputData, initialValue, numThreads, mapFn) {
    if (!Array.isArray(inputData)) {
      throw new Error("inputData must be an array");
    }
    if (inputData.length === 0) {
      return initialValue;
    }

    ensureSharedArrayBuffer();

    const threads =
      numThreads || (navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4);
    const length = inputData.length;
    const { buffer: inputBuffer } = initSharedFloat64FromArray(inputData);
    const { buffer: partialsBuffer } = initSharedFloat64(threads);
    const { buffer: validBuffer } = initSharedUint8(threads);
    const identityElement = detectIdentityElement(fn, initialValue);
    const ranges = buildRanges(length, threads);

    const workerSource = `
      self.onmessage = (event) => {
        const {
          fn,
          mapFnStr,
          inputBuffer,
          partialsBuffer,
          validBuffer,
          start,
          end,
          workerId,
          identityElement,
        } = event.data;
        try {
          const inputView = new Float64Array(inputBuffer);
          const partialsView = new Float64Array(partialsBuffer);
          const validView = new Uint8Array(validBuffer);
          const reduceFn = new Function("acc", "curr", "return (" + fn + ")(acc, curr)");
          const mapFn = mapFnStr ? new Function("return " + mapFnStr)() : null;
          if (start >= end) {
            validView[workerId] = 0;
            self.postMessage("done");
            return;
          }
          let acc = identityElement;
          if (mapFn) {
            for (let i = start; i < end; i++) {
              acc = reduceFn(acc, mapFn(inputView[i]));
            }
          } else {
            for (let i = start; i < end; i++) {
              acc = reduceFn(acc, inputView[i]);
            }
          }
          partialsView[workerId] = acc;
          validView[workerId] = 1;
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
          fn: fn.toString(),
          mapFnStr,
          inputBuffer,
          partialsBuffer,
          validBuffer,
          start,
          end,
          workerId: i,
          identityElement,
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

      const partialsView = new Float64Array(partialsBuffer);
      const validView = new Uint8Array(validBuffer);
      const validResults = [];
      for (let i = 0; i < threads; i++) {
        if (validView[i] === 1) {
          validResults.push(partialsView[i]);
        }
      }

      if (validResults.length === 0) {
        return initialValue;
      }

      let combinedResult;
      if (identityElement === 1) {
        combinedResult = validResults.reduce((acc, val) => acc * val, 1);
      } else {
        combinedResult = validResults.reduce((acc, val) => acc + val, 0);
      }

      if (identityElement === 1 && initialValue === 1) {
        return combinedResult;
      }
      if (identityElement === 0 && initialValue === 0) {
        return combinedResult;
      }
      return identityElement === 1
        ? initialValue * combinedResult
        : initialValue + combinedResult;
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  }
}
