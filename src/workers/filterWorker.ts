const { parentPort } = require("node:worker_threads");

interface FunctionMessage {
	fn: string;
	inputData: Array<any>;
}

export type Message = { fn: string; inputData: Array<any> } | string;

let cachedFn: Function | null = null;
let cachedFnStr: string = "";

function deserializeFn(fnStr: string): Function {
	if (fnStr !== cachedFnStr) {
		cachedFnStr = fnStr;
		cachedFn = new Function("return " + fnStr)();
	}
	return cachedFn!;
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
			const { fn, inputData } = message as FunctionMessage;
			const filterFn = deserializeFn(fn);
			const result = inputData.filter(filterFn as any);

			parentPort.postMessage(result);
		} catch (error) {
			console.error("Error in worker:", error);
			parentPort.postMessage("error");
		}
	}
});
