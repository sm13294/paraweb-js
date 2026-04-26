import { ParallelMapShared } from "./mapShared";
import { ParallelReduceShared } from "./reduceShared";
import { AssociativeOp } from "./reduce";
import { detectIdentityElement } from "../core/parallelUtils";

interface ParallelMapReduceSharedInterface {
  mapReduce(
    mapFn: Function,
    reduceOp: AssociativeOp,
    inputData: Array<number>,
    numThreads?: number
  ): Promise<any>;
}

/**
 * Shared-memory MapReduce. See {@link ParallelMapReduce} for semantics:
 * `mapFn` is a per-element transform, `reduceOp` is an associative binary
 * combine operator.
 */
class ParallelMapReduceShared implements ParallelMapReduceSharedInterface {
  async mapReduce(
    mapFn: Function,
    reduceOp: AssociativeOp,
    inputData: Array<number>,
    numThreads?: number
  ): Promise<any> {
    const mapImpl = new ParallelMapShared();
    const reduceImpl = new ParallelReduceShared();
    const mapResults = await mapImpl.map(mapFn, inputData, numThreads);

    const identity = detectIdentityElement(reduceOp, 0);

    if (!mapResults || mapResults.length === 0) {
      return identity;
    }

    return await reduceImpl.reduce(reduceOp, mapResults, identity, numThreads);
  }
}

export { ParallelMapReduceShared };
