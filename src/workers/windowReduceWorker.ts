const { parentPort } = require("node:worker_threads");

interface WindowReduceMessage {
  fn: string;
  inputBuffer: SharedArrayBuffer;
  outputBuffer: SharedArrayBuffer;
  windowStart: number;
  windowEnd: number;
  size: number;
  step: number;
  identity: number;
}

let cachedFn: Function | null = null;
let cachedFnStr: string = "";

function deserializeFn(fnStr: string): Function {
  if (fnStr !== cachedFnStr) {
    cachedFnStr = fnStr;
    cachedFn = new Function("acc", "curr", `return (${fnStr})(acc, curr)`);
  }
  return cachedFn!;
}

parentPort.on("message", (message: WindowReduceMessage | string) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
    return;
  }

  try {
    const { fn, inputBuffer, outputBuffer, windowStart, windowEnd, size, step, identity } = message;
    const input = new Float64Array(inputBuffer);
    const output = new Float64Array(outputBuffer);
    const op = deserializeFn(fn);

    for (let w = windowStart; w < windowEnd; w++) {
      const base = w * step;
      let acc = identity;
      for (let i = 0; i < size; i++) {
        acc = op(acc, input[base + i]);
      }
      output[w] = acc;
    }
    parentPort.postMessage("done");
  } catch (error) {
    console.error("Error in windowReduce worker:", error);
    parentPort.postMessage("error");
  }
});

export {};
