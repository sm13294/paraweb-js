import { MapSharedBrowser } from "./mapSharedBrowser.js";
import { ReduceSharedBrowser } from "./reduceSharedBrowser.js";

export class MapReduceSharedBrowser {
  async mapReduce(mapFn, reduceFn, inputData, numThreads) {
    const mapper = new MapSharedBrowser();
    const reducer = new ReduceSharedBrowser();
    const mapped = await mapper.map(mapFn, inputData, numThreads);
    if (!mapped || mapped.length === 0) {
      return undefined;
    }
    let initialValue = 0;
    try {
      const testValue = 5;
      const resultWith0 = reduceFn(0, testValue);
      if (resultWith0 === testValue && typeof resultWith0 === "number") {
        initialValue = 0;
      } else {
        const resultWith1 = reduceFn(1, testValue);
        if (resultWith1 === testValue && typeof resultWith1 === "number") {
          initialValue = 1;
        }
      }
    } catch (e) {
      initialValue = 0;
    }
    return reducer.reduce(reduceFn, mapped, initialValue, numThreads);
  }
}
