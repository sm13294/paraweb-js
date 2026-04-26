const { ParallelDivideAndConquerShared } = require("../index");
const assert = require("assert");
const { PatternTestRunner } = require("./testUtils");
const { BenchmarkRunner } = require("./benchmarkRunner");
const { fftSequential } = require("../core/fftUtils");

// Cache inputs across benchmark runs so that JS array creation time is not
// included in per-call timing. Keyed by file+size.
const __inputCache = new Map<string, any>();
function __getCachedInput<T>(key: string, factory: () => T): T {
  let v = __inputCache.get(key);
  if (v === undefined) { v = factory(); __inputCache.set(key, v); }
  return v;
}

const divideAndConquerImpl = new ParallelDivideAndConquerShared();
const runner = new PatternTestRunner("DivideAndConquerShared");
const benchmarkRunner = new BenchmarkRunner();

// ============================================================================
// FUNCTIONAL TESTS - Edge cases and correctness across thread counts
// ============================================================================

async function runFunctionalTests() {
  const threadCounts = [1, 2, 4, 8];
  for (const threads of threadCounts) {
    await runner.runFunctionalTest(
      `Sum calculation (${threads} threads)`,
      async () => {
        const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        const divideFn = (arr: number[]) => {
          if (arr.length <= 1) return [];
          const mid = Math.floor(arr.length / 2);
          return [arr.slice(0, mid), arr.slice(mid)];
        };
        const conquerFn = (results: any[]) => {
          const flattened = results.map((r: any) => {
            if (Array.isArray(r)) {
              if (r.length === 1) return r[0];
              if (r.length === 0) return 0;
              return r;
            }
            return r;
          });
          return flattened.reduce((a: number, b: number) => a + b, 0);
        };
        const baseCaseFn = (arr: number[]) => arr.length <= 1;
        const output = await divideAndConquerImpl.divideAndConquer(
          divideFn,
          conquerFn,
          baseCaseFn,
          input,
          threads
        );
        const expected = input.reduce((a, b) => a + b, 0);
        assert.strictEqual(output, expected);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Find maximum (${threads} threads)`,
      async () => {
        const input = [3, 7, 2, 9, 1, 5, 8, 4, 6, 10, 15, 12, 11, 14, 13, 16];
        const divideFn = (arr: number[]) => {
          if (arr.length <= 1) return [];
          const mid = Math.floor(arr.length / 2);
          return [arr.slice(0, mid), arr.slice(mid)];
        };
        const conquerFn = (results: any[]) => {
          const flattened = results.map((r: any) => Array.isArray(r) ? r[0] : r);
          return Math.max(...flattened);
        };
        const baseCaseFn = (arr: number[]) => arr.length <= 1;
        const output = await divideAndConquerImpl.divideAndConquer(
          divideFn,
          conquerFn,
          baseCaseFn,
          input,
          threads
        );
        const expected = Math.max(...input);
        assert.strictEqual(output, expected);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Merge sort (${threads} threads)`,
      async () => {
        const input = [3, 7, 2, 9, 1, 5, 8, 4, 6, 10];
        const divideFn = (arr: number[]) => {
          if (arr.length <= 1) return [];
          const mid = Math.floor(arr.length / 2);
          return [arr.slice(0, mid), arr.slice(mid)];
        };
        const conquerFn = (results: any[]) => {
          const left = Array.isArray(results[0]) ? results[0] : [results[0]];
          const right = Array.isArray(results[1]) ? results[1] : [results[1]];

          if (!left || left.length === 0) return right || [];
          if (!right || right.length === 0) return left || [];

          const merged: number[] = [];
          let i = 0, j = 0;
          while (i < left.length && j < right.length) {
            if (left[i] <= right[j]) {
              merged.push(left[i++]);
            } else {
              merged.push(right[j++]);
            }
          }
          return merged.concat(left.slice(i)).concat(right.slice(j));
        };
        const baseCaseFn = (arr: number[]) => arr.length <= 1;
        const output = await divideAndConquerImpl.divideAndConquer(
          divideFn,
          conquerFn,
          baseCaseFn,
          input,
          threads
        );
        const expected = [...input].sort((a, b) => a - b);
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Count elements (${threads} threads)`,
      async () => {
        const input = Array.from({ length: 1000 }, (_, i) => i + 1);
        const divideFn = (arr: number[]) => {
          if (arr.length <= 1) return [];
          const mid = Math.floor(arr.length / 2);
          return [arr.slice(0, mid), arr.slice(mid)];
        };
        const conquerFn = (results: any[]) => {
          const flattened = results.map((r: any) => {
            if (Array.isArray(r)) {
              if (r.length === 1) return 1;
              if (r.length === 0) return 0;
              return r;
            }
            return r;
          });
          return flattened.reduce((a: number, b: number) => a + b, 0);
        };
        const baseCaseFn = (arr: number[]) => arr.length <= 1;
        const output = await divideAndConquerImpl.divideAndConquer(
          divideFn,
          conquerFn,
          baseCaseFn,
          input,
          threads
        );
        assert.strictEqual(output, input.length);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Empty array (${threads} threads)`,
      async () => {
        const divideFn = (arr: number[]) => [];
        const conquerFn = (results: any[]) => 0;
        const baseCaseFn = (arr: number[]) => arr.length === 0;
        const output = await divideAndConquerImpl.divideAndConquer(
          divideFn,
          conquerFn,
          baseCaseFn,
          [],
          threads
        );
        assert.strictEqual(Array.isArray(output) && output.length === 0 ? 0 : output, 0);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Single element (${threads} threads)`,
      async () => {
        const divideFn = (arr: number[]) => [];
        const conquerFn = (results: any[]) => results[0] || 0;
        const baseCaseFn = (arr: number[]) => arr.length <= 1;
        const output = await divideAndConquerImpl.divideAndConquer(
          divideFn,
          conquerFn,
          baseCaseFn,
          [42],
          threads
        );
        assert.strictEqual(Array.isArray(output) && output.length === 1 ? output[0] : output, 42);
      }
    );
  }

  await runner.runFunctionalTest(
    "Consistency across thread counts",
    async () => {
      const input = Array.from({ length: 1000 }, (_, i) => i + 1);
      const divideFn = (arr: number[]) => {
        if (arr.length <= 1) return [];
        const mid = Math.floor(arr.length / 2);
        return [arr.slice(0, mid), arr.slice(mid)];
      };
      const conquerFn = (results: any[]) => {
        const flattened = results.map((r: any) => Array.isArray(r) ? r[0] : r);
        return flattened.reduce((a: number, b: number) => a + b, 0);
      };
      const baseCaseFn = (arr: number[]) => arr.length <= 1;

      const results1 = await divideAndConquerImpl.divideAndConquer(divideFn, conquerFn, baseCaseFn, input, 1);
      const results2 = await divideAndConquerImpl.divideAndConquer(divideFn, conquerFn, baseCaseFn, input, 2);
      const results4 = await divideAndConquerImpl.divideAndConquer(divideFn, conquerFn, baseCaseFn, input, 4);
      const results8 = await divideAndConquerImpl.divideAndConquer(divideFn, conquerFn, baseCaseFn, input, 8);

      assert.strictEqual(results1, results2, "1 vs 2 threads");
      assert.strictEqual(results2, results4, "2 vs 4 threads");
      assert.strictEqual(results4, results8, "4 vs 8 threads");
    },
    false
  );
}

// ============================================================================
// PERFORMANCE BENCHMARKS
// ============================================================================

async function runPerformanceBenchmarks() {
  const summary = await benchmarkRunner.runBenchmark({
    pattern: "DivideAndConquerShared",
    sizes: [
      // FFT requires N to be a power of two; sizes here are 2^14 .. 2^23.
      { name: "Small",           size: 16384,    description: "Cooley-Tukey FFT (16K complex points)" },
      { name: "Medium",          size: 131072,   description: "Cooley-Tukey FFT (128K complex points)" },
      { name: "Large",           size: 1048576,  description: "Cooley-Tukey FFT (1M complex points)" },
      { name: "Extremely Large", size: 8388608,  description: "Cooley-Tukey FFT (8M complex points)" }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      const input = __getCachedInput("testDivideAndConquerShared.ts:fft-input:" + String(size), () => {
        const buf = new Float64Array(2 * size);
        for (let i = 0; i < size; i++) buf[2 * i] = Math.sin(i * 0.001) + Math.cos(i * 0.0005);
        return buf;
      }) as Float64Array;
      return await divideAndConquerImpl.fft(input, threads);
    },
    sequentialFn: (size: number) => {
      const input = __getCachedInput("testDivideAndConquerShared.ts:fft-input:" + String(size), () => {
        const buf = new Float64Array(2 * size);
        for (let i = 0; i < size; i++) buf[2 * i] = Math.sin(i * 0.001) + Math.cos(i * 0.0005);
        return buf;
      }) as Float64Array;
      const data = new Float64Array(input);
      return fftSequential(data);
    },
    verifyFn: (result1: any, result8: any, size: number) => {
      const a = result1 as Float64Array, b = result8 as Float64Array;
      assert.strictEqual(a.length, b.length, `length mismatch at size ${size}`);
      let maxErr = 0;
      for (let i = 0; i < a.length; i++) maxErr = Math.max(maxErr, Math.abs(a[i] - b[i]));
      assert.ok(maxErr < 1e-6 * Math.max(1, size), `FFT outputs differ at size ${size} (max err ${maxErr})`);
    }
  });

  benchmarkRunner.saveResults("DivideAndConquerShared");
  benchmarkRunner.generatePlotData("DivideAndConquerShared");

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
