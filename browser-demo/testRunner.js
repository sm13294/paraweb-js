import { MapBrowser } from "./mapBrowser.js";
import { FilterBrowser } from "./filterBrowser.js";
import { ReduceBrowser } from "./reduceBrowser.js";
import { AccumulatorBrowser } from "./accumulatorBrowser.js";
import { MapReduceBrowser } from "./mapReduceBrowser.js";
import { ScatterBrowser } from "./scatterBrowser.js";
import { StencilBrowser } from "./stencilBrowser.js";
import { FarmBrowser } from "./farmBrowser.js";
import { PipelineBrowser } from "./pipelineBrowser.js";
import { DivideAndConquerBrowser } from "./divideAndConquerBrowser.js";
import { MapSharedBrowser } from "./mapSharedBrowser.js";
import { FilterSharedBrowser } from "./filterSharedBrowser.js";
import { ReduceSharedBrowser } from "./reduceSharedBrowser.js";
import { AccumulatorSharedBrowser } from "./accumulatorSharedBrowser.js";
import { MapReduceSharedBrowser } from "./mapReduceSharedBrowser.js";
import { ScatterSharedBrowser } from "./scatterSharedBrowser.js";
import { StencilSharedBrowser } from "./stencilSharedBrowser.js";
import { FarmSharedBrowser } from "./farmSharedBrowser.js";
import { PipelineSharedBrowser } from "./pipelineSharedBrowser.js";
import { DivideAndConquerSharedBrowser } from "./divideAndConquerSharedBrowser.js";
import { ensureSharedArrayBuffer } from "./workerUtils.js";

const now = () => performance.now();

const downloadCsv = (filename, csvText) => {
  const blob = new Blob([csvText], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const buildInput = (size, maxVal) =>
  Array.from({ length: size }, () => Math.floor(Math.random() * maxVal) + 1);

const normalizeSizes = (sizes) => {
  if (!Array.isArray(sizes)) return [10000, 100000, 1000000, 10000000];
  const normalized = sizes
    .map((size) => Math.max(1, Math.floor(size)))
    .filter((size) => Number.isFinite(size));
  return normalized.length ? normalized : [10000, 100000, 1000000, 10000000];
};

const buildVariantList = (variant) => {
  if (variant === "both") {
    return ["mp", "shared"];
  }
  if (variant === "shared") {
    return ["shared"];
  }
  return ["mp"];
};

const buildPatterns = (variant) => {
  if (variant === "shared") {
    ensureSharedArrayBuffer();
    return {
      map: new MapSharedBrowser(),
      filter: new FilterSharedBrowser(),
      reduce: new ReduceSharedBrowser(),
      accumulator: new AccumulatorSharedBrowser(),
      mapReduce: new MapReduceSharedBrowser(),
      scatter: new ScatterSharedBrowser(),
      stencil: new StencilSharedBrowser(),
      farm: new FarmSharedBrowser(),
      pipeline: new PipelineSharedBrowser(),
      dac: new DivideAndConquerSharedBrowser(),
    };
  }

  return {
    map: new MapBrowser(),
    filter: new FilterBrowser(),
    reduce: new ReduceBrowser(),
    accumulator: new AccumulatorBrowser(),
    mapReduce: new MapReduceBrowser(),
    scatter: new ScatterBrowser(),
    stencil: new StencilBrowser(),
    farm: new FarmBrowser(),
    pipeline: new PipelineBrowser(),
    dac: new DivideAndConquerBrowser(),
  };
};

const runFunctionalTests = async (threads, sizes, variant = "mp") => {
  const sizeList = normalizeSizes(sizes);
  const rows = [
    ["pattern", "test", "size", "threads", "variant", "status", "details"],
  ];
  const variants = buildVariantList(variant);
  const record = (pattern, test, size, variantLabel, status, details = "") => {
    rows.push([pattern, test, String(size), String(threads), variantLabel, status, details]);
  };

  for (const variantLabel of variants) {
    const { map, filter, reduce, accumulator, mapReduce, scatter, stencil, farm, pipeline, dac } =
      buildPatterns(variantLabel);

    for (const size of sizeList) {
      const input = buildInput(size, 1000);
      const sampleIndices = Array.from(new Set([0, Math.floor(size / 2), size - 1])).filter(
        (idx) => idx >= 0 && idx < size
      );

      try {
        const output = await map.map((x) => x * 2, input, threads);
        const ok =
          output.length === input.length &&
          sampleIndices.every((idx) => output[idx] === input[idx] * 2);
        record("Map", "double", size, variantLabel, ok ? "PASS" : "FAIL", ok ? "" : "sample mismatch");
      } catch (e) {
        record("Map", "double", size, variantLabel, "FAIL", e.message);
      }

      try {
        const output = await filter.filter((x) => x % 2 === 0, input, threads);
        let expectedCount = 0;
        for (const val of input) {
          if (val % 2 === 0) expectedCount++;
        }
        const ok = output.length === expectedCount && output.every((val) => val % 2 === 0);
        record(
          "Filter",
          "even",
          size,
          variantLabel,
          ok ? "PASS" : "FAIL",
          ok ? "" : "count/predicate mismatch"
        );
      } catch (e) {
        record("Filter", "even", size, variantLabel, "FAIL", e.message);
      }

      try {
        let expected = 0;
        for (const val of input) expected += val;
        const output = await reduce.reduce((acc, x) => acc + x, input, 0, threads);
        const ok = output === expected;
        record(
          "Reduce",
          "sum",
          size,
          variantLabel,
          ok ? "PASS" : "FAIL",
          ok ? "" : `expected ${expected}, got ${output}`
        );
      } catch (e) {
        record("Reduce", "sum", size, variantLabel, "FAIL", e.message);
      }

      try {
        let expected = 100;
        for (const val of input) expected += val;
        const output = await accumulator.accumulator((acc, x) => acc + x, input, 100, threads);
        const ok = output === expected;
        record(
          "Accumulator",
          "sum+init",
          size,
          variantLabel,
          ok ? "PASS" : "FAIL",
          ok ? "" : `expected ${expected}, got ${output}`
        );
      } catch (e) {
        record("Accumulator", "sum+init", size, variantLabel, "FAIL", e.message);
      }

      try {
        let expected = 0;
        for (const val of input) expected += val * 2;
        const output = await mapReduce.mapReduce(
          (x) => x * 2,
          (acc, x) => acc + x,
          input,
          threads
        );
        const ok = output === expected;
        record(
          "MapReduce",
          "double+sum",
          size,
          variantLabel,
          ok ? "PASS" : "FAIL",
          ok ? "" : `expected ${expected}, got ${output}`
        );
      } catch (e) {
        record("MapReduce", "double+sum", size, variantLabel, "FAIL", e.message);
      }

      try {
        const indices = Array.from({ length: size }, (_, i) => (i + 1) % size);
        const output = await scatter.scatter(input, indices, 0, undefined, threads);
        const ok =
          output.length === size &&
          sampleIndices.every((idx) => output[idx] === input[(idx - 1 + size) % size]);
        record("Scatter", "reindex", size, variantLabel, ok ? "PASS" : "FAIL", ok ? "" : "sample mismatch");
      } catch (e) {
        record("Scatter", "reindex", size, variantLabel, "FAIL", e.message);
      }

      try {
        const kernel = [1, 1, 1];
        const output = await stencil.stencil(
          (val, neighbors, stencilKernel) => neighbors.reduce((sum, n, i) => sum + (n || 0) * stencilKernel[i], 0),
          input,
          kernel,
          threads,
          { type: "zero" }
        );
        const expected = input.map((_, i) => {
          const left = i - 1 >= 0 ? input[i - 1] : 0;
          const center = input[i];
          const right = i + 1 < input.length ? input[i + 1] : 0;
          return left + center + right;
        });
        const ok =
          output.length === expected.length &&
          sampleIndices.every((idx) => output[idx] === expected[idx]);
        record("Stencil", "sum-neighbors", size, variantLabel, ok ? "PASS" : "FAIL", ok ? "" : "sample mismatch");
      } catch (e) {
        record("Stencil", "sum-neighbors", size, variantLabel, "FAIL", e.message);
      }

      try {
        const output = await farm.farm((x) => x * 2, input, threads);
        const ok =
          output.length === input.length &&
          sampleIndices.every((idx) => output[idx] === input[idx] * 2);
        record("Farm", "double", size, variantLabel, ok ? "PASS" : "FAIL", ok ? "" : "sample mismatch");
      } catch (e) {
        record("Farm", "double", size, variantLabel, "FAIL", e.message);
      }

      try {
        const stages = [(x) => x * 2, (x) => x + 1];
        const output = await pipeline.pipeline(stages, input, threads);
        const ok =
          output.length === input.length &&
          sampleIndices.every((idx) => output[idx] === input[idx] * 2 + 1);
        record("Pipeline", "double+add", size, variantLabel, ok ? "PASS" : "FAIL", ok ? "" : "sample mismatch");
      } catch (e) {
        record("Pipeline", "double+add", size, variantLabel, "FAIL", e.message);
      }

      try {
        let expected = 0;
        for (const val of input) expected += val;
        const divideFn = (arr) => {
          if (arr.length <= 1) return [];
          const mid = Math.floor(arr.length / 2);
          return [arr.slice(0, mid), arr.slice(mid)];
        };
        const baseCaseFn = (arr) => arr.length <= 1;
        const conquerFn = (results) =>
          results.map((r) => (Array.isArray(r) ? r[0] : r)).reduce((a, b) => a + b, 0);
        const output = await dac.divideAndConquer(divideFn, conquerFn, baseCaseFn, input, threads);
        const ok = output === expected;
        record(
          "DivideAndConquer",
          "sum",
          size,
          variantLabel,
          ok ? "PASS" : "FAIL",
          ok ? "" : `expected ${expected}, got ${output}`
        );
      } catch (e) {
        record("DivideAndConquer", "sum", size, variantLabel, "FAIL", e.message);
      }
    }
  }

  return rows.map((row) => row.join(",")).join("\n");
};

const runBenchmarks = async (threads, sizes, variant = "mp", runs = 1) => {
  const sizeList = normalizeSizes(sizes);
  const threadList = Array.isArray(threads) && threads.length
    ? threads.map((t) => Math.max(1, Math.floor(t))).filter((t) => Number.isFinite(t))
    : [1, 2, 4, 8, 16];
  const runCount = Math.max(1, Number(runs) || 1);
  const rows = [
    ["pattern", "size", "threads", "variant", "runs", "avg_time_ms"],
  ];
  const variants = buildVariantList(variant);

  for (const variantLabel of variants) {
    const { map, filter, reduce, accumulator, mapReduce, scatter, stencil, farm, pipeline, dac } =
      buildPatterns(variantLabel);

    for (const size of sizeList) {
      const input = buildInput(size, 1000);
      const indices = buildInput(size, Math.max(1, size / 4)).map((v) => v - 1);
      const kernel = [1, 2, 1];
      const divideFn = (arr) => {
        if (arr.length <= 1) return [];
        const mid = Math.floor(arr.length / 2);
        return [arr.slice(0, mid), arr.slice(mid)];
      };
      const baseCaseFn = (arr) => arr.length <= 1;
      const conquerFn = (results) =>
        results.map((r) => (Array.isArray(r) ? r[0] : r)).reduce((a, b) => a + b, 0);

      for (const threadCount of threadList) {
        await map.map((x) => x * 2, input, threadCount);
        let total = 0;
        for (let i = 0; i < runCount; i++) {
          const start = now();
          await map.map((x) => x * 2, input, threadCount);
          total += now() - start;
        }
        rows.push([
          "Map",
          String(size),
          String(threadCount),
          variantLabel,
          String(runCount),
          (total / runCount).toFixed(2),
        ]);

        await filter.filter((x) => x % 2 === 0, input, threadCount);
        total = 0;
        for (let i = 0; i < runCount; i++) {
          const start = now();
          await filter.filter((x) => x % 2 === 0, input, threadCount);
          total += now() - start;
        }
        rows.push([
          "Filter",
          String(size),
          String(threadCount),
          variantLabel,
          String(runCount),
          (total / runCount).toFixed(2),
        ]);

        await reduce.reduce((acc, x) => acc + x, input, 0, threadCount);
        total = 0;
        for (let i = 0; i < runCount; i++) {
          const start = now();
          await reduce.reduce((acc, x) => acc + x, input, 0, threadCount);
          total += now() - start;
        }
        rows.push([
          "Reduce",
          String(size),
          String(threadCount),
          variantLabel,
          String(runCount),
          (total / runCount).toFixed(2),
        ]);

        await accumulator.accumulator((acc, x) => acc + x, input, 100, threadCount);
        total = 0;
        for (let i = 0; i < runCount; i++) {
          const start = now();
          await accumulator.accumulator((acc, x) => acc + x, input, 100, threadCount);
          total += now() - start;
        }
        rows.push([
          "Accumulator",
          String(size),
          String(threadCount),
          variantLabel,
          String(runCount),
          (total / runCount).toFixed(2),
        ]);

        await mapReduce.mapReduce(
          (x) => {
            let steps = 0;
            let num = x;
            while (num !== 1) {
              if (num % 2 === 0) {
                num = num / 2;
              } else {
                num = 3 * num + 1;
              }
              steps++;
              if (steps > 10000) break;
            }
            return steps;
          },
          (acc, x) => acc + x,
          input,
          threadCount
        );
        total = 0;
        for (let i = 0; i < runCount; i++) {
          const start = now();
          await mapReduce.mapReduce(
            (x) => {
              let steps = 0;
              let num = x;
              while (num !== 1) {
                if (num % 2 === 0) {
                  num = num / 2;
                } else {
                  num = 3 * num + 1;
                }
                steps++;
                if (steps > 10000) break;
              }
              return steps;
            },
            (acc, x) => acc + x,
            input,
            threadCount
          );
          total += now() - start;
        }
        rows.push([
          "MapReduce",
          String(size),
          String(threadCount),
          variantLabel,
          String(runCount),
          (total / runCount).toFixed(2),
        ]);

        await scatter.scatter(input, indices, 0, (a, b) => a + b, threadCount);
        total = 0;
        for (let i = 0; i < runCount; i++) {
          const start = now();
          await scatter.scatter(input, indices, 0, (a, b) => a + b, threadCount);
          total += now() - start;
        }
        rows.push([
          "Scatter",
          String(size),
          String(threadCount),
          variantLabel,
          String(runCount),
          (total / runCount).toFixed(2),
        ]);

        await stencil.stencil(
          (val, neighbors, stencilKernel) =>
            neighbors.reduce((sum, n, i) => sum + (n || 0) * stencilKernel[i], 0),
          input,
          kernel,
          threadCount,
          { type: "zero" }
        );
        total = 0;
        for (let i = 0; i < runCount; i++) {
          const start = now();
          await stencil.stencil(
            (val, neighbors, stencilKernel) =>
              neighbors.reduce((sum, n, i) => sum + (n || 0) * stencilKernel[i], 0),
            input,
            kernel,
            threadCount,
            { type: "zero" }
          );
          total += now() - start;
        }
        rows.push([
          "Stencil",
          String(size),
          String(threadCount),
          variantLabel,
          String(runCount),
          (total / runCount).toFixed(2),
        ]);

        await farm.farm(
          (x) => {
            let steps = 0;
            let num = x;
            while (num !== 1) {
              if (num % 2 === 0) {
                num = num / 2;
              } else {
                num = 3 * num + 1;
              }
              steps++;
              if (steps > 10000) break;
            }
            return steps;
          },
          input,
          threadCount
        );
        total = 0;
        for (let i = 0; i < runCount; i++) {
          const start = now();
          await farm.farm(
            (x) => {
              let steps = 0;
              let num = x;
              while (num !== 1) {
                if (num % 2 === 0) {
                  num = num / 2;
                } else {
                  num = 3 * num + 1;
                }
                steps++;
                if (steps > 10000) break;
              }
              return steps;
            },
            input,
            threadCount
          );
          total += now() - start;
        }
        rows.push([
          "Farm",
          String(size),
          String(threadCount),
          variantLabel,
          String(runCount),
          (total / runCount).toFixed(2),
        ]);

        await pipeline.pipeline(
          [
            (x) => {
              let steps = 0;
              let num = x;
              while (num !== 1) {
                if (num % 2 === 0) {
                  num = num / 2;
                } else {
                  num = 3 * num + 1;
                }
                steps++;
                if (steps > 10000) break;
              }
              return steps;
            },
            (x) => Math.sin(x) + Math.cos(x) + Math.tan(x),
          ],
          input,
          threadCount
        );
        total = 0;
        for (let i = 0; i < runCount; i++) {
          const start = now();
          await pipeline.pipeline(
            [
              (x) => {
                let steps = 0;
                let num = x;
                while (num !== 1) {
                  if (num % 2 === 0) {
                    num = num / 2;
                  } else {
                    num = 3 * num + 1;
                  }
                  steps++;
                  if (steps > 10000) break;
                }
                return steps;
              },
              (x) => Math.sin(x) + Math.cos(x) + Math.tan(x),
            ],
            input,
            threadCount
          );
          total += now() - start;
        }
        rows.push([
          "Pipeline",
          String(size),
          String(threadCount),
          variantLabel,
          String(runCount),
          (total / runCount).toFixed(2),
        ]);

        await dac.divideAndConquer(divideFn, conquerFn, baseCaseFn, input, threadCount);
        total = 0;
        for (let i = 0; i < runCount; i++) {
          const start = now();
          await dac.divideAndConquer(divideFn, conquerFn, baseCaseFn, input, threadCount);
          total += now() - start;
        }
        rows.push([
          "DivideAndConquer",
          String(size),
          String(threadCount),
          variantLabel,
          String(runCount),
          (total / runCount).toFixed(2),
        ]);
      }
    }
  }

  return rows.map((row) => row.join(",")).join("\n");
};

export { runFunctionalTests, runBenchmarks, downloadCsv };
