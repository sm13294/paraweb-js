const { parentPort } = require("node:worker_threads");

interface ScanSharedPhase1 {
  phase: 1;
  fn: string;
  mapFnStr?: string | null;
  inputBuffer: SharedArrayBuffer;
  outputBuffer: SharedArrayBuffer;
  totalsBuffer: SharedArrayBuffer;
  start: number;
  end: number;
  workerId: number;
  identity: number;
}

interface ScanSharedPhase2 {
  phase: 2;
  fn: string;
  outputBuffer: SharedArrayBuffer;
  start: number;
  end: number;
  offset: number;
}

type Msg = ScanSharedPhase1 | ScanSharedPhase2 | string;

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

parentPort.on("message", (message: Msg) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
    return;
  }

  try {
    const scanFn = deserializeFn(message.fn);

    if (message.phase === 1) {
      const input = new Float64Array(message.inputBuffer);
      const output = new Float64Array(message.outputBuffer);
      const totals = new Float64Array(message.totalsBuffer);
      const { start, end, workerId, identity, mapFnStr } = message;
      const mapFn = mapFnStr ? deserializeMapFn(mapFnStr) : null;

      if (start >= end) {
        totals[workerId] = identity;
        parentPort.postMessage("done");
        return;
      }

      let acc = identity;
      if (mapFn) {
        for (let i = start; i < end; i++) {
          acc = scanFn(acc, mapFn(input[i]));
          output[i] = acc;
        }
      } else {
        for (let i = start; i < end; i++) {
          acc = scanFn(acc, input[i]);
          output[i] = acc;
        }
      }
      totals[workerId] = acc;
      parentPort.postMessage("done");
    } else {
      const output = new Float64Array(message.outputBuffer);
      const { start, end, offset } = message;

      for (let i = start; i < end; i++) {
        output[i] = scanFn(offset, output[i]);
      }
      parentPort.postMessage("done");
    }
  } catch (error) {
    console.error("Error in scan shared worker:", error);
    parentPort.postMessage("error");
  }
});

export {};
