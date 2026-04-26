/**
 * Tests and benchmark for stream stage operators in Pipeline:
 *   filter, windowReduce, iterate.
 *
 * Verifies semantics by comparing against a reference sequential implementation,
 * and exercises a realistic web-style pipeline that combines a map stage,
 * a stream filter, a stream window-reduce, and a stream iterate stage.
 */
const { ParallelPipelineShared } = require("../index");
const assert = require("assert");
const seedrandom = require("seedrandom");
const { PatternTestRunner } = require("./testUtils");
const { BenchmarkRunner } = require("./benchmarkRunner");

const myPipeline = new ParallelPipelineShared();
const runner = new PatternTestRunner("PipelineStream");
const benchmarkRunner = new BenchmarkRunner();

// ----- reference sequential implementations -----

function refMap(fn: Function, arr: number[]): number[] {
  return arr.map(x => fn(x));
}

function refFilter(keep: Function, arr: number[]): number[] {
  return arr.filter(x => keep(x));
}

function refWindowReduce(arr: number[], size: number, step: number, op: Function, identity: number): number[] {
  if (arr.length < size) return [];
  const numWindows = Math.floor((arr.length - size) / step) + 1;
  const out = new Array<number>(numWindows);
  for (let w = 0; w < numWindows; w++) {
    let acc = identity;
    for (let i = 0; i < size; i++) acc = op(acc, arr[w * step + i]);
    out[w] = acc;
  }
  return out;
}

function refIterate(op: Function, until: Function, arr: number[], maxIterations: number = 1000): number[] {
  return arr.map(x => {
    let v = x;
    let iter = 0;
    while (!until(v) && iter < maxIterations) { v = op(v); iter++; }
    return v;
  });
}

async function runFunctionalTests() {
  // ----- filter stage -----
  await runner.runFunctionalTest("Filter stage: keep evens", async () => {
    const input = Array.from({ length: 100 }, (_, i) => i);
    const expected = refFilter((x: number) => x % 2 === 0, input);
    const out = await myPipeline.pipeline(
      [{ kind: "filter", keep: (x: number) => x % 2 === 0 }],
      input,
      4
    );
    assert.deepStrictEqual(out, expected);
  });

  // ----- windowReduce stage -----
  await runner.runFunctionalTest("WindowReduce stage: non-overlapping sum windows", async () => {
    const input = Array.from({ length: 32 }, (_, i) => i + 1);
    const expected = refWindowReduce(input, 4, 4, (a: number, b: number) => a + b, 0);
    const out = await myPipeline.pipeline(
      [{ kind: "windowReduce", size: 4, step: 4, op: (a: number, b: number) => a + b, identity: 0 }],
      input,
      4
    );
    assert.deepStrictEqual(out, expected);
  });

  await runner.runFunctionalTest("WindowReduce stage: overlapping windows (moving average input)", async () => {
    const input = Array.from({ length: 50 }, (_, i) => i + 1);
    const expected = refWindowReduce(input, 5, 1, (a: number, b: number) => a + b, 0);
    const out = await myPipeline.pipeline(
      [{ kind: "windowReduce", size: 5, step: 1, op: (a: number, b: number) => a + b, identity: 0 }],
      input,
      4
    );
    assert.deepStrictEqual(out, expected);
  });

  // ----- iterate stage -----
  await runner.runFunctionalTest("Iterate stage: collatz steps", async () => {
    const input = [27, 13, 6, 19, 100];
    // op: x -> x even ? x/2 : 3x+1
    // until: x === 1
    const op = (x: number) => x % 2 === 0 ? x / 2 : 3 * x + 1;
    const until = (x: number) => x === 1;
    const expected = refIterate(op, until, input);
    const out = await myPipeline.pipeline(
      [{ kind: "iterate", op, until }],
      input,
      4
    );
    assert.deepStrictEqual(out, expected);
  });

  // ----- composed pipeline -----
  await runner.runFunctionalTest("Composed: map -> filter -> windowReduce", async () => {
    const input = Array.from({ length: 64 }, (_, i) => i + 1);
    const mapFn = (x: number) => x * 2;
    const keepFn = (x: number) => x > 20;
    const reduceOp = (a: number, b: number) => a + b;

    const stage1 = refMap(mapFn, input);
    const stage2 = refFilter(keepFn, stage1);
    const expected = refWindowReduce(stage2, 4, 4, reduceOp, 0);

    const out = await myPipeline.pipeline(
      [
        mapFn,
        { kind: "filter", keep: keepFn },
        { kind: "windowReduce", size: 4, step: 4, op: reduceOp, identity: 0 },
      ],
      input,
      4
    );
    assert.deepStrictEqual(out, expected);
  });

  // ----- consistency across thread counts -----
  await runner.runFunctionalTest("WindowReduce consistency across threads", async () => {
    const rng = seedrandom("pipeline-stream");
    const input = Array.from({ length: 500 }, () => Math.floor(rng() * 100));
    const stages = [{ kind: "windowReduce", size: 8, step: 4, op: (a: number, b: number) => a + b, identity: 0 }];
    const refs = await Promise.all([1, 2, 4, 8].map(t => myPipeline.pipeline(stages, input, t)));
    for (let i = 1; i < refs.length; i++) {
      assert.deepStrictEqual(refs[i], refs[0], `Thread count ${i} mismatch`);
    }
  });
}

async function runPerformanceBenchmarks() {
  // Benchmark each stream operator individually as a single-stage pipeline,
  // to measure the parallel scaling of each stream stage in isolation
  // (without inter-stage materialization overhead from a multi-stage pipeline).
  const heavyOp = (a: number, b: number) => {
    let v = b;
    for (let i = 0; i < 5; i++) v = Math.sin(v) * Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
    return a + v;
  };

  // 1) WindowReduce — windowed sum-of-trig; size=16, step=16 (non-overlapping).
  await benchmarkRunner.runBenchmark({
    pattern: "PipelineWindowReduce",
    sizes: [
      { name: "Medium", size: 100000, description: "Pipeline windowReduce (100K)" },
      { name: "Large", size: 1000000, description: "Pipeline windowReduce (1M)" },
      { name: "Extremely Large", size: 10000000, description: "Pipeline windowReduce (10M)" }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      const input = Array.from({ length: size }, (_, i) => (i % 1000) + 1);
      return await myPipeline.pipeline(
        [{ kind: "windowReduce", size: 16, step: 16, op: heavyOp, identity: 0 }],
        input,
        threads
      );
    },
  });
  benchmarkRunner.saveResults("PipelineWindowReduce");

  // 2) Iterate — fixed-point loop with per-step trig (high arithmetic intensity per element).
  await benchmarkRunner.runBenchmark({
    pattern: "PipelineIterate",
    sizes: [
      { name: "Medium", size: 100000, description: "Pipeline iterate (100K)" },
      { name: "Large", size: 1000000, description: "Pipeline iterate (1M)" },
      { name: "Extremely Large", size: 10000000, description: "Pipeline iterate (10M)" }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      const input = Array.from({ length: size }, (_, i) => ((i % 50) + 1) / 100);
      const op = (x: number) => Math.cos(x) + Math.sin(x * 0.5) * 0.5;
      const until = (x: number) => Math.abs(x - 0.7390851332) < 1e-3;
      return await myPipeline.pipeline(
        [{ kind: "iterate", op, until, maxIterations: 100 }],
        input,
        threads
      );
    },
  });
  benchmarkRunner.saveResults("PipelineIterate");

  // 3) Composed end-to-end pipeline: Map -> Filter -> WindowReduce.
  // Realistic streaming-style workload (e.g., event stream -> threshold filter -> windowed analytics).
  await benchmarkRunner.runBenchmark({
    pattern: "PipelineStream",
    sizes: [
      { name: "Medium", size: 100000, description: "End-to-end stream pipeline (100K)" },
      { name: "Large", size: 1000000, description: "End-to-end stream pipeline (1M)" },
      { name: "Extremely Large", size: 10000000, description: "End-to-end stream pipeline (10M)" }
    ],
    threadCounts: [1, 2, 4, 8, 16],
    testFn: async (size: number, threads: number) => {
      const input = Array.from({ length: size }, (_, i) => (i % 1000) + 1);
      const mapStage = (x: number) => {
        let v = x;
        for (let i = 0; i < 20; i++) v = Math.sin(v) * Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
        return v;
      };
      const stages = [
        mapStage,
        { kind: "filter", keep: (x: number) => x > 0 },
        { kind: "windowReduce", size: 16, step: 16, op: (a: number, b: number) => a + b, identity: 0 },
      ];
      return await myPipeline.pipeline(stages, input, threads);
    },
  });
  benchmarkRunner.saveResults("PipelineStream");
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
