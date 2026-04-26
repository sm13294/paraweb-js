import { defaultNumThreads } from "../utils/utilities";
import { chunkArray, detectIdentityElement } from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";
import type { AssociativeOp } from "./reduce";

interface ParallelScanInterface {
  scan(
    op: AssociativeOp,
    inputData: Array<number>,
    identity: number,
    numThreads?: number,
    mapFn?: Function
  ): Promise<Array<number>>;
}

/**
 * Prefix-scan (inclusive scan).
 *
 * For input `[x_0, x_1, ..., x_{n-1}]` and an associative binary operator `op`,
 * the result is `[identity op x_0, identity op x_0 op x_1, ..., identity op x_0 op ... op x_{n-1}]`.
 * The combine step between chunks re-applies `op` to per-chunk totals, so `op`
 * must be associative — non-associative folds give incorrect results.
 *
 * Two-pass algorithm:
 *   Phase 1: each worker computes a local inclusive scan of its chunk,
 *            returning the scanned chunk and its total.
 *   Main:    compute an exclusive scan of chunk totals (sequential, p elements).
 *   Phase 2: each worker (except worker 0) adds its offset to every element in its chunk.
 */
class ParallelScan implements ParallelScanInterface {
  async scan(
    op: AssociativeOp,
    inputData: Array<number>,
    identity: number,
    numThreads: number = defaultNumThreads,
    mapFn?: Function
  ): Promise<Array<number>> {
    if (inputData.length === 0) return [];

    const detectedIdentity = detectIdentityElement(op, identity);
    numThreads = Math.min(numThreads, inputData.length);

    const chunks = chunkArray(inputData, numThreads);
    const pool = WorkerPool.getPool("./dist/workers/scanWorker.js", numThreads);

    const fnStr = op.toString();
    const mapFnStr = mapFn ? mapFn.toString() : null;

    // Phase 1: fused map + local scan (if mapFn provided) else just local scan.
    const phase1Messages = chunks.map((chunk) => ({
      fn: fnStr,
      mapFnStr,
      chunk,
      identity: detectedIdentity,
      offset: null,
    }));
    const phase1Results: Array<{ scanned: number[]; total: number }> =
      await pool.execAll(phase1Messages);

    // Compute exclusive scan of chunk totals to get per-chunk offsets.
    // offsets[0] = identity (or initial value). Then offsets[k] = fn(offsets[k-1], totals[k-1]).
    // If user passed a non-identity initial value, it folds in as the first offset.
    const offsets: number[] = new Array(chunks.length);
    offsets[0] = identity;
    for (let k = 1; k < chunks.length; k++) {
      offsets[k] = op(offsets[k - 1], phase1Results[k - 1].total);
    }

    // Phase 2: chunks 0 gets offset=identity; if identity is the detected identity,
    // chunk 0's local scan already has the right values. Otherwise we must re-apply.
    // For correctness/simplicity, always apply the offset unless it equals the detected identity.
    const needsOffset = (offset: number) => offset !== detectedIdentity;

    const phase2Tasks: Promise<{ scanned: number[] }>[] = [];
    for (let k = 0; k < chunks.length; k++) {
      if (needsOffset(offsets[k])) {
        phase2Tasks.push(
          pool.exec({
            fn: fnStr,
            chunk: phase1Results[k].scanned,
            identity: detectedIdentity,
            offset: offsets[k],
          })
        );
      } else {
        phase2Tasks.push(Promise.resolve({ scanned: phase1Results[k].scanned }));
      }
    }
    const phase2Results = await Promise.all(phase2Tasks);

    const output: number[] = [];
    for (const r of phase2Results) {
      for (const v of r.scanned) output.push(v);
    }
    return output;
  }
}

export { ParallelScan };
