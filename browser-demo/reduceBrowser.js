import { buildChunks, createWorkerUrl } from "./workerUtils.js";

const detectIdentityElement = (fn, initialValue) => {
  try {
    const testValue = 5;
    const resultWith0 = fn(0, testValue);
    if (resultWith0 === testValue && typeof resultWith0 === "number") {
      return 0;
    }
    const resultWith1 = fn(1, testValue);
    if (resultWith1 === testValue && typeof resultWith1 === "number") {
      return 1;
    }
  } catch (e) {
    // Ignore and fall back to initialValue
  }
  if (initialValue === 1) {
    return 1;
  }
  return 0;
};

export class ReduceBrowser {
  async reduce(fn, inputData, initialValue, numThreads, mapFn) {
    if (!Array.isArray(inputData)) {
      throw new Error("inputData must be an array");
    }
    if (inputData.length === 0) {
      return initialValue;
    }

    const threads =
      numThreads || (navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4);
    const chunks = buildChunks(inputData, threads);
    const identityElement = detectIdentityElement(fn, initialValue);

    const workerSource = `
      self.onmessage = (event) => {
        const { fn, mapFnStr, inputData, identityElement } = event.data;
        try {
          if (!inputData || inputData.length === 0) {
            self.postMessage(null);
            return;
          }
          const reduceFn = new Function("acc", "curr", "return (" + fn + ")(acc, curr)");
          const mapFn = mapFnStr ? new Function("return " + mapFnStr)() : null;
          let result = identityElement;
          if (mapFn) {
            for (let i = 0; i < inputData.length; i++) {
              result = reduceFn(result, mapFn(inputData[i]));
            }
          } else {
            for (let i = 0; i < inputData.length; i++) {
              result = reduceFn(result, inputData[i]);
            }
          }
          self.postMessage(result);
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
        worker.postMessage({
          fn: fn.toString(),
          mapFnStr,
          inputData: chunks[i],
          identityElement,
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

      const partials = (await Promise.all(promises)).filter((v) => v !== null);
      if (partials.length === 0) {
        return initialValue;
      }

      let combined = identityElement === 1 ? 1 : 0;
      for (const value of partials) {
        combined = fn(combined, value);
      }

      if (identityElement === 1 && initialValue === 1) {
        return combined;
      }
      if (identityElement === 0 && initialValue === 0) {
        return combined;
      }
      return identityElement === 1 ? initialValue * combined : initialValue + combined;
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  }
}
