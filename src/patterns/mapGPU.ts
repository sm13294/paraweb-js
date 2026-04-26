/**
 * Map Pattern - GPU Implementation using WebGPU compute shaders.
 * Applies an operation to each element of the input array in parallel on the GPU.
 */
import { getGPUDevice } from "../core/gpuContext";
import { createInputBuffer, createOutputBuffer, readbackBuffer, toFloat32, toNumberArray } from "../core/gpuBufferUtils";
import { getOrCreatePipeline } from "../core/gpuKernelCache";
import { buildMapShader, GPUOperation, WORKGROUP_SIZE } from "../core/gpuShaderBuilder";

class ParallelMapGPU {
  async map(
    op: GPUOperation,
    inputData: number[]
  ): Promise<number[]> {
    if (inputData.length === 0) return [];

    const device = await getGPUDevice();
    const length = inputData.length;
    const f32Data = toFloat32(inputData);

    // Create buffers
    const inputBuffer = createInputBuffer(device, f32Data);
    const outputBuffer = createOutputBuffer(device, length * 4);
    const paramsData = new Uint32Array([length]);
    const paramsBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(paramsBuffer.getMappedRange()).set(paramsData);
    paramsBuffer.unmap();

    // Build and run pipeline
    const shader = buildMapShader(op);
    const pipeline = getOrCreatePipeline(device, shader, "main");

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: outputBuffer } },
        { binding: 2, resource: { buffer: paramsBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(length / WORKGROUP_SIZE));
    pass.end();
    device.queue.submit([encoder.finish()]);

    // Readback
    const result = await readbackBuffer(device, outputBuffer, length * 4);

    // Cleanup
    inputBuffer.destroy();
    outputBuffer.destroy();
    paramsBuffer.destroy();

    return toNumberArray(result);
  }
}

export { ParallelMapGPU };
