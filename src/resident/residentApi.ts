/**
 * Resident forms of ParaWeb's Map, Filter, Reduce and MapReduce patterns.
 *
 * The patterns keep their names and argument order; a call becomes resident
 * in one of two ways, recognised from the argument types:
 *
 * 1. Resident data. The last argument is `{ pool, key? }` instead of a thread
 *    count. The input is shipped to the pool's workers once, under `key`, and
 *    later calls with the same key run on the resident copy without copying
 *    it again. Per-element functions keep their usual meaning:
 *
 *      const pool = new ResidentPool(8);
 *      await paraweb.shared.mapReduce(x => x > 20 ? 1 : 0, (a, b) => a + b,
 *                                     delays, { pool, key: "delay" });
 *
 * 2. Kernels. The first argument is a kernel `{ key, src }` (or
 *    `{ map, combine }` for MapReduce, a predicate `{ key, prelude, cond }` for
 *    Filter) instead of a function. A kernel is the body of
 *    `function (cols, bufs, args, start, end, idx)` and processes a range of
 *    rows of several resident columns in one loop, which lets a client fuse a
 *    filter, a binning step and an aggregate into one pass.
 *
 * Both forms always run on shared memory: data lives in SharedArrayBuffers
 * that the workers of the pool keep between calls.
 */
import { ColumnType, PriorityLevel, ResidentPool } from "./residentPool";
import {
  FilterDelta, FilterState, Kernel, MapCall, MapReduceCall, MapReduceResult, Predicate,
  RunOptions, SharedBuf, residentFilter, residentMap, residentMapReduce,
} from "./residentPatterns";
import { detectIdentityElement } from "../core/parallelUtils";

// ---------------------------------------------------------------------------
// Argument forms
// ---------------------------------------------------------------------------

/** Options that make a function-form call run on resident data. */
export interface ResidentOptions extends RunOptions {
  pool: ResidentPool;
  /**
   * Name of the resident copy of the input. The first call with a key uploads
   * the input; later calls with the same key and length reuse it. Without a
   * key, an input over a SharedArrayBuffer is used in place and any other
   * input is uploaded for this call only.
   */
  key?: string;
  /** Upload the input again although `key` is resident (the data changed). */
  refresh?: boolean;
}

/** Input of a function-form call: data, or the key of a resident column. */
export type ResidentInput = ArrayLike<number> | string;

export type KernelCall = MapCall & { pool: ResidentPool };
export type MapReduceKernels = Pick<MapReduceCall, "map" | "combine">;
export type MapReduceKernelCall = Omit<MapReduceCall, "map" | "combine"> & { pool: ResidentPool };
export type FilterKernelCall = {
  pool: ResidentPool; cols?: string[]; bufs?: SharedBuf[]; args?: Record<string, any>; priority?: PriorityLevel;
};
export type ReduceKernelCall<T> = KernelCall & {
  /** Associative combine of two partial results, applied in row order. */
  combine: (a: T, b: T) => T;
  /** Result for empty input; also prepended to the combination when given. */
  identity?: T;
};

export const isResidentOptions = (o: any): o is ResidentOptions =>
  !!o && typeof o === "object" && !!o.pool && typeof o.pool.ensureColumn === "function" && typeof o.pool.run === "function";
export const isKernel = (k: any): k is Kernel =>
  !!k && typeof k === "object" && typeof k.key === "string" && typeof k.src === "string";
export const isMapReduceKernels = (k: any): k is MapReduceKernels =>
  !!k && typeof k === "object" && isKernel(k.map) && isKernel(k.combine);
export const isPredicate = (p: any): p is Predicate =>
  !!p && typeof p === "object" && typeof p.key === "string" && typeof p.cond === "string";

// ---------------------------------------------------------------------------
// Resident inputs
// ---------------------------------------------------------------------------

interface Column { key: string; n: number; temp: boolean }

/** Per pool: user key -> resident column (versioned, so refreshes never race a drop). */
const named = new WeakMap<ResidentPool, Map<string, { col: string; n: number }>>();
/** Per pool: SharedArrayBuffer used in place -> column key. */
const inPlace = new WeakMap<ResidentPool, WeakMap<SharedArrayBuffer, string>>();
let nextColumn = 1;

const typeOf = (a: any): ColumnType | null =>
  a instanceof Float64Array ? "f64" : a instanceof Float32Array ? "f32" : a instanceof Int32Array ? "i32"
    : a instanceof Uint32Array ? "u32" : a instanceof Uint8Array ? "u8" : null;

function sharedInPlace(a: any): { buffer: SharedArrayBuffer; type: ColumnType } | null {
  const type = typeOf(a);
  if (!type || typeof SharedArrayBuffer === "undefined" || !(a.buffer instanceof SharedArrayBuffer)) return null;
  if (a.byteOffset !== 0 || a.byteLength !== a.buffer.byteLength) return null;
  return { buffer: a.buffer, type };
}

function upload(pool: ResidentPool, input: ArrayLike<number>): string {
  const key = `pw:col:${nextColumn++}`;
  const view = new Float64Array(new SharedArrayBuffer(Math.max(8, 8 * input.length)));
  view.set(input as any);
  pool.ensureColumn(key, "f64", view.buffer);
  return key;
}

function residentColumn(input: ResidentInput, o: ResidentOptions): Column {
  const pool = o.pool;
  const names = named.get(pool) ?? named.set(pool, new Map()).get(pool)!;
  if (typeof input === "string") {
    const c = names.get(input);
    if (c) return { key: c.col, n: c.n, temp: false };
    throw new Error(`paraweb: no resident input named "${input}"`);
  }
  const n = input.length;
  if (o.key !== undefined) {
    const c = names.get(o.key);
    if (c && c.n === n && !o.refresh) return { key: c.col, n, temp: false };
    if (c) pool.dropColumns([c.col]);
    const shared = sharedInPlace(input);
    let col: string;
    if (shared) { col = `pw:col:${nextColumn++}`; pool.ensureColumn(col, shared.type, shared.buffer); }
    else col = upload(pool, input);
    names.set(o.key, { col, n });
    return { key: col, n, temp: false };
  }
  const shared = sharedInPlace(input);
  if (shared) {
    const byBuf = inPlace.get(pool) ?? inPlace.set(pool, new WeakMap()).get(pool)!;
    let col = byBuf.get(shared.buffer);
    if (!col) { col = `pw:col:${nextColumn++}`; pool.ensureColumn(col, shared.type, shared.buffer); byBuf.set(shared.buffer, col); }
    return { key: col, n, temp: false };
  }
  return { key: upload(pool, input), n, temp: true };
}

/** Run with a resident input; temporary columns are dropped afterwards. */
async function withColumn<T>(input: ResidentInput, o: ResidentOptions, f: (c: Column) => Promise<T>): Promise<T> {
  const c = residentColumn(input, o);
  try { return await f(c); } finally { if (c.temp) o.pool.dropColumns([c.key]); }
}

const run = (o: ResidentOptions): RunOptions => ({ priority: o.priority, chunkRows: o.chunkRows, threads: o.threads });
const fnSource = (f: Function | string) => (typeof f === "string" ? f : f.toString());

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

/** Map with a per-element function `fn(value, index)` over resident data. */
export async function mapResident(fn: Function | string, input: ResidentInput, o: ResidentOptions): Promise<Float64Array> {
  return withColumn(input, o, async c => {
    const out = new Float64Array(new SharedArrayBuffer(Math.max(8, 8 * c.n)));
    if (c.n === 0) return out.subarray(0, 0);
    const src = fnSource(fn);
    await residentMap(o.pool, {
      key: "pw:map:" + src,
      src: `const f = (${src});\nconst x = cols[0], out = bufs[0];\nfor (let i = start; i < end; i++) out[i] = f(x[i], i);`,
    }, { ...run(o), n: c.n, cols: [c.key], bufs: [{ buffer: out.buffer as SharedArrayBuffer, type: "f64" }] });
    return out;
  });
}

/** Map with a range kernel. Returns the kernel results per worker and chunk. */
export function mapKernel(kernel: Kernel, call: KernelCall): Promise<any[][]> {
  return residentMap(call.pool, kernel, call);
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/**
 * Filter with a predicate `fn(value, index)` over resident data. Every worker
 * compacts the selected values of its range in place, in one pass; the
 * segments are then concatenated in row order.
 */
export async function filterResident(fn: Function | string, input: ResidentInput, o: ResidentOptions): Promise<Float64Array> {
  return withColumn(input, o, async c => {
    if (c.n === 0) return new Float64Array(0);
    const seg = new Float64Array(new SharedArrayBuffer(8 * c.n));
    const src = fnSource(fn);
    const res = await residentMap(o.pool, {
      key: "pw:filter:" + src,
      src: `const f = (${src});\nconst x = cols[0], out = bufs[0];\nlet w = start;\n` +
        `for (let i = start; i < end; i++) { const v = x[i]; if (f(v, i)) out[w++] = v; }\nreturn [start, w - start];`,
    }, { ...run(o), n: c.n, cols: [c.key], bufs: [{ buffer: seg.buffer as SharedArrayBuffer, type: "f64" }] });
    const parts = res.flat() as [number, number][];
    const out = new Float64Array(parts.reduce((s, [, k]) => s + k, 0));
    let w = 0;
    for (const [s, k] of parts) { out.set(seg.subarray(s, s + k), w); w += k; }
    return out;
  });
}

/** Filter with a predicate kernel and change detection (see FilterState). */
export function filterKernel(pred: Predicate, state: FilterState, call: FilterKernelCall): Promise<FilterDelta> {
  return residentFilter(call.pool, pred, state, call);
}

// ---------------------------------------------------------------------------
// Reduce and MapReduce
// ---------------------------------------------------------------------------

/** One pass per worker: map (optional) and reduce its range; partials are combined in row order. */
async function partials(op: Function | string, mapFn: Function | string | undefined | null,
  c: Column, o: ResidentOptions): Promise<any[]> {
  const opSrc = fnSource(op), mapSrc = mapFn ? fnSource(mapFn) : null;
  const res = await residentMap(o.pool, {
    key: "pw:reduce:" + opSrc + "\u0000" + (mapSrc ?? ""),
    src: `const op = (${opSrc});\n${mapSrc ? `const f = (${mapSrc});\n` : ""}const x = cols[0];\n` +
      `if (start >= end) return { has: false };\nlet acc = ${mapSrc ? "f(x[start])" : "x[start]"};\n` +
      `for (let i = start + 1; i < end; i++) acc = op(acc, ${mapSrc ? "f(x[i])" : "x[i]"});\nreturn { has: true, acc };`,
  }, { ...run(o), n: c.n, cols: [c.key] });
  return (res.flat() as { has: boolean; acc: any }[]).filter(p => p.has).map(p => p.acc);
}

/** Reduce with an associative `op` over resident data, optionally mapping each element first. */
export async function reduceResident(op: (a: any, b: any) => any, input: ResidentInput, identity: any,
  o: ResidentOptions, mapFn?: Function): Promise<any> {
  return withColumn(input, o, async c => {
    const ps = await partials(op, mapFn, c, o);
    if (ps.length === 0) return identity;
    let acc = ps[0];
    for (let i = 1; i < ps.length; i++) acc = op(acc, ps[i]);
    return identity === undefined ? acc : op(identity, acc);
  });
}

/** Reduce with a range kernel: each range returns a partial, combined in row order. */
export async function reduceKernel<T>(kernel: Kernel, call: ReduceKernelCall<T>): Promise<T | undefined> {
  const ps = (await residentMap(call.pool, kernel, call)).flat() as T[];
  if (ps.length === 0) return call.identity;
  let acc = ps[0];
  for (let i = 1; i < ps.length; i++) acc = call.combine(acc, ps[i]);
  return call.identity === undefined ? acc : call.combine(call.identity, acc);
}

/** MapReduce (fused into one pass per worker) with per-element functions over resident data. */
export async function mapReduceResident(mapFn: Function, reduceOp: (a: any, b: any) => any,
  input: ResidentInput, o: ResidentOptions): Promise<any> {
  return withColumn(input, o, async c => {
    const ps = await partials(reduceOp, mapFn, c, o);
    if (ps.length === 0) return detectIdentityElement(reduceOp, 0);
    let acc = ps[0];
    for (let i = 1; i < ps.length; i++) acc = reduceOp(acc, ps[i]);
    return acc;
  });
}

/** MapReduce with a map kernel and a combine kernel over keyed regions (see MapReduceCall). */
export function mapReduceKernel(k: MapReduceKernels, call: MapReduceKernelCall): Promise<MapReduceResult> {
  const { pool, ...rest } = call;
  return residentMapReduce(pool, { ...rest, map: k.map, combine: k.combine });
}

// ---------------------------------------------------------------------------
// Pattern entry points (resident forms only)
// ---------------------------------------------------------------------------

/**
 * The four patterns with only their resident forms. `src/index.ts` routes the
 * `paraweb.map/filter/reduce/mapReduce` calls (default, `mp` and `shared`)
 * here when the arguments are resident; browser clients that do not need the
 * per-call variants can import these directly.
 */
export function map(fn: Function | string, input: ResidentInput, o: ResidentOptions): Promise<Float64Array>;
export function map(kernel: Kernel, call: KernelCall): Promise<any[][]>;
export function map(a: any, b: any, c?: any): Promise<any> {
  if (isKernel(a)) return mapKernel(a, b);
  if (isResidentOptions(c)) return mapResident(a, b, c);
  throw new TypeError("paraweb.map: expected (kernel, { pool, ... }) or (fn, input, { pool, key })");
}

export function filter(fn: Function | string, input: ResidentInput, o: ResidentOptions): Promise<Float64Array>;
export function filter(pred: Predicate, state: FilterState, call: FilterKernelCall): Promise<FilterDelta>;
export function filter(a: any, b: any, c: any): Promise<any> {
  if (isPredicate(a)) return filterKernel(a, b, c);
  if (isResidentOptions(c)) return filterResident(a, b, c);
  throw new TypeError("paraweb.filter: expected (predicate, state, { pool }) or (fn, input, { pool, key })");
}

export function reduce(op: (a: any, b: any) => any, input: ResidentInput, identity: any, o: ResidentOptions, mapFn?: Function): Promise<any>;
export function reduce<T>(kernel: Kernel, call: ReduceKernelCall<T>): Promise<T | undefined>;
export function reduce(a: any, b: any, c?: any, d?: any, e?: any): Promise<any> {
  if (isKernel(a)) return reduceKernel(a, b);
  if (isResidentOptions(d)) return reduceResident(a, b, c, d, e);
  throw new TypeError("paraweb.reduce: expected (kernel, { pool, combine }) or (op, input, identity, { pool, key })");
}

export function mapReduce(mapFn: Function, reduceOp: (a: any, b: any) => any, input: ResidentInput, o: ResidentOptions): Promise<any>;
export function mapReduce(kernels: MapReduceKernels, call: MapReduceKernelCall): Promise<MapReduceResult>;
export function mapReduce(a: any, b: any, c?: any, d?: any): Promise<any> {
  if (isMapReduceKernels(a)) return mapReduceKernel(a, b);
  if (isResidentOptions(d)) return mapReduceResident(a, b, c, d);
  throw new TypeError("paraweb.mapReduce: expected ({ map, combine }, { pool, ... }) or (mapFn, reduceOp, input, { pool, key })");
}

/** True when a call of `pattern` with these arguments is a resident form. */
export function isResidentCall(pattern: "map" | "filter" | "reduce" | "mapReduce", args: any[]): boolean {
  switch (pattern) {
    case "map": return isKernel(args[0]) || isResidentOptions(args[2]);
    case "filter": return isPredicate(args[0]) || isResidentOptions(args[2]);
    case "reduce": return isKernel(args[0]) || isResidentOptions(args[3]);
    case "mapReduce": return isMapReduceKernels(args[0]) || isResidentOptions(args[3]);
  }
}
