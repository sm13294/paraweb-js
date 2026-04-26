const { ParallelFarmShared } = require("../index");
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

const farmImpl = new ParallelFarmShared();
const runner = new PatternTestRunner("FarmShared");
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
        const output = await farmImpl.farm((x: number) => x * 2, input, threads);
        const expected = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32];
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Empty array (${threads} threads)`,
      async () => {
        const output = await farmImpl.farm((x: number) => x * 2, [], threads);
        assert.deepStrictEqual(output, []);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Single element (${threads} threads)`,
      async () => {
        const output = await farmImpl.farm((x: number) => x * 2, [5], threads);
        assert.deepStrictEqual(output, [10]);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Varying computation times (${threads} threads)`,
      async () => {
        const input = Array.from({ length: 1000 }, (_, i) => i + 1);
        const fn = (x: number) => {
          let result = x;
          const iterations = Math.floor(x / 100) + 1;
          for (let i = 0; i < iterations; i++) {
            result = Math.sqrt(result * result + 1);
          }
          return Math.round(result);
        };
        const output = await farmImpl.farm(fn, input, threads);
        assert.strictEqual(output.length, input.length);
      }
    );
  }

  await runner.runFunctionalTest(
    "Consistency across thread counts",
    async () => {
      const input = Array.from({ length: 1000 }, (_, i) => i + 1);
      const fn = (x: number) => x * x + 1;

      const results1 = await farmImpl.farm(fn, input, 1);
      const results2 = await farmImpl.farm(fn, input, 2);
      const results4 = await farmImpl.farm(fn, input, 4);
      const results8 = await farmImpl.farm(fn, input, 8);

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
        const output = await farmImpl.farm((x: number) => x * 2, input, threads);

        assert.strictEqual(output.length, input.length);
        for (let i = 0; i < Math.min(100, input.length); i++) {
          assert.strictEqual(output[i], input[i] * 2);
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
    pattern: "FarmShared",
    sizes: [
      {
        name: "Small",
        size: 10000,
        description: "Variable-cost tasks (10K) - Collatz + numeric refinement"
      },
      {
        name: "Medium",
        size: 100000,
        description: "Variable-cost tasks (100K) - Collatz + numeric refinement"
      },
      {
        name: "Large",
        size: 1000000,
        description: "Variable-cost tasks (1M) - Collatz + numeric refinement"
      },
      {
        name: "Extremely Large",
        size: 5000000,
        description: "Variable-cost tasks (5M) - Collatz + numeric refinement"
      }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      const input = __getCachedInput("testFarmShared.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1000)));
      // Collatz step count drives mild per-task cost variance; the trailing
      // 200-iteration trig refinement raises absolute per-task cost from
      // microseconds to ~milliseconds so worker coordination amortizes.
      const fn = (n: number) => {
        let steps = 0;
        let num = n;
        while (num !== 1) {
          if (num % 2 === 0) num = num / 2;
          else num = 3 * num + 1;
          steps++;
          if (steps > 10000) break;
        }
        let v = steps;
        for (let i = 0; i < 200; i++) {
          v = Math.sin(v) + Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
          v = v * v - Math.floor(v * v) + 1;
        }
        return v;
      };
      return await farmImpl.farm(fn, input, threads);
    },
    sequentialFn: (size: number) => {
      const input = __getCachedInput("testFarmShared.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1000)));
      const fn = (n: number) => {
        let steps = 0;
        let num = n;
        while (num !== 1) {
          if (num % 2 === 0) num = num / 2;
          else num = 3 * num + 1;
          steps++;
          if (steps > 10000) break;
        }
        let v = steps;
        for (let i = 0; i < 200; i++) {
          v = Math.sin(v) + Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
          v = v * v - Math.floor(v * v) + 1;
        }
        return v;
      };
      const out = new Array(input.length);
      for (let i = 0; i < input.length; i++) out[i] = fn(input[i]);
      return out;
    },
    verifyFn: (result1: any, result8: any, size: number) => {
      assert.deepStrictEqual(result1, result8, `Results should be identical for size ${size}`);
    }
  });

  benchmarkRunner.saveResults("FarmShared");
  benchmarkRunner.generatePlotData("FarmShared");

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
