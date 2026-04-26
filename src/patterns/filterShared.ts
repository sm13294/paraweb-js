import { defaultNumThreads } from "../utils/utilities";
import {
  buildRanges,
  initSharedFloat64FromArray,
  initSharedUint8,
  initSharedInt32,
  initSharedFloat64,
} from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";

interface ParallelFilterSharedInterface {
  filter(
    fn: Function,
    inputData: Array<number>,
    numThreads?: number
  ): Promise<Array<number>>;
}

class ParallelFilterShared implements ParallelFilterSharedInterface {
  async filter(
    fn: Function,
    inputData: Array<number>,
    numThreads: number = defaultNumThreads
  ): Promise<Array<number>> {
    if (inputData.length === 0) {
      return [];
    }

    numThreads = Math.min(numThreads, inputData.length);

    const length = inputData.length;
    const { buffer: inputBuffer } = initSharedFloat64FromArray(inputData);
    const { buffer: flagsBuffer } = initSharedUint8(length);
    const { buffer: countsBuffer } = initSharedInt32(numThreads);
    const ranges = buildRanges(length, numThreads);

    const pool = WorkerPool.getPool("./dist/workers/filterSharedWorker.js", numThreads);

    // Count phase
    const countMessages = ranges.map(({ start, end }, i) => ({
      phase: "count",
      fn: fn.toString(),
      inputBuffer,
      flagsBuffer,
      countsBuffer,
      start,
      end,
      workerId: i,
    }));

    await pool.execAll(countMessages);

    const countsView = new Int32Array(countsBuffer);
    const offsets: number[] = [];
    let total = 0;
    for (let i = 0; i < numThreads; i++) {
      offsets[i] = total;
      total += countsView[i];
    }

    if (total === 0) {
      return [];
    }

    const { buffer: outputBuffer } = initSharedFloat64(total);

    // Write phase
    const writeMessages = ranges.map(({ start, end }, i) => ({
      phase: "write",
      fn: fn.toString(),
      inputBuffer,
      flagsBuffer,
      outputBuffer,
      start,
      end,
      offset: offsets[i],
    }));

    await pool.execAll(writeMessages);

    return Array.from(new Float64Array(outputBuffer));
  }
}

export { ParallelFilterShared };
