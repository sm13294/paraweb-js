// Browser GPU benchmark driver. Same hardening as full.js: progress logging
// at each phase, a 60s timeout on puppeteer.launch(), and Linux-friendly
// launch args. Platform-specific ANGLE/WebGPU flags are chosen by uname.
const puppeteer = require("puppeteer");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const LAUNCH_TIMEOUT_MS = 60_000;

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

async function launchChromium() {
  const base = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
  ];
  // ANGLE backend: Metal on macOS, Vulkan elsewhere (Linux/Windows via NVIDIA/AMD).
  const args = os.platform() === "darwin"
    ? [...base, "--use-angle=metal"]
    : [...base, "--use-angle=vulkan"];
  const launch = puppeteer.launch({
    headless: "new",
    args,
    protocolTimeout: 3_600_000,
    dumpio: true,
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`puppeteer.launch() did not return after ${LAUNCH_TIMEOUT_MS}ms`)), LAUNCH_TIMEOUT_MS)
  );
  return Promise.race([launch, timeout]);
}

(async () => {
  console.log("step: starting local HTTP server on :8787");
  const server = spawn("node", [path.join(__dirname, "server.js")], { stdio: ["ignore", "inherit", "inherit"] });
  try {
    await waitServer("http://localhost:8787/browser-bench/gpu.html");
    console.log("step: server responsive; launching headless Chromium with WebGPU");
    const b = await launchChromium();
    console.log("step: Chromium launched; opening page");
    const p = await b.newPage();
    p.on("console", m => console.log("[pg]", m.text()));
    p.on("pageerror", e => console.error("[err]", e.message));
    p.setDefaultTimeout(3_600_000);
    await p.goto("http://localhost:8787/browser-bench/gpu.html", { waitUntil: "domcontentloaded" });
    await p.waitForFunction("typeof window.runGPUBench === 'function'", { timeout: 10_000 });
    console.log("step: page ready; querying GPU adapter");

    const status = await p.evaluate(() => window.checkGPU());
    console.log("GPU status:", JSON.stringify(status));
    if (!status.available) { throw new Error("WebGPU not available: " + (status.reason || "unknown")); }

    const t0 = Date.now();
    const results = await p.evaluate(async () => {
      return await window.runGPUBench({
        patterns: ["Map","Filter","Reduce","Scan","MapReduce","Scatter","Stencil","Farm","Pipeline","DivideAndConquer"],
        size: 10000000,
        runs: 3,
        warmup: 1,
      });
    });
    console.log(`done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
    const outPath = path.join(__dirname, "gpu-results-full.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log("saved to", outPath);

    console.log("\n=== Browser GPU results @ 10M elements ===");
    console.log("pattern             time (ms)");
    for (const r of results) {
      if (r.error) console.log(`${r.pattern.padEnd(20)} ERROR: ${r.error}`);
      else console.log(`${r.pattern.padEnd(20)}${r.time.toFixed(2).padStart(10)}`);
    }
    await b.close();
  } finally {
    server.kill();
  }
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
