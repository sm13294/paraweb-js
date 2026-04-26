const { parentPort } = require("node:worker_threads");

interface ScanMessage {
  fn: string;
  mapFnStr?: string | null;
  chunk: number[];
  identity: number;
  offset: number | null;
}

let cachedFn: Function | null = null;
let cachedFnStr: string = "";
let cachedMapFn: ((x: number) => number) | null = null;
let cachedMapFnStr: string = "";

function deserializeFn(fnStr: string): Function {
  if (fnStr !== cachedFnStr) {
    cachedFnStr = fnStr;
    cachedFn = new Function("acc", "curr", `return (${fnStr})(acc, curr)`);
  }
  return cachedFn!;
}

function deserializeMapFn(fnStr: string): (x: number) => number {
  if (fnStr !== cachedMapFnStr) {
    cachedMapFnStr = fnStr;
    cachedMapFn = new Function("return " + fnStr)() as (x: number) => number;
  }
  return cachedMapFn!;
}

parentPort.on("message", (message: ScanMessage | string) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
    return;
  }

  try {
    const { fn, mapFnStr, chunk, identity, offset } = message;
    const scanFn = deserializeFn(fn);
    const mapFn = mapFnStr ? deserializeMapFn(mapFnStr) : null;

    if (offset === null) {
      // Phase 1: optional per-element transform followed by local inclusive scan.
      // Returns { scanned: number[], total: number }.
      const n = chunk.length;
      const scanned = new Array<number>(n);
      let acc = identity;
      if (mapFn) {
        for (let i = 0; i < n; i++) {
          acc = scanFn(acc, mapFn(chunk[i]));
          scanned[i] = acc;
        }
      } else {
        for (let i = 0; i < n; i++) {
          acc = scanFn(acc, chunk[i]);
          scanned[i] = acc;
        }
      }
      parentPort.postMessage({ scanned, total: acc });
    } else {
      // Phase 2: add offset to every element of chunk.
      const n = chunk.length;
      const out = new Array<number>(n);
      for (let i = 0; i < n; i++) {
        out[i] = scanFn(offset, chunk[i]);
      }
      parentPort.postMessage({ scanned: out });
    }
  } catch (error) {
    console.error("Error in scan worker:", error);
    parentPort.postMessage("error");
  }
});

export {};
