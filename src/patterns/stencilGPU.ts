/**
 * Stencil Pattern - GPU Implementation using WebGPU compute shaders.
 * Neighborhood-based computation with configurable weights and edge handling.
 */
import { getGPUDevice } from "../core/gpuContext";
import { createInputBuffer, createOutputBuffer, readbackBuffer, toFloat32, toNumberArray } from "../core/gpuBufferUtils";
import { getOrCreatePipeline } from "../core/gpuKernelCache";
import { buildStencilShader, GPUOperation, WORKGROUP_SIZE } from "../core/gpuShaderBuilder";

class ParallelStencilGPU {
  async stencil(
    op: GPUOperation,
    inputData: number[],
    weights: number[]
  ): Promise<number[]> {
    if (inputData.length === 0) return [];

    const device = await getGPUDevice();
    const length = inputData.length;
    const stencilSize = weights.length;

    const f32Input = toFloat32(inputData);
    const f32Weights = toFloat32(weights);

    const inputBuffer = createInputBuffer(device, f32Input);
    const weightsBuffer = createInputBuffer(device, f32Weights);
    const outputBuffer = createOutputBuffer(device, length * 4);

    const paramsBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(paramsBuffer.getMappedRange()).set([length]);
    paramsBuffer.unmap();

    const shader = buildStencilShader(op, stencilSize);
    const pipeline = getOrCreatePipeline(device, shader, "main");

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: weightsBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
        { binding: 3, resource: { buffer: paramsBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(length / WORKGROUP_SIZE));
    pass.end();
    device.queue.submit([encoder.finish()]);

    const result = await readbackBuffer(device, outputBuffer, length * 4);

    inputBuffer.destroy();
    weightsBuffer.destroy();
    outputBuffer.destroy();
    paramsBuffer.destroy();

    return toNumberArray(result);
  }
}

export { ParallelStencilGPU };
