import { defaultNumThreads } from "../utils/utilities";
import {
  buildRanges,
  detectIdentityElement,
  initSharedFloat64,
  initSharedFloat64FromArray,
  initSharedUint8,
} from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";
import type { AssociativeOp } from "./reduce";

interface ParallelReduceSharedInterface {
  reduce(
    op: AssociativeOp,
    inputData: Array<number>,
    identity: number,
    numThreads?: number,
    mapFn?: Function
  ): Promise<number>;
}

class ParallelReduceShared implements ParallelReduceSharedInterface {
  /**
   * Parallel reduction over a numeric array using a shared-memory backend.
   * See `ParallelReduce` for parameter semantics; the public contract is
   * identical — `op` must be an associative binary combine operator.
   */
  async reduce(
    op: AssociativeOp,
    inputData: Array<number>,
    identity: number,
    numThreads: number = defaultNumThreads,
    mapFn?: Function
  ): Promise<number> {
    if (inputData.length === 0) {
      return identity;
    }

    numThreads = Math.min(numThreads, inputData.length);

    const length = inputData.length;
    const { buffer: inputBuffer } = initSharedFloat64FromArray(inputData);
    const { buffer: partialsBuffer } = initSharedFloat64(numThreads);
    const { buffer: validBuffer } = initSharedUint8(numThreads);
    const workerIdentity = detectIdentityElement(op, identity);
    const ranges = buildRanges(length, numThreads);

    const pool = WorkerPool.getPool("./dist/workers/reduceSharedWorker.js", numThreads);
    const mapFnStr = mapFn ? mapFn.toString() : null;

    const messages = ranges.map(({ start, end }, i) => ({
      fn: op.toString(),
      mapFnStr,
      inputBuffer,
      partialsBuffer,
      validBuffer,
      start,
      end,
      workerId: i,
      identityElement: workerIdentity,
    }));

    await pool.execAll(messages);

    const partialsView = new Float64Array(partialsBuffer);
    const validView = new Uint8Array(validBuffer);
    const validResults: number[] = [];
    for (let i = 0; i < numThreads; i++) {
      if (validView[i] === 1) {
        validResults.push(partialsView[i]);
      }
    }

    if (validResults.length === 0) {
      return identity;
    }

    let combinedResult = validResults[0];
    for (let i = 1; i < validResults.length; i++) {
      combinedResult = op(combinedResult, validResults[i]);
    }
    if (identity !== workerIdentity) {
      combinedResult = op(identity, combinedResult);
    }
    return combinedResult;
  }
}

export { ParallelReduceShared };
