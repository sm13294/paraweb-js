import { defaultNumThreads } from "../utils/utilities";
import {
  buildRanges,
  detectIdentityElement,
  initSharedFloat64,
  initSharedFloat64FromArray,
} from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";
import type { AssociativeOp } from "./reduce";

interface ParallelScanSharedInterface {
  scan(
    op: AssociativeOp,
    inputData: Array<number>,
    identity: number,
    numThreads?: number,
    mapFn?: Function
  ): Promise<Array<number>>;
}

/**
 * Prefix-scan (inclusive scan), SharedArrayBuffer variant.
 *
 * Same two-pass algorithm as {@link ParallelScan}, but workers operate
 * directly on shared Float64Array buffers. The output array is written
 * in-place into a shared buffer, avoiding chunk-level copies. `op` must be
 * an associative binary operator.
 */
class ParallelScanShared implements ParallelScanSharedInterface {
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

    const n = inputData.length;
    const { buffer: inputBuffer } = initSharedFloat64FromArray(inputData);
    const { buffer: outputBuffer } = initSharedFloat64(n);
    const { buffer: totalsBuffer } = initSharedFloat64(numThreads);

    const ranges = buildRanges(n, numThreads);
    const pool = WorkerPool.getPool("./dist/workers/scanSharedWorker.js", numThreads);

    const fnStr = op.toString();
    const mapFnStr = mapFn ? mapFn.toString() : null;

    // Phase 1: local scans (with optional per-element transform) writing into the shared output buffer.
    const phase1Messages = ranges.map(({ start, end }, workerId) => ({
      phase: 1 as const,
      fn: fnStr,
      mapFnStr,
      inputBuffer,
      outputBuffer,
      totalsBuffer,
      start,
      end,
      workerId,
      identity: detectedIdentity,
    }));
    await pool.execAll(phase1Messages);

    // Compute per-chunk offsets on the main thread.
    const totalsView = new Float64Array(totalsBuffer);
    const offsets: number[] = new Array(ranges.length);
    offsets[0] = identity;
    for (let k = 1; k < ranges.length; k++) {
      offsets[k] = op(offsets[k - 1], totalsView[k - 1]);
    }

    // Phase 2: apply offset to each chunk (except when offset equals detected identity).
    const phase2Messages: any[] = [];
    for (let k = 0; k < ranges.length; k++) {
      if (offsets[k] !== detectedIdentity && ranges[k].start < ranges[k].end) {
        phase2Messages.push({
          phase: 2 as const,
          fn: fnStr,
          outputBuffer,
          start: ranges[k].start,
          end: ranges[k].end,
          offset: offsets[k],
        });
      }
    }
    if (phase2Messages.length > 0) {
      await pool.execAll(phase2Messages);
    }

    const outputView = new Float64Array(outputBuffer);
    return Array.from(outputView);
  }
}

export { ParallelScanShared };
