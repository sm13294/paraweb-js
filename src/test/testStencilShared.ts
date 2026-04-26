const { ParallelStencilShared } = require("../index");
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

const stencilImpl = new ParallelStencilShared();
const runner = new PatternTestRunner("StencilShared");
const benchmarkRunner = new BenchmarkRunner();

// ============================================================================
// FUNCTIONAL TESTS - Edge cases and correctness across thread counts
// ============================================================================

async function runFunctionalTests() {
  const stencilTests = [
    { stencil: [1, 1], expected: [2, 4, 6, 8, 10, 12, 14, 7] },
    { stencil: [1, 1, 1], expected: [3, 6, 9, 12, 15, 18, 21, 15] },
    { stencil: [1, 2, 1], expected: [4, 8, 12, 16, 20, 24, 28, 23] },
    { stencil: [2, 2], expected: [4, 8, 12, 16, 20, 24, 28, 14] },
  ];

  for (const testCase of stencilTests) {
    for (const threads of [1, 2, 4, 8]) {
      await runner.runFunctionalTest(
        `Stencil [${testCase.stencil.join(",")}] (${threads} threads)`,
        async () => {
          const input = [1, 2, 3, 4, 5, 6, 7, 8];
          const fn = (val: number, neighbors: Array<number>, stencil: Array<number>) => {
            let result = 0;
            neighbors.forEach((neighbor, i) => {
              result += neighbor * stencil[i];
            });
            return result;
          };
          const output = await stencilImpl.stencil(fn, input, testCase.stencil, threads);
          assert.deepStrictEqual(output, testCase.expected);
        }
      );
    }
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Empty array (${threads} threads)`,
      async () => {
        const stencil = [1, 1, 1];
        const fn = (val: number, neighbors: Array<number>) => 0;
        const output = await stencilImpl.stencil(fn, [], stencil, threads);
        assert.deepStrictEqual(output, []);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Single element (${threads} threads)`,
      async () => {
        const input = [5];
        const stencil = [1, 1, 1];
        const fn = (val: number, neighbors: Array<number>, stencil: Array<number>) => {
          let result = 0;
          neighbors.forEach((neighbor, i) => {
            result += (neighbor || 0) * stencil[i];
          });
          return result;
        };
        const output = await stencilImpl.stencil(fn, input, stencil, threads);
        assert.strictEqual(output.length, 1);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Large stencil (${threads} threads)`,
      async () => {
        const input = Array.from({ length: 100 }, (_, i) => i + 1);
        const stencil = [1, 2, 3, 4, 5, 4, 3, 2, 1];
        const fn = (val: number, neighbors: Array<number>, stencil: Array<number>) => {
          let result = 0;
          neighbors.forEach((neighbor, i) => {
            result += (neighbor || 0) * stencil[i];
          });
          return result;
        };
        const output = await stencilImpl.stencil(fn, input, stencil, threads);
        assert.strictEqual(output.length, input.length);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Edge options - zero padding (${threads} threads)`,
      async () => {
        const input = [1, 2, 3];
        const stencil = [1, 1, 1];
        const fn = (val: number, neighbors: Array<number>) => {
          return neighbors.reduce((sum, n) => sum + (n || 0), 0);
        };
        const output = await stencilImpl.stencil(
          fn,
          input,
          stencil,
          threads,
          { type: "zero" }
        );
        assert.strictEqual(output.length, input.length);
      }
    );
  }

  await runner.runFunctionalTest(
    "Consistency across thread counts",
    async () => {
      const rng = seedrandom("stencil-shared-consistency");
      const input = Array.from({ length: 1000 }, () => Math.floor(rng() * 100));
      const stencil = [1, 1, 1];
      const fn = (val: number, neighbors: Array<number>) => neighbors.reduce((sum, n) => sum + (n || 0), 0);

      const results1 = await stencilImpl.stencil(fn, input, stencil, 1);
      const results2 = await stencilImpl.stencil(fn, input, stencil, 2);
      const results4 = await stencilImpl.stencil(fn, input, stencil, 4);
      const results8 = await stencilImpl.stencil(fn, input, stencil, 8);

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
    pattern: "StencilShared",
    sizes: [
      {
        name: "Small",
        size: 10000,
        description: "Stencil computation (10K) - 5-point weighted + iterative refinement"
      },
      {
        name: "Medium",
        size: 100000,
        description: "Stencil computation (100K) - 5-point weighted + iterative refinement"
      },
      {
        name: "Large",
        size: 1000000,
        description: "Stencil computation (1M) - 5-point weighted + iterative refinement"
      },
      {
        name: "Extremely Large",
        size: 10000000,
        description: "Stencil computation (10M) - 5-point weighted + iterative refinement"
      }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      const input = __getCachedInput("testStencilShared.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 100) + 1)));
      const stencil = [1, 2, 3, 2, 1];  // 5-point stencil
      const fn = (val: number, neighbors: Array<number>, stencil: Array<number>) => {
        // Weighted sum of neighbors
        let result = 0;
        for (let i = 0; i < neighbors.length; i++) {
          result += (neighbors[i] || 0) * stencil[i];
        }
        // Iterative refinement (fixed cost)
        for (let iter = 0; iter < 15; iter++) {
          result = Math.sin(result * 0.01) * 100 + Math.cos(result * 0.01) * 50;
          result = Math.sqrt(Math.abs(result) + 1);
        }
        return result;
      };
      return await stencilImpl.stencil(fn, input, stencil, threads, { type: "zero" });
    },
    sequentialFn: (size: number) => {
      const input = __getCachedInput("testStencilShared.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 100) + 1)));
      const stencil = [1, 2, 3, 2, 1];
      const half = 2;
      const out = new Array(input.length);
      for (let i = 0; i < input.length; i++) {
        let result = 0;
        for (let k = -half; k <= half; k++) {
          const idx = i + k;
          const v = idx >= 0 && idx < input.length ? input[idx] : 0;
          result += v * stencil[k + half];
        }
        for (let iter = 0; iter < 15; iter++) {
          result = Math.sin(result * 0.01) * 100 + Math.cos(result * 0.01) * 50;
          result = Math.sqrt(Math.abs(result) + 1);
        }
        out[i] = result;
      }
      return out;
    },
    verifyFn: (result1: any, result8: any, size: number) => {
      assert.deepStrictEqual(result1, result8, `Results should be identical for size ${size}`);
    }
  });

  benchmarkRunner.saveResults("StencilShared");
  benchmarkRunner.generatePlotData("StencilShared");

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
