/**
 * MapReduce Pattern - GPU Implementation.
 * Composes MapGPU (map phase) then ReduceGPU (reduce phase).
 */
import { ParallelMapGPU } from "./mapGPU";
import { ParallelReduceGPU } from "./reduceGPU";
import { GPUOperation, GPUBinaryOperation } from "../core/gpuShaderBuilder";

class ParallelMapReduceGPU {
  private mapper = new ParallelMapGPU();
  private reducer = new ParallelReduceGPU();

  async mapReduce(
    mapOp: GPUOperation,
    reduceOp: GPUBinaryOperation,
    inputData: number[],
    initialValue?: number
  ): Promise<number> {
    if (inputData.length === 0) return initialValue ?? 0;

    // Map phase on GPU
    const mapped = await this.mapper.map(mapOp, inputData);

    // Reduce phase on GPU
    return this.reducer.reduce(reduceOp, mapped, initialValue);
  }
}

export { ParallelMapReduceGPU };
