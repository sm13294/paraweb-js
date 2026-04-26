export {};
const { ParallelReduceGPU } = require("../index");
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


const reduceGPU = new ParallelReduceGPU();
const runner = new PatternTestRunner("ReduceGPU");
const benchmarkRunner = new BenchmarkRunner();

async function runFunctionalTests() {
  // Test 1: Sum of array
  await runner.runFunctionalTest("Sum of [1,2,3,4,5]", async () => {
    const input = [1, 2, 3, 4, 5];
    const output = await reduceGPU.reduce("add", input);
    assert(Math.abs(output - 15) < 0.01, `Expected 15, got ${output}`);
  });

  // Test 2: Product of array
  await runner.runFunctionalTest("Product of [1,2,3,4,5]", async () => {
    const input = [1, 2, 3, 4, 5];
    const output = await reduceGPU.reduce("multiply", input);
    assert(Math.abs(output - 120) < 0.01, `Expected 120, got ${output}`);
  });

  // Test 3: Min operation
  await runner.runFunctionalTest("Min of [5, 3, 8, 1, 9]", async () => {
    const input = [5, 3, 8, 1, 9];
    const output = await reduceGPU.reduce("min", input);
    assert(Math.abs(output - 1) < 0.01, `Expected 1, got ${output}`);
  });

  // Test 4: Max operation
  await runner.runFunctionalTest("Max of [5, 3, 8, 1, 9]", async () => {
    const input = [5, 3, 8, 1, 9];
    const output = await reduceGPU.reduce("max", input);
    assert(Math.abs(output - 9) < 0.01, `Expected 9, got ${output}`);
  });

  // Test 5: With initial value
  await runner.runFunctionalTest("Sum with initial value 10", async () => {
    const input = [1, 2, 3, 4, 5];
    const output = await reduceGPU.reduce("add", input, 10);
    assert(Math.abs(output - 25) < 0.01, `Expected 25, got ${output}`);
  });

  // Test 6: Empty array returns initial value
  await runner.runFunctionalTest("Empty array returns initial value", async () => {
    const output = await reduceGPU.reduce("add", [], 42);
    assert(Math.abs(output - 42) < 0.01, `Expected 42, got ${output}`);
  });

  // Test 7: Single element
  await runner.runFunctionalTest("Single element", async () => {
    const output = await reduceGPU.reduce("add", [7]);
    assert(Math.abs(output - 7) < 0.01, `Expected 7, got ${output}`);
  });

  // Test 8: Large array sum
  await runner.runFunctionalTest("Large array sum (10K elements)", async () => {
    const input = Array.from({ length: 10000 }, (_, i) => 1);
    const output = await reduceGPU.reduce("add", input);
    assert(Math.abs(output - 10000) < 1.0, `Expected 10000, got ${output}`);
  });

  // Test 9: Product with initial value
  await runner.runFunctionalTest("Product with initial value 2", async () => {
    const input = [3, 4, 5];
    const output = await reduceGPU.reduce("multiply", input, 2);
    assert(Math.abs(output - 120) < 0.01, `Expected 120, got ${output}`);
  });
}

async function runBenchmarks() {
  const testMode = process.env.TEST_MODE;
  if (testMode !== "benchmark") return;

  await benchmarkRunner.runBenchmark({
    pattern: "ReduceGPU",
    sizes: [
      { name: "Small", size: 10000, description: "10K elements" },
      { name: "Medium", size: 100000, description: "100K elements" },
      { name: "Large", size: 1000000, description: "1M elements" },
      { name: "Extremely Large", size: 10000000, description: "10M elements" },
    ],
    threadCounts: [1], // GPU does not use thread count parameter
    testFn: async (size: number) => {
      const input = __getCachedInput("testReduceGPU.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 100) + 1)));
      // Fused per-element transform + associative sum. The transform mirrors
      // the 10-iteration sin+cos `mapFn` used by the CPU Reduce benchmark so
      // that GPU and CPU measure equivalent workloads (apples-to-apples).
      return reduceGPU.reduce("add", input, undefined, "trig_reduce_10");
    },
    runs: 5,
    warmupRuns: 2,
  });
}

async function main() {
  const available = await isGPUAvailable();
  if (!available) {
    console.log("WebGPU is not available. Skipping ReduceGPU tests.");
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
