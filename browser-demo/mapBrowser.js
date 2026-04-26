import { buildChunks, createWorkerUrl } from "./workerUtils.js";

export class MapBrowser {
  async map(fn, inputData, numThreads) {
    if (!Array.isArray(inputData)) {
      throw new Error("inputData must be an array");
    }
    if (inputData.length === 0) {
      return [];
    }

    const threads =
      numThreads || (navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4);
    const chunks = buildChunks(inputData, threads);

    const workerSource = `
      self.onmessage = (event) => {
        const { fn, inputData } = event.data;
        try {
          const mapFn = new Function("return " + fn)();
          const result = inputData.map(mapFn);
          self.postMessage(result);
        } catch (error) {
          self.postMessage({ error: true, message: String(error) });
        }
      };
    `;

    const workerUrl = createWorkerUrl(workerSource);

    try {
      const workers = Array.from({ length: threads }, () => new Worker(workerUrl));
      const promises = workers.map((worker, i) => {
        worker.postMessage({ fn: fn.toString(), inputData: chunks[i] });
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

      const results = await Promise.all(promises);
      return results.flat();
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  }
}
