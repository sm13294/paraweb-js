import { defaultNumThreads } from "../utils/utilities";
import { chunkArray } from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";

interface ParallelFilterInterface {
  filter(
    fn: Function,
    inputData: Array<any>,
    numThreads?: number
  ): Promise<Array<any>>;
}

class ParallelFilter implements ParallelFilterInterface {
  private async runWorkers(
    fn: Function,
    inputData: Array<any>,
    numThreads: number
  ): Promise<any> {
    const pool = WorkerPool.getPool("./dist/workers/filterWorker.js", numThreads);
    const messages = inputData.map((chunk) => ({
      fn: fn.toString(),
      inputData: chunk,
    }));
    return await pool.execAll(messages);
  }

  async filter(
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

export { ParallelFilter };
