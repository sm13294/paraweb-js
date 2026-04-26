// benchmarksRunner.js — paper-aligned benchmark harness for all ten patterns
// across MP / Shared / GPU variants. Mirrors the workloads reported in the
// paper Section 5.2 (and matches browser-bench/index.html and gpu.html).

import { MapBrowser } from "./mapBrowser.js";
import { MapSharedBrowser } from "./mapSharedBrowser.js";
import { FilterBrowser } from "./filterBrowser.js";
import { FilterSharedBrowser } from "./filterSharedBrowser.js";
import { ReduceBrowser } from "./reduceBrowser.js";
import { ReduceSharedBrowser } from "./reduceSharedBrowser.js";
import { ScanBrowser } from "./scanBrowser.js";
import { ScanSharedBrowser } from "./scanSharedBrowser.js";
import { ScatterBrowser } from "./scatterBrowser.js";
import { ScatterSharedBrowser } from "./scatterSharedBrowser.js";
import { StencilBrowser } from "./stencilBrowser.js";
import { StencilSharedBrowser } from "./stencilSharedBrowser.js";
import { FarmBrowser } from "./farmBrowser.js";
import { FarmSharedBrowser } from "./farmSharedBrowser.js";
import { PipelineBrowser } from "./pipelineBrowser.js";
import { PipelineSharedBrowser } from "./pipelineSharedBrowser.js";
import { MapReduceBrowser } from "./mapReduceBrowser.js";
import { MapReduceSharedBrowser } from "./mapReduceSharedBrowser.js";
import { DivideAndConquerBrowser } from "./divideAndConquerBrowser.js";
import { DivideAndConquerSharedBrowser } from "./divideAndConquerSharedBrowser.js";

// ---------- Workload functions (match paper Section 5.2) ----------

// Map / MapReduce: 50-iteration trig+poly per element.
const mapHeavyFn = (x) => {
  let v = x;
  for (let k = 0; k < 50; k++) {
    v = Math.sin(v) + Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
    v = v * v + 1;
  }
  return v;
};

// Filter: 30-iteration trig predicate followed by threshold > 2.
const filterHeavyPred = (x) => {
  let v = x;
  for (let k = 0; k < 30; k++) {
    v = Math.sin(v) + Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
  }
  return v > 2;
};

// Reduce: 10-iteration trig per-element transform; combine = associative sum.
const reduceMapFn = (x) => {
  let v = x;
  for (let k = 0; k < 10; k++) {
    v = Math.sin(v) + Math.cos(v * 0.5);
  }
  return v;
};
const sumOp = (a, b) => a + b;

// Scan: 50-iteration trig per-element transform; combine = associative sum.
const scanMapFn = (x) => {
  let v = x;
  for (let k = 0; k < 50; k++) {
    v = Math.sin(v) + Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
    v = v * v + 1;
  }
  return v;
};

// Scatter: 50-iteration trig per-element transform.
const scatterMapFn = scanMapFn;

// Stencil: weighted neighborhood sum followed by 15-iteration trig refinement.
const stencilWeights = [1, 2, 3, 2, 1];
const stencilFn = (val, neighbors, kernel) => {
  let result = 0;
  for (let i = 0; i < neighbors.length; i++) {
    result += (neighbors[i] || 0) * kernel[i];
  }
  for (let iter = 0; iter < 15; iter++) {
    result = Math.sin(result * 0.01) * 100 + Math.cos(result * 0.01) * 50;
    result = Math.sqrt(Math.abs(result) + 1);
  }
  return result;
};

// Farm: Collatz step-count followed by 200-iteration trig refinement.
const farmHeavyFn = (n) => {
  let steps = 0;
  let num = n;
  while (num !== 1) {
    if (num % 2 === 0) num = num / 2;
    else num = 3 * num + 1;
    steps++;
    if (steps > 10000) break;
  }
  let v = steps;
  for (let k = 0; k < 200; k++) {
    v = Math.sin(v) + Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
    v = v * v + 1;
  }
  return v;
};

// Pipeline: stage 1 = 30-iter trig, stage 2 = 20-iter polynomial with rounding.
const pipelineStage1 = (x) => {
  let v = x;
  for (let k = 0; k < 30; k++) {
    v = Math.sin(v) + Math.cos(v * 0.5) + Math.sqrt(Math.abs(v) + 1);
  }
  return v;
};
const pipelineStage2 = (x) => {
  let v = x;
  for (let k = 0; k < 20; k++) {
    v = v * 0.99 + 1.01;
  }
  return Math.round(v * 1000) / 1000;
};

// ---------- Input generators ----------

const modInput = (size, mod, offset) => {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) arr[i] = (i % mod) + offset;
  return arr;
};

const seededInput = (size, maxVal) => {
  const arr = new Array(size);
  let s = 42;
  for (let i = 0; i < size; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    arr[i] = (s % maxVal) + 1;
  }
  return arr;
};

const fftInput = (size) => {
  const buf = new Float64Array(2 * size);
  for (let i = 0; i < size; i++) {
    buf[2 * i] = Math.sin(i * 0.001) + Math.cos(i * 0.0005);
  }
  return buf;
};

// ---------- Sequential reference implementations (baseline) ----------

const seqMap = (input) => {
  const out = new Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = mapHeavyFn(input[i]);
  return out;
};

const seqFilter = (input) => {
  const out = [];
  for (let i = 0; i < input.length; i++) {
    if (filterHeavyPred(input[i])) out.push(input[i]);
  }
  return out;
};

const seqReduce = (input) => {
  let acc = 0;
  for (let i = 0; i < input.length; i++) acc = sumOp(acc, reduceMapFn(input[i]));
  return acc;
};

const seqScan = (input) => {
  const out = new Array(input.length);
  let acc = 0;
  for (let i = 0; i < input.length; i++) {
    acc = sumOp(acc, scanMapFn(input[i]));
    out[i] = acc;
  }
  return out;
};

const seqScatter = (input, indices) => {
  let maxIdx = 0;
  for (let i = 0; i < indices.length; i++) if (indices[i] > maxIdx) maxIdx = indices[i];
  const out = new Array(maxIdx + 1).fill(0);
  const lastWriter = new Int32Array(maxIdx + 1).fill(-1);
  for (let i = 0; i < input.length; i++) {
    const idx = indices[i];
    if (i > lastWriter[idx]) {
      out[idx] = scatterMapFn(input[i]);
      lastWriter[idx] = i;
    }
  }
  return out;
};

const seqStencil = (input) => {
  const out = new Array(input.length);
  const w = stencilWeights;
  const radius = (w.length - 1) >> 1;
  for (let i = 0; i < input.length; i++) {
    const neighbors = new Array(w.length);
    for (let k = -radius; k <= radius; k++) {
      const idx = i + k;
      neighbors[k + radius] = idx >= 0 && idx < input.length ? input[idx] : 0;
    }
    out[i] = stencilFn(input[i], neighbors, w);
  }
  return out;
};

const seqFarm = (input) => {
  const out = new Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = farmHeavyFn(input[i]);
  return out;
};

const seqPipeline = (input) => {
  const out = new Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = pipelineStage2(pipelineStage1(input[i]));
  return out;
};

const seqMapReduce = (input) => {
  let acc = 0;
  for (let i = 0; i < input.length; i++) acc = sumOp(acc, mapHeavyFn(input[i]));
  return acc;
};

// Sequential Cooley-Tukey radix-2 FFT in-place on interleaved Float64Array.
const seqFft = (input) => {
  const data = new Float64Array(input);
  const N = data.length / 2;
  const bits = Math.log2(N) | 0;
  for (let i = 0; i < N; i++) {
    let r = 0, x = i;
    for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>>= 1; }
    if (r > i) {
      const ar = data[2 * i], ai = data[2 * i + 1];
      data[2 * i] = data[2 * r];
      data[2 * i + 1] = data[2 * r + 1];
      data[2 * r] = ar;
      data[2 * r + 1] = ai;
    }
  }
  for (let s = 1; s <= bits; s++) {
    const m = 1 << s;
    const mh = m >> 1;
    const theta = -2 * Math.PI / m;
    const wpr = Math.cos(theta);
    const wpi = Math.sin(theta);
    for (let k = 0; k < N; k += m) {
      let wr = 1, wi = 0;
      for (let j = 0; j < mh; j++) {
        const tr = wr * data[2 * (k + j + mh)] - wi * data[2 * (k + j + mh) + 1];
        const ti = wr * data[2 * (k + j + mh) + 1] + wi * data[2 * (k + j + mh)];
        data[2 * (k + j + mh)] = data[2 * (k + j)] - tr;
        data[2 * (k + j + mh) + 1] = data[2 * (k + j) + 1] - ti;
        data[2 * (k + j)] = data[2 * (k + j)] + tr;
        data[2 * (k + j) + 1] = data[2 * (k + j) + 1] + ti;
        const newWr = wr * wpr - wi * wpi;
        wi = wr * wpi + wi * wpr;
        wr = newWr;
      }
    }
  }
  return data;
};

// ---------- Pattern config table ----------
//
// Each entry knows how to:
//   - build inputs (cached across runs to keep timings comparable)
//   - call MP / Shared / GPU variants with the paper's heavy workload
//   - run a sequential reference for the same workload
//
// Some patterns ignore the threads argument on certain variants (e.g. GPU is
// a single dispatch).

const inputCache = new Map();
const cached = (key, factory) => {
  let v = inputCache.get(key);
  if (v === undefined) { v = factory(); inputCache.set(key, v); }
  return v;
};

export const PATTERNS = {
  Map: {
    label: "Map",
    sequential: (size) => seqMap(cached("Map:input:" + size, () => modInput(size, 1000, 1))),
    mp: async (browser, threads, size) => browser.map(mapHeavyFn, cached("Map:input:" + size, () => modInput(size, 1000, 1)), threads),
    shared: async (browser, threads, size) => browser.map(mapHeavyFn, cached("Map:input:" + size, () => modInput(size, 1000, 1)), threads),
    gpu: async (instance, size) => instance.map("trig_50", cached("Map:input:" + size, () => modInput(size, 1000, 1))),
    Mp: MapBrowser,
    Shared: MapSharedBrowser,
    Gpu: "Map",
  },
  Filter: {
    label: "Filter",
    sequential: (size) => seqFilter(cached("Filter:input:" + size, () => modInput(size, 1000, 1))),
    mp: async (browser, threads, size) => browser.filter(filterHeavyPred, cached("Filter:input:" + size, () => modInput(size, 1000, 1)), threads),
    shared: async (browser, threads, size) => browser.filter(filterHeavyPred, cached("Filter:input:" + size, () => modInput(size, 1000, 1)), threads),
    gpu: async (instance, size) => instance.filter("trig_gt2", cached("Filter:input:" + size, () => modInput(size, 1000, 1))),
    Mp: FilterBrowser,
    Shared: FilterSharedBrowser,
    Gpu: "Filter",
  },
  Reduce: {
    label: "Reduce",
    sequential: (size) => seqReduce(cached("Reduce:input:" + size, () => modInput(size, 100, 1))),
    mp: async (browser, threads, size) => browser.reduce(sumOp, cached("Reduce:input:" + size, () => modInput(size, 100, 1)), 0, threads, reduceMapFn),
    shared: async (browser, threads, size) => browser.reduce(sumOp, cached("Reduce:input:" + size, () => modInput(size, 100, 1)), 0, threads, reduceMapFn),
    gpu: async (instance, size) => instance.reduce("add", cached("Reduce:input:" + size, () => modInput(size, 100, 1)), 0, "trig_reduce_10"),
    Mp: ReduceBrowser,
    Shared: ReduceSharedBrowser,
    Gpu: "Reduce",
  },
  Scan: {
    label: "Scan",
    sequential: (size) => seqScan(cached("Scan:input:" + size, () => modInput(size, 100, 1))),
    mp: async (browser, threads, size) => browser.scan(sumOp, cached("Scan:input:" + size, () => modInput(size, 100, 1)), 0, threads, scanMapFn),
    shared: async (browser, threads, size) => browser.scan(sumOp, cached("Scan:input:" + size, () => modInput(size, 100, 1)), 0, threads, scanMapFn),
    gpu: async (instance, size) => instance.scan("add", cached("Scan:input:" + size, () => modInput(size, 100, 1)), 0, "trig_scan_50"),
    Mp: ScanBrowser,
    Shared: ScanSharedBrowser,
    Gpu: "Scan",
  },
  Scatter: {
    label: "Scatter",
    sequential: (size) => {
      const input = cached("Scatter:input:" + size, () => seededInput(size, 1000));
      const indices = cached("Scatter:indices:" + size, () => seededInput(size, Math.floor(size / 4)));
      return seqScatter(input, indices);
    },
    mp: async (browser, threads, size) => {
      const input = cached("Scatter:input:" + size, () => seededInput(size, 1000));
      const indices = cached("Scatter:indices:" + size, () => seededInput(size, Math.floor(size / 4)));
      return browser.scatter(input, indices, 0, undefined, threads, scatterMapFn);
    },
    shared: async (browser, threads, size) => {
      const input = cached("Scatter:input:" + size, () => seededInput(size, 1000));
      const indices = cached("Scatter:indices:" + size, () => seededInput(size, Math.floor(size / 4)));
      return browser.scatter(input, indices, 0, undefined, threads, scatterMapFn);
    },
    gpu: async (instance, size) => {
      const input = cached("Scatter:input:" + size, () => seededInput(size, 1000));
      const indices = cached("Scatter:indices:" + size, () => seededInput(size, Math.floor(size / 4)));
      return instance.scatter(input, indices, undefined, 0, "trig_scan_50");
    },
    Mp: ScatterBrowser,
    Shared: ScatterSharedBrowser,
    Gpu: "Scatter",
  },
  Stencil: {
    label: "Stencil",
    sequential: (size) => seqStencil(cached("Stencil:input:" + size, () => modInput(size, 100, 1))),
    mp: async (browser, threads, size) => browser.stencil(stencilFn, cached("Stencil:input:" + size, () => modInput(size, 100, 1)), stencilWeights, threads, { type: "zero" }),
    shared: async (browser, threads, size) => browser.stencil(stencilFn, cached("Stencil:input:" + size, () => modInput(size, 100, 1)), stencilWeights, threads, { type: "zero" }),
    gpu: async (instance, size) => instance.stencil("trig_15", cached("Stencil:input:" + size, () => modInput(size, 100, 1)), stencilWeights),
    Mp: StencilBrowser,
    Shared: StencilSharedBrowser,
    Gpu: "Stencil",
  },
  Farm: {
    label: "Farm",
    sequential: (size) => seqFarm(cached("Farm:input:" + size, () => modInput(size, 1000, 1000))),
    mp: async (browser, threads, size) => browser.farm(farmHeavyFn, cached("Farm:input:" + size, () => modInput(size, 1000, 1000)), threads),
    shared: async (browser, threads, size) => browser.farm(farmHeavyFn, cached("Farm:input:" + size, () => modInput(size, 1000, 1000)), threads),
    gpu: async (instance, size) => instance.farm("farm_collatz_trig_200", cached("Farm:input:" + size, () => modInput(size, 1000, 1000))),
    Mp: FarmBrowser,
    Shared: FarmSharedBrowser,
    Gpu: "Farm",
  },
  Pipeline: {
    label: "Pipeline",
    sequential: (size) => seqPipeline(cached("Pipeline:input:" + size, () => modInput(size, 1000, 1))),
    mp: async (browser, threads, size) => browser.pipeline([pipelineStage1, pipelineStage2], cached("Pipeline:input:" + size, () => modInput(size, 1000, 1)), threads),
    shared: async (browser, threads, size) => browser.pipeline([pipelineStage1, pipelineStage2], cached("Pipeline:input:" + size, () => modInput(size, 1000, 1)), threads),
    gpu: async (instance, size) => instance.pipeline(["trig_30", "poly_stage2"], cached("Pipeline:input:" + size, () => modInput(size, 1000, 1))),
    Mp: PipelineBrowser,
    Shared: PipelineSharedBrowser,
    Gpu: "Pipeline",
  },
  MapReduce: {
    label: "MapReduce",
    sequential: (size) => seqMapReduce(cached("MapReduce:input:" + size, () => modInput(size, 1000, 1))),
    mp: async (browser, threads, size) => browser.mapReduce(mapHeavyFn, sumOp, cached("MapReduce:input:" + size, () => modInput(size, 1000, 1)), threads),
    shared: async (browser, threads, size) => browser.mapReduce(mapHeavyFn, sumOp, cached("MapReduce:input:" + size, () => modInput(size, 1000, 1)), threads),
    gpu: async (instance, size) => instance.mapReduce("trig_50", "add", cached("MapReduce:input:" + size, () => modInput(size, 1000, 1))),
    Mp: MapReduceBrowser,
    Shared: MapReduceSharedBrowser,
    Gpu: "MapReduce",
  },
  DivideAndConquer: {
    label: "Divide-and-Conquer (FFT)",
    requiresPow2: true,
    sequential: (size) => seqFft(cached("DAC:input:" + size, () => fftInput(size))),
    mp: async (browser, threads, size) => browser.fft(cached("DAC:input:" + size, () => fftInput(size)), threads),
    shared: async (browser, threads, size) => browser.fft(cached("DAC:input:" + size, () => fftInput(size)), threads),
    gpu: async (instance, size) => instance.fft(cached("DAC:input:" + size, () => fftInput(size))),
    Mp: DivideAndConquerBrowser,
    Shared: DivideAndConquerSharedBrowser,
    Gpu: "DivideAndConquer",
  },
};

export const PATTERN_KEYS = Object.keys(PATTERNS);

// ---------- Timing harness ----------

const now = () => performance.now();

async function timeIt(fn, runs, warmup) {
  for (let i = 0; i < warmup; i++) await fn();
  let total = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = now();
    await fn();
    total += now() - t0;
  }
  return total / runs;
}

// ---------- Public runner ----------
//
// config = {
//   patterns: ["Map", "Filter", ...] | undefined (defaults to all),
//   variants: ["mp", "shared", "gpu"]  // subset
//   sizes:    [size, ...]              // input sizes
//   threads:  [t, ...]                 // thread counts (CPU); GPU uses [1] internally
//   runs:     5,
//   warmup:   2,
//   onProgress: ({ pattern, variant, size, threads, time, speedup }) => {},
// }

export async function runBenchmarks(config) {
  const patterns = (config.patterns && config.patterns.length) ? config.patterns : PATTERN_KEYS;
  const variants = config.variants && config.variants.length ? config.variants : ["mp", "shared"];
  const sizes = config.sizes && config.sizes.length ? config.sizes : [100000];
  const threadList = config.threads && config.threads.length ? config.threads : [1, 2, 4, 8, 16];
  const runs = Math.max(1, Number(config.runs) || 5);
  const warmup = Math.max(0, Number(config.warmup) || 2);
  const onProgress = config.onProgress || (() => {});

  const results = [];

  // Sequential baseline: one timing per (pattern, size). Reused across variants
  // and thread counts so that speedup numbers are anchored to the same
  // single-threaded reference for each input size.
  const seqCache = new Map();

  for (const pat of patterns) {
    const cfg = PATTERNS[pat];
    if (!cfg) continue;
    for (const size of sizes) {
      if (cfg.requiresPow2 && (size & (size - 1)) !== 0) {
        onProgress({ pattern: pat, variant: "info", size, message: `skipping (not a power of two)` });
        continue;
      }
      // Sequential baseline.
      const seqKey = `${pat}|${size}`;
      let seqTime;
      if (seqCache.has(seqKey)) {
        seqTime = seqCache.get(seqKey);
      } else {
        seqTime = await timeIt(() => cfg.sequential(size), runs, warmup);
        seqCache.set(seqKey, seqTime);
        results.push({ pattern: pat, variant: "seq", size, threads: 1, time: seqTime, speedup: 1 });
        onProgress({ pattern: pat, variant: "seq", size, threads: 1, time: seqTime, speedup: 1 });
      }

      for (const variant of variants) {
        if (variant === "gpu") {
          if (typeof window === "undefined" || !window.PW_GPU) {
            onProgress({ pattern: pat, variant, size, message: "GPU bundle not loaded" });
            continue;
          }
          const Cls = window.PW_GPU[cfg.Gpu];
          if (!Cls) {
            onProgress({ pattern: pat, variant, size, message: "GPU class missing" });
            continue;
          }
          const instance = new Cls();
          try {
            const time = await timeIt(() => cfg.gpu(instance, size), runs, warmup);
            const speedup = seqTime / time;
            results.push({ pattern: pat, variant, size, threads: 1, time, speedup });
            onProgress({ pattern: pat, variant, size, threads: 1, time, speedup });
          } catch (e) {
            onProgress({ pattern: pat, variant, size, message: "error: " + e.message });
          }
          continue;
        }

        const Cls = variant === "shared" ? cfg.Shared : cfg.Mp;
        const browser = new Cls();
        for (const threads of threadList) {
          try {
            const fn = variant === "shared" ? cfg.shared : cfg.mp;
            const time = await timeIt(() => fn(browser, threads, size), runs, warmup);
            const speedup = seqTime / time;
            results.push({ pattern: pat, variant, size, threads, time, speedup });
            onProgress({ pattern: pat, variant, size, threads, time, speedup });
          } catch (e) {
            onProgress({ pattern: pat, variant, size, threads, message: "error: " + e.message });
          }
        }
      }
    }
  }

  return results;
}

// ---------- CSV export ----------

export function resultsToCSV(rows) {
  const header = ["pattern", "variant", "size", "threads", "time_ms", "speedup"];
  const lines = [header.join(",")];
  for (const r of rows) {
    if (r.message) continue;
    lines.push([
      r.pattern,
      r.variant,
      String(r.size),
      String(r.threads),
      r.time.toFixed(3),
      r.speedup.toFixed(3),
    ].join(","));
  }
  return lines.join("\n");
}

export function downloadCSV(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
