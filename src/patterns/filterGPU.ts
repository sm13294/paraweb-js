/**
 * Filter Pattern - GPU Implementation using WebGPU compute shaders.
 * Three-phase stream compaction: mark, prefix sum, compact.
 */
import { getGPUDevice } from "../core/gpuContext";
import { createInputBuffer, createOutputBuffer, readbackBuffer, readbackUint32Buffer, toFloat32, toNumberArray } from "../core/gpuBufferUtils";
import { getOrCreatePipeline } from "../core/gpuKernelCache";
import { buildFilterMarkShader, buildPrefixSumShader, buildFilterCompactShader, GPUPredicate, WORKGROUP_SIZE } from "../core/gpuShaderBuilder";

class ParallelFilterGPU {
  async filter(
    pred: GPUPredicate,
    inputData: number[],
    threshold?: number
  ): Promise<number[]> {
    if (inputData.length === 0) return [];

    const device = await getGPUDevice();
    const length = inputData.length;
    const f32Data = toFloat32(inputData);
    const hasThreshold = threshold !== undefined;

    // Create input buffer
    const inputBuffer = createInputBuffer(device, f32Data);

    // Create flags buffer (u32 per element)
    const flagsBuffer = createOutputBuffer(device, length * 4);

    // Create params
    const paramsSize = hasThreshold ? 8 : 4;
    const paramsBuffer = device.createBuffer({
      size: paramsSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    if (hasThreshold) {
      const view = new DataView(paramsBuffer.getMappedRange());
      view.setUint32(0, length, true);
      view.setFloat32(4, threshold!, true);
    } else {
      new Uint32Array(paramsBuffer.getMappedRange()).set([length]);
    }
    paramsBuffer.unmap();

    // Phase 1: Mark elements
    const markShader = buildFilterMarkShader(pred, hasThreshold);
    const markPipeline = getOrCreatePipeline(device, markShader, "main");
    const markBindGroup = device.createBindGroup({
      layout: markPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: flagsBuffer } },
        { binding: 2, resource: { buffer: paramsBuffer } },
      ],
    });

    let encoder = device.createCommandEncoder();
    let pass = encoder.beginComputePass();
    pass.setPipeline(markPipeline);
    pass.setBindGroup(0, markBindGroup);
    pass.dispatchWorkgroups(Math.ceil(length / WORKGROUP_SIZE));
    pass.end();
    device.queue.submit([encoder.finish()]);

    // Phase 2: Prefix sum (scan[length] holds total count)
    const scanBuffer = createOutputBuffer(device, (length + 1) * 4);
    const scanParamsBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(scanParamsBuffer.getMappedRange()).set([length]);
    scanParamsBuffer.unmap();

    const scanShader = buildPrefixSumShader();
    const scanPipeline = getOrCreatePipeline(device, scanShader, "main");
    const scanBindGroup = device.createBindGroup({
      layout: scanPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: flagsBuffer } },
        { binding: 1, resource: { buffer: scanBuffer } },
        { binding: 2, resource: { buffer: scanParamsBuffer } },
      ],
    });

    encoder = device.createCommandEncoder();
    pass = encoder.beginComputePass();
    pass.setPipeline(scanPipeline);
    pass.setBindGroup(0, scanBindGroup);
    pass.dispatchWorkgroups(1); // Sequential scan - single workgroup
    pass.end();
    device.queue.submit([encoder.finish()]);

    // Read total count from scan[length]
    const scanData = await readbackUint32Buffer(device, scanBuffer, (length + 1) * 4);
    const totalCount = scanData[length];

    if (totalCount === 0) {
      inputBuffer.destroy();
      flagsBuffer.destroy();
      paramsBuffer.destroy();
      scanBuffer.destroy();
      scanParamsBuffer.destroy();
      return [];
    }

    // Phase 3: Compact
    const outputBuffer = createOutputBuffer(device, totalCount * 4);
    const compactShader = buildFilterCompactShader();
    const compactPipeline = getOrCreatePipeline(device, compactShader, "main");
    const compactBindGroup = device.createBindGroup({
      layout: compactPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: flagsBuffer } },
        { binding: 2, resource: { buffer: scanBuffer } },
        { binding: 3, resource: { buffer: outputBuffer } },
        { binding: 4, resource: { buffer: paramsBuffer } },
      ],
    });

    encoder = device.createCommandEncoder();
    pass = encoder.beginComputePass();
    pass.setPipeline(compactPipeline);
    pass.setBindGroup(0, compactBindGroup);
    pass.dispatchWorkgroups(Math.ceil(length / WORKGROUP_SIZE));
    pass.end();
    device.queue.submit([encoder.finish()]);

    const result = await readbackBuffer(device, outputBuffer, totalCount * 4);

    // Cleanup
    inputBuffer.destroy();
    flagsBuffer.destroy();
    paramsBuffer.destroy();
    scanBuffer.destroy();
    scanParamsBuffer.destroy();
    outputBuffer.destroy();

    return toNumberArray(result);
  }
}

export { ParallelFilterGPU };
