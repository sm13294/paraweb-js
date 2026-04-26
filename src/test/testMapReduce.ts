const { ParallelMapReduceMP } = require("../index");
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

const mapReduce = new ParallelMapReduceMP();
const runner = new PatternTestRunner("MapReduceMP");
const benchmarkRunner = new BenchmarkRunner();

// ============================================================================
// FUNCTIONAL TESTS - Edge cases and correctness across thread counts
// ============================================================================

async function runFunctionalTests() {
  // Test 1: Basic functionality with different thread counts
  const threadCounts = [1, 2, 4, 8];
  for (const threads of threadCounts) {
    await runner.runFunctionalTest(
      `Basic MapReduce (${threads} threads)`,
      async () => {
        const mapFn = (x: number) => x * 2;
        const reduceFn = (acc: number, x: number) => acc + x;
        const inputData = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        const output = await mapReduce.mapReduce(mapFn, reduceFn, inputData, threads);
        assert.strictEqual(output, 272); // Sum of doubled values
      }
    );
  }

  // Test 2: Empty array
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Empty array (${threads} threads)`,
      async () => {
        const mapFn = (x: number) => x * 2;
        const reduceFn = (acc: number, x: number) => acc + x;
        const output = await mapReduce.mapReduce(mapFn, reduceFn, [], threads);
        assert.strictEqual(output, 0); // returns identity element for empty input
      }
    );
  }

  // Test 3: Single element
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Single element (${threads} threads)`,
      async () => {
        const mapFn = (x: number) => x * 2;
        const reduceFn = (acc: number, x: number) => acc + x;
        const output = await mapReduce.mapReduce(mapFn, reduceFn, [5], threads);
        assert.strictEqual(output, 10); // 5 * 2 = 10
      }
    );
  }

  // Test 4: Multi-dimensional array processing
  for (const threads of [1, 2, 4, 8]) {
    await runner.runFunctionalTest(
      `Multi-dimensional array (${threads} threads)`,
      async () => {
        // Map: sum each sub-array, Reduce: sum all results
        const inputData = [[1, 2, 3], [4, 5], [6, 7, 8], [9, 10]];
        const mapFn = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
        const reduceFn = (acc: number, x: number) => acc + x;
        const output = await mapReduce.mapReduce(mapFn, reduceFn, inputData, threads);
        assert.strictEqual(output, 55); // (6 + 9 + 21 + 19) = 55
      }
    );
  }

  // Test 5: Consistency across thread counts
  await runner.runFunctionalTest(
    "Consistency across thread counts",
    async () => {
      const input = Array.from({ length: 1000 }, (_, i) => i + 1);
      const mapFn = (x: number) => x * x;
      const reduceFn = (acc: number, x: number) => acc + x;

      const results1 = await mapReduce.mapReduce(mapFn, reduceFn, input, 1);
      const results2 = await mapReduce.mapReduce(mapFn, reduceFn, input, 2);
      const results4 = await mapReduce.mapReduce(mapFn, reduceFn, input, 4);
      const results8 = await mapReduce.mapReduce(mapFn, reduceFn, input, 8);

      assert.strictEqual(results1, results2, "1 vs 2 threads");
      assert.strictEqual(results2, results4, "2 vs 4 threads");
      assert.strictEqual(results4, results8, "4 vs 8 threads");
    },
    false
  );

  // Test 6: Large array correctness
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Large array correctness (${threads} threads)`,
      async () => {
        const input = Array.from({ length: 100000 }, (_, i) => i + 1);
        const mapFn = (x: number) => x * 2;
        const reduceFn = (acc: number, x: number) => acc + x;
        const output = await mapReduce.mapReduce(mapFn, reduceFn, input, threads);
        const expected = input.reduce((acc, x) => acc + (x * 2), 0);
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
    pattern: "MapReduceMP",
    sizes: [
      {
        name: "Small",
        size: 10000,
        description: "Transform + aggregate (10K) - fixed-cost map, sum reduce"
      },
      {
        name: "Medium",
        size: 100000,
        description: "Transform + aggregate (100K) - fixed-cost map, sum reduce"
      },
      {
        name: "Large",
        size: 1000000,
        description: "Transform + aggregate (1M) - fixed-cost map, sum reduce"
      },
      {
        name: "Extremely Large",
        size: 10000000,
        description: "Transform + aggregate (10M) - fixed-cost map, sum reduce"
      }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      const input = __getCachedInput("testMapReduce.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1)));
      // Fixed-cost computation: iterative trigonometric + polynomial evaluation
      // Each element does exactly the same amount of work
      const mapFn = (x: number) => {
        let result = x;
        for (let i = 0; i < 50; i++) {
          result = Math.sin(result) * Math.cos(result * 0.5) + Math.sqrt(Math.abs(result) + 1);
          result = result * result - Math.floor(result * result);
        }
        return result;
      };
      const reduceFn = (acc: number, x: number) => acc + x;
      return await mapReduce.mapReduce(mapFn, reduceFn, input, threads);
    },
    sequentialFn: (size: number) => {
      const input = __getCachedInput("testMapReduce.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1)));
      const mapFn = (x: number) => {
        let result = x;
        for (let i = 0; i < 50; i++) {
          result = Math.sin(result) * Math.cos(result * 0.5) + Math.sqrt(Math.abs(result) + 1);
          result = result * result - Math.floor(result * result);
        }
        return result;
      };
      let acc = 0;
      for (let i = 0; i < input.length; i++) acc += mapFn(input[i]);
      return acc;
    },
    verifyFn: (result1: any, result8: any, size: number) => {
      verifyApproxEqual(result1, result8, size, "reduction result");
    }
  });

  benchmarkRunner.saveResults("MapReduceMP");
  benchmarkRunner.generatePlotData("MapReduceMP");
  
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
