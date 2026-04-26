import {
  buildRanges,
  createWorkerUrl,
  ensureSharedArrayBuffer,
  initSharedFloat64,
  initSharedFloat64FromArray,
  initSharedInt32,
  initSharedUint8,
} from "./workerUtils.js";

export class FilterSharedBrowser {
  async filter(fn, inputData, numThreads) {
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
    const { buffer: flagsBuffer } = initSharedUint8(length);
    const { buffer: countsBuffer } = initSharedInt32(threads);
    const ranges = buildRanges(length, threads);

    const workerSource = `
      self.onmessage = (event) => {
        const {
          phase,
          fn,
          inputBuffer,
          flagsBuffer,
          countsBuffer,
          outputBuffer,
          start,
          end,
          workerId,
          offset,
        } = event.data;
        try {
          const inputView = new Float64Array(inputBuffer);
          const flagsView = new Uint8Array(flagsBuffer);
          const predicate = new Function("value", "index", "return (" + fn + ")(value, index)");
          if (phase === "count") {
            const countsView = new Int32Array(countsBuffer);
            let count = 0;
            for (let i = start; i < end; i++) {
              const keep = !!predicate(inputView[i], i);
              flagsView[i] = keep ? 1 : 0;
              if (keep) count++;
            }
            countsView[workerId] = count;
            self.postMessage("done");
          } else if (phase === "write") {
            const outputView = new Float64Array(outputBuffer);
            let writeIndex = offset;
            for (let i = start; i < end; i++) {
              if (flagsView[i] === 1) {
                outputView[writeIndex++] = inputView[i];
              }
            }
            self.postMessage("done");
          }
        } catch (error) {
          self.postMessage({ error: true, message: String(error) });
        }
      };
    `;

    const workerUrl = createWorkerUrl(workerSource);

    const runPhase = async (phase, outputBuffer, offsets) => {
      const workers = Array.from({ length: threads }, () => new Worker(workerUrl));
      const promises = workers.map((worker, i) => {
        const { start, end } = ranges[i];
        const payload =
          phase === "count"
            ? {
                phase,
                fn: fn.toString(),
                inputBuffer,
                flagsBuffer,
                countsBuffer,
                start,
                end,
                workerId: i,
              }
            : {
                phase,
                fn: fn.toString(),
                inputBuffer,
                flagsBuffer,
                outputBuffer,
                start,
                end,
                offset: offsets[i],
              };
        worker.postMessage(payload);
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
    };

    try {
      await runPhase("count");

      const countsView = new Int32Array(countsBuffer);
      const offsets = [];
      let total = 0;
      for (let i = 0; i < threads; i++) {
        offsets[i] = total;
        total += countsView[i];
      }

      if (total === 0) {
        return [];
      }

      const { buffer: outputBuffer } = initSharedFloat64(total);
      await runPhase("write", outputBuffer, offsets);
      return Array.from(new Float64Array(outputBuffer));
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  }
}
