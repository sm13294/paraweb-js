const { parentPort } = require("node:worker_threads");

interface EdgeOptions {
  type: "zero" | "padding" | "custom";
  value?: any;
  customFn?: Function;
}

interface FunctionMessage {
  fn: string;
  inputData: Array<any>;
  stencil: Array<any>;
  edgeOption: EdgeOptions;
}

export type Message = FunctionMessage | string;

let cachedFn: Function | null = null;
let cachedFnStr: string = "";

function deserializeFn(fnStr: string): Function {
  if (fnStr !== cachedFnStr) {
    cachedFnStr = fnStr;
    cachedFn = new Function("return " + fnStr)();
  }
  return cachedFn!;
}

function makeStencilOdd(stencil: Array<any>): number[] {
  if (stencil.length % 2 !== 0) {
    return stencil;
  }

  const midpoint = Math.floor(stencil.length / 2);
  const newStencil = [
    ...stencil.slice(0, midpoint),
    null,
    ...stencil.slice(midpoint),
  ];

  return newStencil;
}

function getEdgeValue(edgeOption: EdgeOptions): any {
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

// Function to apply the stencil logic
const applyStencilSymetric = (
  fn: Function,
  inputData: any[],
  stencil: Array<any>,
  edgeOption?: EdgeOptions
): any[] => {
  stencil = makeStencilOdd(stencil);
  const stencilHalf = Math.floor(stencil.length / 2);
  const outputData: any[] = [];

  for (let i = 0; i < inputData.length; i++) {
    const neighbors: any[] = new Array(stencil.length);
    for (let j = 0; j < stencil.length; j++) {
      const idx = i - stencilHalf + j;
      if (idx < 0 || idx >= inputData.length) {
        neighbors[j] = edgeOption ? getEdgeValue(edgeOption) : null;
      } else {
        neighbors[j] = inputData[idx];
      }
    }
    outputData.push(fn(inputData[i], neighbors, stencil));
  }

  return outputData;
};

// Listen for messages from the main thread
parentPort.on("message", (message: Message) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
  } else if (
    "fn" in message &&
    "inputData" in message &&
    "stencil" in message &&
    "edgeOption" in message
  ) {
    try {
      const { fn, inputData, stencil, edgeOption } = message as FunctionMessage;
      const stencilFn = deserializeFn(fn);

      const result = applyStencilSymetric(
        stencilFn,
        inputData,
        stencil,
        edgeOption
      );

      parentPort.postMessage(result);
    } catch (error) {
      console.error("Error in worker:", error);
      parentPort.postMessage("error");
    }
  }
});
