import { ParallelDivideAndConquer } from "./divideAndConquer";
import { defaultNumThreads } from "../utils/utilities";
import { WorkerPool } from "../core/workerPool";
import { bitReversePermute, isPowerOfTwo } from "../core/fftUtils";

interface ParallelDivideAndConquerSharedInterface {
  divideAndConquer(
    divideFn: Function,
    conquerFn: Function,
    baseCaseFn: Function,
    inputData: any,
    numThreads?: number
  ): Promise<any>;
}

class ParallelDivideAndConquerShared
  implements ParallelDivideAndConquerSharedInterface
{
  async divideAndConquer(
    divideFn: Function,
    conquerFn: Function,
    baseCaseFn: Function,
    inputData: any,
    numThreads?: number
  ): Promise<any> {
    const impl = new ParallelDivideAndConquer();
    return impl.divideAndConquer(
      divideFn,
      conquerFn,
      baseCaseFn,
      inputData,
      numThreads
    );
  }

  /**
   * Parallel Cooley-Tukey radix-2 FFT using SharedArrayBuffer with per-stage
   * dispatch: the main thread issues one round-trip per stage (log2(N) total)
   * and workers compute their slice of butterflies on the shared buffer
   * in-place. This avoids the Atomics.wait barrier (which deadlocks under
   * contention in our setup) at the cost of one extra round-trip per stage.
   * Input is interleaved [re0, im0, re1, im1, ...] of length 2*N where N is a
   * power of two.
   */
  async fft(
    complexData: Float64Array | number[],
    numThreads: number = defaultNumThreads
  ): Promise<Float64Array> {
    const N = (complexData.length / 2) | 0;
    if (N <= 1) return Float64Array.from(complexData as ArrayLike<number>);
    if (!isPowerOfTwo(N)) throw new Error(`fft: N must be power of two, got ${N}`);

    const dataBuffer = new SharedArrayBuffer(2 * N * 8);
    const data = new Float64Array(dataBuffer);
    if (complexData instanceof Float64Array) {
      data.set(complexData);
    } else {
      for (let i = 0; i < 2 * N; i++) data[i] = (complexData as number[])[i];
    }
    bitReversePermute(data);

    const bits = Math.log2(N) | 0;
    const threads = Math.min(numThreads, Math.max(1, N >> 1));
    const pool = WorkerPool.getPool("./dist/workers/fftSharedWorker.js", threads);
    for (let stage = 1; stage <= bits; stage++) {
      const messages = Array.from({ length: threads }, (_, workerId) => ({
        dataBuffer,
        N,
        numWorkers: threads,
        workerId,
        stage,
      }));
      await pool.execAll(messages);
    }
    return new Float64Array(data);
  }
}

export { ParallelDivideAndConquerShared };
