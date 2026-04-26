import { MapBrowser } from "./mapBrowser.js";

export class PipelineBrowser {
  async pipeline(stages, inputData, numThreads) {
    const mapper = new MapBrowser();
    let current = inputData;
    for (const stage of stages) {
      if (Array.isArray(current)) {
        current = await mapper.map(stage, current, numThreads);
      } else {
        current = stage(current);
      }
    }
    return current;
  }
}
