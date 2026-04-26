const { ParallelFilterShared } = require("../index");
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

const myFilter = new ParallelFilterShared();
const runner = new PatternTestRunner("FilterShared");
const benchmarkRunner = new BenchmarkRunner();

// ============================================================================
// FUNCTIONAL TESTS - Edge cases and correctness across thread counts
// ============================================================================

async function runFunctionalTests() {
  const threadCounts = [1, 2, 4, 8];
  for (const threads of threadCounts) {
    await runner.runFunctionalTest(
      `Basic functionality (${threads} threads)`,
      async () => {
        const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        const output = await myFilter.filter((x: number) => x % 2 === 0, input, threads);
        const expected = [2, 4, 6, 8, 10, 12, 14, 16];
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Empty array (${threads} threads)`,
      async () => {
        const output = await myFilter.filter((x: number) => x > 0, [], threads);
        assert.deepStrictEqual(output, []);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `All elements filtered out (${threads} threads)`,
      async () => {
        const input = [1, 2, 3, 4, 5];
        const output = await myFilter.filter((x: number) => x > 100, input, threads);
        assert.deepStrictEqual(output, []);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `All elements pass filter (${threads} threads)`,
      async () => {
        const input = [1, 2, 3, 4, 5];
        const output = await myFilter.filter((x: number) => x > 0, input, threads);
        assert.deepStrictEqual(output, input);
      }
    );
  }

  await runner.runFunctionalTest(
    "Consistency across thread counts",
    async () => {
      const input = Array.from({ length: 1000 }, (_, i) => i + 1);
      const fn = (x: number) => x % 2 === 0;

      const results1 = await myFilter.filter(fn, input, 1);
      const results2 = await myFilter.filter(fn, input, 2);
      const results4 = await myFilter.filter(fn, input, 4);
      const results8 = await myFilter.filter(fn, input, 8);

      assert.deepStrictEqual(results1, results2, "1 vs 2 threads");
      assert.deepStrictEqual(results2, results4, "2 vs 4 threads");
      assert.deepStrictEqual(results4, results8, "4 vs 8 threads");
    },
    false
  );

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Large array correctness (${threads} threads)`,
      async () => {
        const input = Array.from({ length: 100000 }, (_, i) => i + 1);
        const output = await myFilter.filter((x: number) => x % 2 === 0, input, threads);

        assert.strictEqual(output.length, input.length / 2);
        for (const val of output) {
          assert.strictEqual(val % 2, 0);
        }
      }
    );
  }
}

// ============================================================================
// PERFORMANCE BENCHMARKS
// ============================================================================

async function runPerformanceBenchmarks() {
  const summary = await benchmarkRunner.runBenchmark({
    pattern: "FilterShared",
    sizes: [
      {
        name: "Small",
        size: 10000,
        description: "Compute-and-filter (10K) - fixed-cost predicate"
      },
      {
        name: "Medium",
        size: 100000,
        description: "Compute-and-filter (100K) - fixed-cost predicate"
      },
      {
        name: "Large",
        size: 1000000,
        description: "Compute-and-filter (1M) - fixed-cost predicate"
      },
      {
        name: "Extremely Large",
        size: 10000000,
        description: "Compute-and-filter (10M) - fixed-cost predicate"
      }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      const input = __getCachedInput("testFilterShared.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1)));
      // Fixed-cost predicate: heavy computation, then threshold check
      const fn = (x: number) => {
        let val = x;
        for (let i = 0; i < 30; i++) {
          val = Math.sin(val) * Math.cos(val * 0.5) + Math.sqrt(Math.abs(val) + 1);
        }
        return val > 2.0; // ~50% pass rate
      };
      return await myFilter.filter(fn, input, threads);
    },
    sequentialFn: (size: number) => {
      const input = __getCachedInput("testFilterShared.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1)));
      const fn = (x: number) => {
        let val = x;
        for (let i = 0; i < 30; i++) {
          val = Math.sin(val) * Math.cos(val * 0.5) + Math.sqrt(Math.abs(val) + 1);
        }
        return val > 2.0;
      };
      const out: number[] = [];
      for (let i = 0; i < input.length; i++) if (fn(input[i])) out.push(input[i]);
      return out;
    },
    verifyFn: (result1: any, result8: any, size: number) => {
      assert.deepStrictEqual(result1, result8, `Results should be identical for size ${size}`);
    }
  });

  benchmarkRunner.saveResults("FilterShared");
  benchmarkRunner.generatePlotData("FilterShared");

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
