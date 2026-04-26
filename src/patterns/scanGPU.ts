/**
 * Prefix-Scan Pattern — parallel Blelloch scan on WebGPU.
 *
 * Each workgroup scans a `SCAN_BLOCK_SIZE`-element block using Blelloch's
 * up-sweep/down-sweep in shared memory (see `buildBlockScanShader`). The
 * per-block totals are then recursively scanned with the same kernel and
 * added back into each block's output with a uniform-add shader. Compared
 * to the previous single-workgroup sequential kernel this gives true
 * parallelism across workgroups at the cost of three kernel invocations per
 * level of recursion (2 levels at 10M elements with a 512-element block).
 */
import { getGPUDevice } from "../core/gpuContext";
import { createInputBuffer, createReadWriteBuffer, readbackBuffer, toFloat32 } from "../core/gpuBufferUtils";
import { getOrCreatePipeline } from "../core/gpuKernelCache";
import {
  buildBlockScanShader,
  buildMapShader,
  buildUniformAddShader,
  GPUBinaryOperation,
  GPUOperation,
  SCAN_BLOCK_SIZE,
  WORKGROUP_SIZE,
} from "../core/gpuShaderBuilder";

interface LevelPlan {
  inputBuffer: GPUBuffer;
  outputBuffer: GPUBuffer;
  blockSumsBuffer: GPUBuffer;
  length: number;
  numBlocks: number;
}

class ParallelScanGPU {
  async scan(
    op: GPUBinaryOperation,
    inputData: number[],
    identity?: number,
    preOp?: GPUOperation
  ): Promise<number[]> {
    const id = identity !== undefined ? identity : this.getIdentity(op);
    if (inputData.length === 0) return [];

    const device = await getGPUDevice();
    const data = toFloat32(inputData);
    const length = data.length;

    // Build (or fetch) the two compute pipelines we will reuse at every level.
    const blockScanShader = buildBlockScanShader(op, id);
    const uniformAddShader = buildUniformAddShader(op, id);
    const blockScanPipeline = getOrCreatePipeline(device, blockScanShader, "main");
    const uniformAddPipeline = getOrCreatePipeline(device, uniformAddShader, "main");

    const buffersToDestroy: GPUBuffer[] = [];
    let inputBuffer = createInputBuffer(device, data);
    buffersToDestroy.push(inputBuffer);

    // When a per-element transform is supplied, fuse it via a Map pre-pass
    // that writes transformed values to a fresh on-GPU buffer, which the
    // block-scan then consumes. Keeps everything on the device.
    if (preOp !== undefined) {
      const mapShader = buildMapShader(preOp);
      const mapPipeline = getOrCreatePipeline(device, mapShader, "main");
      const transformedBuffer = createReadWriteBuffer(device, length * 4);
      buffersToDestroy.push(transformedBuffer);
      const mapParamsBuffer = this.makeParamsBuffer(device, length);
      buffersToDestroy.push(mapParamsBuffer);
      const mapEncoder = device.createCommandEncoder();
      const mapPass = mapEncoder.beginComputePass();
      mapPass.setPipeline(mapPipeline);
      mapPass.setBindGroup(0, device.createBindGroup({
        layout: mapPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputBuffer } },
          { binding: 1, resource: { buffer: transformedBuffer } },
          { binding: 2, resource: { buffer: mapParamsBuffer } },
        ],
      }));
      mapPass.dispatchWorkgroups(Math.ceil(length / WORKGROUP_SIZE));
      mapPass.end();
      device.queue.submit([mapEncoder.finish()]);
      inputBuffer = transformedBuffer;
    }

    // Set up the chain of levels. The first level scans `input -> output`;
    // each subsequent level scans the previous level's block-sums buffer
    // into a fresh scratch buffer. Recursion ends when a level has a single
    // block (its block-sums output is the grand total and is not used).
    const finalOutput = createReadWriteBuffer(device, length * 4);
    buffersToDestroy.push(finalOutput);

    const levels: LevelPlan[] = [];
    let currentIn: GPUBuffer = inputBuffer;
    let currentOut: GPUBuffer = finalOutput;
    let currentLength = length;

    while (true) {
      const numBlocks = Math.ceil(currentLength / SCAN_BLOCK_SIZE);
      const blockSumsBuf = createReadWriteBuffer(device, numBlocks * 4);
      buffersToDestroy.push(blockSumsBuf);
      levels.push({
        inputBuffer: currentIn,
        outputBuffer: currentOut,
        blockSumsBuffer: blockSumsBuf,
        length: currentLength,
        numBlocks,
      });
      if (numBlocks <= 1) break;
      const nextOut = createReadWriteBuffer(device, numBlocks * 4);
      buffersToDestroy.push(nextOut);
      currentIn = blockSumsBuf;
      currentOut = nextOut;
      currentLength = numBlocks;
    }

    // Single encoder, single compute pass — the driver serializes dispatches
    // on the same storage buffer, so the block-scan of level n completes
    // before the block-scan of level n+1 reads its input.
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();

    pass.setPipeline(blockScanPipeline);
    for (const lvl of levels) {
      const paramsBuf = this.makeParamsBuffer(device, lvl.length);
      buffersToDestroy.push(paramsBuf);
      const bg = device.createBindGroup({
        layout: blockScanPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: lvl.inputBuffer } },
          { binding: 1, resource: { buffer: lvl.outputBuffer } },
          { binding: 2, resource: { buffer: lvl.blockSumsBuffer } },
          { binding: 3, resource: { buffer: paramsBuf } },
        ],
      });
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(lvl.numBlocks);
    }

    // Apply offsets from deepest level downward. The bottom-most level has
    // a single block and therefore needs no offset.
    pass.setPipeline(uniformAddPipeline);
    for (let i = levels.length - 2; i >= 0; i--) {
      const lvl = levels[i];
      const offsets = levels[i + 1].outputBuffer; // scanned block-sums of level i
      const paramsBuf = this.makeParamsBuffer(device, lvl.length);
      buffersToDestroy.push(paramsBuf);
      const bg = device.createBindGroup({
        layout: uniformAddPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: lvl.outputBuffer } },
          { binding: 1, resource: { buffer: offsets } },
          { binding: 2, resource: { buffer: paramsBuf } },
        ],
      });
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(lvl.length / WORKGROUP_SIZE));
    }

    pass.end();
    device.queue.submit([encoder.finish()]);

    const result = await readbackBuffer(device, finalOutput, length * 4);
    for (const b of buffersToDestroy) b.destroy();
    return Array.from(result);
  }

  private makeParamsBuffer(device: GPUDevice, length: number): GPUBuffer {
    const buf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(buf.getMappedRange()).set([length]);
    buf.unmap();
    return buf;
  }

  private getIdentity(op: GPUBinaryOperation): number {
    const name = typeof op === "string" ? op : "";
    switch (name) {
      case "add": return 0;
      case "multiply": return 1;
      case "min": return 3.402823e+38;
      case "max": return -3.402823e+38;
      default: return 0;
    }
  }
}

export { ParallelScanGPU };
