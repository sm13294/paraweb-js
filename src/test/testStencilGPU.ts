export {};
const { ParallelStencilGPU } = require("../index");
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


const stencilGPU = new ParallelStencilGPU();
const runner = new PatternTestRunner("StencilGPU");
const benchmarkRunner = new BenchmarkRunner();

async function runFunctionalTests() {
  // Test 1: 3-point averaging stencil with identity op
  await runner.runFunctionalTest("3-point averaging stencil [0.25, 0.5, 0.25]", async () => {
    const input = [0, 0, 1, 0, 0];
    const weights = [0.25, 0.5, 0.25];
    const output = await stencilGPU.stencil({ wgsl: "x" }, input, weights);
    assert.strictEqual(output.length, input.length);
    // Middle element: 0.25*0 + 0.5*1 + 0.25*0 = 0.5
    assert(Math.abs(output[2] - 0.5) < 0.01, `Element 2: expected 0.5, got ${output[2]}`);
    // Element 1: 0.25*0 + 0.5*0 + 0.25*1 = 0.25
    assert(Math.abs(output[1] - 0.25) < 0.01, `Element 1: expected 0.25, got ${output[1]}`);
    // Element 3: 0.25*1 + 0.5*0 + 0.25*0 = 0.25
    assert(Math.abs(output[3] - 0.25) < 0.01, `Element 3: expected 0.25, got ${output[3]}`);
  });

  // Test 2: Uniform 3-point stencil
  await runner.runFunctionalTest("Uniform 3-point stencil [1, 1, 1]", async () => {
    const input = [1, 2, 3, 4, 5];
    const weights = [1, 1, 1];
    const output = await stencilGPU.stencil({ wgsl: "x" }, input, weights);
    assert.strictEqual(output.length, 5);
    // Element 1: 1*1 + 1*2 + 1*3 = 6
    assert(Math.abs(output[1] - 6) < 0.01, `Element 1: expected 6, got ${output[1]}`);
    // Element 2: 1*2 + 1*3 + 1*4 = 9
    assert(Math.abs(output[2] - 9) < 0.01, `Element 2: expected 9, got ${output[2]}`);
    // Element 3: 1*3 + 1*4 + 1*5 = 12
    assert(Math.abs(output[3] - 12) < 0.01, `Element 3: expected 12, got ${output[3]}`);
  });

  // Test 3: Empty array
  await runner.runFunctionalTest("Empty array", async () => {
    const output = await stencilGPU.stencil({ wgsl: "x" }, [], [0.25, 0.5, 0.25]);
    assert.deepStrictEqual(output, []);
  });

  // Test 4: Single element
  await runner.runFunctionalTest("Single element with 3-point stencil", async () => {
    const output = await stencilGPU.stencil({ wgsl: "x" }, [5], [0.25, 0.5, 0.25]);
    assert.strictEqual(output.length, 1);
    // Only center weight applies (neighbors are boundary/zero)
    assert(Math.abs(output[0] - 2.5) < 0.01, `Expected ~2.5, got ${output[0]}`);
  });

  // Test 5: 5-point stencil
  await runner.runFunctionalTest("5-point stencil", async () => {
    const input = [1, 2, 3, 4, 5, 6, 7];
    const weights = [0.1, 0.2, 0.4, 0.2, 0.1];
    const output = await stencilGPU.stencil({ wgsl: "x" }, input, weights);
    assert.strictEqual(output.length, 7);
    // Element 2: 0.1*1 + 0.2*2 + 0.4*3 + 0.2*4 + 0.1*5 = 0.1+0.4+1.2+0.8+0.5 = 3.0
    assert(Math.abs(output[2] - 3.0) < 0.01, `Element 2: expected 3.0, got ${output[2]}`);
  });

  // Test 6: With square operation applied to weighted sum
  await runner.runFunctionalTest("Stencil with square operation", async () => {
    const input = [0, 0, 2, 0, 0];
    const weights = [0, 1, 0]; // Just pass-through center
    const output = await stencilGPU.stencil("square", input, weights);
    assert.strictEqual(output.length, 5);
    // Center element: square(0*0 + 1*2 + 0*0) = square(2) = 4
    assert(Math.abs(output[2] - 4) < 0.01, `Element 2: expected 4, got ${output[2]}`);
  });

  // Test 7: Large array
  await runner.runFunctionalTest("Large array (10K elements)", async () => {
    const input = Array.from({ length: 10000 }, (_, i) => i + 1);
    const weights = [0.25, 0.5, 0.25];
    const output = await stencilGPU.stencil({ wgsl: "x" }, input, weights);
    assert.strictEqual(output.length, 10000);
    // Interior element 5000: 0.25*5000 + 0.5*5001 + 0.25*5002 = 1250+2500.5+1250.5 = 5001
    assert(Math.abs(output[5000] - 5001) < 0.01, `Element 5000: expected 5001, got ${output[5000]}`);
  });
}

async function runBenchmarks() {
  const testMode = process.env.TEST_MODE;
  if (testMode !== "benchmark") return;

  await benchmarkRunner.runBenchmark({
    pattern: "StencilGPU",
    sizes: [
      { name: "Small", size: 10000, description: "10K elements" },
      { name: "Medium", size: 100000, description: "100K elements" },
      { name: "Large", size: 1000000, description: "1M elements" },
      { name: "Extremely Large", size: 10000000, description: "10M elements" },
    ],
    threadCounts: [1], // GPU does not use thread count parameter
    testFn: async (size: number) => {
      const input = __getCachedInput("testStencilGPU.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 100) + 1)));
      const weights = [1, 2, 3, 2, 1];
      return stencilGPU.stencil("trig_15", input, weights);
    },
    runs: 5,
    warmupRuns: 2,
  });
}

async function main() {
  const available = await isGPUAvailable();
  if (!available) {
    console.log("WebGPU is not available. Skipping StencilGPU tests.");
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
