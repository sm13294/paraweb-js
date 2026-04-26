"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __commonJS = (cb, mod) => function __require2() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // dist/core/gpuContext.js
  var require_gpuContext = __commonJS({
    "dist/core/gpuContext.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.isGPUAvailable = isGPUAvailable2;
      exports.getGPUDevice = getGPUDevice;
      exports.releaseGPUDevice = releaseGPUDevice;
      var cachedGPU = void 0;
      var cachedDevice = null;
      async function isGPUAvailable2() {
        try {
          const gpu = getGPU();
          if (!gpu)
            return false;
          const adapter = await gpu.requestAdapter();
          return adapter !== null;
        } catch {
          return false;
        }
      }
      function getGPU() {
        if (cachedGPU !== void 0)
          return cachedGPU;
        if (typeof navigator !== "undefined" && navigator.gpu) {
          cachedGPU = navigator.gpu;
          return cachedGPU;
        }
        try {
          const webgpu = __require("webgpu");
          if (webgpu.globals) {
            for (const [key, value] of Object.entries(webgpu.globals)) {
              if (!(key in globalThis)) {
                globalThis[key] = value;
              }
            }
          }
          if (webgpu.create) {
            cachedGPU = webgpu.create([]);
            return cachedGPU;
          }
          cachedGPU = webgpu.gpu || null;
          return cachedGPU;
        } catch {
          cachedGPU = null;
          return null;
        }
      }
      async function getGPUDevice() {
        if (cachedDevice)
          return cachedDevice;
        const gpu = getGPU();
        if (!gpu) {
          throw new Error("WebGPU is not available. Install the 'webgpu' npm package for Node.js, or use a WebGPU-capable browser.");
        }
        const adapter = await gpu.requestAdapter();
        if (!adapter) {
          throw new Error("Failed to get GPU adapter. No compatible GPU found.");
        }
        cachedDevice = await adapter.requestDevice({
          requiredLimits: {
            maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
            maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
            maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup
          }
        });
        cachedDevice.lost.then(() => {
          cachedDevice = null;
        });
        return cachedDevice;
      }
      function releaseGPUDevice() {
        if (cachedDevice) {
          cachedDevice.destroy();
          cachedDevice = null;
        }
      }
    }
  });

  // dist/core/gpuBufferUtils.js
  var require_gpuBufferUtils = __commonJS({
    "dist/core/gpuBufferUtils.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.createInputBuffer = createInputBuffer;
      exports.createOutputBuffer = createOutputBuffer;
      exports.createReadWriteBuffer = createReadWriteBuffer;
      exports.createUniformBuffer = createUniformBuffer;
      exports.readbackBuffer = readbackBuffer;
      exports.readbackUint32Buffer = readbackUint32Buffer;
      exports.toFloat32 = toFloat32;
      exports.toNumberArray = toNumberArray;
      function createInputBuffer(device, data) {
        const buffer = device.createBuffer({
          size: data.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true
        });
        new Float32Array(buffer.getMappedRange()).set(data);
        buffer.unmap();
        return buffer;
      }
      function createOutputBuffer(device, sizeInBytes) {
        return device.createBuffer({
          size: sizeInBytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
          mappedAtCreation: false
        });
      }
      function createReadWriteBuffer(device, sizeInBytes) {
        return device.createBuffer({
          size: sizeInBytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          mappedAtCreation: false
        });
      }
      function createUniformBuffer(device, data) {
        const buffer = device.createBuffer({
          size: data.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true
        });
        new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data));
        buffer.unmap();
        return buffer;
      }
      async function readbackBuffer(device, srcBuffer, sizeInBytes) {
        const stagingBuffer = device.createBuffer({
          size: sizeInBytes,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(srcBuffer, 0, stagingBuffer, 0, sizeInBytes);
        device.queue.submit([encoder.finish()]);
        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const result = new Float32Array(stagingBuffer.getMappedRange().slice(0));
        stagingBuffer.unmap();
        stagingBuffer.destroy();
        return result;
      }
      async function readbackUint32Buffer(device, srcBuffer, sizeInBytes) {
        const stagingBuffer = device.createBuffer({
          size: sizeInBytes,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(srcBuffer, 0, stagingBuffer, 0, sizeInBytes);
        device.queue.submit([encoder.finish()]);
        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const result = new Uint32Array(stagingBuffer.getMappedRange().slice(0));
        stagingBuffer.unmap();
        stagingBuffer.destroy();
        return result;
      }
      function toFloat32(data) {
        return new Float32Array(data);
      }
      function toNumberArray(data) {
        return Array.from(data);
      }
    }
  });

  // dist/core/gpuKernelCache.js
  var require_gpuKernelCache = __commonJS({
    "dist/core/gpuKernelCache.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.getOrCreatePipeline = getOrCreatePipeline;
      exports.clearPipelineCache = clearPipelineCache;
      var pipelineCache = /* @__PURE__ */ new Map();
      function getOrCreatePipeline(device, shaderSource, entryPoint = "main", bindGroupLayout) {
        const key = shaderSource + "::" + entryPoint;
        const cached = pipelineCache.get(key);
        if (cached)
          return cached;
        const shaderModule = device.createShaderModule({ code: shaderSource });
        const pipelineDesc = {
          layout: bindGroupLayout ? device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }) : "auto",
          compute: {
            module: shaderModule,
            entryPoint
          }
        };
        const pipeline = device.createComputePipeline(pipelineDesc);
        pipelineCache.set(key, pipeline);
        return pipeline;
      }
      function clearPipelineCache() {
        pipelineCache.clear();
      }
    }
  });

  // dist/core/gpuShaderBuilder.js
  var require_gpuShaderBuilder = __commonJS({
    "dist/core/gpuShaderBuilder.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.WORKGROUP_SIZE = exports.SCAN_BLOCK_SIZE = void 0;
      exports.buildMapShader = buildMapShader;
      exports.buildFilterMarkShader = buildFilterMarkShader;
      exports.buildPrefixSumShader = buildPrefixSumShader;
      exports.buildFilterCompactShader = buildFilterCompactShader;
      exports.buildReduceShader = buildReduceShader;
      exports.buildBlockScanShader = buildBlockScanShader;
      exports.buildUniformAddShader = buildUniformAddShader;
      exports.buildScanShader = buildScanShader;
      exports.buildScatterShader = buildScatterShader;
      exports.buildStencilShader = buildStencilShader;
      exports.buildBitonicSortKernel = buildBitonicSortKernel;
      exports.buildFFTButterflyKernel = buildFFTButterflyKernel;
      var WORKGROUP_SIZE = 256;
      exports.WORKGROUP_SIZE = WORKGROUP_SIZE;
      var BUILTIN_UNARY_OPS = {
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
        collatz_steps: "collatz_steps_fn(x)",
        polynomial: "polynomial_fn(x)",
        trig_50: "trig_loop_fn(x, 50u)",
        trig_30: "trig_loop_fn(x, 30u)",
        trig_20: "trig_loop_fn(x, 20u)",
        trig_15: "trig_loop_fn(x, 15u)",
        trig_10: "trig_loop_fn(x, 10u)",
        trig_reduce_10: "trig_reduce_fn(x)",
        trig_scan_50: "trig_scan_fn(x)",
        farm_collatz_trig_200: "farm_collatz_trig_fn(x)",
        poly_stage2: "poly_stage2_fn(x)"
      };
      var BUILTIN_BINARY_OPS = {
        add: "a + b",
        multiply: "a * b",
        min: "min(a, b)",
        max: "max(a, b)"
      };
      var BUILTIN_PREDICATES = {
        positive: "x > 0.0",
        negative: "x < 0.0",
        nonzero: "x != 0.0",
        even: "u32(x) % 2u == 0u",
        odd: "u32(x) % 2u == 1u",
        is_prime: "is_prime_fn(x)",
        gt_threshold: "x > params.threshold",
        trig_gt2: "trig_loop_fn(x, 30u) > 2.0"
      };
      function resolveUnaryOp(op) {
        if (typeof op === "string") {
          const builtin = BUILTIN_UNARY_OPS[op];
          if (!builtin)
            throw new Error(`Unknown built-in unary operation: ${op}. Available: ${Object.keys(BUILTIN_UNARY_OPS).join(", ")}`);
          return builtin;
        }
        return op.wgsl;
      }
      function resolveBinaryOp(op) {
        if (typeof op === "string") {
          const builtin = BUILTIN_BINARY_OPS[op];
          if (!builtin)
            throw new Error(`Unknown built-in binary operation: ${op}. Available: ${Object.keys(BUILTIN_BINARY_OPS).join(", ")}`);
          return builtin;
        }
        return op.wgsl;
      }
      function resolvePredicate(op) {
        if (typeof op === "string") {
          const builtin = BUILTIN_PREDICATES[op];
          if (!builtin)
            throw new Error(`Unknown built-in predicate: ${op}. Available: ${Object.keys(BUILTIN_PREDICATES).join(", ")}`);
          return builtin;
        }
        return op.wgsl;
      }
      function helperFunctions(op) {
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
      function buildMapShader(op) {
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
      function buildFilterMarkShader(pred, hasThreshold = false) {
        const expr = resolvePredicate(pred);
        const helpers = helperFunctions(expr);
        const paramsStruct = hasThreshold ? "struct Params { length: u32, threshold: f32 }" : "struct Params { length: u32 }";
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
      function buildPrefixSumShader() {
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
      function buildFilterCompactShader() {
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
      function buildReduceShader(op, identity, preOp) {
        const expr = resolveBinaryOp(op);
        const preExpr = preOp !== void 0 ? resolveUnaryOp(preOp) : void 0;
        const preHelpers = preExpr !== void 0 ? helperFunctions(preExpr) : "";
        const loadExpr = preExpr !== void 0 ? `let x = input[i]; wg_data[lid.x] = ${preExpr};` : `wg_data[lid.x] = input[i];`;
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
      exports.SCAN_BLOCK_SIZE = 2 * WORKGROUP_SIZE;
      function buildBlockScanShader(op, identity) {
        const expr = resolveBinaryOp(op);
        const idStr = identity.toFixed(7);
        return `
struct Params { length: u32 }

@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<storage, read_write> blockSums: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

var<workgroup> temp: array<f32, ${exports.SCAN_BLOCK_SIZE}>;

fn combine(a: f32, b: f32) -> f32 {
  return ${expr};
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>
) {
  let tid = lid.x;
  let blockStart = wid.x * ${exports.SCAN_BLOCK_SIZE}u;
  let g0 = blockStart + 2u * tid;
  let g1 = blockStart + 2u * tid + 1u;

  let orig0 = select(f32(${idStr}), input[g0], g0 < params.length);
  let orig1 = select(f32(${idStr}), input[g1], g1 < params.length);
  temp[2u * tid] = orig0;
  temp[2u * tid + 1u] = orig1;
  workgroupBarrier();

  // Upsweep: build balanced binary tree of partial sums in place.
  var offset: u32 = 1u;
  for (var d: u32 = ${exports.SCAN_BLOCK_SIZE}u >> 1u; d > 0u; d = d >> 1u) {
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
    blockSums[wid.x] = temp[${exports.SCAN_BLOCK_SIZE}u - 1u];
    temp[${exports.SCAN_BLOCK_SIZE}u - 1u] = f32(${idStr});
  }
  workgroupBarrier();

  // Downsweep: walk the tree back down, producing an exclusive scan in temp.
  for (var d2: u32 = 1u; d2 < ${exports.SCAN_BLOCK_SIZE}u; d2 = d2 << 1u) {
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
      function buildUniformAddShader(op, identity) {
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
  let blockIdx = i / ${exports.SCAN_BLOCK_SIZE}u;
  let offset = select(f32(${idStr}), offsets[blockIdx - 1u], blockIdx > 0u);
  output[i] = combine(offset, output[i]);
}
`;
      }
      function buildScanShader(op, identity) {
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
      function buildScatterShader(preOp) {
        const preExpr = preOp !== void 0 ? resolveUnaryOp(preOp) : void 0;
        const preHelpers = preExpr !== void 0 ? helperFunctions(preExpr) : "";
        const valExpr = preExpr !== void 0 ? `let x = input[i]; let v = ${preExpr};` : `let v = input[i];`;
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
      function buildStencilShader(op, stencilSize) {
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
      function buildBitonicSortKernel() {
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
      function buildFFTButterflyKernel() {
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
    }
  });

  // dist/patterns/mapGPU.js
  var require_mapGPU = __commonJS({
    "dist/patterns/mapGPU.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.ParallelMapGPU = void 0;
      var gpuContext_1 = require_gpuContext();
      var gpuBufferUtils_1 = require_gpuBufferUtils();
      var gpuKernelCache_1 = require_gpuKernelCache();
      var gpuShaderBuilder_1 = require_gpuShaderBuilder();
      var ParallelMapGPU2 = class {
        async map(op, inputData) {
          if (inputData.length === 0)
            return [];
          const device = await (0, gpuContext_1.getGPUDevice)();
          const length = inputData.length;
          const f32Data = (0, gpuBufferUtils_1.toFloat32)(inputData);
          const inputBuffer = (0, gpuBufferUtils_1.createInputBuffer)(device, f32Data);
          const outputBuffer = (0, gpuBufferUtils_1.createOutputBuffer)(device, length * 4);
          const paramsData = new Uint32Array([length]);
          const paramsBuffer = device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
          });
          new Uint32Array(paramsBuffer.getMappedRange()).set(paramsData);
          paramsBuffer.unmap();
          const shader = (0, gpuShaderBuilder_1.buildMapShader)(op);
          const pipeline = (0, gpuKernelCache_1.getOrCreatePipeline)(device, shader, "main");
          const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: inputBuffer } },
              { binding: 1, resource: { buffer: outputBuffer } },
              { binding: 2, resource: { buffer: paramsBuffer } }
            ]
          });
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(Math.ceil(length / gpuShaderBuilder_1.WORKGROUP_SIZE));
          pass.end();
          device.queue.submit([encoder.finish()]);
          const result = await (0, gpuBufferUtils_1.readbackBuffer)(device, outputBuffer, length * 4);
          inputBuffer.destroy();
          outputBuffer.destroy();
          paramsBuffer.destroy();
          return (0, gpuBufferUtils_1.toNumberArray)(result);
        }
      };
      exports.ParallelMapGPU = ParallelMapGPU2;
    }
  });

  // dist/patterns/filterGPU.js
  var require_filterGPU = __commonJS({
    "dist/patterns/filterGPU.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.ParallelFilterGPU = void 0;
      var gpuContext_1 = require_gpuContext();
      var gpuBufferUtils_1 = require_gpuBufferUtils();
      var gpuKernelCache_1 = require_gpuKernelCache();
      var gpuShaderBuilder_1 = require_gpuShaderBuilder();
      var ParallelFilterGPU2 = class {
        async filter(pred, inputData, threshold) {
          if (inputData.length === 0)
            return [];
          const device = await (0, gpuContext_1.getGPUDevice)();
          const length = inputData.length;
          const f32Data = (0, gpuBufferUtils_1.toFloat32)(inputData);
          const hasThreshold = threshold !== void 0;
          const inputBuffer = (0, gpuBufferUtils_1.createInputBuffer)(device, f32Data);
          const flagsBuffer = (0, gpuBufferUtils_1.createOutputBuffer)(device, length * 4);
          const paramsSize = hasThreshold ? 8 : 4;
          const paramsBuffer = device.createBuffer({
            size: paramsSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
          });
          if (hasThreshold) {
            const view = new DataView(paramsBuffer.getMappedRange());
            view.setUint32(0, length, true);
            view.setFloat32(4, threshold, true);
          } else {
            new Uint32Array(paramsBuffer.getMappedRange()).set([length]);
          }
          paramsBuffer.unmap();
          const markShader = (0, gpuShaderBuilder_1.buildFilterMarkShader)(pred, hasThreshold);
          const markPipeline = (0, gpuKernelCache_1.getOrCreatePipeline)(device, markShader, "main");
          const markBindGroup = device.createBindGroup({
            layout: markPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: inputBuffer } },
              { binding: 1, resource: { buffer: flagsBuffer } },
              { binding: 2, resource: { buffer: paramsBuffer } }
            ]
          });
          let encoder = device.createCommandEncoder();
          let pass = encoder.beginComputePass();
          pass.setPipeline(markPipeline);
          pass.setBindGroup(0, markBindGroup);
          pass.dispatchWorkgroups(Math.ceil(length / gpuShaderBuilder_1.WORKGROUP_SIZE));
          pass.end();
          device.queue.submit([encoder.finish()]);
          const scanBuffer = (0, gpuBufferUtils_1.createOutputBuffer)(device, (length + 1) * 4);
          const scanParamsBuffer = device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
          });
          new Uint32Array(scanParamsBuffer.getMappedRange()).set([length]);
          scanParamsBuffer.unmap();
          const scanShader = (0, gpuShaderBuilder_1.buildPrefixSumShader)();
          const scanPipeline = (0, gpuKernelCache_1.getOrCreatePipeline)(device, scanShader, "main");
          const scanBindGroup = device.createBindGroup({
            layout: scanPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: flagsBuffer } },
              { binding: 1, resource: { buffer: scanBuffer } },
              { binding: 2, resource: { buffer: scanParamsBuffer } }
            ]
          });
          encoder = device.createCommandEncoder();
          pass = encoder.beginComputePass();
          pass.setPipeline(scanPipeline);
          pass.setBindGroup(0, scanBindGroup);
          pass.dispatchWorkgroups(1);
          pass.end();
          device.queue.submit([encoder.finish()]);
          const scanData = await (0, gpuBufferUtils_1.readbackUint32Buffer)(device, scanBuffer, (length + 1) * 4);
          const totalCount = scanData[length];
          if (totalCount === 0) {
            inputBuffer.destroy();
            flagsBuffer.destroy();
            paramsBuffer.destroy();
            scanBuffer.destroy();
            scanParamsBuffer.destroy();
            return [];
          }
          const outputBuffer = (0, gpuBufferUtils_1.createOutputBuffer)(device, totalCount * 4);
          const compactShader = (0, gpuShaderBuilder_1.buildFilterCompactShader)();
          const compactPipeline = (0, gpuKernelCache_1.getOrCreatePipeline)(device, compactShader, "main");
          const compactBindGroup = device.createBindGroup({
            layout: compactPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: inputBuffer } },
              { binding: 1, resource: { buffer: flagsBuffer } },
              { binding: 2, resource: { buffer: scanBuffer } },
              { binding: 3, resource: { buffer: outputBuffer } },
              { binding: 4, resource: { buffer: paramsBuffer } }
            ]
          });
          encoder = device.createCommandEncoder();
          pass = encoder.beginComputePass();
          pass.setPipeline(compactPipeline);
          pass.setBindGroup(0, compactBindGroup);
          pass.dispatchWorkgroups(Math.ceil(length / gpuShaderBuilder_1.WORKGROUP_SIZE));
          pass.end();
          device.queue.submit([encoder.finish()]);
          const result = await (0, gpuBufferUtils_1.readbackBuffer)(device, outputBuffer, totalCount * 4);
          inputBuffer.destroy();
          flagsBuffer.destroy();
          paramsBuffer.destroy();
          scanBuffer.destroy();
          scanParamsBuffer.destroy();
          outputBuffer.destroy();
          return (0, gpuBufferUtils_1.toNumberArray)(result);
        }
      };
      exports.ParallelFilterGPU = ParallelFilterGPU2;
    }
  });

  // dist/patterns/reduceGPU.js
  var require_reduceGPU = __commonJS({
    "dist/patterns/reduceGPU.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.ParallelReduceGPU = void 0;
      var gpuContext_1 = require_gpuContext();
      var gpuBufferUtils_1 = require_gpuBufferUtils();
      var gpuKernelCache_1 = require_gpuKernelCache();
      var gpuShaderBuilder_1 = require_gpuShaderBuilder();
      var ParallelReduceGPU2 = class {
        async reduce(op, inputData, initialValue, preOp) {
          const identity = this.getIdentity(op);
          const hasInitialValue = initialValue !== void 0;
          const initVal = hasInitialValue ? initialValue : identity;
          if (inputData.length === 0)
            return initVal;
          if (inputData.length === 1) {
            return hasInitialValue && initialValue !== identity ? this.applyBinaryOp(op, initialValue, inputData[0]) : inputData[0];
          }
          const device = await (0, gpuContext_1.getGPUDevice)();
          const f32 = (0, gpuBufferUtils_1.toFloat32)(inputData);
          const firstStageShader = (0, gpuShaderBuilder_1.buildReduceShader)(op, identity, preOp);
          const firstStagePipeline = (0, gpuKernelCache_1.getOrCreatePipeline)(device, firstStageShader, "main");
          const laterStageShader = preOp !== void 0 ? (0, gpuShaderBuilder_1.buildReduceShader)(op, identity) : firstStageShader;
          const laterStagePipeline = preOp !== void 0 ? (0, gpuKernelCache_1.getOrCreatePipeline)(device, laterStageShader, "main") : firstStagePipeline;
          let currentLength = f32.length;
          let currentBuffer = (0, gpuBufferUtils_1.createInputBuffer)(device, f32);
          const buffersToDestroy = [currentBuffer];
          const stages = [];
          let isFirst = true;
          while (currentLength > 1) {
            const numWorkgroups = Math.ceil(currentLength / gpuShaderBuilder_1.WORKGROUP_SIZE);
            const outBuf = (0, gpuBufferUtils_1.createReadWriteBuffer)(device, numWorkgroups * 4);
            buffersToDestroy.push(outBuf);
            const paramsBuffer = device.createBuffer({
              size: 4,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
              mappedAtCreation: true
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
                { binding: 2, resource: { buffer: paramsBuffer } }
              ]
            });
            stages.push({ bindGroup, workgroups: numWorkgroups, pipeline: stagePipeline });
            currentBuffer = outBuf;
            currentLength = numWorkgroups;
            isFirst = false;
          }
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          for (const st of stages) {
            pass.setPipeline(st.pipeline);
            pass.setBindGroup(0, st.bindGroup);
            pass.dispatchWorkgroups(st.workgroups);
          }
          pass.end();
          device.queue.submit([encoder.finish()]);
          const finalData = await (0, gpuBufferUtils_1.readbackBuffer)(device, currentBuffer, 4);
          for (const b of buffersToDestroy)
            b.destroy();
          const result = finalData[0];
          if (hasInitialValue && initialValue !== identity) {
            return this.applyBinaryOp(op, initialValue, result);
          }
          return result;
        }
        getIdentity(op) {
          const name = typeof op === "string" ? op : "";
          switch (name) {
            case "add":
              return 0;
            case "multiply":
              return 1;
            case "min":
              return 3402823e32;
            case "max":
              return -3402823e32;
            default:
              return 0;
          }
        }
        applyBinaryOp(op, a, b) {
          const name = typeof op === "string" ? op : "";
          switch (name) {
            case "add":
              return a + b;
            case "multiply":
              return a * b;
            case "min":
              return Math.min(a, b);
            case "max":
              return Math.max(a, b);
            default:
              return a + b;
          }
        }
      };
      exports.ParallelReduceGPU = ParallelReduceGPU2;
    }
  });

  // dist/patterns/scanGPU.js
  var require_scanGPU = __commonJS({
    "dist/patterns/scanGPU.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.ParallelScanGPU = void 0;
      var gpuContext_1 = require_gpuContext();
      var gpuBufferUtils_1 = require_gpuBufferUtils();
      var gpuKernelCache_1 = require_gpuKernelCache();
      var gpuShaderBuilder_1 = require_gpuShaderBuilder();
      var ParallelScanGPU2 = class {
        async scan(op, inputData, identity, preOp) {
          const id = identity !== void 0 ? identity : this.getIdentity(op);
          if (inputData.length === 0)
            return [];
          const device = await (0, gpuContext_1.getGPUDevice)();
          const data = (0, gpuBufferUtils_1.toFloat32)(inputData);
          const length = data.length;
          const blockScanShader = (0, gpuShaderBuilder_1.buildBlockScanShader)(op, id);
          const uniformAddShader = (0, gpuShaderBuilder_1.buildUniformAddShader)(op, id);
          const blockScanPipeline = (0, gpuKernelCache_1.getOrCreatePipeline)(device, blockScanShader, "main");
          const uniformAddPipeline = (0, gpuKernelCache_1.getOrCreatePipeline)(device, uniformAddShader, "main");
          const buffersToDestroy = [];
          let inputBuffer = (0, gpuBufferUtils_1.createInputBuffer)(device, data);
          buffersToDestroy.push(inputBuffer);
          if (preOp !== void 0) {
            const mapShader = (0, gpuShaderBuilder_1.buildMapShader)(preOp);
            const mapPipeline = (0, gpuKernelCache_1.getOrCreatePipeline)(device, mapShader, "main");
            const transformedBuffer = (0, gpuBufferUtils_1.createReadWriteBuffer)(device, length * 4);
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
                { binding: 2, resource: { buffer: mapParamsBuffer } }
              ]
            }));
            mapPass.dispatchWorkgroups(Math.ceil(length / gpuShaderBuilder_1.WORKGROUP_SIZE));
            mapPass.end();
            device.queue.submit([mapEncoder.finish()]);
            inputBuffer = transformedBuffer;
          }
          const finalOutput = (0, gpuBufferUtils_1.createReadWriteBuffer)(device, length * 4);
          buffersToDestroy.push(finalOutput);
          const levels = [];
          let currentIn = inputBuffer;
          let currentOut = finalOutput;
          let currentLength = length;
          while (true) {
            const numBlocks = Math.ceil(currentLength / gpuShaderBuilder_1.SCAN_BLOCK_SIZE);
            const blockSumsBuf = (0, gpuBufferUtils_1.createReadWriteBuffer)(device, numBlocks * 4);
            buffersToDestroy.push(blockSumsBuf);
            levels.push({
              inputBuffer: currentIn,
              outputBuffer: currentOut,
              blockSumsBuffer: blockSumsBuf,
              length: currentLength,
              numBlocks
            });
            if (numBlocks <= 1)
              break;
            const nextOut = (0, gpuBufferUtils_1.createReadWriteBuffer)(device, numBlocks * 4);
            buffersToDestroy.push(nextOut);
            currentIn = blockSumsBuf;
            currentOut = nextOut;
            currentLength = numBlocks;
          }
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
                { binding: 3, resource: { buffer: paramsBuf } }
              ]
            });
            pass.setBindGroup(0, bg);
            pass.dispatchWorkgroups(lvl.numBlocks);
          }
          pass.setPipeline(uniformAddPipeline);
          for (let i = levels.length - 2; i >= 0; i--) {
            const lvl = levels[i];
            const offsets = levels[i + 1].outputBuffer;
            const paramsBuf = this.makeParamsBuffer(device, lvl.length);
            buffersToDestroy.push(paramsBuf);
            const bg = device.createBindGroup({
              layout: uniformAddPipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: lvl.outputBuffer } },
                { binding: 1, resource: { buffer: offsets } },
                { binding: 2, resource: { buffer: paramsBuf } }
              ]
            });
            pass.setBindGroup(0, bg);
            pass.dispatchWorkgroups(Math.ceil(lvl.length / gpuShaderBuilder_1.WORKGROUP_SIZE));
          }
          pass.end();
          device.queue.submit([encoder.finish()]);
          const result = await (0, gpuBufferUtils_1.readbackBuffer)(device, finalOutput, length * 4);
          for (const b of buffersToDestroy)
            b.destroy();
          return Array.from(result);
        }
        makeParamsBuffer(device, length) {
          const buf = device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
          });
          new Uint32Array(buf.getMappedRange()).set([length]);
          buf.unmap();
          return buf;
        }
        getIdentity(op) {
          const name = typeof op === "string" ? op : "";
          switch (name) {
            case "add":
              return 0;
            case "multiply":
              return 1;
            case "min":
              return 3402823e32;
            case "max":
              return -3402823e32;
            default:
              return 0;
          }
        }
      };
      exports.ParallelScanGPU = ParallelScanGPU2;
    }
  });

  // dist/patterns/mapReduceGPU.js
  var require_mapReduceGPU = __commonJS({
    "dist/patterns/mapReduceGPU.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.ParallelMapReduceGPU = void 0;
      var mapGPU_1 = require_mapGPU();
      var reduceGPU_1 = require_reduceGPU();
      var ParallelMapReduceGPU2 = class {
        constructor() {
          this.mapper = new mapGPU_1.ParallelMapGPU();
          this.reducer = new reduceGPU_1.ParallelReduceGPU();
        }
        async mapReduce(mapOp, reduceOp, inputData, initialValue) {
          if (inputData.length === 0)
            return initialValue ?? 0;
          const mapped = await this.mapper.map(mapOp, inputData);
          return this.reducer.reduce(reduceOp, mapped, initialValue);
        }
      };
      exports.ParallelMapReduceGPU = ParallelMapReduceGPU2;
    }
  });

  // dist/patterns/scatterGPU.js
  var require_scatterGPU = __commonJS({
    "dist/patterns/scatterGPU.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.ParallelScatterGPU = void 0;
      var gpuContext_1 = require_gpuContext();
      var gpuBufferUtils_1 = require_gpuBufferUtils();
      var gpuKernelCache_1 = require_gpuKernelCache();
      var gpuShaderBuilder_1 = require_gpuShaderBuilder();
      var ParallelScatterGPU2 = class {
        async scatter(inputData, indices, outputLength, defaultValue = 0, preOp) {
          if (inputData.length === 0)
            return [];
          if (inputData.length !== indices.length) {
            throw new Error("Input data and indices must have the same length");
          }
          const device = await (0, gpuContext_1.getGPUDevice)();
          const length = inputData.length;
          let maxIdx;
          if (outputLength !== void 0) {
            maxIdx = outputLength;
          } else {
            maxIdx = 0;
            for (let i = 0; i < indices.length; i++) {
              if (indices[i] > maxIdx)
                maxIdx = indices[i];
            }
            maxIdx += 1;
          }
          const f32Input = (0, gpuBufferUtils_1.toFloat32)(inputData);
          const u32Indices = new Uint32Array(indices);
          const inputBuffer = (0, gpuBufferUtils_1.createInputBuffer)(device, f32Input);
          const indicesBuffer = device.createBuffer({
            size: u32Indices.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
          });
          new Uint32Array(indicesBuffer.getMappedRange()).set(u32Indices);
          indicesBuffer.unmap();
          const outputBuffer = device.createBuffer({
            size: maxIdx * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
          });
          new Float32Array(outputBuffer.getMappedRange()).fill(defaultValue);
          outputBuffer.unmap();
          const paramsBuffer = device.createBuffer({
            size: 8,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
          });
          new Uint32Array(paramsBuffer.getMappedRange()).set([length, maxIdx]);
          paramsBuffer.unmap();
          const shader = (0, gpuShaderBuilder_1.buildScatterShader)(preOp);
          const pipeline = (0, gpuKernelCache_1.getOrCreatePipeline)(device, shader, "main");
          const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: inputBuffer } },
              { binding: 1, resource: { buffer: indicesBuffer } },
              { binding: 2, resource: { buffer: outputBuffer } },
              { binding: 3, resource: { buffer: paramsBuffer } }
            ]
          });
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(Math.ceil(length / gpuShaderBuilder_1.WORKGROUP_SIZE));
          pass.end();
          device.queue.submit([encoder.finish()]);
          const result = await (0, gpuBufferUtils_1.readbackBuffer)(device, outputBuffer, maxIdx * 4);
          inputBuffer.destroy();
          indicesBuffer.destroy();
          outputBuffer.destroy();
          paramsBuffer.destroy();
          return (0, gpuBufferUtils_1.toNumberArray)(result);
        }
      };
      exports.ParallelScatterGPU = ParallelScatterGPU2;
    }
  });

  // dist/patterns/stencilGPU.js
  var require_stencilGPU = __commonJS({
    "dist/patterns/stencilGPU.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.ParallelStencilGPU = void 0;
      var gpuContext_1 = require_gpuContext();
      var gpuBufferUtils_1 = require_gpuBufferUtils();
      var gpuKernelCache_1 = require_gpuKernelCache();
      var gpuShaderBuilder_1 = require_gpuShaderBuilder();
      var ParallelStencilGPU2 = class {
        async stencil(op, inputData, weights) {
          if (inputData.length === 0)
            return [];
          const device = await (0, gpuContext_1.getGPUDevice)();
          const length = inputData.length;
          const stencilSize = weights.length;
          const f32Input = (0, gpuBufferUtils_1.toFloat32)(inputData);
          const f32Weights = (0, gpuBufferUtils_1.toFloat32)(weights);
          const inputBuffer = (0, gpuBufferUtils_1.createInputBuffer)(device, f32Input);
          const weightsBuffer = (0, gpuBufferUtils_1.createInputBuffer)(device, f32Weights);
          const outputBuffer = (0, gpuBufferUtils_1.createOutputBuffer)(device, length * 4);
          const paramsBuffer = device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
          });
          new Uint32Array(paramsBuffer.getMappedRange()).set([length]);
          paramsBuffer.unmap();
          const shader = (0, gpuShaderBuilder_1.buildStencilShader)(op, stencilSize);
          const pipeline = (0, gpuKernelCache_1.getOrCreatePipeline)(device, shader, "main");
          const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: inputBuffer } },
              { binding: 1, resource: { buffer: weightsBuffer } },
              { binding: 2, resource: { buffer: outputBuffer } },
              { binding: 3, resource: { buffer: paramsBuffer } }
            ]
          });
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(Math.ceil(length / gpuShaderBuilder_1.WORKGROUP_SIZE));
          pass.end();
          device.queue.submit([encoder.finish()]);
          const result = await (0, gpuBufferUtils_1.readbackBuffer)(device, outputBuffer, length * 4);
          inputBuffer.destroy();
          weightsBuffer.destroy();
          outputBuffer.destroy();
          paramsBuffer.destroy();
          return (0, gpuBufferUtils_1.toNumberArray)(result);
        }
      };
      exports.ParallelStencilGPU = ParallelStencilGPU2;
    }
  });

  // dist/patterns/farmGPU.js
  var require_farmGPU = __commonJS({
    "dist/patterns/farmGPU.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.ParallelFarmGPU = void 0;
      var mapGPU_1 = require_mapGPU();
      var ParallelFarmGPU2 = class {
        constructor() {
          this.mapper = new mapGPU_1.ParallelMapGPU();
        }
        async farm(op, inputData) {
          return this.mapper.map(op, inputData);
        }
      };
      exports.ParallelFarmGPU = ParallelFarmGPU2;
    }
  });

  // dist/patterns/pipelineGPU.js
  var require_pipelineGPU = __commonJS({
    "dist/patterns/pipelineGPU.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.ParallelPipelineGPU = void 0;
      var mapGPU_1 = require_mapGPU();
      var ParallelPipelineGPU2 = class {
        constructor() {
          this.mapper = new mapGPU_1.ParallelMapGPU();
        }
        async pipeline(stages, inputData) {
          if (inputData.length === 0)
            return [];
          if (stages.length === 0)
            return [...inputData];
          let data = inputData;
          for (const stage of stages) {
            data = await this.mapper.map(stage, data);
          }
          return data;
        }
      };
      exports.ParallelPipelineGPU = ParallelPipelineGPU2;
    }
  });

  // dist/core/fftUtils.js
  var require_fftUtils = __commonJS({
    "dist/core/fftUtils.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.bitReverse = bitReverse;
      exports.isPowerOfTwo = isPowerOfTwo;
      exports.nextPow2 = nextPow2;
      exports.makeComplexFromReal = makeComplexFromReal;
      exports.fftSequential = fftSequential;
      exports.bitReversePermute = bitReversePermute;
      function bitReverse(x, bits) {
        let r = 0;
        for (let i = 0; i < bits; i++) {
          r = r << 1 | x & 1;
          x >>= 1;
        }
        return r >>> 0;
      }
      function isPowerOfTwo(n) {
        return n > 0 && (n & n - 1) === 0;
      }
      function nextPow2(n) {
        if (n <= 1)
          return 1;
        let p = 1;
        while (p < n)
          p <<= 1;
        return p;
      }
      function makeComplexFromReal(N, make) {
        const buf = new Float64Array(2 * N);
        for (let i = 0; i < N; i++)
          buf[2 * i] = make(i);
        return buf;
      }
      function fftSequential(data) {
        const N = data.length / 2;
        if (!isPowerOfTwo(N))
          throw new Error("fftSequential: N must be power of two, got " + N);
        if (N <= 1)
          return data;
        const bits = Math.log2(N) | 0;
        for (let i = 0; i < N; i++) {
          const j = bitReverse(i, bits);
          if (j > i) {
            const ar = data[2 * i], ai = data[2 * i + 1];
            data[2 * i] = data[2 * j];
            data[2 * i + 1] = data[2 * j + 1];
            data[2 * j] = ar;
            data[2 * j + 1] = ai;
          }
        }
        for (let s = 1; s <= bits; s++) {
          const m = 1 << s;
          const half = m >> 1;
          const angleStep = -2 * Math.PI / m;
          for (let k = 0; k < N; k += m) {
            for (let j = 0; j < half; j++) {
              const wRe = Math.cos(angleStep * j);
              const wIm = Math.sin(angleStep * j);
              const oRe = data[2 * (k + j + half)], oIm = data[2 * (k + j + half) + 1];
              const tRe = wRe * oRe - wIm * oIm;
              const tIm = wRe * oIm + wIm * oRe;
              const eRe = data[2 * (k + j)], eIm = data[2 * (k + j) + 1];
              data[2 * (k + j + half)] = eRe - tRe;
              data[2 * (k + j + half) + 1] = eIm - tIm;
              data[2 * (k + j)] = eRe + tRe;
              data[2 * (k + j) + 1] = eIm + tIm;
            }
          }
        }
        return data;
      }
      function bitReversePermute(data) {
        const N = data.length / 2;
        if (!isPowerOfTwo(N))
          throw new Error("bitReversePermute: N must be power of two");
        const bits = Math.log2(N) | 0;
        for (let i = 0; i < N; i++) {
          const j = bitReverse(i, bits);
          if (j > i) {
            const ar = data[2 * i], ai = data[2 * i + 1];
            data[2 * i] = data[2 * j];
            data[2 * i + 1] = data[2 * j + 1];
            data[2 * j] = ar;
            data[2 * j + 1] = ai;
          }
        }
      }
    }
  });

  // dist/patterns/divideAndConquerGPU.js
  var require_divideAndConquerGPU = __commonJS({
    "dist/patterns/divideAndConquerGPU.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.ParallelDivideAndConquerGPU = void 0;
      var mapGPU_1 = require_mapGPU();
      var gpuShaderBuilder_1 = require_gpuShaderBuilder();
      var gpuContext_1 = require_gpuContext();
      var gpuBufferUtils_1 = require_gpuBufferUtils();
      var gpuKernelCache_1 = require_gpuKernelCache();
      var fftUtils_1 = require_fftUtils();
      var ParallelDivideAndConquerGPU2 = class {
        constructor() {
          this.mapper = new mapGPU_1.ParallelMapGPU();
        }
        async divideAndConquer(inputData, options) {
          if (inputData.length === 0)
            return [];
          const leafChunks = [];
          const tree = this.buildTree(inputData, options, leafChunks);
          const totalElements = leafChunks.reduce((sum, c) => sum + c.length, 0);
          const flatData = new Array(totalElements);
          let offset = 0;
          for (const chunk of leafChunks) {
            for (let i = 0; i < chunk.length; i++) {
              flatData[offset + i] = chunk[i];
            }
            offset += chunk.length;
          }
          const gpuResult = await this.mapper.map(options.conquerOp, flatData);
          const leafResults = [];
          offset = 0;
          for (const chunk of leafChunks) {
            leafResults.push(gpuResult.slice(offset, offset + chunk.length));
            offset += chunk.length;
          }
          return this.recombine(tree, leafResults, options.combineFn);
        }
        buildTree(data, options, leafChunks) {
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
          const children = subproblems.map((sp) => this.buildTree(sp, options, leafChunks));
          return { type: "branch", children };
        }
        recombine(node, leafResults, combineFn) {
          if (node.type === "leaf") {
            return leafResults[node.offset];
          }
          const childResults = node.children.map((child) => this.recombine(child, leafResults, combineFn));
          return combineFn(childResults);
        }
        async sort(inputData) {
          const n = inputData.length;
          if (n <= 1)
            return inputData.slice();
          const device = await (0, gpuContext_1.getGPUDevice)();
          let m = 1;
          while (m < n)
            m <<= 1;
          const padded = new Float32Array(m);
          const f32 = (0, gpuBufferUtils_1.toFloat32)(inputData);
          padded.set(f32);
          for (let i = n; i < m; i++)
            padded[i] = Infinity;
          const dataBuffer = (0, gpuBufferUtils_1.createReadWriteBuffer)(device, m * 4);
          device.queue.writeBuffer(dataBuffer, 0, padded.buffer, padded.byteOffset, padded.byteLength);
          const shader = (0, gpuShaderBuilder_1.buildBitonicSortKernel)();
          const pipeline = (0, gpuKernelCache_1.getOrCreatePipeline)(device, shader, "main");
          const paramsBuffer = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
          });
          const paramsHost = new Uint32Array(4);
          paramsHost[2] = m;
          const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: dataBuffer } },
              { binding: 1, resource: { buffer: paramsBuffer } }
            ]
          });
          const dispatchCount = Math.ceil(m / 2 / gpuShaderBuilder_1.WORKGROUP_SIZE);
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
          const readback = await (0, gpuBufferUtils_1.readbackBuffer)(device, dataBuffer, m * 4);
          dataBuffer.destroy();
          paramsBuffer.destroy();
          const result = new Array(n);
          for (let i = 0; i < n; i++)
            result[i] = readback[i];
          return result;
        }
        async fft(complexData) {
          const data = complexData instanceof Float64Array ? new Float64Array(complexData) : Float64Array.from(complexData);
          const N = data.length / 2;
          if (N <= 1)
            return data;
          if (!(0, fftUtils_1.isPowerOfTwo)(N))
            throw new Error(`ParallelDivideAndConquerGPU.fft: N must be power of two, got ${N}`);
          (0, fftUtils_1.bitReversePermute)(data);
          const device = await (0, gpuContext_1.getGPUDevice)();
          const f32 = new Float32Array(2 * N);
          for (let i = 0; i < f32.length; i++)
            f32[i] = data[i];
          const dataBuffer = (0, gpuBufferUtils_1.createReadWriteBuffer)(device, 2 * N * 4);
          device.queue.writeBuffer(dataBuffer, 0, f32.buffer, f32.byteOffset, f32.byteLength);
          const shader = (0, gpuShaderBuilder_1.buildFFTButterflyKernel)();
          const pipeline = (0, gpuKernelCache_1.getOrCreatePipeline)(device, shader, "main");
          const paramsBuffer = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
          });
          const paramsHost = new Uint32Array(4);
          paramsHost[2] = N;
          const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: dataBuffer } },
              { binding: 1, resource: { buffer: paramsBuffer } }
            ]
          });
          const dispatchCount = Math.ceil(N / 2 / gpuShaderBuilder_1.WORKGROUP_SIZE);
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
          const readback = await (0, gpuBufferUtils_1.readbackBuffer)(device, dataBuffer, 2 * N * 4);
          dataBuffer.destroy();
          paramsBuffer.destroy();
          const out = new Float64Array(2 * N);
          for (let i = 0; i < out.length; i++)
            out[i] = readback[i];
          return out;
        }
      };
      exports.ParallelDivideAndConquerGPU = ParallelDivideAndConquerGPU2;
    }
  });

  // browser-bench/entry.js
  var { ParallelMapGPU } = require_mapGPU();
  var { ParallelFilterGPU } = require_filterGPU();
  var { ParallelReduceGPU } = require_reduceGPU();
  var { ParallelScanGPU } = require_scanGPU();
  var { ParallelMapReduceGPU } = require_mapReduceGPU();
  var { ParallelScatterGPU } = require_scatterGPU();
  var { ParallelStencilGPU } = require_stencilGPU();
  var { ParallelFarmGPU } = require_farmGPU();
  var { ParallelPipelineGPU } = require_pipelineGPU();
  var { ParallelDivideAndConquerGPU } = require_divideAndConquerGPU();
  var { isGPUAvailable } = require_gpuContext();
  window.PW_GPU = {
    Map: ParallelMapGPU,
    Filter: ParallelFilterGPU,
    Reduce: ParallelReduceGPU,
    Scan: ParallelScanGPU,
    MapReduce: ParallelMapReduceGPU,
    Scatter: ParallelScatterGPU,
    Stencil: ParallelStencilGPU,
    Farm: ParallelFarmGPU,
    Pipeline: ParallelPipelineGPU,
    DivideAndConquer: ParallelDivideAndConquerGPU,
    isGPUAvailable
  };
})();
