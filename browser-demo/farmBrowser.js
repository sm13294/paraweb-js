export class FarmBrowser {
  async farm(fn, inputData, numThreads) {
    if (!Array.isArray(inputData)) {
      throw new Error("inputData must be an array");
    }
    if (inputData.length === 0) {
      return [];
    }

    const threads = Math.min(
      numThreads || (navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4),
      inputData.length
    );

    // Static chunking: each worker receives one contiguous chunk of n/p items
    // and processes them locally. Mirrors the Node.js Farm MP implementation.
    const chunkSize = Math.ceil(inputData.length / threads);
    const chunks = [];
    for (let w = 0; w < threads; w++) {
      const start = w * chunkSize;
      const end = Math.min(start + chunkSize, inputData.length);
      chunks.push({ start, items: inputData.slice(start, end) });
    }

    const workerSource = `
      self.onmessage = (event) => {
        const { fn, items, start } = event.data;
        try {
          const farmFn = new Function("value", "index", "return (" + fn + ")(value, index)");
          const out = new Array(items.length);
          for (let i = 0; i < items.length; i++) {
            out[i] = farmFn(items[i], start + i);
          }
          self.postMessage({ start, out });
        } catch (error) {
          self.postMessage({ error: true, message: String(error) });
        }
      };
    `;

    const blob = new Blob([workerSource], { type: "application/javascript" });
    const workerUrl = URL.createObjectURL(blob);

    try {
      const results = new Array(inputData.length);
      const workers = Array.from({ length: threads }, () => new Worker(workerUrl));
      const promises = workers.map((worker, i) => {
        const { start, items } = chunks[i];
        return new Promise((resolve, reject) => {
          worker.onmessage = (event) => {
            const data = event.data;
            if (data && data.error) {
              reject(new Error(data.message));
              return;
            }
            for (let k = 0; k < data.out.length; k++) {
              results[data.start + k] = data.out[k];
            }
            worker.terminate();
            resolve();
          };
          worker.onerror = reject;
          worker.postMessage({ fn: fn.toString(), items, start });
        });
      });
      await Promise.all(promises);
      return results;
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  }
}
