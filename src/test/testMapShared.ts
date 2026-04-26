const { ParallelMapShared } = require("../index");
const assert = require("assert");
const seedrandom = require("seedrandom");
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

const myMapShared = new ParallelMapShared();
const runner = new PatternTestRunner("MapShared");
const benchmarkRunner = new BenchmarkRunner();

// ============================================================================
// FUNCTIONAL TESTS - Edge cases and correctness across thread counts
// ============================================================================

async function runFunctionalTests() {
  const threadCounts = [1, 2, 4, 8];

  // Test 1: Basic functionality with different thread counts
  for (const threads of threadCounts) {
    await runner.runFunctionalTest(
      `Basic functionality (${threads} threads)`,
      async () => {
        const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        const output = await myMapShared.map((x: number) => x * 2, input, threads);
        const expected = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32];
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  // Test 2: Empty array
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Empty array (${threads} threads)`,
      async () => {
        const output = await myMapShared.map((x: number) => x * 2, [], threads);
        assert.deepStrictEqual(output, []);
      }
    );
  }

  // Test 3: Single element
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Single element (${threads} threads)`,
      async () => {
        const output = await myMapShared.map((x: number) => x * 2, [5], threads);
        assert.deepStrictEqual(output, [10]);
      }
    );
  }

  // Test 4: Index-aware mapping
  for (const threads of [1, 2, 4, 8]) {
    await runner.runFunctionalTest(
      `Index-aware mapping (${threads} threads)`,
      async () => {
        const input = [10, 10, 10, 10];
        const output = await myMapShared.map((x: number, i: number) => x + i, input, threads);
        const expected = [10, 11, 12, 13];
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  // Test 5: Consistency across thread counts
  await runner.runFunctionalTest(
    "Consistency across thread counts",
    async () => {
      const rng = seedrandom("map-shared-consistency");
      const input = Array.from({ length: 1000 }, () => Math.floor(rng() * 1000));
      const fn = (x: number) => x * x + 1;

      const results1 = await myMapShared.map(fn, input, 1);
      const results2 = await myMapShared.map(fn, input, 2);
      const results4 = await myMapShared.map(fn, input, 4);
      const results8 = await myMapShared.map(fn, input, 8);

      assert.deepStrictEqual(results1, results2, "1 vs 2 threads");
      assert.deepStrictEqual(results2, results4, "2 vs 4 threads");
      assert.deepStrictEqual(results4, results8, "4 vs 8 threads");
    },
    false
  );
}

// ============================================================================
// PERFORMANCE BENCHMARKS
// ============================================================================

async function runPerformanceBenchmarks() {
  const summary = await benchmarkRunner.runBenchmark({
    pattern: "MapShared",
    sizes: [
      {
        name: "Small",
        size: 10000,
        description: "Numerical transform (10K elements) - fixed-cost per element"
      },
      {
        name: "Medium",
        size: 100000,
        description: "Numerical transform (100K elements) - fixed-cost per element"
      },
      {
        name: "Large",
        size: 1000000,
        description: "Numerical transform (1M elements) - fixed-cost per element"
      },
      {
        name: "Extremely Large",
        size: 10000000,
        description: "Numerical transform (10M elements) - fixed-cost per element"
      }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      const input = __getCachedInput("testMapShared.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1)));
      // Fixed-cost computation: iterative trigonometric + polynomial evaluation
      // Each element does exactly the same amount of work
      const fn = (x: number) => {
        let result = x;
        for (let i = 0; i < 50; i++) {
          result = Math.sin(result) * Math.cos(result * 0.5) + Math.sqrt(Math.abs(result) + 1);
          result = result * result - Math.floor(result * result);
        }
        return result;
      };
      return await myMapShared.map(fn, input, threads);
    },
    sequentialFn: (size: number) => {
      const input = __getCachedInput("testMapShared.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1)));
      const fn = (x: number) => {
        let result = x;
        for (let i = 0; i < 50; i++) {
          result = Math.sin(result) * Math.cos(result * 0.5) + Math.sqrt(Math.abs(result) + 1);
          result = result * result - Math.floor(result * result);
        }
        return result;
      };
      const out = new Array(input.length);
      for (let i = 0; i < input.length; i++) out[i] = fn(input[i]);
      return out;
    },
    verifyFn: (result1: any, result8: any, size: number) => {
      assert.deepStrictEqual(result1, result8, `Results should be identical for size ${size}`);
    }
  });

  benchmarkRunner.saveResults("MapShared");
  benchmarkRunner.generatePlotData("MapShared");

  if (process.env.PARAWEB_QUIET !== "1") {
    console.log(`\n${"=".repeat(80)}`);
    console.log("BENCHMARK SUMMARY");
    console.log("=".repeat(80));
    console.log("\nSize".padEnd(20) + "1 Thread".padEnd(15) + "2 Threads".padEnd(15) + "4 Threads".padEnd(15) + "8 Threads".padEnd(15) + "16 Threads");
    console.log("─".repeat(95));
  
    for (const result of summary.results) {
      const sizeStr = result.size.padEnd(20);
      const times = result.threadResults.map((r: { threads: number; time: number }) => `${r.time.toFixed(2)}ms`.padEnd(15)).join("");
      console.log(`${sizeStr}${times}`);
    }
  
    console.log();
  }
  benchmarkRunner.generateSummaryReport();
}

// ============================================================================
// MAIN TEST RUNNER
// ============================================================================

(async () => {
  try {
    const testMode = process.env.TEST_MODE || "all";

    if (testMode === "functional" || testMode === "all") {
      await runFunctionalTests();
    }

    if (testMode === "benchmark" || testMode === "all") {
      await runPerformanceBenchmarks();
    }

    runner.printSummary();
  } catch (error) {
    console.error("Test suite failed:", error);
    process.exit(1);
  }
})();

export {};
