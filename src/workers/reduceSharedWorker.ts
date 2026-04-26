const { parentPort } = require("node:worker_threads");

interface ReduceSharedMessage {
  fn: string;
  mapFnStr?: string | null;
  inputBuffer: SharedArrayBuffer;
  partialsBuffer: SharedArrayBuffer;
  validBuffer: SharedArrayBuffer;
  start: number;
  end: number;
  workerId: number;
  identityElement: number;
}

export type Message = ReduceSharedMessage | string;

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

parentPort.on("message", (message: Message) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
  } else if ("fn" in message && "inputBuffer" in message) {
    try {
      const {
        fn,
        mapFnStr,
        inputBuffer,
        partialsBuffer,
        validBuffer,
        start,
        end,
        workerId,
        identityElement,
      } = message as ReduceSharedMessage;

      const inputView = new Float64Array(inputBuffer);
      const partialsView = new Float64Array(partialsBuffer);
      const validView = new Uint8Array(validBuffer);
      const reduceFn = deserializeFn(fn);
      const mapFn = mapFnStr ? deserializeMapFn(mapFnStr) : null;

      if (start >= end) {
        validView[workerId] = 0;
        parentPort.postMessage("done");
        return;
      }

      let acc = identityElement;
      if (mapFn) {
        for (let i = start; i < end; i++) {
          acc = reduceFn(acc, mapFn(inputView[i]));
        }
      } else {
        for (let i = start; i < end; i++) {
          acc = reduceFn(acc, inputView[i]);
        }
      }

      partialsView[workerId] = acc;
      validView[workerId] = 1;
      parentPort.postMessage("done");
    } catch (error) {
      console.error("Error in worker:", error);
      parentPort.postMessage("error");
    }
  }
});
