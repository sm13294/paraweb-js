/**
 * Scatter Pattern - GPU Implementation using WebGPU compute shaders.
 * Redistributes values into output array based on index mapping.
 */
import { getGPUDevice } from "../core/gpuContext";
import { createInputBuffer, createOutputBuffer, readbackBuffer, toFloat32, toNumberArray } from "../core/gpuBufferUtils";
import { getOrCreatePipeline } from "../core/gpuKernelCache";
import { buildScatterShader, GPUOperation, WORKGROUP_SIZE } from "../core/gpuShaderBuilder";

class ParallelScatterGPU {
  async scatter(
    inputData: number[],
    indices: number[],
    outputLength?: number,
    defaultValue: number = 0,
    preOp?: GPUOperation
  ): Promise<number[]> {
    if (inputData.length === 0) return [];
    if (inputData.length !== indices.length) {
      throw new Error("Input data and indices must have the same length");
    }

    const device = await getGPUDevice();
    const length = inputData.length;
    let maxIdx: number;
    if (outputLength !== undefined) {
      maxIdx = outputLength;
    } else {
      maxIdx = 0;
      for (let i = 0; i < indices.length; i++) {
        if (indices[i] > maxIdx) maxIdx = indices[i];
      }
      maxIdx += 1;
    }

    const f32Input = toFloat32(inputData);
    const u32Indices = new Uint32Array(indices);

    // Create buffers
    const inputBuffer = createInputBuffer(device, f32Input);

    const indicesBuffer = device.createBuffer({
      size: u32Indices.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(indicesBuffer.getMappedRange()).set(u32Indices);
    indicesBuffer.unmap();

    // Output buffer pre-filled with default value
    const outputBuffer = device.createBuffer({
      size: maxIdx * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(outputBuffer.getMappedRange()).fill(defaultValue);
    outputBuffer.unmap();

    // Params: [length, outputLength]
    const paramsBuffer = device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(paramsBuffer.getMappedRange()).set([length, maxIdx]);
    paramsBuffer.unmap();

    const shader = buildScatterShader(preOp);
    const pipeline = getOrCreatePipeline(device, shader, "main");

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: indicesBuffer } },
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

    const result = await readbackBuffer(device, outputBuffer, maxIdx * 4);

    inputBuffer.destroy();
    indicesBuffer.destroy();
    outputBuffer.destroy();
    paramsBuffer.destroy();

    return toNumberArray(result);
  }
}

export { ParallelScatterGPU };
