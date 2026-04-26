import { defaultNumThreads } from "../utils/utilities";
import {
  buildRanges,
  initSharedFloat64,
  initSharedFloat64FromArray,
  initSharedInt32,
  initSharedInt32FromArray,
} from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";
import { ParallelScatter } from "./scatter";

interface ParallelScatterSharedInterface {
  scatter(
    inputData: Array<number>,
    indexData: Array<number>,
    defaultValue?: number,
    conflictFn?: Function,
    numThreads?: number,
    mapFn?: Function
  ): Promise<Array<number>>;
}

class ParallelScatterShared implements ParallelScatterSharedInterface {
  async scatter(
    inputData: Array<number>,
    indexData: Array<number>,
    defaultValue: number = 0,
    conflictFn?: Function,
    numThreads: number = defaultNumThreads,
    mapFn?: Function
  ): Promise<Array<number>> {
    // conflictFn requires cross-worker atomic combine on Float64 (no native op);
    // fall back to MP only in that case. mapFn runs inside the shared worker.
    if (conflictFn) {
      const fallback = new ParallelScatter();
      return fallback.scatter(inputData, indexData, defaultValue, conflictFn, numThreads, mapFn);
    }

    if (inputData.length !== indexData.length) {
      throw new Error("inputData and indexData must have the same length");
    }
    if (inputData.length === 0) {
      return [];
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

    const length = inputData.length;
    const { buffer: inputBuffer } = initSharedFloat64FromArray(inputData);
    const { buffer: indexBuffer } = initSharedInt32FromArray(indexData);
    const { buffer: outputBuffer, view: outputView } = initSharedFloat64(
      outputLength,
      defaultValue
    );
    const { buffer: lastIndexBuffer, view: lastIndexView } = initSharedInt32(
      outputLength,
      -1
    );
    const ranges = buildRanges(length, numThreads);

    const pool = WorkerPool.getPool("./dist/workers/scatterSharedWorker.js", numThreads);

    const mapFnStr = mapFn ? mapFn.toString() : undefined;

    const messages = ranges.map(({ start, end }) => ({
      inputBuffer,
      indexBuffer,
      outputBuffer,
      lastIndexBuffer,
      start,
      end,
      mapFnStr,
    }));

    await pool.execAll(messages);

    return Array.from(outputView);
  }
}

export { ParallelScatterShared };
