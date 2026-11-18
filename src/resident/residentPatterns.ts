/**
 * ParaWeb patterns over resident data.
 *
 * These are the Map, MapReduce, Filter, Scan + Scatter (counting sort) and
 * Reduce patterns of ParaWeb, restated for data that already lives in the
 * workers of a ResidentPool. A call sends only parameters and kernel keys;
 * kernels are source strings compiled once per worker. Every pattern takes
 * a priority and an optional chunk size: with chunking, all chunks are
 * queued at once and per-worker queues run them in order, so higher
 * priority requests are served between chunks.
 */
import { ColumnType, Priority, PriorityLevel, ResidentPool } from "./residentPool";

/** A kernel: the body of function(cols, bufs, args, start, end, idx). */
export interface Kernel {
  /** Cache key; equal keys must mean equal source. */
  key: string;
  src: string;
}

/** A shared buffer passed to a kernel; the worker wraps it in a typed array. */
export interface SharedBuf {
  buffer: SharedArrayBuffer;
  type: ColumnType;
}

export interface RunOptions {
  priority?: PriorityLevel;
  /** Split each worker's range into chunks of at most this many rows (0: no split). */
  chunkRows?: number;
  /** Use at most this many workers. */
  threads?: number;
}

/** Split [0, n) into at most T contiguous, non-empty ranges. */
export function splitRanges(n: number, T: number): [number, number][] {
  const out: [number, number][] = [];
  if (n <= 0) return out;
  T = Math.max(1, Math.min(T, n));
  const chunk = Math.ceil(n / T);
  for (let t = 0; t < T; t++) {
    const s = t * chunk, e = Math.min(n, s + chunk);
    if (s < e) out.push([s, e]);
  }
  return out;
}

/** Split [s, e) into pieces of at most `size` (one piece when size is 0). */
export function chunkRange(s: number, e: number, size: number): [number, number][] {
  if (!size || e - s <= size) return [[s, e]];
  const out: [number, number][] = [];
  for (let a = s; a < e; a += size) out.push([a, Math.min(e, a + size)]);
  return out;
}

const mainThreadKernels = new Map<string, Function>();

/** Compile a kernel for use on the calling thread (same source, same cache key). */
export function compileKernelHere(k: Kernel): Function {
  let fn = mainThreadKernels.get(k.key);
  if (!fn) {
    fn = new Function("cols", "bufs", "args", "start", "end", "idx", k.src);
    mainThreadKernels.set(k.key, fn);
  }
  return fn;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

export interface MapCall extends RunOptions {
  /** Number of rows (or index positions when idx is given). */
  n: number;
  /** Keys of resident columns, in the order the kernel expects. */
  cols?: string[];
  bufs?: SharedBuf[];
  /** Passed to the kernel; each call also gets args.t (worker) and args.chunk. */
  args?: Record<string, any>;
  /** Visit rows idx[start .. end) instead of [start, end). */
  idx?: SharedArrayBuffer;
}

/**
 * Map: run a kernel over [0, n), one contiguous range per worker. Returns
 * the kernel results, per worker, per chunk.
 */
export async function residentMap(pool: ResidentPool, kernel: Kernel, call: MapCall): Promise<any[][]> {
  const ranges = splitRanges(call.n, Math.min(pool.size, call.threads ?? pool.size));
  const priority = call.priority ?? Priority.High;
  const jobs: Promise<any>[][] = ranges.map(([start, end], t) =>
    chunkRange(start, end, call.chunkRows ?? 0).map(([s, e], chunk) => pool.run(t, {
      op: "kernel", key: kernel.key, src: kernel.src, cols: call.cols, bufs: call.bufs,
      args: { ...call.args, t, chunk }, start: s, end: e, idx: call.idx,
    }, priority)));
  return Promise.all(jobs.map(j => Promise.all(j)));
}

// ---------------------------------------------------------------------------
// MapReduce
// ---------------------------------------------------------------------------

export interface MapReduceCall extends RunOptions {
  /**
   * Accumulates rows [start, end) into the Float64Array bufs[0], in the
   * region starting at args.base (keys * slots values). args.first is true
   * for the first chunk of a worker, which must initialise the region.
   */
  map: Kernel;
  /**
   * Combines args.T regions of bufs[0] into bufs[1] for keys [start, end).
   * args.region is the region length (keys * slots).
   */
  combine: Kernel;
  n: number;
  keys: number;
  slots: number;
  cols?: string[];
  args?: Record<string, any>;
  /** Reused shared buffers; grown on demand. */
  scratch?: { parts?: SharedArrayBuffer; dst?: SharedArrayBuffer };
  /** Combine in parallel when T * region reaches this (default 65536 values). */
  parallelCombineMin?: number;
  /** Reduce the worker count so that partials stay below this (default 512 MB). */
  maxPartialBytes?: number;
}

export interface MapReduceResult {
  final: Float64Array;
  threads: number;
  combine: "single" | "main" | "parallel";
}

function grow(buf: SharedArrayBuffer | undefined, bytes: number): SharedArrayBuffer {
  if (buf && buf.byteLength >= bytes) return buf;
  return new SharedArrayBuffer(Math.max(8, bytes));
}

/**
 * MapReduce: every worker accumulates its range into a private region of a
 * shared partials buffer (Map), then the regions are combined (Reduce),
 * on the calling thread when small and in parallel by key range otherwise.
 */
export async function residentMapReduce(pool: ResidentPool, call: MapReduceCall): Promise<MapReduceResult> {
  const priority = call.priority ?? Priority.High;
  const region = call.keys * call.slots;
  const maxBytes = call.maxPartialBytes ?? 512 * 1024 * 1024;
  if (region * 8 > maxBytes) throw new Error(`resident MapReduce: ${call.keys} groups exceed the partial-buffer limit`);
  let T = Math.min(pool.size, call.threads ?? pool.size, Math.max(1, call.n));
  while (T > 1 && T * region * 8 > maxBytes) T--;
  const ranges = splitRanges(call.n, T);
  if (ranges.length === 0) return { final: new Float64Array(region), threads: 0, combine: "single" };
  T = ranges.length;

  const scratch = call.scratch ?? {};
  scratch.parts = grow(scratch.parts, T * region * 8);
  const parts = new Float64Array(scratch.parts, 0, T * region);
  const partsBuf: SharedBuf = { buffer: scratch.parts, type: "f64" };

  // All chunks are queued before the first await.
  const jobs: Promise<any>[] = [];
  ranges.forEach(([start, end], t) => {
    chunkRange(start, end, call.chunkRows ?? 0).forEach(([s, e], c) => {
      jobs.push(pool.run(t, {
        op: "kernel", key: call.map.key, src: call.map.src, cols: call.cols, bufs: [partsBuf],
        args: { ...call.args, t, base: t * region, first: c === 0 }, start: s, end: e,
      }, priority));
    });
  });
  await Promise.all(jobs);

  if (T === 1) return { final: parts.subarray(0, region), threads: 1, combine: "single" };
  const cargs = { ...call.args, T, region };
  if (T * region < (call.parallelCombineMin ?? 1 << 16)) {
    const final = new Float64Array(region);
    compileKernelHere(call.combine)([], [parts, final], cargs, 0, call.keys);
    return { final, threads: T, combine: "main" };
  }
  scratch.dst = grow(scratch.dst, region * 8);
  const final = new Float64Array(scratch.dst, 0, region);
  const dstBuf: SharedBuf = { buffer: scratch.dst, type: "f64" };
  await Promise.all(splitRanges(call.keys, pool.size).map(([kStart, kEnd], w) => pool.run(w, {
    op: "kernel", key: call.combine.key, src: call.combine.src, bufs: [partsBuf, dstBuf],
    args: cargs, start: kStart, end: kEnd,
  }, priority)));
  return { final, threads: T, combine: "parallel" };
}

// ---------------------------------------------------------------------------
// Reduce: extent
// ---------------------------------------------------------------------------

/** Min and max of a resident numeric column, ignoring NaN. */
export async function residentExtent(
  pool: ResidentPool, col: string, n: number, opts: RunOptions = {},
): Promise<[number, number]> {
  const parts: [number, number][] = await Promise.all(splitRanges(n, pool.size).map(([start, end], t) =>
    pool.run(t, { op: "extent", col, start, end }, opts.priority ?? Priority.High)));
  let lo = Infinity, hi = -Infinity;
  for (const [a, b] of parts) { if (a < lo) lo = a; if (b > hi) hi = b; }
  return [lo, hi];
}

// ---------------------------------------------------------------------------
// Map + Scan + Scatter: counting sort by bucket
// ---------------------------------------------------------------------------

/** Equal-width buckets: b = floor((x - lo) * scale), clamped to [0, R); NaN -> R. */
export interface BucketSpec { lo: number; hi: number; scale: number; R: number }

export interface CountingSortResult {
  /** Row ids ordered by bucket; stable within a bucket. */
  perm: Int32Array;
  /** perm[offsets[b] .. offsets[b + 1]) are the rows of bucket b (R + 2 entries). */
  offsets: Int32Array;
}

/**
 * Parallel counting sort of row ids by bucket: per-worker histograms (Map),
 * exclusive prefix sums over (bucket, worker) on the calling thread (Scan),
 * then every worker writes its row ids at its offsets (Scatter). With
 * chunking, the Scatter chunks are announced to the pool (reserveLow) while
 * the Map phase runs, so lowPendingMs() includes them.
 */
export async function residentCountingSort(
  pool: ResidentPool, col: string, n: number, b: BucketSpec, opts: RunOptions = {},
): Promise<CountingSortResult> {
  const priority = opts.priority ?? Priority.High;
  const { lo, hi, scale, R } = b;
  const ranges = splitRanges(n, pool.size);
  const B = R + 1;
  const pieces = ranges.map(([s, e]) => chunkRange(s, e, opts.chunkRows ?? 0));
  const scatterChunks = pieces.reduce((a, p) => a + p.length, 0);
  const hist = new Int32Array(new SharedArrayBuffer(4 * Math.max(1, ranges.length * B)));
  pool.reserveLow(scatterChunks);
  try {
    await Promise.all(pieces.flatMap((p, t) => p.map(([s, e], c) => pool.run(t, {
      op: "bhist", col, lo, hi, scale, R, start: s, end: e, hist: hist.buffer, base: t * B, reset: c === 0,
    }, priority))));
  } catch (e) {
    pool.releaseLow(scatterChunks);
    throw e;
  }
  const cursor = new Int32Array(new SharedArrayBuffer(4 * Math.max(1, ranges.length * B)));
  const offsets = new Int32Array(B + 1);
  let run = 0;
  for (let k = 0; k < B; k++) {
    offsets[k] = run;
    for (let t = 0; t < ranges.length; t++) {
      cursor[t * B + k] = run;
      run += hist[t * B + k];
    }
  }
  offsets[B] = run;
  const perm = new Int32Array(new SharedArrayBuffer(4 * Math.max(1, n)));
  pool.releaseLow(scatterChunks);
  await Promise.all(pieces.flatMap((p, t) => p.map(([s, e]) => pool.run(t, {
    op: "bscatter", col, lo, hi, scale, R, start: s, end: e, cursor: cursor.buffer, base: t * B, perm: perm.buffer,
  }, priority))));
  return { perm, offsets };
}

// ---------------------------------------------------------------------------
// Filter with change detection
// ---------------------------------------------------------------------------

/**
 * Selection state of a filter over n rows. Two mask buffers alternate
 * between calls ("current" and "previous"), so no copy is needed.
 */
export class FilterState {
  readonly n: number;
  private masks: [Uint8Array, Uint8Array];
  private cur = 0;
  readonly changes: Int32Array;
  /** Number of rows currently selected. */
  selected = 0;

  constructor(n: number) {
    this.n = n;
    const m = () => new Uint8Array(new SharedArrayBuffer(Math.max(1, n)));
    this.masks = [m(), m()];
    this.changes = new Int32Array(new SharedArrayBuffer(4 * Math.max(1, n)));
  }

  /** Mask of the last completed call. */
  get mask(): Uint8Array { return this.masks[this.cur]; }
  get next(): Uint8Array { return this.masks[1 - this.cur]; }
  swap() { this.cur = 1 - this.cur; }
}

/** A row predicate: `prelude` runs once per call, `cond` is evaluated per row i. */
export interface Predicate {
  key: string;
  prelude: string;
  cond: string;
}

export interface FilterDelta {
  /** Row ids that became selected. */
  add: Int32Array;
  /** Row ids that are no longer selected. */
  rem: Int32Array;
  threads: number;
}

/**
 * Filter returning only what changed since the previous call: each worker
 * evaluates the predicate over its range, writes a 0/1 mask and appends rows
 * whose state changed to its own segment of a shared change list.
 */
export async function residentFilter(
  pool: ResidentPool, pred: Predicate, state: FilterState,
  call: { cols?: string[]; bufs?: SharedBuf[]; args?: Record<string, any>; priority?: PriorityLevel } = {},
): Promise<FilterDelta> {
  const rs = splitRanges(state.n, pool.size);
  const mask = state.next, prev = state.mask;
  const counts: number[] = await Promise.all(rs.map(([start, end], t) => pool.run(t, {
    op: "filter", key: pred.key, prelude: pred.prelude, cond: pred.cond,
    cols: call.cols, bufs: call.bufs, args: call.args,
    mask: mask.buffer, prev: prev.buffer, changes: state.changes.buffer, start, end,
  }, call.priority ?? Priority.High)));

  let nAdd = 0, nRem = 0;
  rs.forEach(([start], t) => {
    for (let j = start, e = start + counts[t]; j < e; j++) (state.changes[j] >= 0 ? nAdd++ : nRem++);
  });
  const add = new Int32Array(nAdd), rem = new Int32Array(nRem);
  let a = 0, r = 0;
  rs.forEach(([start], t) => {
    for (let j = start, e = start + counts[t]; j < e; j++) {
      const v = state.changes[j];
      if (v >= 0) add[a++] = v; else rem[r++] = -v - 1;
    }
  });
  state.swap();
  state.selected += nAdd - nRem;
  return { add, rem, threads: rs.length };
}
