import { createWorkerUrl } from "./workerUtils.js";

// FFT helpers shared with the Shared variant.
export function _fftBitReverse(x, bits) {
  let r = 0;
  for (let i = 0; i < bits; i++) { r = (r << 1) | (x & 1); x >>>= 1; }
  return r >>> 0;
}
export function _fftBitReversePermute(data) {
  const N = data.length / 2;
  const bits = Math.log2(N) | 0;
  for (let i = 0; i < N; i++) {
    const j = _fftBitReverse(i, bits);
    if (j > i) {
      const ar = data[2 * i], ai = data[2 * i + 1];
      data[2 * i]     = data[2 * j];     data[2 * i + 1] = data[2 * j + 1];
      data[2 * j]     = ar;               data[2 * j + 1] = ai;
    }
  }
}
export function _isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }

// Run FFT stages [fromStage, toStage] in-place on the main thread. Used for
// global stages whose butterflies cross worker chunk boundaries.
function _fftStagesInPlace(data, N, fromStage, toStage) {
  for (let s = fromStage; s <= toStage; s++) {
    const m = 1 << s, half = m >> 1, angleStep = -2 * Math.PI / m;
    for (let k = 0; k < N; k += m) {
      for (let j = 0; j < half; j++) {
        const wRe = Math.cos(angleStep * j), wIm = Math.sin(angleStep * j);
        const oRe = data[2 * (k + j + half)], oIm = data[2 * (k + j + half) + 1];
        const tRe = wRe * oRe - wIm * oIm, tIm = wRe * oIm + wIm * oRe;
        const eRe = data[2 * (k + j)],       eIm = data[2 * (k + j) + 1];
        data[2 * (k + j + half)]     = eRe - tRe;
        data[2 * (k + j + half) + 1] = eIm - tIm;
        data[2 * (k + j)]            = eRe + tRe;
        data[2 * (k + j) + 1]        = eIm + tIm;
      }
    }
  }
}

export class DivideAndConquerBrowser {
  async divideAndConquer(divideFn, conquerFn, baseCaseFn, inputData, numThreads) {
    const subproblems = divideFn(inputData);
    if (!Array.isArray(subproblems) || subproblems.length === 0) {
      return inputData;
    }

    const threads =
      numThreads || (navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4);
    const workerCount = Math.min(threads, subproblems.length);

    const workerSource = `
      const solveRecursive = (divideFn, conquerFn, baseCaseFn, inputData) => {
        if (baseCaseFn(inputData)) {
          return inputData;
        }
        const subproblems = divideFn(inputData);
        if (!Array.isArray(subproblems) || subproblems.length === 0) {
          return inputData;
        }
        if (subproblems.length === 1) {
          return solveRecursive(divideFn, conquerFn, baseCaseFn, subproblems[0]);
        }
        const subResults = subproblems.map((subproblem) =>
          solveRecursive(divideFn, conquerFn, baseCaseFn, subproblem)
        );
        return conquerFn(subResults);
      };

      self.onmessage = (event) => {
        const { divideFn, conquerFn, baseCaseFn, tasks } = event.data;
        try {
          const divide = new Function("return " + divideFn)();
          const conquer = new Function("return " + conquerFn)();
          const baseCase = new Function("return " + baseCaseFn)();
          const results = tasks.map((task) => ({
            index: task.index,
            result: solveRecursive(divide, conquer, baseCase, task.data),
          }));
          self.postMessage(results);
        } catch (error) {
          self.postMessage({ error: true, message: String(error) });
        }
      };
    `;

    const workerUrl = createWorkerUrl(workerSource);
    const tasksByWorker = Array.from({ length: workerCount }, () => []);
    subproblems.forEach((subproblem, index) => {
      tasksByWorker[index % workerCount].push({ index, data: subproblem });
    });

    try {
      const workers = Array.from({ length: workerCount }, () => new Worker(workerUrl));
      const promises = workers.map((worker, i) => {
        worker.postMessage({
          divideFn: divideFn.toString(),
          conquerFn: conquerFn.toString(),
          baseCaseFn: baseCaseFn.toString(),
          tasks: tasksByWorker[i],
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

      const groupedResults = await Promise.all(promises);
      const results = new Array(subproblems.length);
      groupedResults.flat().forEach((entry) => {
        results[entry.index] = entry.result;
      });
      return conquerFn(results);
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  }

  /**
   * Parallel Cooley-Tukey radix-2 FFT (MP variant). Each worker FFTs its chunk
   * (local stages with butterfly span <= chunk length); the main thread runs
   * the remaining log2(p) global stages after merging the chunks.
   */
  async fft(complexData, numThreads) {
    const N = (complexData.length / 2) | 0;
    if (N <= 1) return Float64Array.from(complexData);
    if (!_isPow2(N)) throw new Error(`fft: N must be power of two, got ${N}`);

    const data = new Float64Array(2 * N);
    if (complexData instanceof Float64Array) data.set(complexData);
    else for (let i = 0; i < 2 * N; i++) data[i] = complexData[i];
    _fftBitReversePermute(data);

    const bits = Math.log2(N) | 0;
    const requested = numThreads || (navigator.hardwareConcurrency || 4);
    let p = Math.max(1, Math.min(requested, N >> 1));
    while (!_isPow2(p)) p--;
    const chunkN = N / p;
    const localBits = Math.log2(chunkN) | 0;

    if (p > 1) {
      const workerSource = `
        self.onmessage = (event) => {
          try {
            const { chunk, chunkN } = event.data;
            const data = chunk;
            const bits = Math.log2(chunkN) | 0;
            for (let s = 1; s <= bits; s++) {
              const m = 1 << s, half = m >> 1, angleStep = -2 * Math.PI / m;
              for (let k = 0; k < chunkN; k += m) {
                for (let j = 0; j < half; j++) {
                  const wRe = Math.cos(angleStep * j), wIm = Math.sin(angleStep * j);
                  const oRe = data[2 * (k + j + half)], oIm = data[2 * (k + j + half) + 1];
                  const tRe = wRe * oRe - wIm * oIm, tIm = wRe * oIm + wIm * oRe;
                  const eRe = data[2 * (k + j)],       eIm = data[2 * (k + j) + 1];
                  data[2 * (k + j + half)]     = eRe - tRe;
                  data[2 * (k + j + half) + 1] = eIm - tIm;
                  data[2 * (k + j)]            = eRe + tRe;
                  data[2 * (k + j) + 1]        = eIm + tIm;
                }
              }
            }
            self.postMessage(data, [data.buffer]);
          } catch (error) {
            self.postMessage({ error: true, message: String(error) });
          }
        };
      `;
      const workerUrl = createWorkerUrl(workerSource);
      try {
        const workers = Array.from({ length: p }, () => new Worker(workerUrl));
        const promises = workers.map((worker, w) => {
          // Send a transferable copy of this chunk's slice to the worker.
          const chunk = new Float64Array(2 * chunkN);
          chunk.set(data.subarray(w * 2 * chunkN, (w + 1) * 2 * chunkN));
          worker.postMessage({ chunk, chunkN }, [chunk.buffer]);
          return new Promise((resolve, reject) => {
            worker.onmessage = (event) => {
              const r = event.data;
              if (r && r.error) reject(new Error(r.message));
              else resolve(r);
            };
            worker.onerror = reject;
          }).finally(() => { worker.terminate(); });
        });
        const results = await Promise.all(promises);
        for (let w = 0; w < p; w++) {
          data.set(results[w], w * 2 * chunkN);
        }
      } finally {
        URL.revokeObjectURL(workerUrl);
      }
    } else {
      _fftStagesInPlace(data, N, 1, localBits);
    }
    if (localBits < bits) _fftStagesInPlace(data, N, localBits + 1, bits);
    return data;
  }
}

export { _fftStagesInPlace };
