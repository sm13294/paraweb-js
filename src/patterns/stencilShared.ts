import { defaultNumThreads } from "../utils/utilities";
import { WorkerPool } from "../core/workerPool";

interface EdgeOptions {
  type: "zero" | "padding" | "custom";
  value?: any;
  customFn?: Function;
}

interface ParallelStencilSharedInterface {
  stencil(
    fn: Function,
    inputData: Array<number>,
    stencil: Array<any>,
    numThreads?: number,
    edgeOption?: EdgeOptions
  ): Promise<Array<number>>;
}

class ParallelStencilShared implements ParallelStencilSharedInterface {
  async stencil(
    fn: Function,
    inputData: Array<number>,
    stencil: Array<any>,
    numThreads: number = defaultNumThreads,
    edgeOption?: EdgeOptions
  ): Promise<Array<number>> {
    if (inputData.length === 0) {
      return [];
    }

    numThreads = Math.min(numThreads, inputData.length);

    const length = inputData.length;
    const inputBuffer = new SharedArrayBuffer(
      Float64Array.BYTES_PER_ELEMENT * length
    );
    const outputBuffer = new SharedArrayBuffer(
      Float64Array.BYTES_PER_ELEMENT * length
    );
    const inputView = new Float64Array(inputBuffer);
    for (let i = 0; i < length; i++) {
      inputView[i] = inputData[i];
    }

    const chunkSize = Math.ceil(length / numThreads);
    const ranges = Array.from({ length: numThreads }, (_, i) => {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, length);
      return { start, end };
    });

    const pool = WorkerPool.getPool("./dist/workers/stencilSharedWorker.js", numThreads);

    const messages = ranges.map(({ start, end }) => ({
      fn: fn.toString(),
      inputBuffer,
      outputBuffer,
      stencil,
      edgeOption,
      start,
      end,
      length,
    }));

    await pool.execAll(messages);

    return Array.from(new Float64Array(outputBuffer));
  }
}

export { ParallelStencilShared };
