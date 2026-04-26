const { parentPort } = require("node:worker_threads");

interface ScatterSharedMessage {
  inputBuffer: SharedArrayBuffer;
  indexBuffer: SharedArrayBuffer;
  outputBuffer: SharedArrayBuffer;
  lastIndexBuffer: SharedArrayBuffer;
  start: number;
  end: number;
  mapFnStr?: string;
}

export type Message = ScatterSharedMessage | string;

let cachedMapFn: Function | null = null;
let cachedMapFnStr: string = "";

function deserializeMapFn(fnStr: string): Function {
  if (fnStr !== cachedMapFnStr) {
    cachedMapFnStr = fnStr;
    cachedMapFn = new Function("value", `return (${fnStr})(value)`);
  }
  return cachedMapFn!;
}

parentPort.on("message", (message: Message) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
  } else if ("inputBuffer" in message && "indexBuffer" in message) {
    try {
      const { inputBuffer, indexBuffer, outputBuffer, lastIndexBuffer, start, end, mapFnStr } =
        message as ScatterSharedMessage;
      const inputView = new Float64Array(inputBuffer);
      const indexView = new Int32Array(indexBuffer);
      const outputView = new Float64Array(outputBuffer);
      const lastIndexView = new Int32Array(lastIndexBuffer);
      const mapFn = mapFnStr ? deserializeMapFn(mapFnStr) : null;

      for (let i = start; i < end; i++) {
        const outIndex = indexView[i];
        if (outIndex < 0) continue;

        const v = mapFn ? mapFn(inputView[i]) : inputView[i];
        while (true) {
          const current = Atomics.load(lastIndexView, outIndex);
          if (i <= current) break;
          const prev = Atomics.compareExchange(lastIndexView, outIndex, current, i);
          if (prev === current) {
            outputView[outIndex] = v;
            break;
          }
        }
      }

      parentPort.postMessage("done");
    } catch (error) {
      console.error("Error in worker:", error);
      parentPort.postMessage("error");
    }
  }
});
