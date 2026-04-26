const { ParallelScanShared } = require("../index");
const assert = require("assert");
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


const myScan = new ParallelScanShared();
const runner = new PatternTestRunner("ScanShared");
const benchmarkRunner = new BenchmarkRunner();

function sequentialScan(fn: Function, arr: number[], identity: number): number[] {
  const out: number[] = [];
  let acc = identity;
  for (let i = 0; i < arr.length; i++) {
    acc = fn(acc, arr[i]);
    out.push(acc);
  }
  return out;
}

async function runFunctionalTests() {
  const threadCounts = [1, 2, 4, 8];

  for (const threads of threadCounts) {
    await runner.runFunctionalTest(
      `Inclusive prefix-sum (${threads} threads)`,
      async () => {
        const input = Array.from({ length: 32 }, (_, i) => i + 1);
        const expected = sequentialScan((a: number, b: number) => a + b, input, 0);
        const output = await myScan.scan((a: number, b: number) => a + b, input, 0, threads);
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Empty array (${threads} threads)`,
      async () => {
        const output = await myScan.scan((a: number, b: number) => a + b, [], 0, threads);
        assert.deepStrictEqual(output, []);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Single element (${threads} threads)`,
      async () => {
        const output = await myScan.scan((a: number, b: number) => a + b, [5], 0, threads);
        assert.deepStrictEqual(output, [5]);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Prefix product (${threads} threads)`,
      async () => {
        const input = [1, 2, 3, 4, 5];
        const expected = [1, 2, 6, 24, 120];
        const output = await myScan.scan((a: number, b: number) => a * b, input, 1, threads);
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  for (const threads of [1, 8]) {
    await runner.runFunctionalTest(
      `Running max (${threads} threads)`,
      async () => {
        const input = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
        const expected = [3, 3, 4, 4, 5, 9, 9, 9, 9, 9];
        const output = await myScan.scan((a: number, b: number) => a > b ? a : b, input, -Infinity, threads);
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  // Non-power-of-two size spanning multiple chunks, with non-identity initial value.
  for (const threads of [1, 2, 4]) {
    await runner.runFunctionalTest(
      `With non-zero initial value (${threads} threads)`,
      async () => {
        const input = Array.from({ length: 17 }, (_, i) => i + 1);
        const init = 100;
        const expected = sequentialScan((a: number, b: number) => a + b, input, init);
        const output = await myScan.scan((a: number, b: number) => a + b, input, init, threads);
        assert.deepStrictEqual(output, expected);
      }
    );
  }

  await runner.runFunctionalTest(
    "Consistency across thread counts",
    async () => {
      const input = Array.from({ length: 1000 }, (_, i) => (i * 7) % 100);
      const fn = (a: number, b: number) => a + b;
      const refs = await Promise.all([1, 2, 4, 8].map(t => myScan.scan(fn, input, 0, t)));
      for (let i = 1; i < refs.length; i++) {
        assert.deepStrictEqual(refs[i], refs[0], `Thread count mismatch at index ${i}`);
      }
    }
  );
}

async function runPerformanceBenchmarks() {
  await benchmarkRunner.runBenchmark({
    pattern: "ScanShared",
    sizes: [
      { name: "Small", size: 10000, description: "Scan with per-element transform (10K)" },
      { name: "Medium", size: 100000, description: "Scan with per-element transform (100K)" },
      { name: "Large", size: 1000000, description: "Scan with per-element transform (1M)" },
      { name: "Extremely Large", size: 10000000, description: "Scan with per-element transform (10M)" }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      const input = __getCachedInput("testScanShared.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 100) + 1)));
      // Pure associative prefix sum; see testScan.ts for rationale.
      const fn = (acc: number, x: number) => acc + x;
      // Per-element heavy transform (matches Map's 50-iteration trig transform)
      // so that Scan's scaling is not dominated by trivial per-element work.
      const heavyFn = (x: number) => {
        let v = x;
        for (let k = 0; k < 50; k++) {
          v = Math.sin(v) + Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
          v = v * v + 1;
        }
        return v;
      };
      return await myScan.scan(fn, input, 0, threads, heavyFn);
    },
    sequentialFn: (size: number) => {
      const input = __getCachedInput("testScanShared.ts:input:" + String(size), () => (Array.from({ length: size }, (_, i) => (i % 100) + 1)));
      const heavyFn = (x: number) => {
        let v = x;
        for (let k = 0; k < 50; k++) {
          v = Math.sin(v) + Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
          v = v * v + 1;
        }
        return v;
      };
      const out = new Array(input.length);
      let acc = 0;
      for (let i = 0; i < input.length; i++) {
        acc += heavyFn(input[i]);
        out[i] = acc;
      }
      return out;
    },
    verifyFn: (result1: any, result8: any, size: number) => {
      verifyApproxEqual(result1, result8, size, "reduction result");
    }
  });

  benchmarkRunner.saveResults("ScanShared");
  benchmarkRunner.generatePlotData("ScanShared");
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
