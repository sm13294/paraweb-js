const { ParallelScanGPU } = require("../index");
const { isGPUAvailable } = require("../core/gpuContext");
const assert = require("assert");
const { PatternTestRunner } = require("./testUtils");
const { BenchmarkRunner } = require("./benchmarkRunner");

// Cache inputs across benchmark runs so that JS array creation time is not
// included in per-call timing. Keyed by file+size.
const __inputCache = new Map<string, any>();
function __getCachedInput<T>(key: string, factory: () => T): T {
  let v = __inputCache.get(key);
  if (v === undefined) { v = factory(); __inputCache.set(key, v); }
  return v;
}


const myScan = new ParallelScanGPU();
const runner = new PatternTestRunner("ScanGPU");
const benchmarkRunner = new BenchmarkRunner();

const EPS = 1e-3; // f32 precision

function assertClose(actual: number[], expected: number[], msg?: string) {
  assert.strictEqual(actual.length, expected.length, msg);
  for (let i = 0; i < actual.length; i++) {
    assert(Math.abs(actual[i] - expected[i]) < EPS + Math.abs(expected[i]) * EPS,
      `${msg} mismatch at ${i}: got ${actual[i]}, expected ${expected[i]}`);
  }
}

async function runFunctionalTests() {
  if (!await isGPUAvailable()) {
    console.log("WebGPU is not available. Skipping ScanGPU tests.");
    return;
  }

  await runner.runFunctionalTest("Inclusive prefix-sum of 1..8", async () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const expected = [1, 3, 6, 10, 15, 21, 28, 36];
    const output = await myScan.scan("add", input, 0);
    assertClose(output, expected, "prefix-sum");
  });

  await runner.runFunctionalTest("Prefix product", async () => {
    const input = [1, 2, 3, 4, 5];
    const expected = [1, 2, 6, 24, 120];
    const output = await myScan.scan("multiply", input, 1);
    assertClose(output, expected, "prefix-product");
  });

  await runner.runFunctionalTest("Running max", async () => {
    const input = [3, 1, 4, 1, 5, 9, 2, 6];
    const expected = [3, 3, 4, 4, 5, 9, 9, 9];
    const output = await myScan.scan("max", input);
    assertClose(output, expected, "running-max");
  });

  await runner.runFunctionalTest("Empty array", async () => {
    const output = await myScan.scan("add", [], 0);
    assert.deepStrictEqual(output, []);
  });

  await runner.runFunctionalTest("Single element", async () => {
    const output = await myScan.scan("add", [42], 0);
    assertClose(output, [42], "single");
  });
}

async function runPerformanceBenchmarks() {
  if (!await isGPUAvailable()) {
    console.log("WebGPU is not available. Skipping ScanGPU benchmarks.");
    return;
  }

  await benchmarkRunner.runBenchmark({
    pattern: "ScanGPU",
    sizes: [
      { name: "Small", size: 10000, description: "GPU scan (10K)" },
      { name: "Medium", size: 100000, description: "GPU scan (100K)" },
      { name: "Large", size: 1000000, description: "GPU scan (1M)" },
      { name: "Extremely Large", size: 10000000, description: "GPU scan (10M)" }
    ],
    threadCounts: [1],
    testFn: async (size: number) => {
      const input = __getCachedInput("testScanGPU.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 100) + 1)));
      // Fused 50-iter trigonometric pre-transform + inclusive prefix-sum,
      // matching the CPU Scan benchmark's `heavyFn` so the GPU and CPU
      // measurements are apples-to-apples.
      return myScan.scan("add", input, 0, "trig_scan_50");
    },
    runs: 5,
    warmupRuns: 2,
  });

  benchmarkRunner.saveResults("ScanGPU");
  benchmarkRunner.generatePlotData("ScanGPU");
  benchmarkRunner.generateSummaryReport();
}

async function main() {
  const testMode = process.env.TEST_MODE || "all";
  try {
    if (testMode === "functional" || testMode === "all") {
      await runFunctionalTests();
      runner.printSummary();
    }
    if (testMode === "benchmark" || testMode === "all") {
      await runPerformanceBenchmarks();
    }
  } catch (e) {
    console.error("Test failure:", e);
    process.exit(1);
  }
  process.exit(0);
}

main();

export {};
