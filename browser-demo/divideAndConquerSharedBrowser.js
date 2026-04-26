import {
  DivideAndConquerBrowser,
  _fftBitReversePermute,
  _isPow2,
} from "./divideAndConquerBrowser.js";
import { ensureSharedArrayBuffer, createWorkerUrl } from "./workerUtils.js";

export class DivideAndConquerSharedBrowser {
  async divideAndConquer(divideFn, conquerFn, baseCaseFn, inputData, numThreads) {
    const impl = new DivideAndConquerBrowser();
    return impl.divideAndConquer(divideFn, conquerFn, baseCaseFn, inputData, numThreads);
  }

  /**
   * Parallel Cooley-Tukey radix-2 FFT (Shared variant). Per-stage dispatch:
   * main thread issues one round-trip per stage; workers compute their slice
   * of butterflies on a `SharedArrayBuffer` in-place. Avoids the Atomics.wait
   * barrier (which deadlocks under contention) at a small per-stage round-trip
   * overhead. log2(N) round-trips total.
   */
  async fft(complexData, numThreads) {
    const N = (complexData.length / 2) | 0;
    if (N <= 1) return Float64Array.from(complexData);
    if (!_isPow2(N)) throw new Error(`fft: N must be power of two, got ${N}`);
    ensureSharedArrayBuffer();

    const dataBuffer = new SharedArrayBuffer(2 * N * 8);
    const data = new Float64Array(dataBuffer);
    if (complexData instanceof Float64Array) data.set(complexData);
    else for (let i = 0; i < 2 * N; i++) data[i] = complexData[i];
    _fftBitReversePermute(data);

    const bits = Math.log2(N) | 0;
    const requested = numThreads || (navigator.hardwareConcurrency || 4);
    const threads = Math.max(1, Math.min(requested, N >> 1));

    // Persistent workers handle one stage per message and post `done`. The
    // main thread waits for all workers to acknowledge before issuing the
    // next stage. The shared buffer reference is sent once at startup.
    const workerSource = `
      let cached = null;
      self.onmessage = (event) => {
        try {
          if (event.data && event.data.__init) {
            cached = {
              data: new Float64Array(event.data.dataBuffer),
              N: event.data.N,
              numWorkers: event.data.numWorkers,
              workerId: event.data.workerId,
            };
            self.postMessage("ready");
            return;
          }
          if (event.data === "terminate") { self.close(); return; }
          const stage = event.data.stage;
          const { data, N, numWorkers, workerId } = cached;
          const totalButterflies = N >>> 1;
          const per = Math.ceil(totalButterflies / numWorkers);
          const start = Math.min(workerId * per, totalButterflies);
          const end = Math.min(start + per, totalButterflies);
          const m = 1 << stage, half = m >> 1, angleStep = -2 * Math.PI / m;
          for (let t = start; t < end; t++) {
            const j = t % half;
            const lo = ((t / half) | 0) * m + j;
            const hi = lo + half;
            const wRe = Math.cos(angleStep * j), wIm = Math.sin(angleStep * j);
            const oRe = data[2 * hi], oIm = data[2 * hi + 1];
            const tRe = wRe * oRe - wIm * oIm, tIm = wRe * oIm + wIm * oRe;
            const eRe = data[2 * lo], eIm = data[2 * lo + 1];
            data[2 * hi]     = eRe - tRe;
            data[2 * hi + 1] = eIm - tIm;
            data[2 * lo]     = eRe + tRe;
            data[2 * lo + 1] = eIm + tIm;
          }
          self.postMessage("done");
        } catch (error) {
          self.postMessage({ error: true, message: String(error) });
        }
      };
    `;
    const workerUrl = createWorkerUrl(workerSource);
    const workers = Array.from({ length: threads }, () => new Worker(workerUrl));
    try {
      // Init: hand each worker the shared buffer and its workerId.
      await Promise.all(workers.map((worker, workerId) => new Promise((resolve, reject) => {
        worker.onmessage = (e) => { if (e.data === "ready") resolve(); else reject(new Error("init failed")); };
        worker.onerror = reject;
        worker.postMessage({ __init: true, dataBuffer, N, numWorkers: threads, workerId });
      })));
      // log2(N) stages.
      for (let stage = 1; stage <= bits; stage++) {
        await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
          worker.onmessage = (e) => {
            const r = e.data;
            if (r && r.error) reject(new Error(r.message));
            else resolve();
          };
          worker.onerror = reject;
          worker.postMessage({ stage });
        })));
      }
    } finally {
      for (const w of workers) w.terminate();
      URL.revokeObjectURL(workerUrl);
    }
    return new Float64Array(data);
  }
}
