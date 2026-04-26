export {};
const { ParallelDivideAndConquerGPU } = require("../index");
const { isGPUAvailable } = require("../core/gpuContext");
const { PatternTestRunner } = require("./testUtils");
const { BenchmarkRunner } = require("./benchmarkRunner");
const assert = require("assert");

// Cache inputs across benchmark runs so that JS array creation time is not
// included in per-call timing. Keyed by file+size.
const __inputCache = new Map<string, any>();
function __getCachedInput<T>(key: string, factory: () => T): T {
  let v = __inputCache.get(key);
  if (v === undefined) { v = factory(); __inputCache.set(key, v); }
  return v;
}


const dacGPU = new ParallelDivideAndConquerGPU();
const runner = new PatternTestRunner("DivideAndConquerGPU");
const benchmarkRunner = new BenchmarkRunner();

async function runFunctionalTests() {
  // Test 1: Sum of squares via divide and conquer
  await runner.runFunctionalTest("Square elements: divide in half, conquer with square, combine by concat", async () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const output = await dacGPU.divideAndConquer(input, {
      conquerOp: "square",
      divideFn: (data: number[]) => {
        const mid = Math.floor(data.length / 2);
        return [data.slice(0, mid), data.slice(mid)];
      },
      combineFn: (results: number[][]) => {
        return results.reduce((acc, r) => acc.concat(r), []);
      },
      threshold: 4,
    });
    const expected = [1, 4, 9, 16, 25, 36, 49, 64];
    assert.strictEqual(output.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 2: Double elements via divide and conquer
  await runner.runFunctionalTest("Double elements with threshold 2", async () => {
    const input = [1, 2, 3, 4];
    const output = await dacGPU.divideAndConquer(input, {
      conquerOp: "double",
      divideFn: (data: number[]) => {
        const mid = Math.floor(data.length / 2);
        return [data.slice(0, mid), data.slice(mid)];
      },
      combineFn: (results: number[][]) => {
        return results.reduce((acc, r) => acc.concat(r), []);
      },
      threshold: 2,
    });
    const expected = [2, 4, 6, 8];
    assert.strictEqual(output.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 3: Empty array
  await runner.runFunctionalTest("Empty array", async () => {
    const output = await dacGPU.divideAndConquer([], {
      conquerOp: "square",
      divideFn: (data: number[]) => {
        const mid = Math.floor(data.length / 2);
        return [data.slice(0, mid), data.slice(mid)];
      },
      combineFn: (results: number[][]) => results.reduce((acc, r) => acc.concat(r), []),
      threshold: 4,
    });
    assert.deepStrictEqual(output, []);
  });

  // Test 4: Single element (below threshold, processed directly on GPU)
  await runner.runFunctionalTest("Single element", async () => {
    const output = await dacGPU.divideAndConquer([5], {
      conquerOp: "square",
      divideFn: (data: number[]) => {
        const mid = Math.floor(data.length / 2);
        return [data.slice(0, mid), data.slice(mid)];
      },
      combineFn: (results: number[][]) => results.reduce((acc, r) => acc.concat(r), []),
      threshold: 4,
    });
    assert.strictEqual(output.length, 1);
    assert(Math.abs(output[0] - 25) < 0.01, `Expected 25, got ${output[0]}`);
  });

  // Test 5: Custom WGSL conquer operation
  await runner.runFunctionalTest("Custom WGSL conquer (x * x + 1)", async () => {
    const input = [1, 2, 3, 4];
    const output = await dacGPU.divideAndConquer(input, {
      conquerOp: { wgsl: "x * x + 1.0" },
      divideFn: (data: number[]) => {
        const mid = Math.floor(data.length / 2);
        return [data.slice(0, mid), data.slice(mid)];
      },
      combineFn: (results: number[][]) => results.reduce((acc, r) => acc.concat(r), []),
      threshold: 2,
    });
    const expected = [2, 5, 10, 17];
    assert.strictEqual(output.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 6: Data smaller than threshold (no divide, direct GPU execution)
  await runner.runFunctionalTest("Data smaller than threshold", async () => {
    const input = [2, 3];
    const output = await dacGPU.divideAndConquer(input, {
      conquerOp: "square",
      divideFn: (data: number[]) => {
        const mid = Math.floor(data.length / 2);
        return [data.slice(0, mid), data.slice(mid)];
      },
      combineFn: (results: number[][]) => results.reduce((acc, r) => acc.concat(r), []),
      threshold: 4,
    });
    const expected = [4, 9];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 7: Large array with negate
  await runner.runFunctionalTest("Large array (10K elements) with negate", async () => {
    const input = Array.from({ length: 10000 }, (_, i) => i + 1);
    const output = await dacGPU.divideAndConquer(input, {
      conquerOp: "negate",
      divideFn: (data: number[]) => {
        const mid = Math.floor(data.length / 2);
        return [data.slice(0, mid), data.slice(mid)];
      },
      combineFn: (results: number[][]) => results.reduce((acc, r) => acc.concat(r), []),
      threshold: 1000,
    });
    assert.strictEqual(output.length, 10000);
    assert(Math.abs(output[0] - (-1)) < 0.01);
    assert(Math.abs(output[9999] - (-10000)) < 0.01);
  });
}

async function runBenchmarks() {
  const testMode = process.env.TEST_MODE;
  if (testMode !== "benchmark") return;

  await benchmarkRunner.runBenchmark({
    pattern: "DivideAndConquerGPU",
    sizes: [
      // Power-of-two sizes for FFT.
      { name: "Small",           size: 16384,   description: "Cooley-Tukey FFT (16K complex points)" },
      { name: "Medium",          size: 131072,  description: "Cooley-Tukey FFT (128K complex points)" },
      { name: "Large",           size: 1048576, description: "Cooley-Tukey FFT (1M complex points)" },
      { name: "Extremely Large", size: 8388608, description: "Cooley-Tukey FFT (8M complex points)" },
    ],
    threadCounts: [1], // GPU does not use thread count parameter
    testFn: async (size: number) => {
      // Same FFT workload + algorithm as CPU MP/Shared D&C — different parallel
      // execution strategy (one WGSL dispatch per stage), same numerical result.
      const input = __getCachedInput("testDivideAndConquerGPU.ts:fft-input:" + String(size), () => {
        const buf = new Float64Array(2 * size);
        for (let i = 0; i < size; i++) buf[2 * i] = Math.sin(i * 0.001) + Math.cos(i * 0.0005);
        return buf;
      }) as Float64Array;
      return dacGPU.fft(input);
    },
    runs: 5,
    warmupRuns: 2,
  });
}

async function main() {
  const available = await isGPUAvailable();
  if (!available) {
    console.log("WebGPU is not available. Skipping DivideAndConquerGPU tests.");
    console.log("Install the 'webgpu' npm package for Node.js GPU support.");
    return;
  }

  const testMode = process.env.TEST_MODE;
  if (!testMode || testMode === "functional") {
    await runFunctionalTests();
    runner.printSummary();
  }
  if (testMode === "benchmark") {
    await runBenchmarks();
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
