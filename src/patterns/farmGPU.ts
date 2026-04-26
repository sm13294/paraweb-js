/**
 * Farm Pattern - GPU Implementation.
 * Farm on GPU is equivalent to Map since GPU handles scheduling internally.
 * The GPU's hardware scheduler provides dynamic work distribution across
 * compute units, which is analogous to the CPU Farm's dynamic task assignment.
 */
import { ParallelMapGPU } from "./mapGPU";
import { GPUOperation } from "../core/gpuShaderBuilder";

class ParallelFarmGPU {
  private mapper = new ParallelMapGPU();

  async farm(
    op: GPUOperation,
    inputData: number[]
  ): Promise<number[]> {
    // GPU hardware scheduler handles load balancing across compute units,
    // so Farm on GPU reduces to Map.
    return this.mapper.map(op, inputData);
  }
}

export { ParallelFarmGPU };
