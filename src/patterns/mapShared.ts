import { defaultNumThreads } from "../utils/utilities";
import {
  buildRanges,
  initSharedFloat64,
  initSharedFloat64FromArray,
} from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";

interface ParallelMapSharedInterface {
  map(
    fn: Function,
    inputData: Array<number>,
    numThreads?: number
  ): Promise<Array<number>>;
}

class ParallelMapShared implements ParallelMapSharedInterface {
  async map(
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
    const { buffer: outputBuffer } = initSharedFloat64(length);

    const ranges = buildRanges(length, numThreads);
    const pool = WorkerPool.getPool("./dist/workers/mapSharedWorker.js", numThreads);

    const messages = ranges.map(({ start, end }) => ({
      fn: fn.toString(),
      inputBuffer,
      outputBuffer,
      start,
      end,
    }));

    await pool.execAll(messages);

    const sharedOutput = new Float64Array(outputBuffer);
    return Array.from(sharedOutput);
  }
}

export { ParallelMapShared };
