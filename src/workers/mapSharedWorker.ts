const { parentPort } = require("node:worker_threads");

interface MapSharedMessage {
  fn: string;
  inputBuffer: SharedArrayBuffer;
  outputBuffer: SharedArrayBuffer;
  start: number;
  end: number;
}

export type Message = MapSharedMessage | string;

let cachedFn: Function | null = null;
let cachedFnStr: string = "";

function deserializeFn(fnStr: string): Function {
  if (fnStr !== cachedFnStr) {
    cachedFnStr = fnStr;
    cachedFn = new Function("value", "index", `return (${fnStr})(value, index)`);
  }
  return cachedFn!;
}

parentPort.on("message", (message: Message) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
  } else if ("fn" in message && "inputBuffer" in message) {
    try {
      const { fn, inputBuffer, outputBuffer, start, end } =
        message as MapSharedMessage;
      const mapFn = deserializeFn(fn);
      const inputView = new Float64Array(inputBuffer);
      const outputView = new Float64Array(outputBuffer);

      for (let i = start; i < end; i++) {
        outputView[i] = mapFn(inputView[i], i);
      }

      parentPort.postMessage("done");
    } catch (error) {
      console.error("Error in worker:", error);
      parentPort.postMessage("error");
    }
  }
});
