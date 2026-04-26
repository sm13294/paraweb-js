const { parentPort } = require("node:worker_threads");

interface IterateMessage {
  opFn: string;
  untilFn: string;
  inputBuffer: SharedArrayBuffer;
  outputBuffer: SharedArrayBuffer;
  start: number;
  end: number;
  maxIterations: number;
}

let cachedOpStr = "";
let cachedOp: Function | null = null;
let cachedUntilStr = "";
let cachedUntil: Function | null = null;

function deserialize(fnStr: string, sig: string, cache: { str: string; fn: Function | null }): Function {
  if (fnStr !== cache.str) {
    cache.str = fnStr;
    cache.fn = new Function(...sig.split(","), `return (${fnStr})(${sig})`);
  }
  return cache.fn!;
}

parentPort.on("message", (message: IterateMessage | string) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
    return;
  }

  try {
    const { opFn, untilFn, inputBuffer, outputBuffer, start, end, maxIterations } = message;
    const input = new Float64Array(inputBuffer);
    const output = new Float64Array(outputBuffer);

    if (opFn !== cachedOpStr) {
      cachedOpStr = opFn;
      cachedOp = new Function("x", `return (${opFn})(x)`);
    }
    if (untilFn !== cachedUntilStr) {
      cachedUntilStr = untilFn;
      cachedUntil = new Function("x", `return (${untilFn})(x)`);
    }
    const op = cachedOp!;
    const until = cachedUntil!;

    for (let i = start; i < end; i++) {
      let v = input[i];
      let iter = 0;
      while (!until(v) && iter < maxIterations) {
        v = op(v);
        iter++;
      }
      output[i] = v;
    }
    parentPort.postMessage("done");
  } catch (error) {
    console.error("Error in iterate worker:", error);
    parentPort.postMessage("error");
  }
});

export {};
