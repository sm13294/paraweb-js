import { ParallelMap } from "./map";
import { ParallelReduce, AssociativeOp } from "./reduce";
import { detectIdentityElement } from "../core/parallelUtils";

interface ParallelMapReduceInterface {
  mapReduce(
    mapFn: Function,
    reduceOp: AssociativeOp,
    inputData: Array<any>,
    numThreads?: number
  ): Promise<any>;
}

/**
 * Map-then-Reduce. `mapFn` is applied element-wise and may be any
 * transformation `(x) => y`; `reduceOp` is the associative binary combine
 * operator that folds the mapped values into a single result. The reduce
 * step uses the same contract as {@link ParallelReduce}, so `reduceOp` must
 * be associative (e.g. sum, product, min, max).
 */
class ParallelMapReduce implements ParallelMapReduceInterface {
  async mapReduce(
    mapFn: Function,
    reduceOp: AssociativeOp,
    inputData: Array<any>,
    numThreads?: number
  ): Promise<any> {
    const mapImpl = new ParallelMap();
    const reduceImpl = new ParallelReduce();
    const mapResults = await mapImpl.map(mapFn, inputData, numThreads);

    const identity = detectIdentityElement(reduceOp, 0);
    if (!mapResults || mapResults.length === 0) {
      return identity;
    }
    return await reduceImpl.reduce(reduceOp, mapResults, identity, numThreads);
  }
}
export { ParallelMapReduce };
