const { performance } = require("perf_hooks");
const assert = require("assert");

interface FunctionalTestResult {
  name: string;
  passed: boolean;
  error?: string;
  time?: number;
}

interface PerformanceResult {
  size: number;
  threads1: number;
  threads8: number;
  speedup: number;
  improvement: number;
}

class PatternTestRunner {
  private patternName: string;
  private functionalResults: FunctionalTestResult[] = [];
  private performanceResults: PerformanceResult[] = [];

  constructor(patternName: string) {
    this.patternName = patternName;
  }

  async runFunctionalTest(
    name: string,
    testFn: () => Promise<void>,
    includeTime: boolean = true
  ) {
    try {
      const startTime = performance.now();
      await testFn();
      const time = includeTime ? performance.now() - startTime : undefined;
      this.functionalResults.push({ name, passed: true, time });
    } catch (error: any) {
      this.functionalResults.push({ name, passed: false, error: error.message });
    }
  }

  async runPerformanceBenchmark(
    name: string,
    sizes: number[],
    testFn: (size: number, threads: number) => Promise<any>,
    verifyFn?: (result1: any, result8: any, size: number) => void
  ) {
    console.log(`\n${name}:`);
    console.log("Size".padEnd(15) + "1 Thread".padEnd(12) + "8 Threads".padEnd(12) + "Speedup".padEnd(10) + "Improvement");
    console.log("─".repeat(60));

    for (const size of sizes) {
      try {
        const start1 = performance.now();
        const result1 = await testFn(size, 1);
        const time1 = performance.now() - start1;

        const start8 = performance.now();
        const result8 = await testFn(size, 8);
        const time8 = performance.now() - start8;

        if (verifyFn) {
          verifyFn(result1, result8, size);
        } else {
          assert.deepStrictEqual(result1, result8, `Results should be identical for size ${size}`);
        }

        const speedup = time1 / time8;
        const improvement = ((time1 - time8) / time1) * 100;

        this.performanceResults.push({ size, threads1: time1, threads8: time8, speedup, improvement });

        const sizeStr = size.toLocaleString().padEnd(15);
        const time1Str = `${time1.toFixed(2)}ms`.padEnd(12);
        const time8Str = `${time8.toFixed(2)}ms`.padEnd(12);
        const speedupStr = `${speedup.toFixed(2)}x`.padEnd(10);
        const improvementStr = `${improvement.toFixed(1)}%`;
        const icon = speedup >= 2 ? "🚀" : speedup >= 1.5 ? "⚡" : speedup >= 1 ? "✓" : "⚠️";

        console.log(`${icon} ${sizeStr}${time1Str}${time8Str}${speedupStr}${improvementStr}`);
      } catch (error: any) {
        console.log(`  ❌ Failed for size ${size}: ${error.message}`);
      }
    }
    console.log();
  }

  printFunctionalReport() {
    console.log("\n" + "=".repeat(80));
    console.log(`${this.patternName.toUpperCase()} PATTERN - FUNCTIONAL TESTS`);
    console.log("=".repeat(80) + "\n");

    let passed = 0;
    let failed = 0;

    for (const result of this.functionalResults) {
      const status = result.passed ? "✅ PASS" : "❌ FAIL";
      const timeStr = result.time !== undefined ? ` (${result.time.toFixed(2)}ms)` : "";
      console.log(`  ${status} ${result.name}${timeStr}`);
      if (!result.passed && result.error) {
        console.log(`     Error: ${result.error}`);
      }
      if (result.passed) passed++;
      else failed++;
    }

    const passRate = this.functionalResults.length > 0
      ? ((passed / this.functionalResults.length) * 100).toFixed(1)
      : "0.0";

    console.log(`\nSummary: ${passed}/${this.functionalResults.length} passed (${passRate}%)\n`);
    return { passed, failed, total: this.functionalResults.length };
  }

  printPerformanceReport() {
    console.log("=".repeat(80));
    console.log(`${this.patternName.toUpperCase()} PATTERN - PERFORMANCE BENCHMARKS`);
    console.log("=".repeat(80) + "\n");

    if (this.performanceResults.length === 0) {
      console.log("  No performance benchmarks run.\n");
      return [];
    }

    console.log("Size".padEnd(15) + "1 Thread".padEnd(12) + "8 Threads".padEnd(12) + "Speedup".padEnd(10) + "Improvement");
    console.log("─".repeat(60));

    for (const perf of this.performanceResults) {
      const sizeStr = perf.size.toLocaleString().padEnd(15);
      const time1Str = `${perf.threads1.toFixed(2)}ms`.padEnd(12);
      const time8Str = `${perf.threads8.toFixed(2)}ms`.padEnd(12);
      const speedupStr = `${perf.speedup.toFixed(2)}x`.padEnd(10);
      const improvementStr = `${perf.improvement.toFixed(1)}%`;
      const icon = perf.speedup >= 2 ? "🚀" : perf.speedup >= 1.5 ? "⚡" : perf.speedup >= 1 ? "✓" : "⚠️";

      console.log(`${icon} ${sizeStr}${time1Str}${time8Str}${speedupStr}${improvementStr}`);
    }

    console.log();
    return this.performanceResults;
  }

  printSummary() {
    const functional = this.printFunctionalReport();
    const performance = this.printPerformanceReport();

    console.log("=".repeat(80));
    console.log(`${this.patternName.toUpperCase()} PATTERN - TEST SUMMARY`);
    console.log("=".repeat(80));
    console.log(`Functional Tests: ${functional.passed}/${functional.total} passed`);
    console.log(`Performance Benchmarks: ${performance.length} completed`);
    console.log("=".repeat(80) + "\n");

    return { functional, performance };
  }
}

/**
 * Approximate-equality helper for benchmark correctness checks on reduction-style
 * patterns. Sequential and parallel f64 reductions combine partial sums in
 * different orders and therefore produce results that are numerically close but
 * not bit-identical; strict equality is the wrong bar. Tolerance is
 * `max(absTol, relTol * max(|a|, |b|))`, with defaults chosen so that
 * 10-million-element sums comfortably pass.
 */
function approxEqual(a: number, b: number, relTol: number = 1e-6, absTol: number = 1e-6): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return diff <= Math.max(absTol, relTol * scale);
}

function verifyApproxEqual(a: any, b: any, size: number, label: string = "result"): void {
  if (typeof a === "number" && typeof b === "number") {
    if (!approxEqual(a, b)) {
      throw new Error(`${label} mismatch at size ${size}: ${a} vs ${b}`);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      throw new Error(`${label} length mismatch at size ${size}: ${a.length} vs ${b.length}`);
    }
    for (let i = 0; i < a.length; i++) {
      if (!approxEqual(a[i], b[i])) {
        throw new Error(`${label} mismatch at size ${size}, index ${i}: ${a[i]} vs ${b[i]}`);
      }
    }
    return;
  }
  // Fallback: bit-exact comparison for unknown types.
  if (a !== b) {
    throw new Error(`${label} mismatch at size ${size}: ${a} vs ${b}`);
  }
}

export { PatternTestRunner, FunctionalTestResult, PerformanceResult, approxEqual, verifyApproxEqual };

