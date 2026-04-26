import { buildRanges, createWorkerUrl } from "./workerUtils.js";

export class StencilBrowser {
  async stencil(fn, inputData, stencil, numThreads, edgeOption) {
    if (!Array.isArray(inputData)) {
      throw new Error("inputData must be an array");
    }
    if (inputData.length === 0) {
      return [];
    }

    const threads =
      numThreads || (navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4);
    const ranges = buildRanges(inputData.length, threads);
    const chunkSize = Math.ceil(inputData.length / threads);
    const stencilHalf = Math.floor(stencil.length / 2);
    const chunks = ranges.map((range, i) => {
      const start = Math.max(0, i * chunkSize - stencilHalf);
      const end = Math.min(inputData.length, (i + 1) * chunkSize + stencilHalf);
      return inputData.slice(start, end);
    });

    const workerSource = `
      const makeStencilOdd = (stencil) => {
        if (stencil.length % 2 !== 0) return stencil;
        const midpoint = Math.floor(stencil.length / 2);
        return [
          ...stencil.slice(0, midpoint),
          null,
          ...stencil.slice(midpoint),
        ];
      };

      self.onmessage = (event) => {
        const { fn, inputData, stencil, edgeOption } = event.data;
        try {
          const stencilFn = new Function("return " + fn)();
          const stencilOdd = makeStencilOdd(stencil);
          const stencilHalf = Math.floor(stencilOdd.length / 2);
          const output = [];
          for (let i = 0; i < inputData.length; i++) {
            let start = Math.max(0, i - stencilHalf);
            let end = Math.min(inputData.length, i + stencilHalf + 1);
            let neighbors = inputData.slice(start, end);
            while (neighbors.length < stencilOdd.length) {
              if (edgeOption) {
                switch (edgeOption.type) {
                  case "zero":
                    if (i < stencilHalf) neighbors.unshift(0);
                    else neighbors.push(0);
                    break;
                  case "padding":
                    if (i < stencilHalf) neighbors.unshift(edgeOption.value);
                    else neighbors.push(edgeOption.value);
                    break;
                  case "custom":
                    if (i < stencilHalf) neighbors.unshift(edgeOption.customFn());
                    else neighbors.push(edgeOption.customFn());
                    break;
                }
              } else {
                if (i < stencilHalf) neighbors.unshift(null);
                else neighbors.push(null);
              }
            }
            output.push(stencilFn(inputData[i], neighbors, stencilOdd));
          }
          self.postMessage(output);
        } catch (error) {
          self.postMessage({ error: true, message: String(error) });
        }
      };
    `;

    const workerUrl = createWorkerUrl(workerSource);

    try {
      const workers = Array.from({ length: threads }, () => new Worker(workerUrl));
      const promises = workers.map((worker, i) => {
        worker.postMessage({
          fn: fn.toString(),
          inputData: chunks[i],
          stencil,
          edgeOption,
        });
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

      const partialResults = await Promise.all(promises);
      let output = [];
      partialResults.forEach((partial, i) => {
        const chunkStartInInput = i * chunkSize;
        const chunkEndInInput = Math.min((i + 1) * chunkSize, inputData.length);
        const chunkDataStartInInput = Math.max(0, chunkStartInInput - stencilHalf);
        const skipAtStart = chunkStartInInput - chunkDataStartInInput;
        const takeCount = chunkEndInInput - chunkStartInInput;
        const endIndex = Math.min(skipAtStart + takeCount, partial.length);
        const validResults = partial.slice(skipAtStart, endIndex);
        output = output.concat(validResults);
      });
      return output;
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  }
}
