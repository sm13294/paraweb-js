/**
 * Puppeteer driver: launches Chrome, navigates to the benchmark page served
 * over COOP/COEP-enabled HTTP, invokes window.runBench, collects results,
 * and writes them to stdout + a JSON file.
 */
const puppeteer = require("puppeteer");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 8787;

function waitFor(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForServer(url, maxTries = 30) {
  for (let i = 0; i < maxTries; i++) {
    try {
      const http = require("http");
      await new Promise((resolve, reject) => {
        const req = http.get(url, res => { res.destroy(); resolve(); });
        req.on("error", reject);
        req.setTimeout(500, () => { req.destroy(); reject(new Error("timeout")); });
      });
      return true;
    } catch {}
    await waitFor(200);
  }
  throw new Error("server did not start");
}

async function main() {
  // 1) Start server
  const serverPath = path.join(__dirname, "server.js");
  const server = spawn("node", [serverPath], { stdio: ["ignore", "inherit", "inherit"] });
  server.on("exit", (code) => { console.error("server exited with code", code); });

  try {
    await waitForServer(`http://localhost:${PORT}/browser-bench/index.html`);
  } catch (e) {
    console.error("server failed to start:", e.message);
    server.kill();
    process.exit(1);
  }

  // 2) Launch Chrome
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--enable-features=SharedArrayBuffer",
      "--disable-web-security",
      "--no-sandbox",
    ],
  });
  const page = await browser.newPage();
  page.on("console", (msg) => console.error("[page]", msg.text()));
  page.on("pageerror", (err) => console.error("[pageerror]", err.message));

  await page.goto(`http://localhost:${PORT}/browser-bench/index.html`, { waitUntil: "domcontentloaded" });
  // Wait a moment for the module script to initialize.
  await page.waitForFunction("typeof window.runBench === 'function'", { timeout: 10000 });

  // Confirm SharedArrayBuffer is actually available
  const sabOK = await page.evaluate(() => typeof SharedArrayBuffer !== "undefined");
  console.error("SharedArrayBuffer available:", sabOK);

  // 3) Run benchmarks
  const config = {
    patterns: ["Map","Filter","Reduce","Scatter","Stencil","Farm","Pipeline","DivideAndConquer","MapReduce"],
    variants: ["mp","shared"],
    sizes: [10000000],
    threads: [1,2,4,8,16],
    runs: 3,
    warmup: 1,
  };

  const navCores = await page.evaluate(() => navigator.hardwareConcurrency);
  console.error("navigator.hardwareConcurrency =", navCores);

  console.error("starting benchmark run...");
  const t0 = Date.now();
  const results = await page.evaluate(async (cfg) => {
    return await window.runBench(cfg);
  }, config);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`finished in ${dt}s (${results.length} rows)`);

  // 4) Save & print
  const outPath = path.join(__dirname, "results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.error("wrote", outPath);

  // Speedup table
  const byKey = {};
  for (const r of results) byKey[`${r.pattern}|${r.variant}|${r.size}|${r.threads}`] = r.time;
  const patterns = [...new Set(results.map(r => r.pattern))];
  const threadList = [...new Set(results.map(r => r.threads))].sort((a,b) => a - b);
  console.log("\n=== Speedups relative to 1 thread ===");
  console.log("pattern           variant    " + threadList.map(t => `${t}T`.padStart(8)).join(""));
  for (const p of patterns) {
    for (const v of ["mp","shared"]) {
      const base = byKey[`${p}|${v}|${config.sizes[0]}|1`];
      const row = threadList.map(t => {
        const time = byKey[`${p}|${v}|${config.sizes[0]}|${t}`];
        return time ? (base / time).toFixed(2).padStart(8) : "    N/A";
      }).join("");
      console.log(`${p.padEnd(18)}${v.padEnd(10)}${row}`);
    }
  }

  await browser.close();
  server.kill();
}

main().catch(e => { console.error(e); process.exit(1); });
