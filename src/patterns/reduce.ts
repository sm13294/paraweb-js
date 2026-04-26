import { defaultNumThreads } from "../utils/utilities";
import { chunkArray, detectIdentityElement } from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";

/**
 * Associative binary combine operator. Both arguments hold T-values (raw
 * input elements OR partial reductions) and must be treated symmetrically:
 * `op(op(a, b), c)` must equal `op(a, op(b, c))`. Non-associative functions
 * (e.g. a fold that applies a transformation to only one side) produce
 * incorrect results once the parallel implementation combines per-chunk
 * partials. For per-element transformation prior to reducing, use MapReduce.
 */
export type AssociativeOp = (a: number, b: number) => number;

interface ParallelReduceInterface {
  reduce(
    op: AssociativeOp,
    inputData: Array<number>,
    identity: number,
    numThreads?: number,
    mapFn?: Function
  ): Promise<number>;
}

class ParallelReduce implements ParallelReduceInterface {
  /**
   * Parallel reduction over a numeric array.
   *
   * @param op         Associative binary combine operator `(a, b) => T`.
   * @param inputData  Numeric array to reduce.
   * @param identity   Identity element of `op` (0 for sum, 1 for product,
   *                   +Infinity for min, -Infinity for max). Returned unchanged
   *                   for an empty input; otherwise folded into the result.
   * @param numThreads Degree of parallelism; defaults to the number of
   *                   available cores.
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

    // Detect the op's true identity for per-worker accumulators. If the user
    // passed a non-identity starting value (e.g. sum from 10), we fold it in
    // once at the end using the same associative op.
    const workerIdentity = detectIdentityElement(op, identity);

    const chunks = chunkArray(inputData, numThreads);
    const pool = WorkerPool.getPool("./dist/workers/reduceWorker.js", numThreads);
    const mapFnStr = mapFn ? mapFn.toString() : null;
    const messages = chunks.map((chunk) => ({
      fn: op.toString(),
      mapFnStr,
      inputData: chunk,
      identityElement: workerIdentity,
    }));
    const partialResults = await pool.execAll(messages);
    const validResults = partialResults.filter((r: any) => r !== undefined && r !== null);

    // Combine per-chunk partial results using the same associative operator.
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

export { ParallelReduce };
