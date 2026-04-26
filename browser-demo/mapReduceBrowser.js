import { MapBrowser } from "./mapBrowser.js";
import { ReduceBrowser } from "./reduceBrowser.js";

export class MapReduceBrowser {
  async mapReduce(mapFn, reduceFn, inputData, numThreads) {
    const mapper = new MapBrowser();
    const reducer = new ReduceBrowser();
    const mapped = await mapper.map(mapFn, inputData, numThreads);
    if (!mapped || mapped.length === 0) {
      return undefined;
    }
    return reducer.reduce(reduceFn, mapped, 0, numThreads);
  }
}
