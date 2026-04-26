export {};
const { ParallelFilterGPU } = require("../index");
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


const filterGPU = new ParallelFilterGPU();
const runner = new PatternTestRunner("FilterGPU");
const benchmarkRunner = new BenchmarkRunner();

async function runFunctionalTests() {
  // Test 1: Filter positive numbers
  await runner.runFunctionalTest("Filter positive numbers", async () => {
    const input = [-3, -2, -1, 0, 1, 2, 3];
    const output = await filterGPU.filter("positive", input);
    const expected = [1, 2, 3];
    assert.strictEqual(output.length, expected.length, `Expected ${expected.length} elements, got ${output.length}`);
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 2: Custom WGSL predicate (greater than 5)
  await runner.runFunctionalTest("Custom WGSL predicate (x > 5)", async () => {
    const input = [1, 3, 5, 7, 9, 11];
    const output = await filterGPU.filter({ wgsl: "x > 5.0" }, input);
    const expected = [7, 9, 11];
    assert.strictEqual(output.length, expected.length, `Expected ${expected.length} elements, got ${output.length}`);
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 3: Empty array
  await runner.runFunctionalTest("Empty array", async () => {
    const output = await filterGPU.filter("positive", []);
    assert.deepStrictEqual(output, []);
  });

  // Test 4: All elements pass
  await runner.runFunctionalTest("All elements pass", async () => {
    const input = [1, 2, 3, 4, 5];
    const output = await filterGPU.filter("positive", input);
    assert.strictEqual(output.length, input.length, `Expected ${input.length} elements, got ${output.length}`);
    for (let i = 0; i < input.length; i++) {
      assert(Math.abs(output[i] - input[i]) < 0.01, `Element ${i}: expected ${input[i]}, got ${output[i]}`);
    }
  });

  // Test 5: No elements pass
  await runner.runFunctionalTest("No elements pass", async () => {
    const input = [-5, -4, -3, -2, -1];
    const output = await filterGPU.filter("positive", input);
    assert.strictEqual(output.length, 0, `Expected 0 elements, got ${output.length}`);
  });

  // Test 6: Single element passes
  await runner.runFunctionalTest("Single element passes", async () => {
    const output = await filterGPU.filter("positive", [5]);
    assert.strictEqual(output.length, 1);
    assert(Math.abs(output[0] - 5) < 0.01);
  });

  // Test 7: Single element fails
  await runner.runFunctionalTest("Single element fails", async () => {
    const output = await filterGPU.filter("positive", [-5]);
    assert.strictEqual(output.length, 0);
  });

  // Test 8: Large array
  await runner.runFunctionalTest("Large array (10K elements)", async () => {
    const input = Array.from({ length: 10000 }, (_, i) => i - 5000);
    const output = await filterGPU.filter("positive", input);
    assert.strictEqual(output.length, 4999); // 1 through 4999
    assert(Math.abs(output[0] - 1) < 0.01);
    assert(Math.abs(output[output.length - 1] - 4999) < 0.01);
  });
}

async function runBenchmarks() {
  const testMode = process.env.TEST_MODE;
  if (testMode !== "benchmark") return;

  await benchmarkRunner.runBenchmark({
    pattern: "FilterGPU",
    sizes: [
      { name: "Small", size: 10000, description: "10K elements" },
      { name: "Medium", size: 100000, description: "100K elements" },
      { name: "Large", size: 1000000, description: "1M elements" },
      { name: "Extremely Large", size: 10000000, description: "10M elements" },
    ],
    threadCounts: [1], // GPU does not use thread count parameter
    testFn: async (size: number) => {
      const input = __getCachedInput("testFilterGPU.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1)));
      return filterGPU.filter("trig_gt2", input);
    },
    runs: 5,
    warmupRuns: 2,
  });
}

async function main() {
  const available = await isGPUAvailable();
  if (!available) {
    console.log("WebGPU is not available. Skipping FilterGPU tests.");
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
