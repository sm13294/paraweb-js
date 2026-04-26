/**
 * Divide and Conquer Pattern - GPU Implementation.
 * CPU handles recursive decomposition to leaf subproblems.
 * All leaf data is batched into a single flat array and processed
 * in one GPU dispatch, then results are split back and recombined
 * on the CPU using the combine function.
 */
import { ParallelMapGPU } from "./mapGPU";
import { buildBitonicSortKernel, buildFFTButterflyKernel, GPUOperation, WORKGROUP_SIZE } from "../core/gpuShaderBuilder";
import { getGPUDevice } from "../core/gpuContext";
import { createReadWriteBuffer, readbackBuffer, toFloat32 } from "../core/gpuBufferUtils";
import { getOrCreatePipeline } from "../core/gpuKernelCache";
import { bitReversePermute, isPowerOfTwo } from "../core/fftUtils";

interface DivideAndConquerGPUOptions {
  /** Operation to apply to leaf data on GPU */
  conquerOp: GPUOperation;
  /** CPU-side divide function that splits data into subproblems */
  divideFn: (data: number[]) => number[][];
  /** CPU-side combine function that merges subproblem results */
  combineFn: (results: number[][]) => number[];
  /** Base case threshold: if data.length <= threshold, it is a leaf */
  threshold: number;
}

// Tree node for tracking divide structure
type DivideNode =
  | { type: "leaf"; offset: number; length: number }
  | { type: "branch"; children: DivideNode[] };

class ParallelDivideAndConquerGPU {
  private mapper = new ParallelMapGPU();

  async divideAndConquer(
    inputData: number[],
    options: DivideAndConquerGPUOptions
  ): Promise<number[]> {
    if (inputData.length === 0) return [];

    // Phase 1: Recursively divide on CPU, collecting leaf data into a flat array
    const leafChunks: number[][] = [];
    const tree = this.buildTree(inputData, options, leafChunks);

    // Phase 2: Batch all leaf data into one flat array
    const totalElements = leafChunks.reduce((sum, c) => sum + c.length, 0);
    const flatData = new Array<number>(totalElements);
    let offset = 0;
    for (const chunk of leafChunks) {
      for (let i = 0; i < chunk.length; i++) {
        flatData[offset + i] = chunk[i];
      }
      offset += chunk.length;
    }

    // Phase 3: Single GPU dispatch for all leaf computation
    const gpuResult = await this.mapper.map(options.conquerOp, flatData);

    // Phase 4: Split GPU results back into per-leaf arrays
    const leafResults: number[][] = [];
    offset = 0;
    for (const chunk of leafChunks) {
      leafResults.push(gpuResult.slice(offset, offset + chunk.length));
      offset += chunk.length;
    }

    // Phase 5: Recombine on CPU using the tree structure
    return this.recombine(tree, leafResults, options.combineFn);
  }

  private buildTree(
    data: number[],
    options: DivideAndConquerGPUOptions,
    leafChunks: number[][]
  ): DivideNode {
    if (data.length <= options.threshold) {
      const leafIndex = leafChunks.length;
      leafChunks.push(data);
      return { type: "leaf", offset: leafIndex, length: data.length };
    }

    const subproblems = options.divideFn(data);
    if (!subproblems || subproblems.length === 0) {
      const leafIndex = leafChunks.length;
      leafChunks.push(data);
      return { type: "leaf", offset: leafIndex, length: data.length };
    }

    const children = subproblems.map((sp) =>
      this.buildTree(sp, options, leafChunks)
    );
    return { type: "branch", children };
  }

  private recombine(
    node: DivideNode,
    leafResults: number[][],
    combineFn: (results: number[][]) => number[]
  ): number[] {
    if (node.type === "leaf") {
      return leafResults[node.offset];
    }
    const childResults = node.children.map((child) =>
      this.recombine(child, leafResults, combineFn)
    );
    return combineFn(childResults);
  }

  /**
   * Sort an array on the GPU using parallel bitonic sort. Bitonic sort is a
   * divide-and-conquer sorting algorithm whose comparator network parallelises
   * naturally on SIMD-style hardware: log2(N) major stages, each with up to
   * log2(k) substages, are issued as kernel dispatches over the input. Input
   * is padded to the next power of two with +infinity so padding sorts to the
   * end and is dropped on readback. Total work is O(N log^2 N) compares.
   */
  async sort(inputData: number[]): Promise<number[]> {
    const n = inputData.length;
    if (n <= 1) return inputData.slice();
    const device = await getGPUDevice();

    // Round up to next power of two and pad with +infinity (sorts to the end).
    let m = 1;
    while (m < n) m <<= 1;
    const padded = new Float32Array(m);
    const f32 = toFloat32(inputData);
    padded.set(f32);
    for (let i = n; i < m; i++) padded[i] = Infinity;

    const dataBuffer = createReadWriteBuffer(device, m * 4);
    device.queue.writeBuffer(dataBuffer, 0, padded.buffer, padded.byteOffset, padded.byteLength);

    const shader = buildBitonicSortKernel();
    const pipeline = getOrCreatePipeline(device, shader, "main");

    // One dispatch per (k, j) pair. Each rebuilds a 12-byte uniform; we reuse a
    // single host-side buffer to avoid 300+ tiny GPU allocations on N=2^24.
    const paramsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const paramsHost = new Uint32Array(4); // [k, j, n, _pad]
    paramsHost[2] = m;

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: dataBuffer } },
        { binding: 1, resource: { buffer: paramsBuffer } },
      ],
    });

    // Submit one encoder per substage so the queue serialises them; using a
    // single encoder with multiple dispatches against the same storage buffer
    // would still be safe (compute-pass barriers are implicit between
    // dispatches), but per-substage submission keeps memory pressure low.
    // Each thread handles one pair, so we need m/2 threads.
    const dispatchCount = Math.ceil((m / 2) / WORKGROUP_SIZE);
    for (let k = 2; k <= m; k <<= 1) {
      for (let j = k >> 1; j > 0; j >>= 1) {
        paramsHost[0] = k;
        paramsHost[1] = j;
        device.queue.writeBuffer(paramsBuffer, 0, paramsHost.buffer, paramsHost.byteOffset, paramsHost.byteLength);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(dispatchCount);
        pass.end();
        device.queue.submit([encoder.finish()]);
      }
    }

    const readback = await readbackBuffer(device, dataBuffer, m * 4);
    dataBuffer.destroy();
    paramsBuffer.destroy();

    // Trim padding (Infinity sentinels at the tail).
    const result = new Array<number>(n);
    for (let i = 0; i < n; i++) result[i] = readback[i];
    return result;
  }

  /**
   * Compute an N-point FFT on the GPU using bottom-up Cooley-Tukey radix-2.
   * Input is a complex array stored as interleaved (re, im) in a Float64Array
   * (or plain number[]) of length 2*N; N must be a power of two. The output
   * follows the same layout. Bit-reversal permutation is performed on the CPU
   * once, then log2(N) butterfly stages are issued as kernel dispatches over
   * the on-device buffer (no readback between stages).
   */
  async fft(complexData: Float64Array | number[]): Promise<Float64Array> {
    const data = complexData instanceof Float64Array
      ? new Float64Array(complexData)            // own copy; we permute in place
      : Float64Array.from(complexData);
    const N = data.length / 2;
    if (N <= 1) return data;
    if (!isPowerOfTwo(N)) throw new Error(`ParallelDivideAndConquerGPU.fft: N must be power of two, got ${N}`);

    // Bit-reverse permute on CPU (cheap relative to the butterflies).
    bitReversePermute(data);

    const device = await getGPUDevice();
    // GPU works in f32. Convert before upload.
    const f32 = new Float32Array(2 * N);
    for (let i = 0; i < f32.length; i++) f32[i] = data[i];

    const dataBuffer = createReadWriteBuffer(device, 2 * N * 4);
    device.queue.writeBuffer(dataBuffer, 0, f32.buffer, f32.byteOffset, f32.byteLength);

    const shader = buildFFTButterflyKernel();
    const pipeline = getOrCreatePipeline(device, shader, "main");

    // 16-byte uniform: [m, half, n, _pad]
    const paramsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const paramsHost = new Uint32Array(4);
    paramsHost[2] = N;

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: dataBuffer } },
        { binding: 1, resource: { buffer: paramsBuffer } },
      ],
    });

    const dispatchCount = Math.ceil((N / 2) / WORKGROUP_SIZE);
    const bits = Math.log2(N) | 0;
    for (let s = 1; s <= bits; s++) {
      const m = 1 << s;
      const half = m >> 1;
      paramsHost[0] = m;
      paramsHost[1] = half;
      device.queue.writeBuffer(paramsBuffer, 0, paramsHost.buffer, paramsHost.byteOffset, paramsHost.byteLength);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(dispatchCount);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    const readback = await readbackBuffer(device, dataBuffer, 2 * N * 4);
    dataBuffer.destroy();
    paramsBuffer.destroy();

    const out = new Float64Array(2 * N);
    for (let i = 0; i < out.length; i++) out[i] = readback[i];
    return out;
  }
}

export { ParallelDivideAndConquerGPU };
