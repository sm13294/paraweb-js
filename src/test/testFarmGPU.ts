export {};
const { ParallelFarmGPU } = require("../index");
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


const farmGPU = new ParallelFarmGPU();
const runner = new PatternTestRunner("FarmGPU");
const benchmarkRunner = new BenchmarkRunner();

async function runFunctionalTests() {
  // Test 1: Basic square operation
  await runner.runFunctionalTest("Square operation", async () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const output = await farmGPU.farm("square", input);
    const expected = [1, 4, 9, 16, 25, 36, 49, 64];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 2: Double operation
  await runner.runFunctionalTest("Double operation", async () => {
    const input = [1, 2, 3, 4];
    const output = await farmGPU.farm("double", input);
    const expected = [2, 4, 6, 8];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 3: Empty array
  await runner.runFunctionalTest("Empty array", async () => {
    const output = await farmGPU.farm("square", []);
    assert.deepStrictEqual(output, []);
  });

  // Test 4: Single element
  await runner.runFunctionalTest("Single element", async () => {
    const output = await farmGPU.farm("square", [5]);
    assert(Math.abs(output[0] - 25) < 0.01);
  });

  // Test 5: Custom WGSL expression
  await runner.runFunctionalTest("Custom WGSL expression (x * x + 1)", async () => {
    const input = [1, 2, 3, 4];
    const output = await farmGPU.farm({ wgsl: "x * x + 1.0" }, input);
    const expected = [2, 5, 10, 17];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 6: Negate operation
  await runner.runFunctionalTest("Negate operation", async () => {
    const input = [1, -2, 3, -4];
    const output = await farmGPU.farm("negate", input);
    const expected = [-1, 2, -3, 4];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01);
    }
  });

  // Test 7: Collatz steps
  await runner.runFunctionalTest("Collatz steps", async () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const output = await farmGPU.farm("collatz_steps", input);
    const expected = [0, 1, 7, 2, 5, 8, 16, 3];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Collatz(${input[i]}): expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 8: Large array
  await runner.runFunctionalTest("Large array (10K elements)", async () => {
    const input = Array.from({ length: 10000 }, (_, i) => i + 1);
    const output = await farmGPU.farm("double", input);
    assert.strictEqual(output.length, 10000);
    assert(Math.abs(output[0] - 2) < 0.01);
    assert(Math.abs(output[9999] - 20000) < 0.01);
  });
}

async function runBenchmarks() {
  const testMode = process.env.TEST_MODE;
  if (testMode !== "benchmark") return;

  await benchmarkRunner.runBenchmark({
    pattern: "FarmGPU",
    sizes: [
      { name: "Small", size: 10000, description: "10K elements" },
      { name: "Medium", size: 100000, description: "100K elements" },
      { name: "Large", size: 1000000, description: "1M elements" },
      // Match the CPU Farm cap (5M) so GPU and CPU compare equivalent workloads.
      { name: "Extremely Large", size: 5000000, description: "5M elements (matches CPU Farm cap)" },
    ],
    threadCounts: [1], // GPU does not use thread count parameter
    testFn: async (size: number) => {
      // Same per-task workload as CPU Farm: Collatz step-count + 200-iter
      // trigonometric refinement. WGSL `farm_collatz_trig_200` mirrors the
      // CPU formula exactly so the comparison is apples-to-apples.
      const input = __getCachedInput("testFarmGPU.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1000)));
      return farmGPU.farm("farm_collatz_trig_200", input);
    },
    runs: 5,
    warmupRuns: 2,
  });
}

async function main() {
  const available = await isGPUAvailable();
  if (!available) {
    console.log("WebGPU is not available. Skipping FarmGPU tests.");
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
