import { defaultNumThreads } from "../utils/utilities";
import { chunkArray } from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";

interface ParallelMapInterface {
  map(
    fn: Function,
    inputData: Array<any>,
    numThreads?: number
  ): Promise<Array<any>>;
}

// Map
class ParallelMap implements ParallelMapInterface {
  private async runWorkers(
    fn: Function,
    chunks: Array<any>,
    numThreads: number
  ): Promise<any> {
    const pool = WorkerPool.getPool("./dist/workers/mapWorker.js", numThreads);
    const messages = chunks.map((chunk) => ({
      fn: fn.toString(),
      inputData: chunk,
    }));
    return await pool.execAll(messages);
  }

  async map(
    fn: Function,
    inputData: Array<any>,
    numThreads: number = defaultNumThreads
  ): Promise<Array<any>> {
    numThreads = Math.min(numThreads, inputData.length);
    const chunks = chunkArray(inputData, numThreads);
    const results = await this.runWorkers(fn, chunks, numThreads);
    return results.flat();
  }
}
export { ParallelMap };
