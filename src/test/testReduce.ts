const { ParallelReduceMP } = require("../index");
const assert = require("assert");
const { performance } = require("perf_hooks");
const { PatternTestRunner, verifyApproxEqual } = require("./testUtils");
const { BenchmarkRunner } = require("./benchmarkRunner");

// Cache inputs across benchmark runs so that JS array creation time is not
// included in per-call timing. Keyed by file+size.
const __inputCache = new Map<string, any>();
function __getCachedInput<T>(key: string, factory: () => T): T {
  let v = __inputCache.get(key);
  if (v === undefined) { v = factory(); __inputCache.set(key, v); }
  return v;
}

const reduceImpl = new ParallelReduceMP();
const runner = new PatternTestRunner("ReduceMP");
const benchmarkRunner = new BenchmarkRunner();

// ============================================================================
// FUNCTIONAL TESTS - Edge cases and correctness across thread counts
// ============================================================================

async function runFunctionalTests() {
  // Test 1: Basic functionality with different thread counts
  const threadCounts = [1, 2, 4, 8];
  for (const threads of threadCounts) {
    await runner.runFunctionalTest(
      `Basic sum (${threads} threads)`,
      async () => {
        const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        const output = await reduceImpl.reduce((acc: number, x: number) => acc + x, input, 0, threads);
        assert.strictEqual(output, 136);
      }
    );
  }

  // Test 2: Empty array
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Empty array (${threads} threads)`,
      async () => {
        const output = await reduceImpl.reduce((acc: number, x: number) => acc + x, [], 42, threads);
        assert.strictEqual(output, 42); // Should return initial value
      }
    );
  }

  // Test 3: Single element
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Single element (${threads} threads)`,
      async () => {
        const output = await reduceImpl.reduce((acc: number, x: number) => acc + x, [5], 10, threads);
        assert.strictEqual(output, 15); // 10 + 5
      }
    );
  }

  // Test 4: Multiplication with initial value
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Multiplication (${threads} threads)`,
      async () => {
        const input = [2, 3, 4];
        const output = await reduceImpl.reduce((acc: number, x: number) => acc * x, input, 1, threads);
        assert.strictEqual(output, 24); // 1 * 2 * 3 * 4
      }
    );
  }


  // Test 6: Consistency across thread counts
  await runner.runFunctionalTest(
    "Consistency across thread counts",
    async () => {
      const input = Array.from({ length: 1000 }, (_, i) => i + 1);
      const fn = (acc: number, x: number) => acc + x;

      const results1 = await reduceImpl.reduce(fn, input, 0, 1);
      const results2 = await reduceImpl.reduce(fn, input, 0, 2);
      const results4 = await reduceImpl.reduce(fn, input, 0, 4);
      const results8 = await reduceImpl.reduce(fn, input, 0, 8);

      assert.strictEqual(results1, results2, "1 vs 2 threads");
      assert.strictEqual(results2, results4, "2 vs 4 threads");
      assert.strictEqual(results4, results8, "4 vs 8 threads");
    },
    false
  );

  // Test 7: Large array correctness
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Large array correctness (${threads} threads)`,
      async () => {
        const input = Array.from({ length: 100000 }, (_, i) => i + 1);
        const output = await reduceImpl.reduce((acc: number, x: number) => acc + x, input, 0, threads);
        const expected = (input.length * (input.length + 1)) / 2;
        assert.strictEqual(output, expected);
      }
    );
  }
}

// ============================================================================
// PERFORMANCE BENCHMARKS
// ============================================================================

async function runPerformanceBenchmarks() {
  const summary = await benchmarkRunner.runBenchmark({
    pattern: "ReduceMP",
    sizes: [
      {
        name: "Small",
        size: 10000,
        description: "Compute-reduce (10K) - per-element transform then sum"
      },
      {
        name: "Medium",
        size: 100000,
        description: "Compute-reduce (100K) - per-element transform then sum"
      },
      {
        name: "Large",
        size: 1000000,
        description: "Compute-reduce (1M) - per-element transform then sum"
      },
      {
        name: "Extremely Large",
        size: 5000000,
        description: "Compute-reduce (5M) - per-element transform then sum"
      }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      const input = __getCachedInput("testReduce.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 100) + 1)));
      // Associative sum over the transform of each element. The Reduce pattern
      // requires an associative combine operator (`+`); per-element work is
      // supplied as a separate mapFn so correctness holds across parallel
      // chunking. The transform is lighter than Map/MapReduce's 50-iteration
      // one so Reduce stays distinct from MapReduce.
      const fn = (acc: number, x: number) => acc + x;
      const lightFn = (x: number) => {
        let v = x;
        for (let k = 0; k < 10; k++) {
          v = Math.sin(v) + Math.cos(v * 0.5);
        }
        return v;
      };
      return await reduceImpl.reduce(fn, input, 0, threads, lightFn);
    },
    sequentialFn: (size: number) => {
      const input = __getCachedInput("testReduce.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 100) + 1)));
      const lightFn = (x: number) => {
        let v = x;
        for (let k = 0; k < 10; k++) {
          v = Math.sin(v) + Math.cos(v * 0.5);
        }
        return v;
      };
      let acc = 0;
      for (let i = 0; i < input.length; i++) acc += lightFn(input[i]);
      return acc;
    },
    verifyFn: (result1: any, result8: any, size: number) => {
      verifyApproxEqual(result1, result8, size, "reduction result");
    }
  });

  benchmarkRunner.saveResults("ReduceMP");
  benchmarkRunner.generatePlotData("ReduceMP");
  
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
    const testMode = process.env.TEST_MODE || "all"; // "functional", "benchmark", or "all"
    
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
