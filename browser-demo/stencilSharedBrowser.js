import {
  buildRanges,
  createWorkerUrl,
  ensureSharedArrayBuffer,
  initSharedFloat64,
  initSharedFloat64FromArray,
} from "./workerUtils.js";

export class StencilSharedBrowser {
  async stencil(fn, inputData, stencil, numThreads, edgeOption) {
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
      const makeStencilOdd = (stencil) => {
        if (stencil.length % 2 !== 0) {
          return stencil;
        }
        const midpoint = Math.floor(stencil.length / 2);
        return [
          ...stencil.slice(0, midpoint),
          null,
          ...stencil.slice(midpoint),
        ];
      };

      const edgeValue = (edgeOption) => {
        if (!edgeOption) return null;
        switch (edgeOption.type) {
          case "zero":
            return 0;
          case "padding":
            return edgeOption.value;
          case "custom":
            return edgeOption.customFn ? edgeOption.customFn() : null;
          default:
            return null;
        }
      };

      self.onmessage = (event) => {
        const {
          fn,
          inputBuffer,
          outputBuffer,
          stencil,
          edgeOption,
          start,
          end,
          length,
        } = event.data;
        try {
          const stencilFn = new Function("return " + fn)();
          const inputView = new Float64Array(inputBuffer);
          const outputView = new Float64Array(outputBuffer);
          const stencilOdd = makeStencilOdd(stencil);
          const stencilSize = stencilOdd.length;
          const stencilHalf = Math.floor(stencilSize / 2);

          for (let i = start; i < end; i++) {
            const neighbors = [];
            for (let offset = -stencilHalf; offset <= stencilHalf; offset++) {
              const idx = i + offset;
              if (idx < 0 || idx >= length) {
                neighbors.push(edgeValue(edgeOption));
              } else {
                neighbors.push(inputView[idx]);
              }
            }
            outputView[i] = stencilFn(inputView[i], neighbors, stencilOdd);
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
          stencil,
          edgeOption,
          start,
          end,
          length,
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
