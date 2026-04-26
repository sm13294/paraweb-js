import { defaultNumThreads } from "../utils/utilities";
import { chunkArray } from "../core/parallelUtils";
import { WorkerPool } from "../core/workerPool";
import {
  Stage,
  isStreamStage,
  FilterStage,
  WindowReduceStage,
  IterateStage,
} from "./pipelineStages";

interface ParallelPipelineInterface {
  pipeline(
    stages: Array<Stage>,
    inputData: any,
    numThreads?: number
  ): Promise<any>;
}

class ParallelPipeline implements ParallelPipelineInterface {
  private async runMapStage(
    stageFn: Function,
    inputData: any,
    numThreads: number
  ): Promise<any> {
    if (Array.isArray(inputData)) {
      if (inputData.length === 0) return [];
      if (numThreads === 1 || inputData.length < numThreads * 2) {
        return inputData.map((item: any) => stageFn(item));
      }

      const effectiveThreads = Math.min(numThreads, inputData.length);
      const chunks = chunkArray(inputData, effectiveThreads);
      const pool = WorkerPool.getPool("./dist/workers/pipelineWorker.js", effectiveThreads);
      const messages = chunks.map((chunk) => ({
        fn: stageFn.toString(),
        inputData: chunk,
      }));
      const results = await pool.execAll(messages);
      return results.flat();
    }
    return stageFn(inputData);
  }

  private runFilterStage(stage: FilterStage, inputData: any): any[] {
    if (!Array.isArray(inputData) || inputData.length === 0) return [];
    const out: any[] = [];
    const keep = stage.keep;
    for (const x of inputData) if (keep(x)) out.push(x);
    return out;
  }

  private runWindowReduceStage(stage: WindowReduceStage, inputData: any): number[] {
    if (!Array.isArray(inputData)) {
      throw new Error("WindowReduce stage requires an array input");
    }
    const n = inputData.length;
    const { size, step, op, identity } = stage;
    if (n < size) return [];
    const numWindows = Math.floor((n - size) / step) + 1;
    const out = new Array<number>(numWindows);
    for (let w = 0; w < numWindows; w++) {
      const base = w * step;
      let acc = identity;
      for (let i = 0; i < size; i++) acc = op(acc, inputData[base + i]);
      out[w] = acc;
    }
    return out;
  }

  private runIterateStage(stage: IterateStage, inputData: any): number[] {
    if (!Array.isArray(inputData) || inputData.length === 0) return [];
    const maxIterations = stage.maxIterations ?? 1000;
    const out = new Array<number>(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
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
            currentData = this.runFilterStage(stage, currentData);
            break;
          case "windowReduce":
            currentData = this.runWindowReduceStage(stage, currentData);
            break;
          case "iterate":
            currentData = this.runIterateStage(stage, currentData);
            break;
        }
      } else {
        currentData = await this.runMapStage(stage, currentData, numThreads);
      }
    }
    return currentData;
  }
}

export { ParallelPipeline };
