import { defaultNumThreads } from "../utils/utilities";
import {
  initSharedFloat64,
  initSharedFloat64FromArray,
  initSharedInt32,
} from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";

interface ParallelFarmSharedInterface {
  farm(
    fn: Function,
    inputData: Array<number>,
    numThreads?: number
  ): Promise<Array<number>>;
}

class ParallelFarmShared implements ParallelFarmSharedInterface {
  async farm(
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
    const { buffer: counterBuffer, view: counterView } = initSharedInt32(1);
    counterView[0] = 0;

    const pool = WorkerPool.getPool("./dist/workers/farmSharedWorker.js", numThreads);

    const batchSize = Math.max(1, Math.ceil(length / numThreads));

    const messages = Array.from({ length: numThreads }, () => ({
      fn: fn.toString(),
      inputBuffer,
      outputBuffer,
      counterBuffer,
      length,
      batchSize,
    }));

    await pool.execAll(messages);

    return Array.from(new Float64Array(outputBuffer));
  }
}

export { ParallelFarmShared };
