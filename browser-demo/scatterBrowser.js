import { buildChunks, createWorkerUrl } from "./workerUtils.js";

export class ScatterBrowser {
  async scatter(inputData, indexData, defaultValue, conflictFn, numThreads, mapFn) {
    if (!Array.isArray(inputData) || !Array.isArray(indexData)) {
      throw new Error("inputData and indexData must be arrays");
    }
    if (inputData.length !== indexData.length) {
      throw new Error("inputData and indexData must have the same length");
    }
    if (inputData.length === 0) {
      return [];
    }

    let maxIndex = -1;
    for (const index of indexData) {
      if (!Number.isInteger(index) || index < 0) {
        throw new Error("indexData must contain non-negative integers");
      }
      if (index > maxIndex) maxIndex = index;
    }

    const outputLength = maxIndex + 1;
    const output = new Array(outputLength).fill(defaultValue);
    const assigned = new Array(outputLength).fill(false);

    const threads =
      numThreads || (navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4);
    const inputChunks = buildChunks(inputData, threads);
    const indexChunks = buildChunks(indexData, threads);

    const workerSource = `
      self.onmessage = (event) => {
        const { inputData, indexData, fnStr } = event.data;
        try {
          const fn = fnStr ? new Function("return " + fnStr)() : null;
          const result = fn
            ? inputData.map((value, i) => [indexData[i], fn(value)])
            : inputData.map((value, i) => [indexData[i], value]);
          self.postMessage(result);
        } catch (error) {
          self.postMessage({ error: true, message: String(error) });
        }
      };
    `;
    const workerUrl = createWorkerUrl(workerSource);
    const fnStr = mapFn ? mapFn.toString() : null;

    try {
      const workers = Array.from({ length: threads }, () => new Worker(workerUrl));
      const promises = workers.map((worker, i) => {
        worker.postMessage({ inputData: inputChunks[i], indexData: indexChunks[i], fnStr });
        return new Promise((resolve, reject) => {
          worker.onmessage = (event) => {
            const data = event.data;
            if (data && data.error) {
              reject(new Error(data.message));
            } else {
              resolve(data);
            }
          };
          worker.onerror = reject;
        }).finally(() => {
          worker.terminate();
        });
      });

      const pairs = (await Promise.all(promises)).flat();
      for (const pair of pairs) {
        const index = pair[0];
        const value = pair[1];
        if (assigned[index]) {
          output[index] = conflictFn ? conflictFn(output[index], value) : value;
        } else {
          output[index] = value;
          assigned[index] = true;
        }
      }
      return output;
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  }
}
