import { defaultNumThreads } from "../utils/utilities";
import {
  buildRanges,
  initSharedFloat64,
  initSharedFloat64FromArray,
} from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";
import {
  Stage,
  isStreamStage,
  FilterStage,
  WindowReduceStage,
  IterateStage,
} from "./pipelineStages";

interface ParallelPipelineSharedInterface {
  pipeline(
    stages: Array<Stage>,
    inputData: any,
    numThreads?: number
  ): Promise<any>;
}

class ParallelPipelineShared implements ParallelPipelineSharedInterface {
  // Map stage: apply fn to each element in parallel via shared output buffer.
  private async runMapStage(
    stageFn: Function,
    inputData: any,
    numThreads: number
  ): Promise<any> {
    if (Array.isArray(inputData)) {
      if (inputData.length === 0) return [];
      if (numThreads === 1 || inputData.length < numThreads * 2) {
        return inputData.map((item: any, index: number) => stageFn(item, index));
      }

      const effectiveThreads = Math.min(numThreads, inputData.length);
      const length = inputData.length;
      const { buffer: inputBuffer } = initSharedFloat64FromArray(inputData);
      const { buffer: outputBuffer } = initSharedFloat64(length);
      const ranges = buildRanges(length, effectiveThreads);

      const pool = WorkerPool.getPool("./dist/workers/mapSharedWorker.js", effectiveThreads);
      const messages = ranges.map(({ start, end }) => ({
        fn: stageFn.toString(),
        inputBuffer,
        outputBuffer,
        start,
        end,
      }));
      await pool.execAll(messages);
      return Array.from(new Float64Array(outputBuffer));
    }

    return stageFn(inputData);
  }

  // Filter stage: drop items that fail the predicate, preserving order.
  // Delegates to the Shared Filter pattern for arrays large enough to benefit.
  private async runFilterStage(
    stage: FilterStage,
    inputData: any,
    numThreads: number
  ): Promise<any> {
    if (!Array.isArray(inputData) || inputData.length === 0) return [];
    if (numThreads === 1 || inputData.length < numThreads * 2) {
      const out: any[] = [];
      const keep = stage.keep;
      for (const x of inputData) if (keep(x)) out.push(x);
      return out;
    }
    // Lazy import to avoid a top-level cycle.
    const { ParallelFilterShared } = require("./filterShared");
    const filter = new ParallelFilterShared();
    return await filter.filter(stage.keep, inputData, numThreads);
  }

  // Window-reduce stage: collapse each sliding window of `size` (with stride `step`)
  // into a single value using `op` and `identity`.
  private async runWindowReduceStage(
    stage: WindowReduceStage,
    inputData: any,
    numThreads: number
  ): Promise<any> {
    if (!Array.isArray(inputData)) {
      throw new Error("WindowReduce stage requires an array input");
    }
    const n = inputData.length;
    const { size, step, op, identity } = stage;
    if (n < size) return [];

    const numWindows = Math.floor((n - size) / step) + 1;
    const inputData32 = inputData;
    const { buffer: inputBuffer } = initSharedFloat64FromArray(inputData32);
    const { buffer: outputBuffer } = initSharedFloat64(numWindows);

    const effectiveThreads = Math.min(numThreads, numWindows);
    if (effectiveThreads <= 1 || numWindows < numThreads * 2) {
      // Sequential fallback.
      const out = new Array<number>(numWindows);
      const view = new Float64Array(inputBuffer);
      for (let w = 0; w < numWindows; w++) {
        const base = w * step;
        let acc = identity;
        for (let i = 0; i < size; i++) acc = op(acc, view[base + i]);
        out[w] = acc;
      }
      return out;
    }

    const ranges = buildRanges(numWindows, effectiveThreads);
    const pool = WorkerPool.getPool(
      "./dist/workers/windowReduceWorker.js",
      effectiveThreads
    );
    const messages = ranges.map(({ start, end }) => ({
      fn: op.toString(),
      inputBuffer,
      outputBuffer,
      windowStart: start,
      windowEnd: end,
      size,
      step,
      identity,
    }));
    await pool.execAll(messages);
    return Array.from(new Float64Array(outputBuffer));
  }

  // Iterate stage: apply op repeatedly to each element until until(value) returns true,
  // bounded by maxIterations to prevent unbounded loops.
  private async runIterateStage(
    stage: IterateStage,
    inputData: any,
    numThreads: number
  ): Promise<any> {
    if (!Array.isArray(inputData) || inputData.length === 0) return [];
    const maxIterations = stage.maxIterations ?? 1000;
    const length = inputData.length;
    const effectiveThreads = Math.min(numThreads, length);

    if (effectiveThreads <= 1 || length < numThreads * 2) {
      const out = new Array<number>(length);
      for (let i = 0; i < length; i++) {
        let v = inputData[i];
        let iter = 0;
        while (!stage.until(v) && iter < maxIterations) {
          v = stage.op(v);
          iter++;
        }
        out[i] = v;
      }
      return out;
    }

    const { buffer: inputBuffer } = initSharedFloat64FromArray(inputData);
    const { buffer: outputBuffer } = initSharedFloat64(length);
    const ranges = buildRanges(length, effectiveThreads);

    const pool = WorkerPool.getPool("./dist/workers/iterateWorker.js", effectiveThreads);
    const messages = ranges.map(({ start, end }) => ({
      opFn: stage.op.toString(),
      untilFn: stage.until.toString(),
      inputBuffer,
      outputBuffer,
      start,
      end,
      maxIterations,
    }));
    await pool.execAll(messages);
    return Array.from(new Float64Array(outputBuffer));
  }

  async pipeline(
    stages: Array<Stage>,
    inputData: any,
    numThreads: number = defaultNumThreads
  ): Promise<any> {
    if (stages.length === 0) return inputData;

    let currentData = inputData;
    for (const stage of stages) {
      if (isStreamStage(stage)) {
        switch (stage.kind) {
          case "filter":
            currentData = await this.runFilterStage(stage, currentData, numThreads);
            break;
          case "windowReduce":
            currentData = await this.runWindowReduceStage(stage, currentData, numThreads);
            break;
          case "iterate":
            currentData = await this.runIterateStage(stage, currentData, numThreads);
            break;
        }
      } else {
        currentData = await this.runMapStage(stage, currentData, numThreads);
      }
    }
    return currentData;
  }
}

export { ParallelPipelineShared };
