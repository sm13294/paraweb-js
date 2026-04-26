const { parentPort } = require("node:worker_threads");

interface TaskMessage {
  divideFn: string;
  conquerFn: string;
  baseCaseFn: string;
  tasks: Array<{ index: number; data: any }>;
}

export type Message = TaskMessage | string;

let cachedDivideFn: Function | null = null;
let cachedDivideFnStr: string = "";
let cachedConquerFn: Function | null = null;
let cachedConquerFnStr: string = "";
let cachedBaseCaseFn: Function | null = null;
let cachedBaseCaseFnStr: string = "";

function deserializeDivideFn(fnStr: string): Function {
  if (fnStr !== cachedDivideFnStr) {
    cachedDivideFnStr = fnStr;
    cachedDivideFn = new Function("return " + fnStr)();
  }
  return cachedDivideFn!;
}

function deserializeConquerFn(fnStr: string): Function {
  if (fnStr !== cachedConquerFnStr) {
    cachedConquerFnStr = fnStr;
    cachedConquerFn = new Function("return " + fnStr)();
  }
  return cachedConquerFn!;
}

function deserializeBaseCaseFn(fnStr: string): Function {
  if (fnStr !== cachedBaseCaseFnStr) {
    cachedBaseCaseFnStr = fnStr;
    cachedBaseCaseFn = new Function("return " + fnStr)();
  }
  return cachedBaseCaseFn!;
}

const solveRecursive = (
  divideFn: Function,
  conquerFn: Function,
  baseCaseFn: Function,
  inputData: any
): any => {
  if (baseCaseFn(inputData)) {
    return inputData;
  }

  const subproblems = divideFn(inputData);
  if (!Array.isArray(subproblems) || subproblems.length === 0) {
    return inputData;
  }

  if (subproblems.length === 1) {
    return solveRecursive(divideFn, conquerFn, baseCaseFn, subproblems[0]);
  }

  const subResults = subproblems.map((subproblem: any) =>
    solveRecursive(divideFn, conquerFn, baseCaseFn, subproblem)
  );
  return conquerFn(subResults);
};

parentPort.on("message", (message: Message) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
  } else if ("divideFn" in message && "tasks" in message) {
    try {
      const { divideFn, conquerFn, baseCaseFn, tasks } = message as TaskMessage;
      const divide = deserializeDivideFn(divideFn);
      const conquer = deserializeConquerFn(conquerFn);
      const baseCase = deserializeBaseCaseFn(baseCaseFn);

      const results = tasks.map((task) => ({
        index: task.index,
        result: solveRecursive(divide, conquer, baseCase, task.data),
      }));

      parentPort.postMessage(results);
    } catch (error) {
      console.error("Error in worker:", error);
      parentPort.postMessage("error");
    }
  }
});
