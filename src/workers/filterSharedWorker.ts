const { parentPort } = require("node:worker_threads");

interface FilterSharedMessage {
  phase: "count" | "write";
  fn: string;
  inputBuffer: SharedArrayBuffer;
  flagsBuffer: SharedArrayBuffer;
  countsBuffer?: SharedArrayBuffer;
  outputBuffer?: SharedArrayBuffer;
  start: number;
  end: number;
  workerId?: number;
  offset?: number;
}

export type Message = FilterSharedMessage | string;

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
  } else if ("phase" in message && "inputBuffer" in message) {
    try {
      const {
        phase,
        fn,
        inputBuffer,
        flagsBuffer,
        countsBuffer,
        outputBuffer,
        start,
        end,
        workerId,
        offset,
      } = message as FilterSharedMessage;

      const inputView = new Float64Array(inputBuffer);
      const flagsView = new Uint8Array(flagsBuffer);
      const predicate = deserializeFn(fn);

      if (phase === "count") {
        const countsView = new Int32Array(countsBuffer!);
        let count = 0;
        for (let i = start; i < end; i++) {
          const keep = !!predicate(inputView[i], i);
          flagsView[i] = keep ? 1 : 0;
          if (keep) count++;
        }
        countsView[workerId!] = count;
        parentPort.postMessage("done");
      } else if (phase === "write") {
        const outputView = new Float64Array(outputBuffer!);
        let writeIndex = offset!;
        for (let i = start; i < end; i++) {
          if (flagsView[i] === 1) {
            outputView[writeIndex++] = inputView[i];
          }
        }
        parentPort.postMessage("done");
      }
    } catch (error) {
      console.error("Error in worker:", error);
      parentPort.postMessage("error");
    }
  }
});
