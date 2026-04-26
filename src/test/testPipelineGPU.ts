export {};
const { ParallelPipelineGPU } = require("../index");
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


const pipelineGPU = new ParallelPipelineGPU();
const runner = new PatternTestRunner("PipelineGPU");
const benchmarkRunner = new BenchmarkRunner();

async function runFunctionalTests() {
  // Test 1: Two-stage pipeline: square then double
  await runner.runFunctionalTest("Square then double [1,2,3] → [2,8,18]", async () => {
    const input = [1, 2, 3];
    const output = await pipelineGPU.pipeline(["square", "double"], input);
    const expected = [2, 8, 18];
    assert.strictEqual(output.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 2: Three-stage pipeline: double, square, negate
  await runner.runFunctionalTest("Three stages: double → square → negate [1,2,3]", async () => {
    const input = [1, 2, 3];
    // double: [2, 4, 6], square: [4, 16, 36], negate: [-4, -16, -36]
    const output = await pipelineGPU.pipeline(["double", "square", "negate"], input);
    const expected = [-4, -16, -36];
    assert.strictEqual(output.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 3: Empty stages list (returns copy of input)
  await runner.runFunctionalTest("Empty stages list returns input copy", async () => {
    const input = [1, 2, 3, 4];
    const output = await pipelineGPU.pipeline([], input);
    assert.strictEqual(output.length, input.length);
    for (let i = 0; i < input.length; i++) {
      assert(Math.abs(output[i] - input[i]) < 0.01, `Element ${i}: expected ${input[i]}, got ${output[i]}`);
    }
  });

  // Test 4: Empty array
  await runner.runFunctionalTest("Empty array", async () => {
    const output = await pipelineGPU.pipeline(["square", "double"], []);
    assert.deepStrictEqual(output, []);
  });

  // Test 5: Single stage
  await runner.runFunctionalTest("Single stage: square", async () => {
    const input = [1, 2, 3, 4];
    const output = await pipelineGPU.pipeline(["square"], input);
    const expected = [1, 4, 9, 16];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 6: Custom WGSL stages
  await runner.runFunctionalTest("Custom WGSL stages", async () => {
    const input = [1, 2, 3, 4];
    // Stage 1: x + 1, Stage 2: x * 2
    const output = await pipelineGPU.pipeline(
      [{ wgsl: "x + 1.0" }, { wgsl: "x * 2.0" }],
      input
    );
    // (1+1)*2=4, (2+1)*2=6, (3+1)*2=8, (4+1)*2=10
    const expected = [4, 6, 8, 10];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(output[i] - expected[i]) < 0.01, `Element ${i}: expected ${expected[i]}, got ${output[i]}`);
    }
  });

  // Test 7: Single element through multiple stages
  await runner.runFunctionalTest("Single element through pipeline", async () => {
    const output = await pipelineGPU.pipeline(["double", "square"], [3]);
    // double(3) = 6, square(6) = 36
    assert(Math.abs(output[0] - 36) < 0.01, `Expected 36, got ${output[0]}`);
  });

  // Test 8: Large array
  await runner.runFunctionalTest("Large array (10K elements)", async () => {
    const input = Array.from({ length: 10000 }, (_, i) => i + 1);
    const output = await pipelineGPU.pipeline(["double"], input);
    assert.strictEqual(output.length, 10000);
    assert(Math.abs(output[0] - 2) < 0.01);
    assert(Math.abs(output[9999] - 20000) < 0.01);
  });
}

async function runBenchmarks() {
  const testMode = process.env.TEST_MODE;
  if (testMode !== "benchmark") return;

  await benchmarkRunner.runBenchmark({
    pattern: "PipelineGPU",
    sizes: [
      { name: "Small", size: 10000, description: "10K elements" },
      { name: "Medium", size: 100000, description: "100K elements" },
      { name: "Large", size: 1000000, description: "1M elements" },
      { name: "Extremely Large", size: 10000000, description: "10M elements" },
    ],
    threadCounts: [1], // GPU does not use thread count parameter
    testFn: async (size: number) => {
      const input = __getCachedInput("testPipelineGPU.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1)));
      return pipelineGPU.pipeline(["trig_30", "poly_stage2"], input);
    },
    runs: 5,
    warmupRuns: 2,
  });
}

async function main() {
  const available = await isGPUAvailable();
  if (!available) {
    console.log("WebGPU is not available. Skipping PipelineGPU tests.");
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
