import { defaultNumThreads } from "../utils/utilities";
import { WorkerPool } from "../core/workerPool";

interface EdgeOptions {
  type: "zero" | "padding" | "custom";
  value?: any;
  customFn?: Function;
}

interface ParallelStencilInterface {
  stencil(
    fn: Function,
    inputData: Array<any>,
    stencil: Array<any>,
    numThreads?: number,
    edgeOption?: EdgeOptions
  ): Promise<Array<any>>;
}

// ParallelStencil
class ParallelStencil implements ParallelStencilInterface {
  private async runWorkers(
    fn: Function,
    chunks: Array<any>,
    stencil: Array<any>,
    numThreads: number,
    edgeOption?: EdgeOptions
  ): Promise<any[]> {
    const pool = WorkerPool.getPool("./dist/workers/stencilWorker.js", numThreads);
    const messages = chunks.map((chunk) => ({
      fn: fn.toString(),
      inputData: chunk,
      stencil,
      edgeOption,
    }));
    return await pool.execAll(messages);
  }

  async stencil(
    fn: Function,
    inputData: Array<any>,
    stencil: Array<any>,
    numThreads: number = defaultNumThreads,
    edgeOption?: EdgeOptions
  ): Promise<Array<any>> {

    numThreads = Math.min(numThreads, inputData.length);

    const stencilSize = stencil.length;
    const stencilHalf = Math.floor(stencilSize / 2);
    const chunkSize = Math.ceil(inputData.length / numThreads);
    const chunks = Array.from({ length: numThreads }, (_, i) => {
      const start = Math.max(0, i * chunkSize - stencilHalf);
      const end = Math.min(inputData.length, (i + 1) * chunkSize + stencilHalf);
      return inputData.slice(start, end);
    });

    const partialResults = await this.runWorkers(
      fn,
      chunks,
      stencil,
      numThreads,
      edgeOption
    );

    // Concatenate results, taking care to avoid overlaps
    // Each chunk has overlap of stencilHalf on both sides
    // We need to extract the valid portion that corresponds to the original input indices
    let output: Array<any> = [];

    partialResults.forEach((partial, i) => {
      // Calculate the start and end indices in the original input for this chunk
      const chunkStartInInput = i * chunkSize;
      const chunkEndInInput = Math.min((i + 1) * chunkSize, inputData.length);

      // Calculate where the chunk data actually starts in the original input
      const chunkDataStartInInput = Math.max(0, chunkStartInInput - stencilHalf);

      // The partial result contains results for elements starting at chunkDataStartInInput
      // We want results for elements starting at chunkStartInInput
      // So we need to skip (chunkStartInInput - chunkDataStartInInput) elements
      const skipAtStart = chunkStartInInput - chunkDataStartInInput;
      const takeCount = chunkEndInInput - chunkStartInInput;

      // Make sure we don't go beyond the partial result length
      const endIndex = Math.min(skipAtStart + takeCount, partial.length);

      // Extract the valid portion from this partial result
      const validResults = partial.slice(skipAtStart, endIndex);
      output = output.concat(validResults);
    });

    return output;
  }
}

export { ParallelStencil };
