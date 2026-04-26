import { MapSharedBrowser } from "./mapSharedBrowser.js";
import { ensureSharedArrayBuffer } from "./workerUtils.js";

export class PipelineSharedBrowser {
  async pipeline(stages, inputData, numThreads) {
    if (stages.length === 0) {
      return inputData;
    }

    ensureSharedArrayBuffer();

    const threads =
      numThreads || (navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4);
    const mapper = new MapSharedBrowser();
    let current = inputData;

    for (const stage of stages) {
      if (Array.isArray(current)) {
        if (current.length === 0) {
          return [];
        }
        if (threads === 1 || current.length < threads * 2) {
          current = current.map((item, index) => stage(item, index));
        } else {
          current = await mapper.map(stage, current, threads);
        }
      } else {
        current = stage(current);
      }
    }

    return current;
  }
}
