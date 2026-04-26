export {};
const { ParallelMapGPU } = require("../index");
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


const mapGPU = new ParallelMapGPU();
const runner = new PatternTestRunner("MapGPU");
const benchmarkRunner = new BenchmarkRunner();

async function runFunctionalTests() {
  // Test 1: Basic square operation
  await runner.runFunctionalTest("Square operation", async () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const output = await mapGPU.map("square", input);
    const expected = [1, 4, 9, 16, 25, 36, 49, 64];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 2: Double operation
  await runner.runFunctionalTest("Double operation", async () => {
    const input = [1, 2, 3, 4];
    const output = await mapGPU.map("double", input);
    const expected = [2, 4, 6, 8];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 3: Empty array
  await runner.runFunctionalTest("Empty array", async () => {
    const output = await mapGPU.map("square", []);
    assert.deepStrictEqual(output, []);
  });

  // Test 4: Single element
  await runner.runFunctionalTest("Single element", async () => {
    const output = await mapGPU.map("square", [5]);
    assert(Math.abs(output[0] - 25) < 0.01);
  });

  // Test 5: Custom WGSL expression
  await runner.runFunctionalTest("Custom WGSL expression (x * x + 1)", async () => {
    const input = [1, 2, 3, 4];
    const output = await mapGPU.map({ wgsl: "x * x + 1.0" }, input);
    const expected = [2, 5, 10, 17];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 6: Large array
  await runner.runFunctionalTest("Large array (10K elements)", async () => {
    const input = Array.from({ length: 10000 }, (_, i) => i + 1);
    const output = await mapGPU.map("double", input);
    assert.strictEqual(output.length, 10000);
    assert(Math.abs(output[0] - 2) < 0.01);
    assert(Math.abs(output[9999] - 20000) < 0.01);
  });

  // Test 7: Negate operation
  await runner.runFunctionalTest("Negate operation", async () => {
    const input = [1, -2, 3, -4];
    const output = await mapGPU.map("negate", input);
    const expected = [-1, 2, -3, 4];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01);
    }
  });

  // Test 8: Collatz steps (built-in)
  await runner.runFunctionalTest("Collatz steps", async () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const output = await mapGPU.map("collatz_steps", input);
    // Known Collatz steps: 1→0, 2→1, 3→7, 4→2, 5→5, 6→8, 7→16, 8→3
    const expected = [0, 1, 7, 2, 5, 8, 16, 3];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Collatz(${input[i]}): expected ${expected[i]}, got ${output[i]}`);
    }
  });
}

async function runBenchmarks() {
  const testMode = process.env.TEST_MODE;
  if (testMode !== "benchmark") return;

  await benchmarkRunner.runBenchmark({
    pattern: "MapGPU",
    sizes: [
      { name: "Small", size: 10000, description: "10K elements" },
      { name: "Medium", size: 100000, description: "100K elements" },
      { name: "Large", size: 1000000, description: "1M elements" },
      { name: "Extremely Large", size: 10000000, description: "10M elements" },
    ],
    threadCounts: [1], // GPU does not use thread count parameter
    testFn: async (size: number) => {
      const input = __getCachedInput("testMapGPU.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1)));
      return mapGPU.map("trig_50", input);
    },
    runs: 5,
    warmupRuns: 2,
  });
}

async function main() {
  const available = await isGPUAvailable();
  if (!available) {
    console.log("WebGPU is not available. Skipping MapGPU tests.");
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
