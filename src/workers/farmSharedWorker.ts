const { parentPort } = require("node:worker_threads");

interface FarmSharedMessage {
  fn: string;
  inputBuffer: SharedArrayBuffer;
  outputBuffer: SharedArrayBuffer;
  counterBuffer: SharedArrayBuffer;
  length: number;
  batchSize?: number;
}

export type Message = FarmSharedMessage | string;

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
      const { fn, inputBuffer, outputBuffer, counterBuffer, length, batchSize = 128 } =
        message as FarmSharedMessage;
      const inputView = new Float64Array(inputBuffer);
      const outputView = new Float64Array(outputBuffer);
      const counterView = new Int32Array(counterBuffer);
      const farmFn = deserializeFn(fn);

      // Pull batches of tasks atomically. For fine-grained workloads like
      // Collatz this cuts atomic-counter contention by batchSize* and keeps
      // dynamic load balancing at the batch level (workers that finish early
      // simply grab the next batch).
      while (true) {
        const start = Atomics.add(counterView, 0, batchSize);
        if (start >= length) break;
        const end = start + batchSize > length ? length : start + batchSize;
        for (let i = start; i < end; i++) {
          outputView[i] = farmFn(inputView[i], i);
        }
      }

      parentPort.postMessage("done");
    } catch (error) {
      console.error("Error in worker:", error);
      parentPort.postMessage("error");
    }
  }
});
