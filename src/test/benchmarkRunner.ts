const { performance } = require("perf_hooks");
const fs = require("fs");
const path = require("path");

// When PARAWEB_QUIET=1 the runner drops all decorative chrome (banners,
// per-size headers, "Results saved to…" lines, emojis) and prints one compact
// row per measurement. The scripts/run-all-benchmarks.sh driver sets this so
// its logs are grep-able; direct `npm run test:map:benchmark` invocations
// stay pretty.
const QUIET = process.env.PARAWEB_QUIET === "1";

interface BenchmarkConfig {
  pattern: string;
  sizes: Array<{ name: string; size: number; description: string }>;
  threadCounts: number[];
  testFn: (size: number, threads: number) => Promise<any>;
  /**
   * Optional plain-JS sequential implementation (no workers, no
   * SharedArrayBuffer, no function serialization). When provided, its
   * execution time is used as the speedup baseline for all thread counts
   * and is recorded as a result with threads=0. This gives honest
   * "parallel vs sequential" speedups, not "parallel vs parallel-1T-with-overhead".
   */
  sequentialFn?: (size: number) => Promise<any> | any;
  verifyFn?: (result1: any, result8: any, size: number) => void;
  runs?: number;
  warmupRuns?: number;
}

interface BenchmarkResult {
  pattern: string;
  size: string;
  sizeValue: number;
  description: string;
  threads: number;
  time: number;
  stddev: number;
  median: number;
  min: number;
  max: number;
  ci95: [number, number];
  runs: number;
  warmupRuns: number;
  timestamp: string;
}

interface BenchmarkSummary {
  pattern: string;
  results: Array<{
    size: string;
    sizeValue: number;
    description: string;
    threadResults: Array<{ threads: number; time: number }>;
    speedups: Array<{ threads: number; speedup: number; improvement: number; speedupCI?: [number, number] }>;
  }>;
}

class BenchmarkRunner {
  private results: BenchmarkResult[] = [];
  private resultsDir: string;

  constructor() {
    // Output directory is controlled by PARAWEB_RESULTS_DIR so that the
    // run-all-benchmarks.sh driver can collect every artifact from a single
    // run into one timestamped folder (benchmark-results/run-<ts>/) alongside
    // the logs. Direct `npm run test:X:benchmark` invocations fall back to
    // benchmark-results/ in the project root, matching the old default.
    this.resultsDir = process.env.PARAWEB_RESULTS_DIR
      || path.join(process.cwd(), "benchmark-results");
    if (!fs.existsSync(this.resultsDir)) {
      fs.mkdirSync(this.resultsDir, { recursive: true });
    }
  }

  async runBenchmark(config: BenchmarkConfig): Promise<BenchmarkSummary> {
    if (QUIET) {
      console.log(`# ${config.pattern}`);
    } else {
      console.log(`\n${"=".repeat(80)}`);
      console.log(`BENCHMARK: ${config.pattern.toUpperCase()} PATTERN`);
      console.log("=".repeat(80));
    }

    const summary: BenchmarkSummary = {
      pattern: config.pattern,
      results: [],
    };

    for (const sizeConfig of config.sizes) {
      if (!QUIET) {
        console.log(`\n📊 Testing ${sizeConfig.name} (${sizeConfig.size.toLocaleString()} elements)`);
        console.log(`   Use case: ${sizeConfig.description}`);
        console.log("─".repeat(80));
      }

      const threadResults: Array<{ threads: number; time: number }> = [];
      const speedups: Array<{ threads: number; speedup: number; improvement: number; speedupCI?: [number, number] }> = [];
      let baselineTime: number | null = null;
      let baselineCi95: [number, number] | null = null;
      const warmupRuns = Math.max(0, config.warmupRuns ?? 2);
      const runs = Math.max(
        1,
        config.runs ?? (Number(process.env.BENCHMARK_RUNS) || 5)
      );

      // Per-thread-count outputs captured from the last timed run, used by
      // config.verifyFn to check that parallelization did not change the result.
      const outputsByThreads = new Map<number, any>();

      // Optional sequential baseline (plain-JS, no workers). Measured first
      // so all subsequent parallel speedups are computed against it.
      if (config.sequentialFn) {
        try {
          for (let i = 0; i < warmupRuns; i++) {
            await config.sequentialFn(sizeConfig.size);
          }
          const seqTimes: number[] = [];
          let seqLast: any;
          for (let i = 0; i < runs; i++) {
            const start = performance.now();
            seqLast = await config.sequentialFn(sizeConfig.size);
            seqTimes.push(performance.now() - start);
          }
          outputsByThreads.set(0, seqLast);
          const sortedSeq = [...seqTimes].sort((a, b) => a - b);
          const seqMean = seqTimes.reduce((s, v) => s + v, 0) / seqTimes.length;
          const seqMedian = seqTimes.length % 2 === 0
            ? (sortedSeq[seqTimes.length / 2 - 1] + sortedSeq[seqTimes.length / 2]) / 2
            : sortedSeq[Math.floor(seqTimes.length / 2)];
          const seqVariance = seqTimes.reduce((s, v) => s + (v - seqMean) ** 2, 0) / Math.max(1, seqTimes.length - 1);
          const seqStddev = Math.sqrt(seqVariance);
          const seqSem = seqStddev / Math.sqrt(seqTimes.length);
          const seqCiLo = seqMean - 1.96 * seqSem;
          const seqCiHi = seqMean + 1.96 * seqSem;

          this.results.push({
            pattern: config.pattern,
            size: sizeConfig.name,
            sizeValue: sizeConfig.size,
            description: sizeConfig.description,
            threads: 0,
            time: seqMean,
            stddev: seqStddev,
            median: seqMedian,
            min: sortedSeq[0],
            max: sortedSeq[sortedSeq.length - 1],
            ci95: [seqCiLo, seqCiHi],
            runs,
            warmupRuns,
            timestamp: new Date().toISOString(),
          });

          // Sequential becomes the authoritative baseline.
          baselineTime = seqMean;
          baselineCi95 = [seqCiLo, seqCiHi];
          threadResults.push({ threads: 0, time: seqMean });

          if (QUIET) {
            console.log(
              `${config.pattern}\t${sizeConfig.name}\t${sizeConfig.size}\t0\t${seqMean.toFixed(2)}\t${seqStddev.toFixed(2)}\tsequential`
            );
          } else {
            console.log(`  ⏱️  sequential:  ${seqMean.toFixed(2)} ± ${seqStddev.toFixed(2)}ms (plain-JS baseline)`);
          }
        } catch (error: any) {
          console.log(`  ❌ sequential baseline failed: ${error.message}`);
        }
      }

      // Test each thread count
      for (const threads of config.threadCounts) {
        try {
          // Warmup runs
          for (let i = 0; i < warmupRuns; i++) {
            await config.testFn(sizeConfig.size, threads);
          }

          // Actual benchmark runs (averaged). Capture the final run's output
          // for inline correctness verification below.
          const times: number[] = [];
          let lastResult: any;
          for (let i = 0; i < runs; i++) {
            const start = performance.now();
            lastResult = await config.testFn(sizeConfig.size, threads);
            times.push(performance.now() - start);
          }
          outputsByThreads.set(threads, lastResult);
          // Compute statistics
          const sorted = [...times].sort((a, b) => a - b);
          const mean = times.reduce((sum, v) => sum + v, 0) / times.length;
          const median = times.length % 2 === 0
            ? (sorted[times.length / 2 - 1] + sorted[times.length / 2]) / 2
            : sorted[Math.floor(times.length / 2)];
          const variance = times.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, times.length - 1);
          const stddev = Math.sqrt(variance);
          const sem = stddev / Math.sqrt(times.length);  // Standard Error of Mean
          const ci95Lower = mean - 1.96 * sem;
          const ci95Upper = mean + 1.96 * sem;
          const min = sorted[0];
          const max = sorted[sorted.length - 1];
          const time = mean;

          threadResults.push({ threads, time });

          // Store result
          this.results.push({
            pattern: config.pattern,
            size: sizeConfig.name,
            sizeValue: sizeConfig.size,
            description: sizeConfig.description,
            threads,
            time,
            stddev,
            median,
            min,
            max,
            ci95: [ci95Lower, ci95Upper],
            runs,
            warmupRuns,
            timestamp: new Date().toISOString(),
          });

          // Calculate speedup. If a sequential baseline was measured, speedups
          // (including the 1-thread parallel time) are reported against it.
          // Otherwise fall back to the 1-thread parallel time as the baseline.
          const hasSequentialBaseline = config.sequentialFn && baselineTime !== null;
          if (!hasSequentialBaseline && threads === 1) {
            baselineTime = time;
            baselineCi95 = [ci95Lower, ci95Upper];
          }

          let speedup = 1;
          let improvement = 0;
          let speedupCI: [number, number] | undefined;
          if (baselineTime && (hasSequentialBaseline || threads > 1)) {
            speedup = baselineTime / time;
            improvement = ((baselineTime - time) / baselineTime) * 100;
            // Speedup CI: baseline_upper/current_lower gives upper bound, baseline_lower/current_upper gives lower bound
            if (baselineCi95 && ci95Upper > 0 && ci95Lower > 0) {
              speedupCI = [baselineCi95[0] / ci95Upper, baselineCi95[1] / ci95Lower];
            }
          }

          speedups.push({ threads, speedup, improvement, speedupCI });

          if (QUIET) {
            // Compact, grep-able one line per measurement. Columns:
            // pattern  size  size_value  threads  mean_ms  stddev_ms  speedup
            const speedupCol = (!hasSequentialBaseline && threads === 1) ? "baseline" : `${speedup.toFixed(2)}x`;
            console.log(
              `${config.pattern}\t${sizeConfig.name}\t${sizeConfig.size}\t${threads}\t${mean.toFixed(2)}\t${stddev.toFixed(2)}\t${speedupCol}`
            );
          } else {
            const icon = speedup >= 2 ? "🚀" : speedup >= 1.5 ? "⚡" : speedup >= 1 ? "✓" : "⚠️";
            const threadsStr = `${threads}`.padEnd(3);
            const timeStr = `${mean.toFixed(2)} ± ${stddev.toFixed(2)}ms (median: ${median.toFixed(2)}ms)`.padEnd(42);
            const noBaseline = !hasSequentialBaseline && threads === 1;
            const speedupStr = noBaseline ? "baseline".padEnd(12) : `${speedup.toFixed(2)}x`.padEnd(12);
            const improvementStr = noBaseline ? "-" : `${improvement.toFixed(1)}%`;

            console.log(`  ${icon} ${threadsStr} threads: ${timeStr} ${speedupStr} ${improvementStr}`);
          }
        } catch (error: any) {
          console.log(`  ❌ ${threads} threads: Failed - ${error.message}`);
        }
      }

      // Inline correctness check: compare the 1-thread result against the
      // highest thread-count result for this size. If verifyFn throws, abort
      // the whole run so potentially-wrong numbers never reach the report.
      if (config.verifyFn && outputsByThreads.size >= 2) {
        const threadsList = [...outputsByThreads.keys()].sort((a, b) => a - b);
        const tLo = threadsList[0];
        const tHi = threadsList[threadsList.length - 1];
        const rLo = outputsByThreads.get(tLo);
        const rHi = outputsByThreads.get(tHi);
        try {
          config.verifyFn(rLo, rHi, sizeConfig.size);
          if (QUIET) {
            console.log(`# verify ${config.pattern} ${sizeConfig.name} ${tLo}vs${tHi}: ok`);
          } else {
            console.log(`  ✅ Correctness: ${tLo}-thread output matches ${tHi}-thread output`);
          }
        } catch (verifyError: any) {
          console.log(`  ❌ Correctness FAILED (${tLo} vs ${tHi} threads): ${verifyError.message}`);
          throw new Error(
            `Correctness verification failed for ${config.pattern} @ ${sizeConfig.name} (${tLo} threads vs ${tHi} threads): ${verifyError.message}`
          );
        }
      }

      summary.results.push({
        size: sizeConfig.name,
        sizeValue: sizeConfig.size,
        description: sizeConfig.description,
        threadResults,
        speedups,
      });
    }

    return summary;
  }

  saveResults(pattern: string) {
    const patternResults = this.results.filter(r => r.pattern === pattern);
    if (patternResults.length === 0) return;

    // Conventional filename: <Pattern>.json. Repeat runs overwrite the
    // previous file so you always know where the latest numbers live.
    const filename = path.join(this.resultsDir, `${pattern}.json`);
    fs.writeFileSync(filename, JSON.stringify(patternResults, null, 2));
    if (!QUIET) console.log(`\n💾 Results saved to: ${filename}`);
  }

  generatePlotData(pattern: string): string {
    const patternResults = this.results.filter(r => r.pattern === pattern);
    if (patternResults.length === 0) return "";

    // Group by size
    const bySize = new Map<string, BenchmarkResult[]>();
    for (const result of patternResults) {
      const key = result.size;
      if (!bySize.has(key)) {
        bySize.set(key, []);
      }
      bySize.get(key)!.push(result);
    }

    // Generate CSV data for plotting
    let csv = "Threads,";
    const sizes = Array.from(bySize.keys());
    csv += sizes.map(s => `${s}_mean,${s}_stddev`).join(",") + "\n";

    // Get all thread counts
    const threadCounts = Array.from(new Set(patternResults.map(r => r.threads))).sort((a, b) => a - b);

    for (const threads of threadCounts) {
      csv += `${threads},`;
      for (const size of sizes) {
        const result = bySize.get(size)!.find(r => r.threads === threads);
        csv += (result ? `${result.time.toFixed(2)},${result.stddev.toFixed(2)}` : ",") + ",";
      }
      csv += "\n";
    }

    const csvFilename = path.join(this.resultsDir, `${pattern}.csv`);
    fs.writeFileSync(csvFilename, csv);
    if (!QUIET) console.log(`📈 Plot data saved to: ${csvFilename}`);

    return csvFilename;
  }

  generateSummaryReport() {
    // One summary.json per test process. Since each test file runs in its own
    // process this only holds that pattern's results; run-all-benchmarks.sh
    // stitches them together downstream. Overwritten on re-run.
    const summaryFilename = path.join(this.resultsDir, `summary.json`);
    // Merge with any existing summary so multiple patterns writing into the
    // same PARAWEB_RESULTS_DIR accumulate rather than clobbering each other.
    let merged: BenchmarkResult[] = [];
    if (fs.existsSync(summaryFilename)) {
      try { merged = JSON.parse(fs.readFileSync(summaryFilename, "utf8")); } catch {}
    }
    const keyOf = (r: BenchmarkResult) => `${r.pattern}|${r.sizeValue}|${r.threads}`;
    const byKey = new Map(merged.map(r => [keyOf(r), r]));
    for (const r of this.results) byKey.set(keyOf(r), r);
    fs.writeFileSync(summaryFilename, JSON.stringify([...byKey.values()], null, 2));
    if (!QUIET) console.log(`\n📋 Summary report saved to: ${summaryFilename}`);
  }
}

export { BenchmarkRunner, BenchmarkConfig, BenchmarkResult, BenchmarkSummary };
