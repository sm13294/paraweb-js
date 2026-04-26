export {};
const { ParallelScatterGPU } = require("../index");
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
const seedrandom = require("seedrandom");


const scatterGPU = new ParallelScatterGPU();
const runner = new PatternTestRunner("ScatterGPU");
const benchmarkRunner = new BenchmarkRunner();

async function runFunctionalTests() {
  // Test 1: Basic scatter
  await runner.runFunctionalTest("Scatter [10,20,30] with indices [2,0,1] → [20,30,10]", async () => {
    const input = [10, 20, 30];
    const indices = [2, 0, 1];
    const output = await scatterGPU.scatter(input, indices);
    const expected = [20, 30, 10];
    assert.strictEqual(output.length, expected.length, `Expected ${expected.length} elements, got ${output.length}`);
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 2: Identity scatter (same positions)
  await runner.runFunctionalTest("Identity scatter", async () => {
    const input = [1, 2, 3, 4];
    const indices = [0, 1, 2, 3];
    const output = await scatterGPU.scatter(input, indices);
    for (let i = 0; i < input.length; i++) {
      assert(Math.abs(output[i] - input[i]) < 0.01, `Element ${i}: expected ${input[i]}, got ${output[i]}`);
    }
  });

  // Test 3: Reverse scatter
  await runner.runFunctionalTest("Reverse scatter", async () => {
    const input = [1, 2, 3, 4];
    const indices = [3, 2, 1, 0];
    const output = await scatterGPU.scatter(input, indices);
    const expected = [4, 3, 2, 1];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 4: Scatter with gaps and default value
  await runner.runFunctionalTest("Scatter with gaps and default value", async () => {
    const input = [10, 20];
    const indices = [0, 4];
    const output = await scatterGPU.scatter(input, indices, 5, -1);
    assert.strictEqual(output.length, 5, `Expected 5 elements, got ${output.length}`);
    assert(Math.abs(output[0] - 10) < 0.01, `Element 0: expected 10, got ${output[0]}`);
    assert(Math.abs(output[4] - 20) < 0.01, `Element 4: expected 20, got ${output[4]}`);
    // Gap positions should have default value -1
    assert(Math.abs(output[1] - (-1)) < 0.01, `Element 1: expected -1, got ${output[1]}`);
    assert(Math.abs(output[2] - (-1)) < 0.01, `Element 2: expected -1, got ${output[2]}`);
    assert(Math.abs(output[3] - (-1)) < 0.01, `Element 3: expected -1, got ${output[3]}`);
  });

  // Test 5: Empty array
  await runner.runFunctionalTest("Empty array", async () => {
    const output = await scatterGPU.scatter([], []);
    assert.deepStrictEqual(output, []);
  });

  // Test 6: Single element
  await runner.runFunctionalTest("Single element", async () => {
    const output = await scatterGPU.scatter([42], [0]);
    assert.strictEqual(output.length, 1);
    assert(Math.abs(output[0] - 42) < 0.01);
  });

  // Test 7: Scatter with default value 0 (gaps filled with 0)
  await runner.runFunctionalTest("Scatter with gaps filled with 0", async () => {
    const input = [10, 20];
    const indices = [0, 3];
    const output = await scatterGPU.scatter(input, indices, 4);
    assert.strictEqual(output.length, 4);
    assert(Math.abs(output[0] - 10) < 0.01);
    assert(Math.abs(output[1] - 0) < 0.01);
    assert(Math.abs(output[2] - 0) < 0.01);
    assert(Math.abs(output[3] - 20) < 0.01);
  });

  // Test 8: Large array
  await runner.runFunctionalTest("Large array (10K elements)", async () => {
    const size = 10000;
    const input = Array.from({ length: size }, (_, i) => i + 1);
    // Reverse indices
    const indices = Array.from({ length: size }, (_, i) => size - 1 - i);
    const output = await scatterGPU.scatter(input, indices);
    assert.strictEqual(output.length, size);
    assert(Math.abs(output[0] - size) < 0.01);
    assert(Math.abs(output[size - 1] - 1) < 0.01);
  });
}

async function runBenchmarks() {
  const testMode = process.env.TEST_MODE;
  if (testMode !== "benchmark") return;

  await benchmarkRunner.runBenchmark({
    pattern: "ScatterGPU",
    sizes: [
      { name: "Small", size: 10000, description: "10K elements" },
      { name: "Medium", size: 100000, description: "100K elements" },
      { name: "Large", size: 1000000, description: "1M elements" },
      { name: "Extremely Large", size: 10000000, description: "10M elements" },
    ],
    threadCounts: [1], // GPU does not use thread count parameter
    testFn: async (size: number) => {
      // Match CPU Shared exactly: same RNG seed, same input and indices distribution,
      // and the same fused 50-iter trigonometric per-element transform so that
      // GPU and CPU measure equivalent workloads (apples-to-apples).
      const rng = seedrandom("scatter-shared-benchmark");
      const input = __getCachedInput("testScatterGPU.ts:input:" + String(size), () => (Array.from({ length: size }, () => Math.floor(rng() * 1000))));
      const indices = __getCachedInput("testScatterGPU.ts:indices:" + String(size), () => (Array.from({ length: size }, () => Math.floor(rng() * (size / 4)))));
      return scatterGPU.scatter(input, indices, undefined, 0, "trig_scan_50");
    },
    runs: 5,
    warmupRuns: 2,
  });
}

async function main() {
  const available = await isGPUAvailable();
  if (!available) {
    console.log("WebGPU is not available. Skipping ScatterGPU tests.");
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
