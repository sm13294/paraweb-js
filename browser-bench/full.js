// Browser CPU benchmark driver. Spawns a local HTTP server, launches headless
// Chromium via Puppeteer, runs the 10-pattern × 2-variant × 5-thread sweep at
// 10M elements, and prints a per-pattern speedup summary.
//
// Troubleshooting:
//   * Hangs right after "serving ..." → puppeteer.launch() is stuck. The
//     script now times out after LAUNCH_TIMEOUT_MS and prints what failed.
//   * Missing shared libraries (Linux)   → install with:
//       sudo apt-get install -y libnss3 libatk-bridge2.0-0 libgtk-3-0 \
//           libxss1 libgbm1 libdrm2 libasound2 libxkbcommon0 libxcomposite1 \
//           libxdamage1 libxrandr2 libu2f-udev
//   * Chromium not downloaded      → scripts/install-deps.sh warms it for you.
//   * /dev/shm too small (Docker)  → we already pass --disable-dev-shm-usage.
const puppeteer = require("puppeteer");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const LAUNCH_TIMEOUT_MS = 60_000;
const SMOKE = process.argv.includes("--smoke");

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitServer(url) {
  for (let i = 0; i < 50; i++) {
    try {
      await new Promise((res, rej) => {
        require("http").get(url, r => { r.destroy(); res(); }).on("error", rej);
      });
      return;
    } catch {}
    await wait(100);
  }
  throw new Error(`server did not start within 5s at ${url}`);
}

// Wrap puppeteer.launch() in a race against a timeout so we never hang.
async function launchChromium() {
  const launchArgs = [
    "--no-sandbox",
    // Many container and CI environments give /dev/shm only 64 MB, which is
    // not enough for Chromium's default shared-memory arena.
    "--disable-dev-shm-usage",
    // The CPU benchmark does not use WebGPU, so hard-disable it to avoid
    // surprise "can't find adapter" warnings in the logs.
    "--disable-gpu",
  ];
  const launchPromise = puppeteer.launch({
    headless: "new",
    args: launchArgs,
    protocolTimeout: 3_600_000,
    dumpio: true, // forward Chromium stderr to our stderr — surfaces crash reasons
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`puppeteer.launch() did not return after ${LAUNCH_TIMEOUT_MS}ms`)), LAUNCH_TIMEOUT_MS)
  );
  return Promise.race([launchPromise, timeout]);
}

(async () => {
  console.log("step: starting local HTTP server on :8787");
  const server = spawn("node", [path.join(__dirname, "server.js")], { stdio: ["ignore", "inherit", "inherit"] });
  try {
    await waitServer("http://localhost:8787/browser-bench/index.html");
    console.log("step: server responsive; launching headless Chromium (timeout 60s)");

    const b = await launchChromium();
    console.log("step: Chromium launched; opening page");

    const p = await b.newPage();
    p.on("pageerror", e => console.error("[pageerror]", e.message));
    p.on("console", m => { if (m.type() === "error") console.error("[pg error]", m.text()); });
    p.setDefaultTimeout(3_600_000);
    await p.goto("http://localhost:8787/browser-bench/index.html", { waitUntil: "domcontentloaded" });
    await p.waitForFunction("typeof window.runBench === 'function'", { timeout: 10_000 });
    console.log("step: page ready; starting benchmark sweep");

    const cfg = SMOKE
      ? { size: 100000, threadList: [1, 16], runs: 1, warmup: 1, label: "SMOKE" }
      : { size: 10000000, threadList: [1, 2, 4, 8, 16], runs: 3, warmup: 1, label: "FULL" };
    console.log(`browser benchmark (${cfg.label}): 10 patterns, 3 variants (seq+mp+shared), ${cfg.size} elements, threads ${cfg.threadList.join("/")}, ${cfg.runs} runs + ${cfg.warmup} warmup`);
    const t0 = Date.now();
    const results = await p.evaluate(async (cfg) => {
      const patterns = ["Map","Filter","Reduce","Scan","Scatter","Stencil","Farm","Pipeline","DivideAndConquer","MapReduce"];
      // Sequential: run once per pattern (threads=1 is just a placeholder).
      const seq = await window.runBench({
        patterns, variants: ["seq"], sizes: [cfg.size], threads: [1], runs: cfg.runs, warmup: cfg.warmup,
      });
      // Parallel: full thread sweep for both MP and Shared.
      const par = await window.runBench({
        patterns, variants: ["mp","shared"], sizes: [cfg.size], threads: cfg.threadList, runs: cfg.runs, warmup: cfg.warmup,
      });
      return [...seq, ...par];
    }, cfg);
    console.log(`done in ${((Date.now()-t0)/1000).toFixed(1)}s (${results.length} rows)`);

    const outPath = path.join(__dirname, "results-full.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log("saved to", outPath);

    // Speedup table: parallel times vs plain-JS sequential baseline.
    const byKey = {};
    for (const r of results) byKey[`${r.pattern}|${r.variant}|${r.threads}`] = r.time;
    const patterns = ["Map","Filter","Reduce","Scan","Scatter","Stencil","Farm","Pipeline","DivideAndConquer","MapReduce"];
    console.log("\n=== Speedups vs plain-JS sequential at 10M elements ===");
    console.log("pattern             variant    seq(ms)     1T     2T     4T     8T    16T");
    for (const pat of patterns) {
      const seq = byKey[`${pat}|seq|1`];
      for (const v of ["mp","shared"]) {
        const row = [1,2,4,8,16].map(t => {
          const time = byKey[`${pat}|${v}|${t}`];
          return time && seq ? (seq / time).toFixed(2).padStart(6) : "   N/A";
        }).join("");
        const seqStr = seq ? seq.toFixed(0).padStart(8) : "     N/A";
        console.log(`${pat.padEnd(20)}${v.padEnd(10)}${seqStr}ms${row}`);
      }
    }
    await b.close();
  } finally {
    server.kill();
  }
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
