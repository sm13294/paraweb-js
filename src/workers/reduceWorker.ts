const { parentPort } = require("node:worker_threads");

interface FunctionMessage {
  fn: string;
  mapFnStr?: string | null;
  inputData: Array<any>;
  identityElement?: number;
}

export type Message = FunctionMessage | string;

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

// Listen for messages from the main thread
parentPort.on("message", (message: Message) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
  } else if ("fn" in message && "inputData" in message) {
    try {
      const { fn, mapFnStr, inputData, identityElement = 0 } = message as FunctionMessage;

      // Handle empty chunks
      if (!inputData || inputData.length === 0) {
        parentPort.postMessage(identityElement);
        return;
      }

      const reduceFn = deserializeFn(fn);
      const mapFn = mapFnStr ? deserializeMapFn(mapFnStr) : null;

      let result = identityElement as any;
      if (mapFn) {
        for (let i = 0; i < inputData.length; i++) {
          result = reduceFn(result, mapFn(inputData[i]));
        }
      } else {
        for (let i = 0; i < inputData.length; i++) {
          result = reduceFn(result, inputData[i]);
        }
      }

      parentPort.postMessage(result);
    } catch (error) {
      console.error("Error in worker:", error);
      parentPort.postMessage("error");
    }
  }
});
