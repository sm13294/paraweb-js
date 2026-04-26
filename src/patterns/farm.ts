import { defaultNumThreads } from "../utils/utilities";
import { chunkArray } from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";

interface ParallelFarmInterface {
  farm(
    fn: Function,
    inputData: Array<any>,
    numThreads?: number
  ): Promise<Array<any>>;
}

// Farm pattern: Distribute tasks to workers using chunking
// Uses the same chunking approach as Map but preserves order
class ParallelFarm implements ParallelFarmInterface {
  async farm(
    fn: Function,
    inputData: Array<any>,
    numThreads: number = defaultNumThreads
  ): Promise<Array<any>> {

    if (inputData.length === 0) {
      return [];
    }

    numThreads = Math.min(numThreads, inputData.length);

    const chunks = chunkArray(inputData, numThreads);
    const pool = WorkerPool.getPool("./dist/workers/farmWorker.js", numThreads);
    const messages = chunks.map((chunk) => ({
      fn: fn.toString(),
      inputData: chunk,
    }));

    const results = await pool.execAll(messages);
    return results.flat();
  }
}

export { ParallelFarm };
