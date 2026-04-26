/**
 * GPU Shader Builder - Generates WGSL compute shaders from operation specifications.
 *
 * Since JavaScript functions cannot run on the GPU, users provide either:
 * 1. A built-in operation name (e.g., "square", "collatz_steps")
 * 2. A custom WGSL expression string (e.g., "x * x + 1.0")
 */

/** Operation specification: either a string name or a WGSL expression object. */
export type GPUOperation = string | { wgsl: string };

/** Binary operation for reduce-like patterns. */
export type GPUBinaryOperation = string | { wgsl: string };

/** Predicate operation for filter. */
export type GPUPredicate = string | { wgsl: string };

const WORKGROUP_SIZE = 256;

/** Built-in unary operations (element-wise). */
const BUILTIN_UNARY_OPS: Record<string, string> = {
  square: "x * x",
  cube: "x * x * x",
  double: "x * 2.0",
  negate: "-x",
  abs: "abs(x)",
  sqrt: "sqrt(abs(x))",
  sin: "sin(x)",
  cos: "cos(x)",
  exp: "exp(x)",
  log: "log(abs(x) + 1.0)",
  sigmoid: "1.0 / (1.0 + exp(-x))",
  relu: "max(x, 0.0)",
  inverse: "1.0 / (x + 0.0001)",
  // Collatz steps (iterative, counted in f32)
  collatz_steps: "collatz_steps_fn(x)",
  // Polynomial x^2 + x^3 + ... + x^10
  polynomial: "polynomial_fn(x)",
  // Iterative trig loops matching CPU benchmark workloads
  trig_50: "trig_loop_fn(x, 50u)",
  trig_30: "trig_loop_fn(x, 30u)",
  trig_20: "trig_loop_fn(x, 20u)",
  trig_15: "trig_loop_fn(x, 15u)",
  trig_10: "trig_loop_fn(x, 10u)",
  // Reduce CPU mapFn (sin + cos, 10 iter) — additive form, no sqrt
  trig_reduce_10: "trig_reduce_fn(x)",
  // Scan / Scatter CPU heavyFn (sin + cos + sqrt, then v*v+1; 50 iter)
  trig_scan_50: "trig_scan_fn(x)",
  // Farm CPU fn: Collatz step-count then 200-iter trig refinement
  farm_collatz_trig_200: "farm_collatz_trig_fn(x)",
  // Pipeline stage 2: polynomial with floor
  poly_stage2: "poly_stage2_fn(x)",
};

/** Built-in binary operations (for reduce). */
const BUILTIN_BINARY_OPS: Record<string, string> = {
  add: "a + b",
  multiply: "a * b",
  min: "min(a, b)",
  max: "max(a, b)",
};

/** Built-in predicate operations (for filter). */
const BUILTIN_PREDICATES: Record<string, string> = {
  positive: "x > 0.0",
  negative: "x < 0.0",
  nonzero: "x != 0.0",
  even: "u32(x) % 2u == 0u",
  odd: "u32(x) % 2u == 1u",
  is_prime: "is_prime_fn(x)",
  gt_threshold: "x > params.threshold",
  trig_gt2: "trig_loop_fn(x, 30u) > 2.0",
};

function resolveUnaryOp(op: GPUOperation): string {
  if (typeof op === "string") {
    const builtin = BUILTIN_UNARY_OPS[op];
    if (!builtin) throw new Error(`Unknown built-in unary operation: ${op}. Available: ${Object.keys(BUILTIN_UNARY_OPS).join(", ")}`);
    return builtin;
  }
  return op.wgsl;
}

function resolveBinaryOp(op: GPUBinaryOperation): string {
  if (typeof op === "string") {
    const builtin = BUILTIN_BINARY_OPS[op];
    if (!builtin) throw new Error(`Unknown built-in binary operation: ${op}. Available: ${Object.keys(BUILTIN_BINARY_OPS).join(", ")}`);
    return builtin;
  }
  return op.wgsl;
}

function resolvePredicate(op: GPUPredicate): string {
  if (typeof op === "string") {
    const builtin = BUILTIN_PREDICATES[op];
    if (!builtin) throw new Error(`Unknown built-in predicate: ${op}. Available: ${Object.keys(BUILTIN_PREDICATES).join(", ")}`);
    return builtin;
  }
  return op.wgsl;
}

/** Helper functions included in shaders that need them. */
function helperFunctions(op: string): string {
  let helpers = "";
  if (op.includes("collatz_steps_fn")) {
    helpers += `
fn collatz_steps_fn(val: f32) -> f32 {
  var n = u32(abs(val));
  if (n <= 1u) { return 0.0; }
  var steps = 0u;
  while (n > 1u && steps < 1000u) {
    if (n % 2u == 0u) { n = n / 2u; }
    else { n = 3u * n + 1u; }
    steps = steps + 1u;
  }
  return f32(steps);
}
`;
  }
  if (op.includes("polynomial_fn")) {
    helpers += `
fn polynomial_fn(x: f32) -> f32 {
  var result = 0.0;
  var xp = x * x;
  for (var p = 2u; p <= 10u; p = p + 1u) {
    result = result + xp;
    xp = xp * x;
  }
  return result;
}
`;
  }
  if (op.includes("is_prime_fn")) {
    helpers += `
fn is_prime_fn(val: f32) -> bool {
  let n = u32(abs(val));
  if (n < 2u) { return false; }
  if (n < 4u) { return true; }
  if (n % 2u == 0u) { return false; }
  var i = 3u;
  while (i * i <= n) {
    if (n % i == 0u) { return false; }
    i = i + 2u;
  }
  return true;
}
`;
  }
  if (op.includes("trig_loop_fn")) {
    helpers += `
fn trig_loop_fn(x: f32, iters: u32) -> f32 {
  var result = x;
  for (var i = 0u; i < iters; i = i + 1u) {
    result = sin(result) * cos(result * 0.5) + sqrt(abs(result) + 1.0);
    result = result * result - floor(result * result);
  }
  return result;
}
`;
  }
  if (op.includes("trig_reduce_fn")) {
    helpers += `
fn trig_reduce_fn(x: f32) -> f32 {
  var v = x;
  for (var k = 0u; k < 10u; k = k + 1u) {
    v = sin(v) + cos(v * 0.5);
  }
  return v;
}
`;
  }
  if (op.includes("trig_scan_fn")) {
    helpers += `
fn trig_scan_fn(x: f32) -> f32 {
  var v = x;
  for (var k = 0u; k < 50u; k = k + 1u) {
    v = sin(v) + cos(v * 0.5) + sqrt(abs(v) + 1.0);
    v = v * v + 1.0;
  }
  return v;
}
`;
  }
  if (op.includes("farm_collatz_trig_fn")) {
    helpers += `
fn farm_collatz_trig_fn(x: f32) -> f32 {
  // Variable-cost Collatz step count.
  var n = u32(abs(x));
  if (n < 1u) { n = 1u; }
  var steps = 0u;
  while (n != 1u && steps < 10000u) {
    if (n % 2u == 0u) { n = n / 2u; }
    else { n = 3u * n + 1u; }
    steps = steps + 1u;
  }
  // Fixed-cost 200-iter trig refinement, formula matching CPU Farm exactly.
  var v: f32 = f32(steps);
  for (var i = 0u; i < 200u; i = i + 1u) {
    v = sin(v) + cos(v * 0.5) + sqrt(abs(v) + 1.0);
    v = v * v - floor(v * v) + 1.0;
  }
  return v;
}
`;
  }
  if (op.includes("poly_stage2_fn")) {
    helpers += `
fn poly_stage2_fn(x: f32) -> f32 {
  var result = x;
  for (var i = 0u; i < 20u; i = i + 1u) {
    result = (result * result - floor(result * result)) * 3.14159 + 1.0;
  }
  return round(result * 1000.0) / 1000.0;
}
`;
  }
  return helpers;
}

/** Build a Map compute shader. */
export function buildMapShader(op: GPUOperation): string {
  const expr = resolveUnaryOp(op);
  const helpers = helperFunctions(expr);
  return `
struct Params { length: u32 }

@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

${helpers}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.length) { return; }
  let x = input[i];
  output[i] = ${expr};
}
`;
}

/** Build a Filter (mark phase) compute shader. Returns 1u if predicate is true, 0u otherwise. */
export function buildFilterMarkShader(pred: GPUPredicate, hasThreshold: boolean = false): string {
  const expr = resolvePredicate(pred);
  const helpers = helperFunctions(expr);
  const paramsStruct = hasThreshold
    ? "struct Params { length: u32, threshold: f32 }"
    : "struct Params { length: u32 }";
  return `
${paramsStruct}

@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> flags: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

${helpers}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.length) { return; }
  let x = input[i];
  if (${expr}) { flags[i] = 1u; } else { flags[i] = 0u; }
}
`;
}

/** Build a prefix sum (exclusive scan) shader for filter compaction. */
export function buildPrefixSumShader(): string {
  return `
struct Params { length: u32 }

@group(0) @binding(0) var<storage, read> flags: array<u32>;
@group(0) @binding(1) var<storage, read_write> scan: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

// Simple sequential prefix sum - run with 1 thread.
// For large arrays, a parallel Blelloch scan would be faster,
// but this keeps the implementation simple for v1.
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  var sum = 0u;
  for (var i = 0u; i < params.length; i = i + 1u) {
    scan[i] = sum;
    sum = sum + flags[i];
  }
  // Store total count at the end
  scan[params.length] = sum;
}
`;
}

/** Build a filter compaction shader. */
export function buildFilterCompactShader(): string {
  return `
struct Params { length: u32 }

@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read> scan: array<u32>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.length) { return; }
  if (flags[i] == 1u) {
    output[scan[i]] = input[i];
  }
}
`;
}

/**
 * Build a Reduce compute shader (single-pass workgroup reduction).
 *
 * When `preOp` is provided, it is a unary operation applied to each element as
 * it is loaded from the input buffer before the tree reduction combines it.
 * This makes the shader equivalent to a fused map+reduce on the first pass.
 * For subsequent hierarchical passes that read already-reduced partial values,
 * callers should pass `preOp = undefined` to avoid re-applying the map.
 */
export function buildReduceShader(
  op: GPUBinaryOperation,
  identity: number,
  preOp?: GPUOperation
): string {
  const expr = resolveBinaryOp(op);
  const preExpr = preOp !== undefined ? resolveUnaryOp(preOp) : undefined;
  const preHelpers = preExpr !== undefined ? helperFunctions(preExpr) : "";
  const loadExpr = preExpr !== undefined
    ? `let x = input[i]; wg_data[lid.x] = ${preExpr};`
    : `wg_data[lid.x] = input[i];`;
  return `
struct Params { length: u32 }

@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

${preHelpers}

var<workgroup> wg_data: array<f32, ${WORKGROUP_SIZE}>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>
) {
  let i = gid.x;
  if (i < params.length) {
    ${loadExpr}
  } else {
    wg_data[lid.x] = f32(${identity});
  }
  workgroupBarrier();

  // Tree reduction within workgroup
  var stride = ${WORKGROUP_SIZE}u / 2u;
  while (stride > 0u) {
    if (lid.x < stride) {
      let a = wg_data[lid.x];
      let b = wg_data[lid.x + stride];
      wg_data[lid.x] = ${expr};
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (lid.x == 0u) {
    output[wid.x] = wg_data[0];
  }
}
`;
}

/** Block size used by the parallel Blelloch scan (two elements per thread). */
export const SCAN_BLOCK_SIZE = 2 * WORKGROUP_SIZE;

/**
 * Build the block-scan kernel for the parallel Blelloch scan.
 *
 * Each workgroup loads `SCAN_BLOCK_SIZE` consecutive input elements into
 * shared memory, computes an inclusive scan using an up-sweep/down-sweep
 * binary tree, writes the scanned block to `output`, and emits the block's
 * total sum to `blockSums[workgroup_id]`. A separate `uniformAdd` shader
 * then combines each block's exclusive-prefix offset (obtained by
 * recursively scanning `blockSums`) into every element of the block.
 *
 * The kernel implements Blelloch's algorithm (upsweep + downsweep) over the
 * per-block shared buffer to get an exclusive scan, then combines the
 * original values back in to produce an inclusive scan. The block total is
 * saved before the upsweep root is cleared to identity.
 */
export function buildBlockScanShader(op: GPUBinaryOperation, identity: number): string {
  const expr = resolveBinaryOp(op);
  const idStr = identity.toFixed(7);
  return `
struct Params { length: u32 }

@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<storage, read_write> blockSums: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

var<workgroup> temp: array<f32, ${SCAN_BLOCK_SIZE}>;

fn combine(a: f32, b: f32) -> f32 {
  return ${expr};
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>
) {
  let tid = lid.x;
  let blockStart = wid.x * ${SCAN_BLOCK_SIZE}u;
  let g0 = blockStart + 2u * tid;
  let g1 = blockStart + 2u * tid + 1u;

  let orig0 = select(f32(${idStr}), input[g0], g0 < params.length);
  let orig1 = select(f32(${idStr}), input[g1], g1 < params.length);
  temp[2u * tid] = orig0;
  temp[2u * tid + 1u] = orig1;
  workgroupBarrier();

  // Upsweep: build balanced binary tree of partial sums in place.
  var offset: u32 = 1u;
  for (var d: u32 = ${SCAN_BLOCK_SIZE}u >> 1u; d > 0u; d = d >> 1u) {
    if (tid < d) {
      let ai = offset * (2u * tid + 1u) - 1u;
      let bi = offset * (2u * tid + 2u) - 1u;
      temp[bi] = combine(temp[ai], temp[bi]);
    }
    offset = offset << 1u;
    workgroupBarrier();
  }

  // Save block total and clear root for the exclusive-scan downsweep.
  if (tid == 0u) {
    blockSums[wid.x] = temp[${SCAN_BLOCK_SIZE}u - 1u];
    temp[${SCAN_BLOCK_SIZE}u - 1u] = f32(${idStr});
  }
  workgroupBarrier();

  // Downsweep: walk the tree back down, producing an exclusive scan in temp.
  for (var d2: u32 = 1u; d2 < ${SCAN_BLOCK_SIZE}u; d2 = d2 << 1u) {
    offset = offset >> 1u;
    workgroupBarrier();
    if (tid < d2) {
      let ai = offset * (2u * tid + 1u) - 1u;
      let bi = offset * (2u * tid + 2u) - 1u;
      let t = temp[ai];
      temp[ai] = temp[bi];
      temp[bi] = combine(t, temp[bi]);
    }
  }
  workgroupBarrier();

  // Convert exclusive scan + original elements back into inclusive scan.
  if (g0 < params.length) { output[g0] = combine(temp[2u * tid], orig0); }
  if (g1 < params.length) { output[g1] = combine(temp[2u * tid + 1u], orig1); }
}
`;
}

/**
 * Build the uniform-add kernel that applies each block's exclusive-prefix
 * offset to every element of the block. `offsets[b]` is the inclusive sum
 * of preceding blocks' totals (i.e. the scanned `blockSums`), so block 0
 * gets an identity offset and block b>0 adds `offsets[b-1]`.
 */
export function buildUniformAddShader(op: GPUBinaryOperation, identity: number): string {
  const expr = resolveBinaryOp(op);
  const idStr = identity.toFixed(7);
  return `
struct Params { length: u32 }

@group(0) @binding(0) var<storage, read_write> output: array<f32>;
@group(0) @binding(1) var<storage, read> offsets: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

fn combine(a: f32, b: f32) -> f32 {
  return ${expr};
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.length) { return; }
  let blockIdx = i / ${SCAN_BLOCK_SIZE}u;
  let offset = select(f32(${idStr}), offsets[blockIdx - 1u], blockIdx > 0u);
  output[i] = combine(offset, output[i]);
}
`;
}

/**
 * Legacy sequential inclusive scan kernel (kept for reference / small inputs).
 * The primary scan path now uses {@link buildBlockScanShader} plus
 * {@link buildUniformAddShader} for parallel execution across workgroups.
 */
export function buildScanShader(op: GPUBinaryOperation, identity: number): string {
  const expr = resolveBinaryOp(op);
  return `
struct Params { length: u32 }

@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

fn combine(a: f32, b: f32) -> f32 {
  return ${expr};
}

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  var acc: f32 = ${identity.toFixed(6)};
  for (var i: u32 = 0u; i < params.length; i = i + 1u) {
    acc = combine(acc, input[i]);
    output[i] = acc;
  }
}
`;
}

/** Build a Scatter compute shader. When preOp is given, the per-element
 * transform is fused with the scatter so the GPU benchmark mirrors the CPU
 * benchmark's per-element work. */
export function buildScatterShader(preOp?: GPUOperation): string {
  const preExpr = preOp !== undefined ? resolveUnaryOp(preOp) : undefined;
  const preHelpers = preExpr !== undefined ? helperFunctions(preExpr) : "";
  const valExpr = preExpr !== undefined ? `let x = input[i]; let v = ${preExpr};` : `let v = input[i];`;
  return `
struct Params { length: u32, output_length: u32 }

@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read> indices: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

${preHelpers}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.length) { return; }
  let idx = indices[i];
  if (idx < params.output_length) {
    ${valExpr}
    output[idx] = v;
  }
}
`;
}

/** Build a Stencil compute shader. */
export function buildStencilShader(op: GPUOperation, stencilSize: number): string {
  const expr = resolveUnaryOp(op);
  const half = Math.floor(stencilSize / 2);
  const helpers = helperFunctions(expr);
  return `
struct Params { length: u32 }

@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read> weights: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

${helpers}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.length) { return; }

  var sum = 0.0;
  for (var k = 0; k < ${stencilSize}; k = k + 1) {
    let neighbor_idx = i32(i) + k - ${half};
    var val = 0.0;
    if (neighbor_idx >= 0 && neighbor_idx < i32(params.length)) {
      val = input[u32(neighbor_idx)];
    }
    sum = sum + val * weights[k];
  }

  // Apply the per-element operation to the weighted sum
  let x = sum;
  output[i] = ${expr};
}
`;
}

/**
 * Build the bitonic-sort step kernel. One dispatch per (stage k, substage j)
 * pair, with `n/2` threads per dispatch — each thread maps directly to one
 * pair `(lo, hi=lo^j)` via `lo = (t/j)*2j + (t mod j)`, so no thread is idle
 * and the dispatch grid stays under WebGPU's 65535-workgroup-per-dimension
 * limit even at the largest padded sizes. Input is padded to the next power
 * of two with `+infinity` so padding sorts to the end.
 */
export function buildBitonicSortKernel(): string {
  return `
struct Params { k: u32, j: u32, n: u32 }

@group(0) @binding(0) var<storage, read_write> data: array<f32>;
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= params.n / 2u) { return; }
  let j = params.j;
  let lo = (t / j) * (2u * j) + (t % j);
  let hi = lo ^ j;
  if (hi >= params.n) { return; }
  let ascending = (lo & params.k) == 0u;
  let a = data[lo];
  let b = data[hi];
  var outOfOrder = false;
  if (ascending) {
    outOfOrder = (a > b);
  } else {
    outOfOrder = (a < b);
  }
  if (outOfOrder) {
    data[lo] = b;
    data[hi] = a;
  }
}
`;
}

/**
 * Build the FFT butterfly kernel for one Cooley-Tukey stage. Complex input is
 * interleaved (re, im) in a single f32 storage buffer of length 2*N. Each
 * thread handles exactly one butterfly; thread `t` maps to butterfly indices:
 *   lo = (t / half) * m + (t mod half)
 *   hi = lo + half
 * where m = 2^stage and half = m/2 are passed in via the uniform.
 *
 * The kernel computes:
 *   t_complex = W * data[hi]    (W = exp(-2*pi*i*j/m), j = t mod half)
 *   data[hi]  = data[lo] - t_complex
 *   data[lo]  = data[lo] + t_complex
 *
 * Bit-reversal permutation must be applied to the input before the first
 * dispatch; the host code does this on the CPU once before uploading.
 */
export function buildFFTButterflyKernel(): string {
  return `
struct Params { m: u32, half: u32, n: u32 }

@group(0) @binding(0) var<storage, read_write> data: array<f32>;
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= params.n / 2u) { return; }
  let half = params.half;
  let m = params.m;
  let j = t % half;
  let lo = (t / half) * m + j;
  let hi = lo + half;
  let angle = -6.283185307179586 * f32(j) / f32(m);
  let wRe = cos(angle);
  let wIm = sin(angle);
  let oRe = data[2u * hi];
  let oIm = data[2u * hi + 1u];
  let tRe = wRe * oRe - wIm * oIm;
  let tIm = wRe * oIm + wIm * oRe;
  let eRe = data[2u * lo];
  let eIm = data[2u * lo + 1u];
  data[2u * hi]      = eRe - tRe;
  data[2u * hi + 1u] = eIm - tIm;
  data[2u * lo]      = eRe + tRe;
  data[2u * lo + 1u] = eIm + tIm;
}
`;
}

export { WORKGROUP_SIZE };
