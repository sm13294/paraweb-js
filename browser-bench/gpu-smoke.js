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
    await waitServer("http://localhost:8787/browser-bench/gpu.html");
    const b = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--use-angle=metal",
      ],
    });
    const p = await b.newPage();
    p.on("console", m => console.log("[pg]", m.text()));
    p.on("pageerror", e => console.error("[err]", e.message));
    await p.goto("http://localhost:8787/browser-bench/gpu.html", { waitUntil: "domcontentloaded" });
    await p.waitForFunction("typeof window.checkGPU === 'function'", { timeout: 10000 });

    const status = await p.evaluate(() => window.checkGPU());
    console.log("GPU status:", JSON.stringify(status, null, 2));

    if (status.available) {
      console.log("\nWebGPU IS available in headless Chromium — running small Map test...");
      const res = await p.evaluate(() => window.runGPUBench({ patterns: ["Map"], size: 100000, runs: 2, warmup: 1 }));
      console.log("Test result:", JSON.stringify(res));
    }

    await b.close();
  } finally {
    server.kill();
  }
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
