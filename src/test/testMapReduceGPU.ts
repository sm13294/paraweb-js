export {};
const { ParallelMapReduceGPU } = require("../index");
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


const mapReduceGPU = new ParallelMapReduceGPU();
const runner = new PatternTestRunner("MapReduceGPU");
const benchmarkRunner = new BenchmarkRunner();

async function runFunctionalTests() {
  // Test 1: Square then sum
  await runner.runFunctionalTest("Square then sum [1,2,3,4] → 30", async () => {
    const input = [1, 2, 3, 4];
    const output = await mapReduceGPU.mapReduce("square", "add", input);
    assert(Math.abs(output - 30) < 0.01, `Expected 30, got ${output}`);
  });

  // Test 2: Double then sum
  await runner.runFunctionalTest("Double then sum [1,2,3,4,5] → 30", async () => {
    const input = [1, 2, 3, 4, 5];
    const output = await mapReduceGPU.mapReduce("double", "add", input);
    assert(Math.abs(output - 30) < 0.01, `Expected 30, got ${output}`);
  });

  // Test 3: Square then product
  await runner.runFunctionalTest("Square then product [1,2,3] → 36", async () => {
    const input = [1, 2, 3];
    const output = await mapReduceGPU.mapReduce("square", "multiply", input);
    assert(Math.abs(output - 36) < 0.01, `Expected 36, got ${output}`);
  });

  // Test 4: With initial value
  await runner.runFunctionalTest("Square then sum with initial value 10", async () => {
    const input = [1, 2, 3, 4];
    const output = await mapReduceGPU.mapReduce("square", "add", input, 10);
    assert(Math.abs(output - 40) < 0.01, `Expected 40, got ${output}`);
  });

  // Test 5: Custom WGSL map then sum
  await runner.runFunctionalTest("Custom WGSL (x * x + 1) then sum", async () => {
    const input = [1, 2, 3, 4];
    const output = await mapReduceGPU.mapReduce({ wgsl: "x * x + 1.0" }, "add", input);
    // (2 + 5 + 10 + 17) = 34
    assert(Math.abs(output - 34) < 0.01, `Expected 34, got ${output}`);
  });

  // Test 6: Empty array returns initial value
  await runner.runFunctionalTest("Empty array returns initial value", async () => {
    const output = await mapReduceGPU.mapReduce("square", "add", [], 42);
    assert(Math.abs(output - 42) < 0.01, `Expected 42, got ${output}`);
  });

  // Test 7: Single element
  await runner.runFunctionalTest("Single element", async () => {
    const output = await mapReduceGPU.mapReduce("square", "add", [5]);
    assert(Math.abs(output - 25) < 0.01, `Expected 25, got ${output}`);
  });

  // Test 8: Negate then min
  await runner.runFunctionalTest("Negate then min [1,2,3,4,5] → -5", async () => {
    const input = [1, 2, 3, 4, 5];
    const output = await mapReduceGPU.mapReduce("negate", "min", input);
    assert(Math.abs(output - (-5)) < 0.01, `Expected -5, got ${output}`);
  });
}

async function runBenchmarks() {
  const testMode = process.env.TEST_MODE;
  if (testMode !== "benchmark") return;

  await benchmarkRunner.runBenchmark({
    pattern: "MapReduceGPU",
    sizes: [
      { name: "Small", size: 10000, description: "10K elements" },
      { name: "Medium", size: 100000, description: "100K elements" },
      { name: "Large", size: 1000000, description: "1M elements" },
      { name: "Extremely Large", size: 10000000, description: "10M elements" },
    ],
    threadCounts: [1], // GPU does not use thread count parameter
    testFn: async (size: number) => {
      const input = __getCachedInput("testMapReduceGPU.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1)));
      return mapReduceGPU.mapReduce("trig_50", "add", input);
    },
    runs: 5,
    warmupRuns: 2,
  });
}

async function main() {
  const available = await isGPUAvailable();
  if (!available) {
    console.log("WebGPU is not available. Skipping MapReduceGPU tests.");
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
