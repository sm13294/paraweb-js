/**
 * Minimal HTTP server that serves the browser-bench/ directory with
 * cross-origin isolation headers (COOP + COEP) so that SharedArrayBuffer
 * is available in the browser. This is required for the Shared variants.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
};

http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(ROOT, safePath === "/" ? "index.html" : safePath);

  fs.readFile(filePath, (err, data) => {
    const cori = {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    };
    if (err) {
      res.writeHead(404, { ...cori, "Content-Type": "text/plain" });
      res.end("Not Found: " + filePath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { ...cori, "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}).on("error", (err) => {
  // If the port is already in use, assume a previous server is still serving
  // the same tree (typical after a benchmark crash). Exit cleanly so the
  // parent driver reuses the existing server instead of aborting the run.
  if (err.code === "EADDRINUSE") {
    console.log(`port ${PORT} already bound; reusing existing server`);
    process.exit(0);
  }
  throw err;
}).listen(PORT, () => {
  console.log(`serving ${ROOT} at http://localhost:${PORT} (COOP/COEP enabled)`);
});
