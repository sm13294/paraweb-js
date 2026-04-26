const { ParallelPipelineMP } = require("../index");
const assert = require("assert");
const seedrandom = require("seedrandom");
const { performance } = require("perf_hooks");
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

const pipelineImpl = new ParallelPipelineMP();
const runner = new PatternTestRunner("PipelineMP");
const benchmarkRunner = new BenchmarkRunner();

// ============================================================================
// FUNCTIONAL TESTS - Edge cases and correctness across thread counts
// ============================================================================

async function runFunctionalTests() {
  // Test 1: Basic pipeline with different thread counts
  const threadCounts = [1, 2, 4, 8];
  for (const threads of threadCounts) {
    await runner.runFunctionalTest(
      `Basic pipeline (${threads} threads)`,
      async () => {
        const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        const stages = [
          (x: number) => x * 2,
          (x: number) => x + 1,
          (x: number) => x * x,
        ];
        const output = await pipelineImpl.pipeline(stages, input, threads);
        const expected = input.map(x => {
          const step1 = x * 2;
          const step2 = step1 + 1;
          const step3 = step2 * step2;
          return step3;
        });
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  // Test 2: Empty array
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Empty array (${threads} threads)`,
      async () => {
        const stages = [
          (x: number) => x * 2,
          (x: number) => x + 1,
        ];
        const output = await pipelineImpl.pipeline(stages, [], threads);
        assert.deepStrictEqual(output, []);
      }
    );
  }

  // Test 3: Single element
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Single element (${threads} threads)`,
      async () => {
        const stages = [
          (x: number) => x * 2,
          (x: number) => x + 1,
        ];
        const output = await pipelineImpl.pipeline(stages, [5], threads);
        assert.deepStrictEqual(output, [11]); // (5 * 2) + 1
      }
    );
  }

  // Test 4: Single stage
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Single stage (${threads} threads)`,
      async () => {
        const input = [1, 2, 3, 4, 5];
        const stages = [(x: number) => x * 2];
        const output = await pipelineImpl.pipeline(stages, input, threads);
        const expected = input.map(x => x * 2);
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  // Test 5: Many stages
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Many stages (${threads} threads)`,
      async () => {
        const input = [1, 2, 3];
        const stages = Array.from({ length: 10 }, (_, i) => (x: number) => x + i);
        const output = await pipelineImpl.pipeline(stages, input, threads);
        const expected = input.map(x => {
          let result = x;
          for (let i = 0; i < 10; i++) {
            result = result + i;
          }
          return result;
        });
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  // Test 6: Multi-dimensional array transformations
  for (const threads of [1, 2, 4, 8]) {
    await runner.runFunctionalTest(
      `Multi-dimensional array (${threads} threads)`,
      async () => {
        const input = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
        const stages = [
          (arr: number[]) => arr.map(x => x * 2),
          (arr: number[]) => arr.map(x => x + 1),
          (arr: number[]) => arr.map(x => x * x),
        ];
        const output = await pipelineImpl.pipeline(stages, input, threads);
        const expected = input.map(arr => {
          const step1 = arr.map(x => x * 2);
          const step2 = step1.map(x => x + 1);
          const step3 = step2.map(x => x * x);
          return step3;
        });
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  // Test 7: Consistency across thread counts
  await runner.runFunctionalTest(
    "Consistency across thread counts",
    async () => {
      const input = Array.from({ length: 1000 }, (_, i) => i + 1);
      const stages = [
        (x: number) => x * 2,
        (x: number) => x + 1,
        (x: number) => x * x,
      ];

      const results1 = await pipelineImpl.pipeline(stages, input, 1);
      const results2 = await pipelineImpl.pipeline(stages, input, 2);
      const results4 = await pipelineImpl.pipeline(stages, input, 4);
      const results8 = await pipelineImpl.pipeline(stages, input, 8);

      assert.deepStrictEqual(results1, results2, "1 vs 2 threads");
      assert.deepStrictEqual(results2, results4, "2 vs 4 threads");
      assert.deepStrictEqual(results4, results8, "4 vs 8 threads");
    },
    false
  );

  // Test 8: Large array correctness
  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Large array correctness (${threads} threads)`,
      async () => {
        const input = Array.from({ length: 100000 }, (_, i) => i + 1);
        const stages = [
          (x: number) => x * 2,
          (x: number) => x + 1,
        ];
        const output = await pipelineImpl.pipeline(stages, input, threads);
        assert.strictEqual(output.length, input.length);
        // Check sample
        for (let i = 0; i < Math.min(100, input.length); i++) {
          assert.strictEqual(output[i], (input[i] * 2) + 1);
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
    pattern: "PipelineMP",
    sizes: [
      {
        name: "Small",
        size: 10000,
        description: "Two-stage transform (10K) - sequential stages, parallel per-stage"
      },
      {
        name: "Medium",
        size: 100000,
        description: "Two-stage transform (100K) - sequential stages, parallel per-stage"
      },
      {
        name: "Large",
        size: 1000000,
        description: "Two-stage transform (1M) - sequential stages, parallel per-stage"
      },
      {
        name: "Extremely Large",
        size: 5000000,
        description: "Two-stage transform (5M) - sequential stages, parallel per-stage"
      }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      const input = __getCachedInput("testPipeline.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1)));
      const stages = [
        // Stage 1: trigonometric transform (fixed cost)
        (x: number) => {
          let result = x;
          for (let i = 0; i < 30; i++) {
            result = Math.sin(result) * Math.cos(result * 0.5) + Math.sqrt(Math.abs(result) + 1);
          }
          return result;
        },
        // Stage 2: polynomial evaluation (fixed cost)
        (x: number) => {
          let result = x;
          for (let i = 0; i < 20; i++) {
            result = (result * result - Math.floor(result * result)) * 3.14159 + 1;
          }
          return Math.round(result * 1000) / 1000;
        },
      ];
      return await pipelineImpl.pipeline(stages, input, threads);
    },
    sequentialFn: (size: number) => {
      const input = __getCachedInput("testPipeline.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 1000) + 1)));
      const stage1 = (x: number) => {
        let result = x;
        for (let i = 0; i < 30; i++) {
          result = Math.sin(result) * Math.cos(result * 0.5) + Math.sqrt(Math.abs(result) + 1);
        }
        return result;
      };
      const stage2 = (x: number) => {
        let result = x;
        for (let i = 0; i < 20; i++) {
          result = (result * result - Math.floor(result * result)) * 3.14159 + 1;
        }
        return Math.round(result * 1000) / 1000;
      };
      const out = new Array(input.length);
      for (let i = 0; i < input.length; i++) out[i] = stage2(stage1(input[i]));
      return out;
    },
    verifyFn: (result1: any, result8: any, size: number) => {
      assert.deepStrictEqual(result1, result8, `Results should be identical for size ${size}`);
    }
  });

  benchmarkRunner.saveResults("PipelineMP");
  benchmarkRunner.generatePlotData("PipelineMP");
  
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
