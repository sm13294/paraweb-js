const puppeteer = require("puppeteer");
const { spawn } = require("child_process");
const path = require("path");

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
  throw new Error("server no start");
}

(async () => {
  const server = spawn("node", [path.join(__dirname, "server.js")], { stdio: ["ignore", "inherit", "inherit"] });
  try {
    await waitServer("http://localhost:8787/browser-bench/index.html");
    const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const p = await b.newPage();
    p.on("pageerror", e => console.error("[err]", e.message));
    await p.goto("http://localhost:8787/browser-bench/index.html", { waitUntil: "domcontentloaded" });
    await p.waitForFunction("typeof window.runBench === 'function'", { timeout: 10000 });
    
    console.log("validation run: 3 patterns, 2 variants, size 1M, 4 thread counts...");
    const t0 = Date.now();
    const results = await p.evaluate(async () => {
      return await window.runBench({
        patterns: ["Map","Reduce","MapReduce"],
        variants: ["mp","shared"],
        sizes: [1000000],
        threads: [1, 2, 8, 16],
        runs: 2,
        warmup: 1,
      });
    });
    console.log(`done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
    
    // Speedup table
    const byKey = {};
    for (const r of results) byKey[`${r.pattern}|${r.variant}|${r.threads}`] = r.time;
    console.log("\npattern           variant   1T time  2x   8x    16x");
    for (const pat of ["Map","Reduce","MapReduce"]) {
      for (const v of ["mp","shared"]) {
        const base = byKey[`${pat}|${v}|1`];
        const s2 = (base / byKey[`${pat}|${v}|2`]).toFixed(2);
        const s8 = (base / byKey[`${pat}|${v}|8`]).toFixed(2);
        const s16 = (base / byKey[`${pat}|${v}|16`]).toFixed(2);
        console.log(`${pat.padEnd(18)}${v.padEnd(10)}${base.toFixed(0).padStart(7)}ms  ${s2}x ${s8}x ${s16}x`);
      }
    }
    await b.close();
  } finally {
    server.kill();
  }
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
