/**
 * Reduce Pattern - GPU Implementation using WebGPU compute shaders.
 * Hierarchical reduction: workgroup-level parallel reduction, then CPU combination.
 */
import { getGPUDevice } from "../core/gpuContext";
import { createInputBuffer, createReadWriteBuffer, readbackBuffer, toFloat32 } from "../core/gpuBufferUtils";
import { getOrCreatePipeline } from "../core/gpuKernelCache";
import { buildReduceShader, GPUBinaryOperation, GPUOperation, WORKGROUP_SIZE } from "../core/gpuShaderBuilder";

class ParallelReduceGPU {
  async reduce(
    op: GPUBinaryOperation,
    inputData: number[],
    initialValue?: number,
    preOp?: GPUOperation
  ): Promise<number> {
    const identity = this.getIdentity(op);
    const hasInitialValue = initialValue !== undefined;
    const initVal = hasInitialValue ? initialValue : identity;

    if (inputData.length === 0) return initVal;
    if (inputData.length === 1) {
      return hasInitialValue && initialValue !== identity
        ? this.applyBinaryOp(op, initialValue, inputData[0])
        : inputData[0];
    }

    const device = await getGPUDevice();
    const f32 = toFloat32(inputData);

    // Hierarchical reduction with ping-pong GPU buffers. The key is that
    // intermediate level outputs stay on the GPU; we only read back the
    // final single value. Previously we round-tripped each level's output
    // through the CPU, which was expensive over the Dawn/Node.js IPC
    // boundary (several hundred ms per readback).
    // When preOp is given, the first stage reads raw input and applies preOp
    // before the tree reduction; subsequent stages read already-reduced
    // partial values and must NOT re-apply preOp.
    const firstStageShader = buildReduceShader(op, identity, preOp);
    const firstStagePipeline = getOrCreatePipeline(device, firstStageShader, "main");
    const laterStageShader = preOp !== undefined ? buildReduceShader(op, identity) : firstStageShader;
    const laterStagePipeline = preOp !== undefined
      ? getOrCreatePipeline(device, laterStageShader, "main")
      : firstStagePipeline;

    // Build the full chain of bind groups up front; then dispatch them all
    // within a single compute pass and a single queue.submit(). This avoids
    // per-level Dawn/IPC sync costs and keeps intermediate results on the GPU.
    let currentLength = f32.length;
    let currentBuffer = createInputBuffer(device, f32); // uploaded once
    const buffersToDestroy: GPUBuffer[] = [currentBuffer];
    const stages: Array<{ bindGroup: GPUBindGroup; workgroups: number; pipeline: GPUComputePipeline }> = [];
    let isFirst = true;

    while (currentLength > 1) {
      const numWorkgroups = Math.ceil(currentLength / WORKGROUP_SIZE);
      const outBuf = createReadWriteBuffer(device, numWorkgroups * 4);
      buffersToDestroy.push(outBuf);

      const paramsBuffer = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Uint32Array(paramsBuffer.getMappedRange()).set([currentLength]);
      paramsBuffer.unmap();
      buffersToDestroy.push(paramsBuffer);

      const stagePipeline = isFirst ? firstStagePipeline : laterStagePipeline;
      const bindGroup = device.createBindGroup({
        layout: stagePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: currentBuffer } },
          { binding: 1, resource: { buffer: outBuf } },
          { binding: 2, resource: { buffer: paramsBuffer } },
        ],
      });

      stages.push({ bindGroup, workgroups: numWorkgroups, pipeline: stagePipeline });
      currentBuffer = outBuf;
      currentLength = numWorkgroups;
      isFirst = false;
    }

    // One encoder, one compute pass, one submit — all stages in a single GPU batch.
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    for (const st of stages) {
      pass.setPipeline(st.pipeline);
      pass.setBindGroup(0, st.bindGroup);
      pass.dispatchWorkgroups(st.workgroups);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);

    // Single readback of the final scalar result.
    const finalData = await readbackBuffer(device, currentBuffer, 4);
    for (const b of buffersToDestroy) b.destroy();

    const result = finalData[0];
    if (hasInitialValue && initialValue !== identity) {
      return this.applyBinaryOp(op, initialValue, result);
    }
    return result;
  }

  private getIdentity(op: GPUBinaryOperation): number {
    const name = typeof op === "string" ? op : "";
    switch (name) {
      case "add": return 0;
      case "multiply": return 1;
      case "min": return 3.402823e+38;  // f32 max
      case "max": return -3.402823e+38; // f32 min
      default: return 0;
    }
  }

  private applyBinaryOp(op: GPUBinaryOperation, a: number, b: number): number {
    const name = typeof op === "string" ? op : "";
    switch (name) {
      case "add": return a + b;
      case "multiply": return a * b;
      case "min": return Math.min(a, b);
      case "max": return Math.max(a, b);
      default: return a + b; // Default to addition
    }
  }
}

export { ParallelReduceGPU };
