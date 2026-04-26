/**
 * Pipeline stage operator definitions.
 *
 * A pipeline is a sequence of stages. Each stage is either:
 *   - a plain function applied element-wise to the input array (the default, equivalent
 *     to a parallel map over the data flowing between stages), or
 *   - one of three stream stage operators that mirror the GrPPI streaming patterns:
 *
 *   FilterStage         (stream filter)        — drops items that fail a predicate
 *   WindowReduceStage   (stream reduction)     — collapses each sliding window into one value
 *   IterateStage        (stream iteration)     — applies a fixed-point loop to each item
 *
 * The composition of these stages with regular map stages within a Pipeline
 * provides the same expressiveness as GrPPI's streaming pattern compositions.
 */

export interface FilterStage {
  kind: "filter";
  /** Predicate: returns true to keep an element, false to drop it. */
  keep: Function;
}

export interface WindowReduceStage {
  kind: "windowReduce";
  /** Number of elements per window. */
  size: number;
  /** Step (stride) between successive window starts. step=size means non-overlapping. */
  step: number;
  /** Associative binary reduction operator. */
  op: Function;
  /** Identity element for the operator. */
  identity: number;
}

export interface IterateStage {
  kind: "iterate";
  /** Per-item transformation applied repeatedly. */
  op: Function;
  /** Termination predicate: returns true when the iteration for this item should stop. */
  until: Function;
  /** Optional safety cap to prevent unbounded loops. Default: 1000. */
  maxIterations?: number;
}

export type StreamStage = FilterStage | WindowReduceStage | IterateStage;
export type Stage = Function | StreamStage;

export function isStreamStage(s: Stage): s is StreamStage {
  return typeof s === "object" && s !== null && "kind" in s;
}
