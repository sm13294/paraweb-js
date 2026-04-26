const { parentPort } = require("node:worker_threads");

interface ScatterMessage {
  inputData: Array<number>;
  indexData: Array<number>;
  fnStr?: string | null;
}

export type Message = ScatterMessage | string;

let cachedFnStr: string | null = null;
let cachedFn: ((x: number) => number) | null = null;

parentPort.on("message", (message: Message) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
  } else if ("inputData" in message && "indexData" in message) {
    try {
      const { inputData, indexData, fnStr } = message as ScatterMessage;
      if (fnStr && fnStr !== cachedFnStr) {
        cachedFn = new Function("return " + fnStr)() as (x: number) => number;
        cachedFnStr = fnStr;
      }
      const fn = fnStr ? cachedFn! : null;
      const result = fn
        ? inputData.map((value, i) => [indexData[i], fn(value)])
        : inputData.map((value, i) => [indexData[i], value]);
      parentPort.postMessage(result);
    } catch (error) {
      console.error("Error in worker:", error);
      parentPort.postMessage("error");
    }
  }
});
