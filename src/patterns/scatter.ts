import { defaultNumThreads } from "../utils/utilities";
import { chunkArray } from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";

interface ParallelScatterInterface {
  scatter(
    inputData: Array<number>,
    indexData: Array<number>,
    defaultValue?: number,
    conflictFn?: Function,
    numThreads?: number,
    mapFn?: Function
  ): Promise<Array<number>>;
}

class ParallelScatter implements ParallelScatterInterface {
  private async runWorkers(
    inputChunks: Array<Array<number>>,
    indexChunks: Array<Array<number>>,
    numThreads: number,
    mapFn?: Function
  ): Promise<Array<Array<[number, number]>>> {
    const pool = WorkerPool.getPool("./dist/workers/scatterWorker.js", numThreads);
    const fnStr = mapFn ? mapFn.toString() : null;
    const messages = inputChunks.map((chunk, i) => ({
      inputData: chunk,
      indexData: indexChunks[i],
      fnStr,
    }));
    return await pool.execAll(messages);
  }

  async scatter(
    inputData: Array<number>,
    indexData: Array<number>,
    defaultValue: number = 0,
    conflictFn?: Function,
    numThreads: number = defaultNumThreads,
    mapFn?: Function
  ): Promise<Array<number>> {
    if (inputData.length !== indexData.length) {
      throw new Error("inputData and indexData must have the same length");
    }
    if (inputData.length === 0) {
      return [];
    }
    if (conflictFn && typeof conflictFn !== "function") {
      throw new Error("conflictFn must be a function");
    }

    numThreads = Math.min(numThreads, inputData.length);

    let maxIndex = -1;
    for (const index of indexData) {
      if (!Number.isInteger(index) || index < 0) {
        throw new Error("indexData must contain non-negative integers");
      }
      if (index > maxIndex) {
        maxIndex = index;
      }
    }

    const outputLength = maxIndex + 1;
    if (outputLength === 0) {
      return [];
    }

    const output = new Array(outputLength).fill(defaultValue);
    const assigned = new Array(outputLength).fill(false);

    const inputChunks = chunkArray(inputData, numThreads);
    const indexChunks = chunkArray(indexData, numThreads);

    const chunkResults = await this.runWorkers(
      inputChunks,
      indexChunks,
      numThreads,
      mapFn
    );

    for (const pairs of chunkResults) {
      for (const pair of pairs) {
        const index = pair[0];
        const value = pair[1];

        if (assigned[index]) {
          output[index] = conflictFn ? conflictFn(output[index], value) : value;
        } else {
          output[index] = value;
          assigned[index] = true;
        }
      }
    }

    return output;
  }
}

export { ParallelScatter };
