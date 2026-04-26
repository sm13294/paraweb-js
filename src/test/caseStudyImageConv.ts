import { WorkerPool } from "../core/workerPool";
import { getGPUDevice, isGPUAvailable } from "../core/gpuContext";

const { performance } = require("perf_hooks");
const seedrandom = require("seedrandom");

// 3x3 Gaussian blur kernel (normalized)
const GAUSS_3 = [
  1/16, 2/16, 1/16,
  2/16, 4/16, 2/16,
  1/16, 2/16, 1/16,
];
const KERNEL_SIZE = 3;

function generateImage(width: number, height: number, seed: string): Float32Array {
  const rng = seedrandom(seed);
  const arr = new Float32Array(width * height);
  for (let i = 0; i < arr.length; i++) arr[i] = rng() * 255;
  return arr;
}

function sequentialConv(input: Float32Array, width: number, height: number,
                       kernel: number[], ks: number): Float32Array {
  const khalf = Math.floor(ks / 2);
  const out = new Float32Array(input.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let ky = -khalf; ky <= khalf; ky++) {
        const yy = y + ky;
        if (yy < 0 || yy >= height) continue;
        for (let kx = -khalf; kx <= khalf; kx++) {
          const xx = x + kx;
          if (xx < 0 || xx >= width) continue;
          acc += input[yy * width + xx] * kernel[(ky + khalf) * ks + (kx + khalf)];
        }
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}

// Cache input/output SharedArrayBuffers per image size across calls, symmetric
// with how the GPU path caches its compiled pipeline and buffer allocations.
// The per-call image copy via .set(input) is retained as the CPU-side analogue
// of GPU writeBuffer.
const cpuSabCache = new Map<string, { inSab: SharedArrayBuffer; outSab: SharedArrayBuffer }>();

async function parallelConv(input: Float32Array, width: number, height: number,
                            kernel: number[], ks: number, threads: number): Promise<Float32Array> {
  const byteLen = input.length * 4;
  const key = `${width}x${height}`;
  let sabs = cpuSabCache.get(key);
  if (!sabs) {
    sabs = { inSab: new SharedArrayBuffer(byteLen), outSab: new SharedArrayBuffer(byteLen) };
    cpuSabCache.set(key, sabs);
  }
  const { inSab, outSab } = sabs;
  new Float32Array(inSab).set(input);

  const pool = WorkerPool.getPool("./dist/workers/imageConvWorker.js", threads);
  const rowsPerWorker = Math.ceil(height / threads);
  const messages = [];
  for (let t = 0; t < threads; t++) {
    const yStart = t * rowsPerWorker;
    const yEnd = Math.min(yStart + rowsPerWorker, height);
    if (yStart >= yEnd) continue;
    messages.push({
      input: inSab, output: outSab, width, height,
      kernel, kernelSize: ks, yStart, yEnd,
    });
  }
  await pool.execAll(messages);
  return new Float32Array(outSab).slice();
}

const GPU_WGSL = `
struct Params { width: u32, height: u32 };
@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

const K: array<f32, 9> = array<f32, 9>(
  0.0625, 0.125, 0.0625,
  0.125,  0.25,  0.125,
  0.0625, 0.125, 0.0625
);

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  if (x >= params.width || y >= params.height) { return; }
  var acc: f32 = 0.0;
  for (var ky: i32 = -1; ky <= 1; ky = ky + 1) {
    for (var kx: i32 = -1; kx <= 1; kx = kx + 1) {
      let xx = i32(x) + kx;
      let yy = i32(y) + ky;
      if (xx < 0 || xx >= i32(params.width) || yy < 0 || yy >= i32(params.height)) { continue; }
      let idx = u32(yy) * params.width + u32(xx);
      acc = acc + input[idx] * K[u32(ky + 1) * 3u + u32(kx + 1)];
    }
  }
  output[y * params.width + x] = acc;
}
`;

// Cache the pipeline (compiled WGSL) across invocations; real applications reuse
// the compiled shader across frames rather than recompiling per call. The
// per-size resource cache (buffers, bind group) is also reused so slider-driven
// updates on the same image size only pay upload + dispatch + readback.
let gpuPipeline: any = null;
const gpuResourceCache = new Map<string, any>();

async function gpuConv(input: Float32Array, width: number, height: number): Promise<Float32Array> {
  const device = await getGPUDevice();
  const byteLen = input.length * 4;

  if (!gpuPipeline) {
    const module = device.createShaderModule({ code: GPU_WGSL });
    gpuPipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  const key = `${width}x${height}`;
  let cached = gpuResourceCache.get(key);
  if (!cached) {
    const inputBuf = device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outputBuf = device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const paramsBuf = device.createBuffer({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([width, height]));
    const stagingBuf = device.createBuffer({ size: byteLen, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const bindGroup = device.createBindGroup({
      layout: gpuPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuf } },
        { binding: 1, resource: { buffer: outputBuf } },
        { binding: 2, resource: { buffer: paramsBuf } },
      ],
    });
    cached = { inputBuf, outputBuf, paramsBuf, stagingBuf, bindGroup };
    gpuResourceCache.set(key, cached);
  }
  const { inputBuf, outputBuf, stagingBuf, bindGroup } = cached;

  device.queue.writeBuffer(inputBuf, 0, input.buffer, input.byteOffset, input.byteLength);

  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(gpuPipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
  pass.end();
  enc.copyBufferToBuffer(outputBuf, 0, stagingBuf, 0, byteLen);
  device.queue.submit([enc.finish()]);

  await stagingBuf.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(stagingBuf.getMappedRange().slice(0));
  stagingBuf.unmap();
  return result;
}

interface BenchStats {
  mean: number;
  median: number;
  stddev: number;
  min: number;
  max: number;
}

async function bench(name: string, fn: () => Promise<any> | any, runs = 5, warmup = 2): Promise<BenchStats> {
  // Matches scripts/benchmarkRunner.ts: 5 timed runs after 2 warmups, with
  // mean, median, stddev, min, and max reported so variance is explicit.
  for (let i = 0; i < warmup; i++) await fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const median = times.length % 2 === 0
    ? (sorted[times.length / 2 - 1] + sorted[times.length / 2]) / 2
    : sorted[Math.floor(times.length / 2)];
  const variance = times.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, times.length - 1);
  const stddev = Math.sqrt(variance);
  return { mean, median, stddev, min: sorted[0], max: sorted[sorted.length - 1] };
}

async function main() {
  const sizes = [
    { name: "1080p", w: 1920, h: 1080 },
    { name: "4K",    w: 3840, h: 2160 },
    { name: "8K",    w: 7680, h: 4320 },
  ];

  const threadCounts = [4, 8, 16];
  const gpuReady = await isGPUAvailable();

  console.log("\n=== Case Study: Image Convolution (3x3 Gaussian blur) ===");
  console.log("(5 runs + 2 warmups; time column is mean +/- stddev, with median in parens)\n");
  console.log(`${"Resolution".padEnd(12)}${"Variant".padEnd(18)}${"Time (ms)".padStart(28)}${"Speedup".padStart(12)}`);
  console.log("-".repeat(70));

  const fmt = (s: BenchStats) =>
    `${s.mean.toFixed(1)} +/- ${s.stddev.toFixed(1)} (med ${s.median.toFixed(1)})`;

  for (const sz of sizes) {
    const img = generateImage(sz.w, sz.h, `img-${sz.name}`);

    const seq = await bench("seq", () => { sequentialConv(img, sz.w, sz.h, GAUSS_3, KERNEL_SIZE); return 0; });
    console.log(`${sz.name.padEnd(12)}${"Sequential".padEnd(18)}${fmt(seq).padStart(28)}${"1.00x".padStart(12)}`);

    for (const t of threadCounts) {
      const s = await bench(`par-${t}`, () => parallelConv(img, sz.w, sz.h, GAUSS_3, KERNEL_SIZE, t));
      const speedup = seq.mean / s.mean;
      console.log(`${sz.name.padEnd(12)}${("CPU Shared " + t + "T").padEnd(18)}${fmt(s).padStart(28)}${(speedup.toFixed(2) + "x").padStart(12)}`);
    }

    if (gpuReady) {
      const s = await bench("gpu", () => gpuConv(img, sz.w, sz.h));
      const speedup = seq.mean / s.mean;
      console.log(`${sz.name.padEnd(12)}${"GPU".padEnd(18)}${fmt(s).padStart(28)}${(speedup.toFixed(2) + "x").padStart(12)}`);
    }
    console.log();
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
