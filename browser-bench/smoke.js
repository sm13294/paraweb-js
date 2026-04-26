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
  const server = spawn("node", [path.join(__dirname, "server.js")], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitServer("http://localhost:8787/browser-bench/index.html");
    const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const p = await b.newPage();
    p.on("console", m => console.log("[pg]", m.text()));
    p.on("pageerror", e => console.log("[err]", e.message));
    await p.goto("http://localhost:8787/browser-bench/index.html", { waitUntil: "domcontentloaded" });
    await p.waitForFunction("typeof window.runBench === 'function'", { timeout: 10000 });
    const sab = await p.evaluate(() => typeof SharedArrayBuffer !== "undefined");
    console.log("SAB available:", sab);
    const results = await p.evaluate(async () => {
      return await window.runBench({
        patterns: ["Map","Filter"],
        variants: ["mp"],
        sizes: [10000],
        threads: [1, 2, 4],
        runs: 2,
        warmup: 1,
      });
    });
    console.log("RESULTS:", JSON.stringify(results));
    await b.close();
  } finally {
    server.kill();
  }
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
