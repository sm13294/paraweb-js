const { ParallelScatterMP } = require("../index");
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

const myScatter = new ParallelScatterMP();
const runner = new PatternTestRunner("ScatterMP");
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
        const input = [10, 20, 30, 40];
        const indices = [3, 0, 1, 2];
        const output = await myScatter.scatter(input, indices, 0, undefined, threads);
        const expected = [20, 30, 40, 10];
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  // Test 2: Default fill for unassigned indices
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Default fill (${threads} threads)`,
      async () => {
        const input = [1, 2];
        const indices = [2, 4];
        const output = await myScatter.scatter(input, indices, -1, undefined, threads);
        const expected = [-1, -1, 1, -1, 2];
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  // Test 3: Conflict resolution (last-wins)
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Conflict resolution last-wins (${threads} threads)`,
      async () => {
        const input = [5, 6, 7];
        const indices = [1, 1, 1];
        const output = await myScatter.scatter(input, indices, 0, undefined, threads);
        const expected = [0, 7];
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  // Test 4: Conflict resolution with custom function
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Conflict resolution custom (${threads} threads)`,
      async () => {
        const input = [5, 6, 7];
        const indices = [1, 1, 1];
        const output = await myScatter.scatter(
          input,
          indices,
          0,
          (a: number, b: number) => a + b,
          threads
        );
        const expected = [0, 18];
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  // Test 5: Empty array
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Empty array (${threads} threads)`,
      async () => {
        const output = await myScatter.scatter([], [], 0, undefined, threads);
        assert.deepStrictEqual(output, []);
      }
    );
  }

  // Test 6: Mismatched input and index lengths
  await runner.runFunctionalTest("Mismatched lengths", async () => {
    await assert.rejects(
      () => myScatter.scatter([1, 2], [0], 0),
      /same length/
    );
  });

  // Test 7: Invalid indices
  await runner.runFunctionalTest("Invalid indices", async () => {
    await assert.rejects(
      () => myScatter.scatter([1], [-1], 0),
      /non-negative integers/
    );
  });

  // Test 8: Consistency across thread counts
  await runner.runFunctionalTest(
    "Consistency across thread counts",
    async () => {
      const rng = seedrandom("scatter-consistency");
      const input = Array.from({ length: 1000 }, () => Math.floor(rng() * 1000));
      const indices = Array.from({ length: 1000 }, () => Math.floor(rng() * 250));

      const results1 = await myScatter.scatter(input, indices, 0, (a: number, b: number) => a + b, 1);
      const results2 = await myScatter.scatter(input, indices, 0, (a: number, b: number) => a + b, 2);
      const results4 = await myScatter.scatter(input, indices, 0, (a: number, b: number) => a + b, 4);
      const results8 = await myScatter.scatter(input, indices, 0, (a: number, b: number) => a + b, 8);

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
    pattern: "ScatterMP",
    sizes: [
      {
        name: "Small",
        size: 10000,
        description: "Index redistribution (10K) - scatter with conflict merge"
      },
      {
        name: "Medium",
        size: 100000,
        description: "Index redistribution (100K) - scatter with conflict merge"
      },
      {
        name: "Large",
        size: 1000000,
        description: "Index redistribution (1M) - scatter with conflict merge"
      },
      {
        name: "Extremely Large",
        size: 10000000,
        description: "Index redistribution (10M) - scatter with conflict merge"
      }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      // Aligned with Scatter Shared and GPU: identical seed produces identical inputs/indices.
      const rng = seedrandom("scatter-shared-benchmark");
      const input = __getCachedInput("testScatter.ts:input:" + String(size), () => (Array.from({ length: size }, () => Math.floor(rng() * 1000))));
      const indices = __getCachedInput("testScatter.ts:indices:" + String(size), () => (Array.from({ length: size }, () => Math.floor(rng() * (size / 4)))));
      // Per-element heavy transform (matches Map's 50-iteration trig transform)
      // so that Scatter's scaling is not dominated by trivial per-element work.
      const heavyFn = (x: number) => {
        let v = x;
        for (let k = 0; k < 50; k++) {
          v = Math.sin(v) + Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
          v = v * v + 1;
        }
        return v;
      };
      return await myScatter.scatter(
        input,
        indices,
        0,
        (a: number, b: number) => a + b,
        threads,
        heavyFn
      );
    },
    sequentialFn: (size: number) => {
      const rng = seedrandom("scatter-shared-benchmark");
      const input = __getCachedInput("testScatter.ts:input:" + String(size), () => (Array.from({ length: size }, () => Math.floor(rng() * 1000))));
      const indices = __getCachedInput("testScatter.ts:indices:" + String(size), () => (Array.from({ length: size }, () => Math.floor(rng() * (size / 4)))));
      const heavyFn = (x: number) => {
        let v = x;
        for (let k = 0; k < 50; k++) {
          v = Math.sin(v) + Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
          v = v * v + 1;
        }
        return v;
      };
      let maxIdx = 0;
      for (let i = 0; i < indices.length; i++) if (indices[i] > maxIdx) maxIdx = indices[i];
      const out = new Array(maxIdx + 1).fill(0);
      const assigned = new Array(maxIdx + 1).fill(false);
      for (let i = 0; i < input.length; i++) {
        const v = heavyFn(input[i]);
        const idx = indices[i];
        out[idx] = assigned[idx] ? out[idx] + v : v;
        assigned[idx] = true;
      }
      return out;
    },
    verifyFn: (result1: any, result8: any, size: number) => {
      assert.deepStrictEqual(result1, result8, `Results should be identical for size ${size}`);
    }
  });

  benchmarkRunner.saveResults("ScatterMP");
  benchmarkRunner.generatePlotData("ScatterMP");

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
