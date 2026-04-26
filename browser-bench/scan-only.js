// One-off driver: run only Scan in the browser bench to fill Table 3.
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
  const server = spawn("node", [path.join("/Users/suejbmemeti/dev/ParaWeb/browser-bench", "server.js")], { stdio: ["ignore", "inherit", "inherit"] });
  try {
    await waitServer("http://localhost:8787/browser-bench/index.html");
    const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 3600000 });
    const p = await b.newPage();
    p.on("pageerror", e => console.error("[err]", e.message));
    p.on("console", m => { if (m.type() === "error") console.error("[pg]", m.text()); });
    p.setDefaultTimeout(3600000);
    await p.goto("http://localhost:8787/browser-bench/index.html", { waitUntil: "domcontentloaded" });
    await p.waitForFunction("typeof window.runBench === 'function'", { timeout: 10000 });

    console.log("browser Scan-only bench: MP+Shared, 10M, threads 1..16, 3 runs + 1 warmup");
    const t0 = Date.now();
    const results = await p.evaluate(async () => {
      return await window.runBench({
        patterns: ["Scan"],
        variants: ["mp", "shared"],
        sizes: [10000000],
        threads: [1, 2, 4, 8, 16],
        runs: 3,
        warmup: 1,
      });
    });
    console.log(`done in ${((Date.now()-t0)/1000).toFixed(1)}s (${results.length} rows)`);

    // Speedup summary
    const byKey = {};
    for (const r of results) byKey[`${r.variant}|${r.threads}`] = r.time;
    console.log("\nvariant     1T(ms)    2T    4T    8T   16T");
    for (const v of ["mp", "shared"]) {
      const base = byKey[`${v}|1`];
      const row = [2, 4, 8, 16].map(t => {
        const time = byKey[`${v}|${t}`];
        return time ? (base / time).toFixed(2).padStart(6) : "   N/A";
      }).join("");
      console.log(`${v.padEnd(10)}${base.toFixed(0).padStart(8)}ms${row}`);
    }
    await b.close();
  } finally {
    server.kill();
  }
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
