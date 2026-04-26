/**
 * Pipeline Pattern - GPU Implementation.
 * Sequential stages where each stage runs on the GPU.
 * CPU orchestrates the stage sequence; each stage is a GPU Map operation.
 */
import { ParallelMapGPU } from "./mapGPU";
import { GPUOperation } from "../core/gpuShaderBuilder";

class ParallelPipelineGPU {
  private mapper = new ParallelMapGPU();

  async pipeline(
    stages: GPUOperation[],
    inputData: number[]
  ): Promise<number[]> {
    if (inputData.length === 0) return [];
    if (stages.length === 0) return [...inputData];

    let data = inputData;
    for (const stage of stages) {
      data = await this.mapper.map(stage, data);
    }
    return data;
  }
}

export { ParallelPipelineGPU };
