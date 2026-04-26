const { parentPort } = require("node:worker_threads");

interface EdgeOptions {
  type: "zero" | "padding" | "custom";
  value?: any;
  customFn?: Function;
}

interface StencilSharedMessage {
  fn: string;
  inputBuffer: SharedArrayBuffer;
  outputBuffer: SharedArrayBuffer;
  stencil: Array<any>;
  edgeOption?: EdgeOptions;
  start: number;
  end: number;
  length: number;
}

export type Message = StencilSharedMessage | string;

let cachedFn: Function | null = null;
let cachedFnStr: string = "";

function deserializeFn(fnStr: string): Function {
  if (fnStr !== cachedFnStr) {
    cachedFnStr = fnStr;
    cachedFn = new Function("return " + fnStr)();
  }
  return cachedFn!;
}

function makeStencilOdd(stencil: Array<any>): Array<any> {
  if (stencil.length % 2 !== 0) {
    return stencil;
  }
  const midpoint = Math.floor(stencil.length / 2);
  return [
    ...stencil.slice(0, midpoint),
    null,
    ...stencil.slice(midpoint),
  ];
}

function edgeValue(edgeOption?: EdgeOptions) {
  if (!edgeOption) {
    return null;
  }
  switch (edgeOption.type) {
    case "zero":
      return 0;
    case "padding":
      return edgeOption.value;
    case "custom":
      return edgeOption.customFn ? edgeOption.customFn() : null;
    default:
      return null;
  }
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
        inputBuffer,
        outputBuffer,
        stencil,
        edgeOption,
        start,
        end,
        length,
      } = message as StencilSharedMessage;

      const stencilFn = deserializeFn(fn);
      const inputView = new Float64Array(inputBuffer);
      const outputView = new Float64Array(outputBuffer);
      const stencilOdd = makeStencilOdd(stencil);
      const stencilSize = stencilOdd.length;
      const stencilHalf = Math.floor(stencilSize / 2);

      // Cache edge value before the loop since it's constant for a given message
      const cachedEdgeValue = edgeValue(edgeOption);

      for (let i = start; i < end; i++) {
        const neighbors = [];
        for (let offset = -stencilHalf; offset <= stencilHalf; offset++) {
          const idx = i + offset;
          if (idx < 0 || idx >= length) {
            neighbors.push(cachedEdgeValue);
          } else {
            neighbors.push(inputView[idx]);
          }
        }
        outputView[i] = stencilFn(inputView[i], neighbors, stencilOdd);
      }

      parentPort.postMessage("done");
    } catch (error) {
      console.error("Error in worker:", error);
      parentPort.postMessage("error");
    }
  }
});
