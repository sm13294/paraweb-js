import { ensureSharedArrayBuffer } from "./workerUtils.js";

// ---------- Filter / kernel builders ----------
// A filter spec is either:
//   { mode: "separable", kernel1D: Float32Array, radius: int, bias: 0,    alphaPassthrough: true }
// or:
//   { mode: "2d",        kernel2D: Float32Array, size: int,  bias: float, alphaPassthrough: true }

function buildGaussianKernel1D(radius) {
  const size = radius * 2 + 1;
  const sigma = Math.max(0.8, radius * 0.5);
  const kernel = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += kernel[i];
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;
  return { kernel, size, sigma };
}

function buildBoxKernel1D(radius) {
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  kernel.fill(1 / size);
  return { kernel, size };
}

// Directional emboss at radius r. Size = 2r+1 non-separable kernel whose values
// follow a diagonal gradient (i - r + j - r), normalized so a sharp diagonal
// edge produces ~255-magnitude output.
function buildEmbossKernelNxN(radius) {
  const size = 2 * radius + 1;
  const kernel = new Float32Array(size * size);
  let posSum = 0;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const v = (i - radius) + (j - radius);
      kernel[i * size + j] = v;
      if (v > 0) posSum += v;
    }
  }
  const norm = Math.max(1, posSum);
  for (let k = 0; k < kernel.length; k++) kernel[k] /= norm;
  return { kernel, size };
}

function buildFilterSpec(filterId, sliderVal) {
  const radius = Math.max(1, Math.min(20, sliderVal));
  switch (filterId) {
    case "gaussian": {
      const { kernel, size, sigma } = buildGaussianKernel1D(radius);
      return { mode: "separable", kernel1D: kernel, radius, bias: 0,
               label: `radius=${radius} (${size}x${size}, sigma=${sigma.toFixed(2)})` };
    }
    case "box": {
      const { kernel, size } = buildBoxKernel1D(radius);
      return { mode: "separable", kernel1D: kernel, radius, bias: 0,
               label: `radius=${radius} (${size}x${size} box)` };
    }
    case "sharpen": {
      // Unsharp mask: out = img + amount * (img - gauss_r(img))
      const { kernel, size } = buildGaussianKernel1D(radius);
      const amount = 1.0;
      return { mode: "unsharp_mask", kernel1D: kernel, radius, amount,
               label: `radius=${radius} (${size}x${size} unsharp mask, amount=${amount.toFixed(1)})` };
    }
    case "edge": {
      // Difference of Gaussians: amp * (gauss_r - gauss_2r) + bias.
      const rLarge = Math.min(20, radius * 2);
      const small = buildGaussianKernel1D(radius);
      const large = buildGaussianKernel1D(rLarge);
      return { mode: "dog",
               kernel1D_small: small.kernel, rSmall: radius,
               kernel1D_large: large.kernel, rLarge,
               amp: 6.0, bias: 128,
               label: `radius=${radius} (DoG r=${radius} vs ${rLarge})` };
    }
    case "emboss": {
      const { kernel, size } = buildEmbossKernelNxN(radius);
      return { mode: "2d", kernel2D: kernel, size, bias: 128,
               label: `radius=${radius} (${size}x${size} emboss)` };
    }
    default:
      throw new Error("Unknown filter: " + filterId);
  }
}

// ---------- Sequential separable convolution ----------
// RGBA stored as Float32Array of length w*h*4.
// Separable: horizontal pass then vertical pass.

function seqConvRGBA(src, width, height, kernel, radius) {
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -radius; k <= radius; k++) {
        let xx = x + k;
        if (xx < 0) xx = 0; else if (xx >= width) xx = width - 1;
        const w = kernel[k + radius];
        const idx = (y * width + xx) * 4;
        r += src[idx] * w;
        g += src[idx + 1] * w;
        b += src[idx + 2] * w;
        a += src[idx + 3] * w;
      }
      const o = (y * width + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -radius; k <= radius; k++) {
        let yy = y + k;
        if (yy < 0) yy = 0; else if (yy >= height) yy = height - 1;
        const w = kernel[k + radius];
        const idx = (yy * width + x) * 4;
        r += tmp[idx] * w;
        g += tmp[idx + 1] * w;
        b += tmp[idx + 2] * w;
        a += tmp[idx + 3] * w;
      }
      const o = (y * width + x) * 4;
      dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; dst[o + 3] = a;
    }
  }
  return dst;
}

// ---------- Sequential 2D (non-separable) convolution ----------
// Alpha channel is passed through unchanged (for fixed small kernels it would
// just re-normalize to ~255 anyway). Bias is added to R/G/B after the sum.

function seqConv2D_RGBA(src, width, height, kernel2D, size, bias) {
  const half = (size - 1) >> 1;
  const dst = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = -half; ky <= half; ky++) {
        let yy = y + ky;
        if (yy < 0) yy = 0; else if (yy >= height) yy = height - 1;
        for (let kx = -half; kx <= half; kx++) {
          let xx = x + kx;
          if (xx < 0) xx = 0; else if (xx >= width) xx = width - 1;
          const w = kernel2D[(ky + half) * size + (kx + half)];
          const idx = (yy * width + xx) * 4;
          r += src[idx] * w;
          g += src[idx + 1] * w;
          b += src[idx + 2] * w;
        }
      }
      const o = (y * width + x) * 4;
      dst[o] = r + bias; dst[o + 1] = g + bias; dst[o + 2] = b + bias;
      dst[o + 3] = src[o + 3];
    }
  }
  return dst;
}

// ---------- Sequential composite filters ----------
// Unsharp mask: out = img + amount * (img - gauss_r(img))
function seqUnsharpMask_RGBA(src, width, height, kernel, radius, amount) {
  const blur = seqConvRGBA(src, width, height, kernel, radius);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i]     = src[i]     + amount * (src[i]     - blur[i]);
    out[i + 1] = src[i + 1] + amount * (src[i + 1] - blur[i + 1]);
    out[i + 2] = src[i + 2] + amount * (src[i + 2] - blur[i + 2]);
    out[i + 3] = src[i + 3];
  }
  return out;
}

// DoG: out = amp * (gauss_r(img) - gauss_rLarge(img)) + bias
function seqDoG_RGBA(src, width, height, kSmall, rSmall, kLarge, rLarge, amp, bias) {
  const b1 = seqConvRGBA(src, width, height, kSmall, rSmall);
  const b2 = seqConvRGBA(src, width, height, kLarge, rLarge);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i]     = amp * (b1[i]     - b2[i])     + bias;
    out[i + 1] = amp * (b1[i + 1] - b2[i + 1]) + bias;
    out[i + 2] = amp * (b1[i + 2] - b2[i + 2]) + bias;
    out[i + 3] = src[i + 3];
  }
  return out;
}

// ---------- CPU-Shared variant (Web Workers + SharedArrayBuffer) ----------

const SHARED_WORKER_SOURCE = `
  self.onmessage = (ev) => {
    const d = ev.data;
    try {
      if (d.cmd === "conv2d") {
        const src = new Float32Array(d.srcSAB);
        const dst = new Float32Array(d.dstSAB);
        const kernel = new Float32Array(d.kernelSAB);
        const { width, height, size, bias, yStart, yEnd } = d;
        const half = (size - 1) >> 1;
        for (let y = yStart; y < yEnd; y++) {
          for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0;
            for (let ky = -half; ky <= half; ky++) {
              let yy = y + ky;
              if (yy < 0) yy = 0; else if (yy >= height) yy = height - 1;
              for (let kx = -half; kx <= half; kx++) {
                let xx = x + kx;
                if (xx < 0) xx = 0; else if (xx >= width) xx = width - 1;
                const w = kernel[(ky + half) * size + (kx + half)];
                const idx = (yy * width + xx) * 4;
                r += src[idx] * w;
                g += src[idx + 1] * w;
                b += src[idx + 2] * w;
              }
            }
            const o = (y * width + x) * 4;
            dst[o] = r + bias; dst[o + 1] = g + bias; dst[o + 2] = b + bias;
            dst[o + 3] = src[o + 3];
          }
        }
      } else if (d.cmd === "combine") {
        const a = new Float32Array(d.aSAB);
        const b = new Float32Array(d.bSAB);
        const out = new Float32Array(d.outSAB);
        const alphaSrc = d.alphaSAB ? new Float32Array(d.alphaSAB) : null;
        const { width, coefA, coefB, bias, useSrcAlpha, yStart, yEnd } = d;
        for (let y = yStart; y < yEnd; y++) {
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            out[i]     = coefA * a[i]     + coefB * b[i]     + bias;
            out[i + 1] = coefA * a[i + 1] + coefB * b[i + 1] + bias;
            out[i + 2] = coefA * a[i + 2] + coefB * b[i + 2] + bias;
            out[i + 3] = (useSrcAlpha && alphaSrc) ? alphaSrc[i + 3] : 255;
          }
        }
      } else if (d.cmd === "hpass") {
        const src = new Float32Array(d.srcSAB);
        const tmp = new Float32Array(d.tmpSAB);
        const kernel = new Float32Array(d.kernelSAB);
        const { width, height, radius, yStart, yEnd } = d;
        for (let y = yStart; y < yEnd; y++) {
          for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let k = -radius; k <= radius; k++) {
              let xx = x + k;
              if (xx < 0) xx = 0; else if (xx >= width) xx = width - 1;
              const w = kernel[k + radius];
              const idx = (y * width + xx) * 4;
              r += src[idx] * w;
              g += src[idx + 1] * w;
              b += src[idx + 2] * w;
              a += src[idx + 3] * w;
            }
            const o = (y * width + x) * 4;
            tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
          }
        }
      } else if (d.cmd === "vpass") {
        const tmp = new Float32Array(d.tmpSAB);
        const dst = new Float32Array(d.dstSAB);
        const kernel = new Float32Array(d.kernelSAB);
        const { width, height, radius, yStart, yEnd } = d;
        for (let y = yStart; y < yEnd; y++) {
          for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let k = -radius; k <= radius; k++) {
              let yy = y + k;
              if (yy < 0) yy = 0; else if (yy >= height) yy = height - 1;
              const w = kernel[k + radius];
              const idx = (yy * width + x) * 4;
              r += tmp[idx] * w;
              g += tmp[idx + 1] * w;
              b += tmp[idx + 2] * w;
              a += tmp[idx + 3] * w;
            }
            const o = (y * width + x) * 4;
            dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; dst[o + 3] = a;
          }
        }
      }
      self.postMessage("done");
    } catch (e) {
      self.postMessage({ error: true, message: String(e) });
    }
  };
`;

class SharedConvPool {
  constructor() {
    this.workerUrl = null;
    this.workers = [];
    this.size = 0;
  }
  ensure(numThreads) {
    if (!this.workerUrl) {
      const blob = new Blob([SHARED_WORKER_SOURCE], { type: "application/javascript" });
      this.workerUrl = URL.createObjectURL(blob);
    }
    if (this.size === numThreads && this.workers.length === numThreads) return;
    for (const w of this.workers) w.terminate();
    this.workers = Array.from({ length: numThreads }, () => new Worker(this.workerUrl));
    this.size = numThreads;
  }
  runAll(messages) {
    return Promise.all(this.workers.map((w, i) => new Promise((resolve, reject) => {
      w.onmessage = (ev) => {
        const d = ev.data;
        if (d && d.error) reject(new Error(d.message));
        else resolve();
      };
      w.onerror = reject;
      w.postMessage(messages[i]);
    })));
  }
}

const sharedPool = new SharedConvPool();
const sharedSabCache = new Map(); // "wxh" -> { srcSAB, tmpSAB, dstSAB }
const sharedKernelCache = { sab: null, view: null }; // overprovisioned for MAX_RADIUS
const MAX_2D_KERNEL_AREA = 41 * 41; // supports emboss kernels up to radius 20 (41x41)
const sharedKernel2DCache = { sab: null, view: null };
const MAX_RADIUS = 32; // hoist: used by kernel-cache allocators and GPU init

async function sharedConvRGBA(src, width, height, kernel, radius, numThreads) {
  ensureSharedArrayBuffer();
  const byteLen = src.length * 4;
  const key = `${width}x${height}`;
  let sabs = sharedSabCache.get(key);
  if (!sabs) {
    sabs = {
      srcSAB: new SharedArrayBuffer(byteLen),
      tmpSAB: new SharedArrayBuffer(byteLen),
      dstSAB: new SharedArrayBuffer(byteLen),
    };
    sharedSabCache.set(key, sabs);
  }
  const { srcSAB, tmpSAB, dstSAB } = sabs;
  new Float32Array(srcSAB).set(src);
  if (!sharedKernelCache.sab) {
    sharedKernelCache.sab = new SharedArrayBuffer((MAX_RADIUS * 2 + 1) * 4);
    sharedKernelCache.view = new Float32Array(sharedKernelCache.sab);
  }
  sharedKernelCache.view.set(kernel);
  const kernelSAB = sharedKernelCache.sab;

  const threads = Math.min(numThreads, height);
  sharedPool.ensure(threads);
  const rowsPer = Math.ceil(height / threads);

  const buildMsgs = (cmd) => Array.from({ length: threads }, (_, t) => {
    const yStart = t * rowsPer;
    const yEnd = Math.min(yStart + rowsPer, height);
    return { cmd, srcSAB, tmpSAB, dstSAB, kernelSAB, width, height, radius, yStart, yEnd };
  });

  await sharedPool.runAll(buildMsgs("hpass"));
  await sharedPool.runAll(buildMsgs("vpass"));
  return new Float32Array(dstSAB).slice();
}

async function sharedConv2D_RGBA(src, width, height, kernel2D, size, bias, numThreads) {
  ensureSharedArrayBuffer();
  const byteLen = src.length * 4;
  const key = `${width}x${height}`;
  let sabs = sharedSabCache.get(key);
  if (!sabs) {
    sabs = {
      srcSAB: new SharedArrayBuffer(byteLen),
      tmpSAB: new SharedArrayBuffer(byteLen),
      dstSAB: new SharedArrayBuffer(byteLen),
    };
    sharedSabCache.set(key, sabs);
  }
  const { srcSAB, dstSAB } = sabs;
  new Float32Array(srcSAB).set(src);

  // Kernel SAB for 2D filters: overprovision to MAX_2D_KERNEL_AREA floats.
  if (!sharedKernel2DCache.sab) {
    sharedKernel2DCache.sab = new SharedArrayBuffer(MAX_2D_KERNEL_AREA * 4);
    sharedKernel2DCache.view = new Float32Array(sharedKernel2DCache.sab);
  }
  sharedKernel2DCache.view.set(kernel2D);
  const kernelSAB = sharedKernel2DCache.sab;

  const threads = Math.min(numThreads, height);
  sharedPool.ensure(threads);
  const rowsPer = Math.ceil(height / threads);
  const msgs = Array.from({ length: threads }, (_, t) => {
    const yStart = t * rowsPer;
    const yEnd = Math.min(yStart + rowsPer, height);
    return { cmd: "conv2d", srcSAB, dstSAB, kernelSAB, width, height, size, bias, yStart, yEnd };
  });
  await sharedPool.runAll(msgs);
  return new Float32Array(dstSAB).slice();
}

// ----- shared helpers for composite filters (sharpen, edge) -----

function sharedSabsFor(width, height, byteLen, needExtra) {
  const key = `${width}x${height}`;
  let sabs = sharedSabCache.get(key);
  if (!sabs) {
    sabs = {
      srcSAB: new SharedArrayBuffer(byteLen),
      tmpSAB: new SharedArrayBuffer(byteLen),
      dstSAB: new SharedArrayBuffer(byteLen),
    };
    sharedSabCache.set(key, sabs);
  }
  if (needExtra && !sabs.dst2SAB) sabs.dst2SAB = new SharedArrayBuffer(byteLen);
  if (needExtra && !sabs.outSAB) sabs.outSAB = new SharedArrayBuffer(byteLen);
  if (!needExtra && !sabs.outSAB) sabs.outSAB = new SharedArrayBuffer(byteLen);
  return sabs;
}

function loadKernel1DIntoSharedCache(kernel) {
  if (!sharedKernelCache.sab) {
    sharedKernelCache.sab = new SharedArrayBuffer((MAX_RADIUS * 2 + 1) * 4);
    sharedKernelCache.view = new Float32Array(sharedKernelCache.sab);
  }
  sharedKernelCache.view.fill(0);
  sharedKernelCache.view.set(kernel);
  return sharedKernelCache.sab;
}

async function sharedUnsharpMask_RGBA(src, width, height, kernel, radius, amount, numThreads) {
  ensureSharedArrayBuffer();
  const byteLen = src.length * 4;
  const sabs = sharedSabsFor(width, height, byteLen, false);
  const { srcSAB, tmpSAB, dstSAB, outSAB } = sabs;
  new Float32Array(srcSAB).set(src);

  const kernelSAB = loadKernel1DIntoSharedCache(kernel);
  const threads = Math.min(numThreads, height);
  sharedPool.ensure(threads);
  const rowsPer = Math.ceil(height / threads);
  const mkRanges = () => Array.from({ length: threads }, (_, t) => ({
    yStart: t * rowsPer, yEnd: Math.min(t * rowsPer + rowsPer, height),
  }));

  // 1. Blur src -> dstSAB via tmpSAB.
  const hMsgs = mkRanges().map(({ yStart, yEnd }) => ({
    cmd: "hpass", srcSAB, tmpSAB, dstSAB, kernelSAB, width, height, radius, yStart, yEnd,
  }));
  await sharedPool.runAll(hMsgs);
  const vMsgs = mkRanges().map(({ yStart, yEnd }) => ({
    cmd: "vpass", srcSAB, tmpSAB, dstSAB, kernelSAB, width, height, radius, yStart, yEnd,
  }));
  await sharedPool.runAll(vMsgs);

  // 2. Combine: out = (1 + amount) * src + (-amount) * blur, alpha from src.
  const combineMsgs = mkRanges().map(({ yStart, yEnd }) => ({
    cmd: "combine", aSAB: srcSAB, bSAB: dstSAB, outSAB, alphaSAB: srcSAB,
    coefA: 1 + amount, coefB: -amount, bias: 0, useSrcAlpha: 1,
    width, height, yStart, yEnd,
  }));
  await sharedPool.runAll(combineMsgs);
  return new Float32Array(outSAB).slice();
}

async function sharedDoG_RGBA(src, width, height, kSmall, rSmall, kLarge, rLarge, amp, bias, numThreads) {
  ensureSharedArrayBuffer();
  const byteLen = src.length * 4;
  const sabs = sharedSabsFor(width, height, byteLen, true);
  const { srcSAB, tmpSAB, dstSAB, dst2SAB, outSAB } = sabs;
  new Float32Array(srcSAB).set(src);

  const threads = Math.min(numThreads, height);
  sharedPool.ensure(threads);
  const rowsPer = Math.ceil(height / threads);
  const mkRanges = () => Array.from({ length: threads }, (_, t) => ({
    yStart: t * rowsPer, yEnd: Math.min(t * rowsPer + rowsPer, height),
  }));

  // Blur 1: src -> dstSAB with kSmall at rSmall
  let kernelSAB = loadKernel1DIntoSharedCache(kSmall);
  await sharedPool.runAll(mkRanges().map(({ yStart, yEnd }) => ({
    cmd: "hpass", srcSAB, tmpSAB, dstSAB, kernelSAB, width, height, radius: rSmall, yStart, yEnd,
  })));
  await sharedPool.runAll(mkRanges().map(({ yStart, yEnd }) => ({
    cmd: "vpass", srcSAB, tmpSAB, dstSAB, kernelSAB, width, height, radius: rSmall, yStart, yEnd,
  })));

  // Blur 2: src -> dst2SAB with kLarge at rLarge (reuse tmpSAB as scratch).
  kernelSAB = loadKernel1DIntoSharedCache(kLarge);
  await sharedPool.runAll(mkRanges().map(({ yStart, yEnd }) => ({
    cmd: "hpass", srcSAB, tmpSAB, dstSAB: dst2SAB, kernelSAB, width, height, radius: rLarge, yStart, yEnd,
  })));
  await sharedPool.runAll(mkRanges().map(({ yStart, yEnd }) => ({
    cmd: "vpass", srcSAB, tmpSAB, dstSAB: dst2SAB, kernelSAB, width, height, radius: rLarge, yStart, yEnd,
  })));

  // Combine: out = amp * (blur_r - blur_rLarge) + bias, alpha from src.
  await sharedPool.runAll(mkRanges().map(({ yStart, yEnd }) => ({
    cmd: "combine", aSAB: dstSAB, bSAB: dst2SAB, outSAB, alphaSAB: srcSAB,
    coefA: amp, coefB: -amp, bias, useSrcAlpha: 1,
    width, height, yStart, yEnd,
  })));
  return new Float32Array(outSAB).slice();
}

// ---------- WebGPU variant (separable, same kernel, RGBA vec4) ----------

const WGSL_HPASS = `
struct Params { width: u32, height: u32, radius: u32 };
@group(0) @binding(0) var<storage, read> inp: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> outp: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> kern: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  if (x >= params.width || y >= params.height) { return; }
  let r = i32(params.radius);
  var acc = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var k: i32 = -r; k <= r; k = k + 1) {
    var xx = i32(x) + k;
    if (xx < 0) { xx = 0; }
    if (xx >= i32(params.width)) { xx = i32(params.width) - 1; }
    let w = kern[u32(k + r)];
    acc = acc + inp[y * params.width + u32(xx)] * w;
  }
  outp[y * params.width + x] = acc;
}
`;

const WGSL_VPASS = `
struct Params { width: u32, height: u32, radius: u32 };
@group(0) @binding(0) var<storage, read> inp: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> outp: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> kern: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  if (x >= params.width || y >= params.height) { return; }
  let r = i32(params.radius);
  var acc = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var k: i32 = -r; k <= r; k = k + 1) {
    var yy = i32(y) + k;
    if (yy < 0) { yy = 0; }
    if (yy >= i32(params.height)) { yy = i32(params.height) - 1; }
    let w = kern[u32(k + r)];
    acc = acc + inp[u32(yy) * params.width + x] * w;
  }
  outp[y * params.width + x] = acc;
}
`;

// Per-pixel linear combination of two buffers. out = coefA*a + coefB*b + bias
// on RGB; alpha is read from alphaSrc if useSrcAlpha, else forced to 255.
const WGSL_COMBINE = `
struct Params {
  width: u32,
  height: u32,
  coefA: f32,
  coefB: f32,
  bias: f32,
  useSrcAlpha: u32,
};
@group(0) @binding(0) var<storage, read> inA: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> inB: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> outp: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> alphaSrc: array<vec4<f32>>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  if (x >= params.width || y >= params.height) { return; }
  let idx = y * params.width + x;
  let a = inA[idx];
  let b = inB[idx];
  let rgb = a.rgb * params.coefA + b.rgb * params.coefB + vec3<f32>(params.bias);
  var alpha: f32;
  if (params.useSrcAlpha != 0u) {
    alpha = alphaSrc[idx].a;
  } else {
    alpha = 255.0;
  }
  outp[idx] = vec4<f32>(rgb, alpha);
}
`;

// 2D non-separable convolution (single compute pass). Alpha is passed through
// unchanged; bias is added to R,G,B. Kernel size (3..9) is a uniform.
const WGSL_CONV2D = `
struct Params { width: u32, height: u32, size: u32, bias: f32 };
@group(0) @binding(0) var<storage, read> inp: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> outp: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> kern: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  if (x >= params.width || y >= params.height) { return; }
  let size = i32(params.size);
  let half = (size - 1) / 2;
  var acc = vec3<f32>(0.0, 0.0, 0.0);
  for (var ky: i32 = -half; ky <= half; ky = ky + 1) {
    var yy = i32(y) + ky;
    if (yy < 0) { yy = 0; }
    if (yy >= i32(params.height)) { yy = i32(params.height) - 1; }
    for (var kx: i32 = -half; kx <= half; kx = kx + 1) {
      var xx = i32(x) + kx;
      if (xx < 0) { xx = 0; }
      if (xx >= i32(params.width)) { xx = i32(params.width) - 1; }
      let w = kern[u32((ky + half) * size + (kx + half))];
      let p = inp[u32(yy) * params.width + u32(xx)];
      acc = acc + p.rgb * w;
    }
  }
  let src = inp[y * params.width + x];
  outp[y * params.width + x] = vec4<f32>(acc.r + params.bias, acc.g + params.bias, acc.b + params.bias, src.a);
}
`;

class GPUConv {
  constructor() {
    this.device = null;
    this.ready = null;
    this.pipeH = null;
    this.pipeV = null;
    this.pipe2D = null;
    this.pipeCombine = null;
    this.kernBuf = null;         // separable 1D kernel (up to 2*MAX_RADIUS+1 floats)
    this.kern2DBuf = null;       // 2D kernel (up to MAX_2D_KERNEL_AREA floats)
    this.paramsBuf = null;       // separable params (uvec3)
    this.params2DBuf = null;     // 2D params (u32 w, u32 h, u32 size, f32 bias)
    this.paramsCombineBuf = null; // combine params (24 bytes padded to 32)
    this.sizeCache = new Map();       // separable bind groups + buffers per image size
    this.sizeCache2D = new Map();     // 2D bind groups per image size
    this.sizeCacheExtra = new Map();  // extra buffers for composite filters (bufD, bufE)
  }
  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (!navigator.gpu) throw new Error("WebGPU not available in this browser.");
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error("No WebGPU adapter.");
      this.device = await adapter.requestDevice();
      const mkPipeline = (code) => {
        const module = this.device.createShaderModule({ code });
        return this.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
      };
      this.pipeH = mkPipeline(WGSL_HPASS);
      this.pipeV = mkPipeline(WGSL_VPASS);
      this.pipe2D = mkPipeline(WGSL_CONV2D);
      this.pipeCombine = mkPipeline(WGSL_COMBINE);
      this.kernBuf = this.device.createBuffer({
        size: (MAX_RADIUS * 2 + 1) * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.kern2DBuf = this.device.createBuffer({
        size: MAX_2D_KERNEL_AREA * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.paramsBuf = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.params2DBuf = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.paramsCombineBuf = this.device.createBuffer({
        size: 32, // 2*u32 + 3*f32 + u32 = 24 bytes, padded
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    })();
    return this.ready;
  }

  _resourcesFor(width, height, byteLen) {
    const key = `${width}x${height}`;
    let entry = this.sizeCache.get(key);
    if (entry) return entry;
    const device = this.device;
    const bufA = device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bufB = device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE });
    const bufC = device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const staging = device.createBuffer({ size: byteLen, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const bgH = device.createBindGroup({
      layout: this.pipeH.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: bufA } },
        { binding: 1, resource: { buffer: bufB } },
        { binding: 2, resource: { buffer: this.kernBuf } },
        { binding: 3, resource: { buffer: this.paramsBuf } },
      ],
    });
    const bgV = device.createBindGroup({
      layout: this.pipeV.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: bufB } },
        { binding: 1, resource: { buffer: bufC } },
        { binding: 2, resource: { buffer: this.kernBuf } },
        { binding: 3, resource: { buffer: this.paramsBuf } },
      ],
    });
    entry = { bufA, bufB, bufC, staging, bgH, bgV };
    this.sizeCache.set(key, entry);
    return entry;
  }

  _resources2DFor(width, height) {
    const key = `${width}x${height}`;
    let entry = this.sizeCache2D.get(key);
    if (entry) return entry;
    const sep = this._resourcesFor(width, height, width * height * 16);
    const bg2D = this.device.createBindGroup({
      layout: this.pipe2D.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sep.bufA } },
        { binding: 1, resource: { buffer: sep.bufC } },
        { binding: 2, resource: { buffer: this.kern2DBuf } },
        { binding: 3, resource: { buffer: this.params2DBuf } },
      ],
    });
    entry = { bg2D, bufA: sep.bufA, bufC: sep.bufC, staging: sep.staging };
    this.sizeCache2D.set(key, entry);
    return entry;
  }

  // Extra buffers + bind groups for composite filters (unsharp mask, DoG).
  //   bufD: scratch for the second blur in DoG
  //   bufE: combine output, copied to staging
  //   bgV_D: vpass writing into bufD (for second DoG blur)
  //   bgCombine_Sharpen: combine(bufA, bufC) -> bufE, alpha from bufA
  //   bgCombine_DoG:     combine(bufC, bufD) -> bufE, alpha from bufA
  _resourcesExtraFor(width, height, byteLen) {
    const key = `${width}x${height}`;
    let entry = this.sizeCacheExtra.get(key);
    if (entry) return entry;
    const sep = this._resourcesFor(width, height, byteLen);
    const device = this.device;
    const bufD = device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE });
    const bufE = device.createBuffer({
      size: byteLen, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const bgV_D = device.createBindGroup({
      layout: this.pipeV.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sep.bufB } },
        { binding: 1, resource: { buffer: bufD } },
        { binding: 2, resource: { buffer: this.kernBuf } },
        { binding: 3, resource: { buffer: this.paramsBuf } },
      ],
    });
    const bgCombine_Sharpen = device.createBindGroup({
      layout: this.pipeCombine.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sep.bufA } },
        { binding: 1, resource: { buffer: sep.bufC } },
        { binding: 2, resource: { buffer: bufE } },
        { binding: 3, resource: { buffer: sep.bufA } },
        { binding: 4, resource: { buffer: this.paramsCombineBuf } },
      ],
    });
    const bgCombine_DoG = device.createBindGroup({
      layout: this.pipeCombine.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sep.bufC } },
        { binding: 1, resource: { buffer: bufD } },
        { binding: 2, resource: { buffer: bufE } },
        { binding: 3, resource: { buffer: sep.bufA } },
        { binding: 4, resource: { buffer: this.paramsCombineBuf } },
      ],
    });
    entry = { bufD, bufE, bgV_D, bgCombine_Sharpen, bgCombine_DoG };
    this.sizeCacheExtra.set(key, entry);
    return entry;
  }

  async run(src, width, height, kernel, radius) {
    await this.init();
    const device = this.device;
    const byteLen = src.length * 4;
    const { bufA, bufC, staging, bgH, bgV } = this._resourcesFor(width, height, byteLen);

    device.queue.writeBuffer(bufA, 0, src);
    device.queue.writeBuffer(this.kernBuf, 0, kernel);
    device.queue.writeBuffer(this.paramsBuf, 0, new Uint32Array([width, height, radius, 0]));

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeH); pass.setBindGroup(0, bgH);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    pass.setPipeline(this.pipeV); pass.setBindGroup(0, bgV);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    pass.end();
    enc.copyBufferToBuffer(bufC, 0, staging, 0, byteLen);
    device.queue.submit([enc.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    return result;
  }

  async run2D(src, width, height, kernel2D, size, bias) {
    await this.init();
    const device = this.device;
    const byteLen = src.length * 4;
    const { bufA, bufC, staging, bg2D } = this._resources2DFor(width, height);

    device.queue.writeBuffer(bufA, 0, src);
    device.queue.writeBuffer(this.kern2DBuf, 0, kernel2D);
    const params = new ArrayBuffer(16);
    new Uint32Array(params, 0, 3).set([width, height, size]);
    new Float32Array(params, 12, 1).set([bias]);
    device.queue.writeBuffer(this.params2DBuf, 0, params);

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipe2D); pass.setBindGroup(0, bg2D);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    pass.end();
    enc.copyBufferToBuffer(bufC, 0, staging, 0, byteLen);
    device.queue.submit([enc.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    return result;
  }

  _writeCombineParams(width, height, coefA, coefB, bias, useSrcAlpha) {
    const buf = new ArrayBuffer(32);
    new Uint32Array(buf, 0, 2).set([width, height]);
    new Float32Array(buf, 8, 3).set([coefA, coefB, bias]);
    new Uint32Array(buf, 20, 1).set([useSrcAlpha ? 1 : 0]);
    this.device.queue.writeBuffer(this.paramsCombineBuf, 0, buf);
  }

  async runUnsharpMask(src, width, height, kernel, radius, amount) {
    await this.init();
    const device = this.device;
    const byteLen = src.length * 4;
    const sep = this._resourcesFor(width, height, byteLen);
    const extra = this._resourcesExtraFor(width, height, byteLen);

    device.queue.writeBuffer(sep.bufA, 0, src);
    device.queue.writeBuffer(this.kernBuf, 0, kernel);
    device.queue.writeBuffer(this.paramsBuf, 0, new Uint32Array([width, height, radius, 0]));
    this._writeCombineParams(width, height, 1 + amount, -amount, 0, true);

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    // blur bufA -> bufB -> bufC
    pass.setPipeline(this.pipeH); pass.setBindGroup(0, sep.bgH);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    pass.setPipeline(this.pipeV); pass.setBindGroup(0, sep.bgV);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    // combine(bufA, bufC) -> bufE
    pass.setPipeline(this.pipeCombine); pass.setBindGroup(0, extra.bgCombine_Sharpen);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    pass.end();
    enc.copyBufferToBuffer(extra.bufE, 0, sep.staging, 0, byteLen);
    device.queue.submit([enc.finish()]);

    await sep.staging.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(sep.staging.getMappedRange().slice(0));
    sep.staging.unmap();
    return result;
  }

  async runDoG(src, width, height, kSmall, rSmall, kLarge, rLarge, amp, bias) {
    await this.init();
    const device = this.device;
    const byteLen = src.length * 4;
    const sep = this._resourcesFor(width, height, byteLen);
    const extra = this._resourcesExtraFor(width, height, byteLen);

    device.queue.writeBuffer(sep.bufA, 0, src);

    // First blur with kSmall/rSmall into bufC.
    device.queue.writeBuffer(this.kernBuf, 0, kSmall);
    device.queue.writeBuffer(this.paramsBuf, 0, new Uint32Array([width, height, rSmall, 0]));
    let enc = device.createCommandEncoder();
    let pass = enc.beginComputePass();
    pass.setPipeline(this.pipeH); pass.setBindGroup(0, sep.bgH);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    pass.setPipeline(this.pipeV); pass.setBindGroup(0, sep.bgV);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    pass.end();
    device.queue.submit([enc.finish()]);

    // Second blur with kLarge/rLarge into bufD (reuse bufB as scratch).
    device.queue.writeBuffer(this.kernBuf, 0, kLarge);
    device.queue.writeBuffer(this.paramsBuf, 0, new Uint32Array([width, height, rLarge, 0]));
    this._writeCombineParams(width, height, amp, -amp, bias, true);
    enc = device.createCommandEncoder();
    pass = enc.beginComputePass();
    pass.setPipeline(this.pipeH); pass.setBindGroup(0, sep.bgH);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    pass.setPipeline(this.pipeV); pass.setBindGroup(0, extra.bgV_D);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    // combine(bufC, bufD) -> bufE
    pass.setPipeline(this.pipeCombine); pass.setBindGroup(0, extra.bgCombine_DoG);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    pass.end();
    enc.copyBufferToBuffer(extra.bufE, 0, sep.staging, 0, byteLen);
    device.queue.submit([enc.finish()]);

    await sep.staging.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(sep.staging.getMappedRange().slice(0));
    sep.staging.unmap();
    return result;
  }
}

const gpuConv = new GPUConv();

// ---------- UI glue ----------

const inputCanvas = document.getElementById("inputCanvas");
const outputCanvas = document.getElementById("outputCanvas");
const inputCtx = inputCanvas.getContext("2d", { willReadFrequently: true });
const outputCtx = outputCanvas.getContext("2d");
const statusEl = document.getElementById("status");
const variantEl = document.getElementById("variant");
const filterEl = document.getElementById("filter");
const radiusEl = document.getElementById("radius");
const radiusLabel = document.getElementById("radiusLabel");
const radiusLabelEl = document.getElementById("radiusLabelText");
const imgFileEl = document.getElementById("imgFile");
const loadSampleBtn = document.getElementById("loadSample");
const loadSampleLargeBtn = document.getElementById("loadSampleLarge");
const loadSample4KBtn = document.getElementById("loadSample4K");
const gpuStatusEl = document.getElementById("gpuStatus");
const liveUpdateEl = document.getElementById("liveUpdate");

let srcF32 = null;
let srcWidth = 0;
let srcHeight = 0;

function setStatus(msg, cls = "") {
  statusEl.className = cls;
  statusEl.textContent = msg;
}

function updateSliderLabel() {
  const filterId = filterEl.value;
  const isSeparable = filterId === "gaussian" || filterId === "box";
  radiusLabelEl.textContent = isSeparable ? "Kernel radius" : "Strength";
  const spec = buildFilterSpec(filterId, Number(radiusEl.value));
  radiusLabel.textContent = spec.label;
}

function imageDataToFloat32(imageData) {
  const n = imageData.width * imageData.height * 4;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = imageData.data[i];
  return f;
}

function float32ToImageData(f, width, height) {
  const id = new ImageData(width, height);
  const d = id.data;
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    d[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return id;
}

function resizeCanvasesTo(w, h) {
  inputCanvas.width = w; inputCanvas.height = h;
  outputCanvas.width = w; outputCanvas.height = h;
}

function generateSample(width, height = width) {
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  const ctx = c.getContext("2d");
  const diag = Math.hypot(width, height);
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, "#2b5876");
  grad.addColorStop(0.5, "#4e4376");
  grad.addColorStop(1, "#8e9eab");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#ffc857";
  const blobCount = Math.round(40 * (width * height) / (1024 * 1024));
  for (let i = 0; i < blobCount; i++) {
    const r = 10 + Math.random() * (diag * 0.05);
    const x = Math.random() * width;
    const y = Math.random() * height;
    ctx.globalAlpha = 0.4 + Math.random() * 0.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  const lineCount = Math.round(20 * (width * height) / (1024 * 1024));
  for (let i = 0; i < lineCount; i++) {
    ctx.beginPath();
    ctx.moveTo(Math.random() * width, Math.random() * height);
    ctx.lineTo(Math.random() * width, Math.random() * height);
    ctx.stroke();
  }
  ctx.font = `bold ${Math.floor(Math.min(width, height) / 8)}px sans-serif`;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("ParaWeb", width / 2, height / 2);
  return ctx.getImageData(0, 0, width, height);
}

function loadImageData(imgData) {
  srcWidth = imgData.width;
  srcHeight = imgData.height;
  resizeCanvasesTo(srcWidth, srcHeight);
  inputCtx.putImageData(imgData, 0, 0);
  srcF32 = imageDataToFloat32(imgData);
  render();
}

async function loadFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const maxSide = 1024;
    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > maxSide || h > maxSide) {
      const s = Math.min(maxSide / w, maxSide / h);
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    loadImageData(c.getContext("2d").getImageData(0, 0, w, h));
  } finally {
    URL.revokeObjectURL(url);
  }
}

let renderInFlight = false;
let renderPending = false;

// One-shot filter application. Returns the Float32Array result; does not touch
// the canvas or status line. Used by both render() and runBenchmarkSuite().
async function applyFilterOnce(spec, variant, src, width, height) {
  const t = variant.startsWith("shared-") ? Number(variant.split("-")[1]) : 0;
  switch (spec.mode) {
    case "separable":
      if (variant === "seq") return seqConvRGBA(src, width, height, spec.kernel1D, spec.radius);
      if (variant === "gpu") return gpuConv.run(src, width, height, spec.kernel1D, spec.radius);
      return sharedConvRGBA(src, width, height, spec.kernel1D, spec.radius, t);
    case "2d":
      if (variant === "seq") return seqConv2D_RGBA(src, width, height, spec.kernel2D, spec.size, spec.bias);
      if (variant === "gpu") return gpuConv.run2D(src, width, height, spec.kernel2D, spec.size, spec.bias);
      return sharedConv2D_RGBA(src, width, height, spec.kernel2D, spec.size, spec.bias, t);
    case "unsharp_mask":
      if (variant === "seq") return seqUnsharpMask_RGBA(src, width, height, spec.kernel1D, spec.radius, spec.amount);
      if (variant === "gpu") return gpuConv.runUnsharpMask(src, width, height, spec.kernel1D, spec.radius, spec.amount);
      return sharedUnsharpMask_RGBA(src, width, height, spec.kernel1D, spec.radius, spec.amount, t);
    case "dog":
      if (variant === "seq") return seqDoG_RGBA(src, width, height,
        spec.kernel1D_small, spec.rSmall, spec.kernel1D_large, spec.rLarge, spec.amp, spec.bias);
      if (variant === "gpu") return gpuConv.runDoG(src, width, height,
        spec.kernel1D_small, spec.rSmall, spec.kernel1D_large, spec.rLarge, spec.amp, spec.bias);
      return sharedDoG_RGBA(src, width, height,
        spec.kernel1D_small, spec.rSmall, spec.kernel1D_large, spec.rLarge, spec.amp, spec.bias, t);
    default:
      throw new Error("Unknown filter mode: " + spec.mode);
  }
}

async function render() {
  if (!srcF32) return;
  if (renderInFlight) { renderPending = true; return; }
  renderInFlight = true;

  const filterId = filterEl.value;
  const sliderVal = Number(radiusEl.value);
  const variant = variantEl.value;
  const spec = buildFilterSpec(filterId, sliderVal);
  const pixels = srcWidth * srcHeight;
  const tStart = performance.now();
  try {
    const out = await applyFilterOnce(spec, variant, srcF32, srcWidth, srcHeight);
    const elapsed = performance.now() - tStart;
    const mp = pixels / 1e6;
    outputCtx.putImageData(float32ToImageData(out, srcWidth, srcHeight), 0, 0);
    const fps = 1000 / elapsed;
    setStatus(
      `filter=${filterId}  variant=${variant}  image=${srcWidth}x${srcHeight} (${mp.toFixed(2)} MP)  ` +
      `${spec.label}  time=${elapsed.toFixed(1)} ms  ~${fps.toFixed(1)} fps`,
      "ok"
    );
  } catch (e) {
    setStatus("Error: " + e.message, "warn");
  } finally {
    renderInFlight = false;
    if (renderPending) { renderPending = false; render(); }
  }
}

// Hook up UI
radiusEl.addEventListener("input", () => {
  updateSliderLabel();
  if (liveUpdateEl.checked) render();
});
radiusEl.addEventListener("change", () => render());
variantEl.addEventListener("change", () => render());
filterEl.addEventListener("change", () => { updateSliderLabel(); render(); });
imgFileEl.addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  setStatus("loading image...");
  try { await loadFile(f); }
  catch (err) { setStatus("Failed to load image: " + err.message, "warn"); }
});
loadSampleBtn.addEventListener("click", () => loadImageData(generateSample(1024)));
loadSampleLargeBtn.addEventListener("click", () => loadImageData(generateSample(2048)));
loadSample4KBtn.addEventListener("click", () => loadImageData(generateSample(3840, 2160)));

updateSliderLabel();

if (!navigator.gpu) {
  gpuStatusEl.textContent = "  (WebGPU unavailable — GPU variant disabled)";
  gpuStatusEl.className = "warn";
  for (const opt of variantEl.options) if (opt.value === "gpu") opt.disabled = true;
} else {
  gpuStatusEl.textContent = "  (WebGPU available)";
  gpuStatusEl.className = "ok";
}

if (typeof SharedArrayBuffer === "undefined" || (typeof crossOriginIsolated !== "undefined" && !crossOriginIsolated)) {
  setStatus(
    "SharedArrayBuffer unavailable. Serve this page with COOP/COEP headers " +
    "(e.g. `node browser-bench/server.js` then open http://localhost:8787/browser-demo/imageConv.html).",
    "warn"
  );
}

// ---------- Benchmark suite ----------

const BENCH_FILTERS = ["gaussian", "box", "sharpen", "emboss", "edge"];
const BENCH_VARIANTS = ["seq", "shared-4", "shared-8", "shared-16", "gpu"];
const VARIANT_LABEL = {
  "seq": "Sequential",
  "shared-4": "Shared 4T",
  "shared-8": "Shared 8T",
  "shared-16": "Shared 16T",
  "gpu": "GPU",
};
const VARIANT_COLOR = {
  "seq":       "#8e9eab",
  "shared-4":  "#ffc857",
  "shared-8":  "#e09f3e",
  "shared-16": "#b8552d",
  "gpu":       "#2b5876",
};

const BENCH_BLUR_FILTERS = ["gaussian", "box"];
const BENCH_FIXED_FILTERS = ["sharpen", "emboss", "edge"];

// All filters now interpret the sweep value as kernel radius; unsharp-mask
// uses it as the blur radius, DoG as the small-blur radius, NxN emboss as the
// kernel half-width.
function filterAxis(_filterId) {
  return { xLabel: "kernel radius", tickFmt: (v) => String(v) };
}

const benchProgressEl = document.getElementById("benchProgress");
const benchScalingTableEl = document.getElementById("benchScalingTable");
const benchScalingChartEl = document.getElementById("benchScalingChart");
const benchCsvEl = document.getElementById("benchCsv");
const runBenchBtn = document.getElementById("runBench");
const downloadBenchCsvBtn = document.getElementById("downloadBenchCsv");
const benchRadiiEl = document.getElementById("benchRadii");
const benchRadiiFullBtn = document.getElementById("benchRadiiFull");
const benchRadiiShortBtn = document.getElementById("benchRadiiShort");
const benchRunsEl = document.getElementById("benchRuns");
const benchWarmupEl = document.getElementById("benchWarmup");

function parseRadiiList(s) {
  return s.split(",")
    .map(t => parseInt(t.trim(), 10))
    .filter(n => Number.isFinite(n) && n >= 1 && n <= 20)
    .sort((a, b) => a - b)
    .filter((v, i, arr) => i === 0 || arr[i - 1] !== v);
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const variance = times.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, times.length - 1);
  const stddev = Math.sqrt(variance);
  const median = times.length % 2 === 0
    ? (sorted[times.length / 2 - 1] + sorted[times.length / 2]) / 2
    : sorted[Math.floor(times.length / 2)];
  return { mean, median, stddev, min: sorted[0], max: sorted[sorted.length - 1] };
}

async function runBenchmarkSuite() {
  if (!srcF32) {
    setStatus("Load an image first.", "warn");
    return;
  }
  runBenchBtn.disabled = true;
  downloadBenchCsvBtn.disabled = true;
  benchScalingChartEl.style.display = "none";
  benchScalingTableEl.innerHTML = "";
  benchCsvEl.value = "";

  const sweep = parseRadiiList(benchRadiiEl.value);
  if (sweep.length === 0) {
    setStatus("No valid sweep values. Use a comma-separated list of integers 1..20.", "warn");
    runBenchBtn.disabled = false;
    return;
  }
  const runs = Math.max(1, Math.min(20, Number(benchRunsEl.value) || 5));
  const warmup = Math.max(0, Math.min(10, Number(benchWarmupEl.value) || 2));
  const gpuReady = !!navigator.gpu;
  const ALL_FILTERS = [...BENCH_BLUR_FILTERS, ...BENCH_FIXED_FILTERS];

  // One entry per (filter, variant, sweepValue).
  const rows = [];
  const total = ALL_FILTERS.length * BENCH_VARIANTS.length * sweep.length;
  let done = 0;

  async function benchOne(filterId, variant, sliderVal) {
    done++;
    if (variant === "gpu" && !gpuReady) {
      rows.push({ filter: filterId, variant, sweep: sliderVal, skipped: true });
      return;
    }
    const spec = buildFilterSpec(filterId, sliderVal);
    const axis = filterAxis(filterId);
    benchProgressEl.textContent =
      `[${done}/${total}] ${filterId} ${axis.xLabel}=${axis.tickFmt(sliderVal)} · ` +
      `${VARIANT_LABEL[variant]}  (${warmup} warmups + ${runs} runs)...`;
    await new Promise(r => setTimeout(r, 0));
    try {
      for (let i = 0; i < warmup; i++) await applyFilterOnce(spec, variant, srcF32, srcWidth, srcHeight);
      const times = [];
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        await applyFilterOnce(spec, variant, srcF32, srcWidth, srcHeight);
        times.push(performance.now() - t0);
      }
      rows.push({ filter: filterId, variant, sweep: sliderVal, ...stats(times) });
    } catch (e) {
      rows.push({ filter: filterId, variant, sweep: sliderVal, mean: NaN, error: String(e) });
    }
  }

  // Sweep every filter across the value list. Inner-most loop is the sweep so
  // a filter+variant's pipeline/buffers stay hot across its sweep values.
  for (const filterId of ALL_FILTERS) {
    for (const variant of BENCH_VARIANTS) {
      for (const s of sweep) {
        await benchOne(filterId, variant, s);
      }
    }
  }

  // Speedup per (filter, sweep).
  const seqByKey = {};
  for (const r of rows) {
    if (r.variant === "seq" && !isNaN(r.mean)) {
      seqByKey[`${r.filter}|${r.sweep}`] = r.mean;
    }
  }
  for (const r of rows) {
    const base = seqByKey[`${r.filter}|${r.sweep}`];
    r.speedup = (!isNaN(r.mean) && base) ? base / r.mean : NaN;
  }

  benchProgressEl.textContent =
    `Done. Image ${srcWidth}x${srcHeight} (${(srcWidth * srcHeight / 1e6).toFixed(2)} MP), ` +
    `sweep=[${sweep.join(",")}], ${warmup} warmups + ${runs} timed runs.`;

  renderScalingTable(rows, sweep);
  renderScalingChart(rows, sweep);
  benchCsvEl.value = toCsv(rows, { sweep, runs, warmup });
  downloadBenchCsvBtn.disabled = false;
  runBenchBtn.disabled = false;
}

function fmtMs(v) { return isNaN(v) ? "—" : v.toFixed(1); }
function fmtX(v) { return isNaN(v) ? "—" : v.toFixed(2) + "x"; }

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

// ----- Scalability table: one row per (filter, sweep), column per variant -----
function renderScalingTable(rows, sweep) {
  const ALL_FILTERS = [...BENCH_BLUR_FILTERS, ...BENCH_FIXED_FILTERS];
  const idx = new Map();
  for (const r of rows) idx.set(`${r.filter}|${r.variant}|${r.sweep}`, r);

  let html = `<table id="benchResultsTable"><thead><tr>
    <th class="filter-col">Filter</th><th>value</th>`;
  for (const v of BENCH_VARIANTS) html += `<th>${VARIANT_LABEL[v]}<br><small>ms / speedup</small></th>`;
  html += `</tr></thead><tbody>`;
  for (const filterId of ALL_FILTERS) {
    const axis = filterAxis(filterId);
    for (const s of sweep) {
      const label = `${axis.xLabel}=${axis.tickFmt(s)}`;
      html += `<tr><td class="filter-col">${filterId}</td><td>${label}</td>`;
      for (const v of BENCH_VARIANTS) {
        const row = idx.get(`${filterId}|${v}|${s}`);
        if (!row || row.skipped) html += `<td>—</td>`;
        else if (row.error) html += `<td style="color:#a00;">err</td>`;
        else html += `<td>${fmtMs(row.mean)} / ${fmtX(row.speedup)}</td>`;
      }
      html += `</tr>`;
    }
  }
  html += `</tbody></table>`;
  benchScalingTableEl.innerHTML = html;
}

// ----- Scalability chart: 5 panels (one per filter), x=sweep value, y=speedup -----
// Round v up to a "nice" log tick (1, 2, 5, 10, 20, 50, 100, ...).
function logCeiling(v) {
  if (v <= 1) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 5, 10]) {
    if (v <= base * m + 1e-9) return base * m;
  }
  return base * 10;
}

// Ticks at 1, 2, 5, 10, 20, 50, ... up to maxY.
function logTicks(maxY) {
  const ticks = [];
  const maxExp = Math.ceil(Math.log10(maxY));
  for (let e = 0; e <= maxExp; e++) {
    const base = Math.pow(10, e);
    for (const m of [1, 2, 5]) {
      const v = base * m;
      if (v <= maxY * 1.05) ticks.push(v);
    }
  }
  return ticks;
}

function renderScalingChart(rows, sweep) {
  const chart = benchScalingChartEl;
  chart.innerHTML = "";
  chart.style.display = "block";

  const ALL_FILTERS = [...BENCH_BLUR_FILTERS, ...BENCH_FIXED_FILTERS];
  const variantsPlotted = BENCH_VARIANTS.filter(v => v !== "seq");
  const speedups = rows.filter(r => r.variant !== "seq" && !isNaN(r.speedup)).map(r => r.speedup);
  const rawMax = Math.max(...speedups, 2);
  // Log Y from 1 (baseline) to a rounded-up decade+ ceiling.
  const yMinVal = 1;
  const yMaxVal = logCeiling(rawMax * 1.05);
  const logMin = Math.log10(yMinVal);
  const logMax = Math.log10(yMaxVal);
  const logRange = logMax - logMin || 1;

  const W = 1150, H = 400;
  const PAD_L = 56, PAD_R = 16, PAD_T = 24, PAD_B = 90;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const panelGap = 18;
  const panelW = (plotW - panelGap * (ALL_FILTERS.length - 1)) / ALL_FILTERS.length;

  // shared y-axis label
  const yLabel = svgEl("text", {
    x: 14, y: PAD_T + plotH / 2,
    transform: `rotate(-90 14 ${PAD_T + plotH / 2})`,
    "text-anchor": "middle", "font-size": "12", fill: "#333",
  });
  yLabel.textContent = "Speedup vs Sequential (log scale)";
  chart.appendChild(yLabel);

  const xMin = sweep[0], xMax = sweep[sweep.length - 1];
  const xRange = Math.max(1, xMax - xMin);
  const yLogPos = (py, s) => py + plotH - ((Math.log10(Math.max(yMinVal, s)) - logMin) / logRange) * plotH;

  ALL_FILTERS.forEach((filterId, pi) => {
    const axis = filterAxis(filterId);
    const px = PAD_L + pi * (panelW + panelGap);
    const py = PAD_T;

    chart.appendChild(svgEl("rect", { x: px, y: py, width: panelW, height: plotH, fill: "#fff", stroke: "#ccc" }));
    const title = svgEl("text", { x: px + 6, y: py + 14, "font-size": "12", "font-weight": "bold", fill: "#333" });
    title.textContent = filterId;
    chart.appendChild(title);

    // log y gridlines + ticks (left panel only labels)
    const ticks = logTicks(yMaxVal);
    for (const yVal of ticks) {
      const y = yLogPos(py, yVal);
      const isDecade = Math.abs(Math.log10(yVal) - Math.round(Math.log10(yVal))) < 1e-9;
      chart.appendChild(svgEl("line", {
        x1: px, y1: y, x2: px + panelW, y2: y,
        stroke: isDecade ? "#ddd" : "#f0f0f0",
      }));
      if (pi === 0) {
        const t = svgEl("text", {
          x: px - 6, y: y + 4, "text-anchor": "end",
          "font-size": "10", fill: isDecade ? "#333" : "#888",
        });
        t.textContent = yVal + "x";
        chart.appendChild(t);
      }
    }
    // Baseline y=1 is at the bottom of the plot; emphasize with a dashed line.
    const yBase = yLogPos(py, 1);
    chart.appendChild(svgEl("line", {
      x1: px, y1: yBase, x2: px + panelW, y2: yBase, stroke: "#888", "stroke-dasharray": "4,3",
    }));

    // x ticks (show a subset if too crowded)
    const xPositionOf = (v) => px + ((v - xMin) / xRange) * (panelW - 16) + 8;
    const maxTicks = 7;
    const step = Math.max(1, Math.ceil(sweep.length / maxTicks));
    sweep.forEach((v, i) => {
      if (i % step !== 0 && i !== sweep.length - 1) return;
      const x = xPositionOf(v);
      const tx = svgEl("text", {
        x, y: py + plotH + 14, "text-anchor": "middle", "font-size": "10", fill: "#555",
      });
      tx.textContent = axis.tickFmt(v);
      chart.appendChild(tx);
    });
    const cap = svgEl("text", {
      x: px + panelW / 2, y: py + plotH + 30,
      "text-anchor": "middle", "font-size": "11", fill: "#333",
    });
    cap.textContent = axis.xLabel;
    chart.appendChild(cap);

    // one polyline + circles per variant
    variantsPlotted.forEach((v) => {
      const pts = sweep.map((s) => {
        const row = rows.find(x => x.filter === filterId && x.variant === v && x.sweep === s);
        if (!row || isNaN(row.speedup)) return null;
        const x = xPositionOf(s);
        const y = yLogPos(py, row.speedup);
        return [x, y];
      }).filter(Boolean);
      if (pts.length === 0) return;
      chart.appendChild(svgEl("polyline", {
        points: pts.map(([x, y]) => `${x},${y}`).join(" "),
        fill: "none", stroke: VARIANT_COLOR[v], "stroke-width": "2",
      }));
      for (const [x, y] of pts) {
        chart.appendChild(svgEl("circle", {
          cx: x, cy: y, r: 3, fill: VARIANT_COLOR[v], stroke: "#222", "stroke-width": "0.5",
        }));
      }
    });
  });

  // legend (below panels)
  const legY = PAD_T + plotH + 56;
  let lx = PAD_L;
  for (const v of variantsPlotted) {
    chart.appendChild(svgEl("line", {
      x1: lx, y1: legY, x2: lx + 18, y2: legY,
      stroke: VARIANT_COLOR[v], "stroke-width": "2",
    }));
    chart.appendChild(svgEl("circle", {
      cx: lx + 9, cy: legY, r: 3, fill: VARIANT_COLOR[v], stroke: "#222", "stroke-width": "0.5",
    }));
    const tl = svgEl("text", { x: lx + 24, y: legY + 4, "font-size": "11", fill: "#333" });
    tl.textContent = VARIANT_LABEL[v];
    chart.appendChild(tl);
    lx += 110;
  }
}

function toCsv(rows, params) {
  const header = [
    `# image=${srcWidth}x${srcHeight}`,
    `# sweep=${params.sweep.join("|")}, runs=${params.runs}, warmup=${params.warmup}`,
    `# sweep value means kernel-radius for gaussian/box, and strength=value/10 for sharpen/emboss/edge`,
    "filter,variant,sweep,mean_ms,median_ms,stddev_ms,min_ms,max_ms,speedup_vs_seq",
  ];
  const lines = [...header];
  for (const r of rows) {
    const rcol = r.sweep == null ? "" : String(r.sweep);
    if (r.skipped) { lines.push([r.filter, r.variant, rcol, "", "", "", "", "", "skipped"].join(",")); continue; }
    if (r.error)   { lines.push([r.filter, r.variant, rcol, "", "", "", "", "", "error"].join(",")); continue; }
    lines.push([
      r.filter, r.variant, rcol,
      r.mean.toFixed(3), r.median.toFixed(3), r.stddev.toFixed(3),
      r.min.toFixed(3), r.max.toFixed(3),
      isNaN(r.speedup) ? "" : r.speedup.toFixed(3),
    ].join(","));
  }
  return lines.join("\n");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

runBenchBtn.addEventListener("click", () => runBenchmarkSuite().catch(e => setStatus("Benchmark error: " + e.message, "warn")));
benchRadiiFullBtn.addEventListener("click", () => {
  benchRadiiEl.value = Array.from({ length: 20 }, (_, i) => i + 1).join(",");
});
benchRadiiShortBtn.addEventListener("click", () => {
  benchRadiiEl.value = "1,2,4,8,16";
});
downloadBenchCsvBtn.addEventListener("click", () => {
  if (!benchCsvEl.value) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  downloadText(`paraweb-imgconv-${srcWidth}x${srcHeight}-${ts}.csv`, benchCsvEl.value);
});

// Auto-load sample so the page is interactive on first visit.
loadImageData(generateSample(1024));
