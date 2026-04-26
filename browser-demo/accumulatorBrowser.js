import { ReduceBrowser } from "./reduceBrowser.js";

export class AccumulatorBrowser {
  async accumulator(fn, inputData, initialValue, numThreads) {
    const reducer = new ReduceBrowser();
    return reducer.reduce(fn, inputData, initialValue, numThreads);
  }
}
