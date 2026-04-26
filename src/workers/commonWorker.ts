/**
 * Common utilities for ParaWeb workers.
 *
 * Provides a cached function deserialization helper so that repeated
 * messages carrying the same stringified function do not pay the
 * parsing cost more than once.
 */

let cachedFn: Function | null = null;
let cachedFnStr: string = "";

/**
 * Deserialize a stringified function, returning a cached version when
 * the same string is passed again.
 */
export function deserializeFn(fnStr: string): Function {
  if (fnStr !== cachedFnStr) {
    cachedFnStr = fnStr;
    cachedFn = new Function("return " + fnStr)();
  }
  return cachedFn!;
}

let cachedArgFn: Function | null = null;
let cachedArgFnStr: string = "";

/**
 * Deserialize a stringified function that takes explicit (value, index)
 * arguments — used by SharedArrayBuffer workers where the function is
 * called element-by-element.
 */
export function deserializeArgFn(fnStr: string): Function {
  if (fnStr !== cachedArgFnStr) {
    cachedArgFnStr = fnStr;
    cachedArgFn = new Function("value", "index", `return (${fnStr})(value, index)`);
  }
  return cachedArgFn!;
}

let cachedReduceFn: Function | null = null;
let cachedReduceFnStr: string = "";

/**
 * Deserialize a stringified reduce/accumulator function that takes
 * (acc, curr) arguments.
 */
export function deserializeReduceFn(fnStr: string): Function {
  if (fnStr !== cachedReduceFnStr) {
    cachedReduceFnStr = fnStr;
    cachedReduceFn = new Function("acc", "curr", `return (${fnStr})(acc, curr)`);
  }
  return cachedReduceFn!;
}
