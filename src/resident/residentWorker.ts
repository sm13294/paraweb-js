/**
 * Worker side of ParaWeb's resident runtime.
 *
 * The worker is a single self-contained function so that it can be shipped
 * as a string (ParaWeb's function-as-string convention) and started from a
 * Blob URL in browsers, from `worker_threads` with `eval` in Node.js, or run
 * on the calling thread (inline factory). It must not reference anything
 * outside its own body.
 *
 * State kept per worker:
 *   - columns: typed-array views over SharedArrayBuffers, sent once per key;
 *   - kernels: functions compiled from source strings, cached per key.
 *
 * Protocol: every request may carry an id; the reply is { id, result } on
 * success or { id, error } on failure. Requests without an id get no reply.
 *
 * Ops:
 *   column   { key, type: "f64" | "f32" | "i32" | "u32" | "u8", buffer }
 *   drop     { keys }
 *   kernel   { key, src, cols, bufs, args, start, end, idx? }
 *            src is the body of function(cols, bufs, args, start, end, idx);
 *            its return value is the reply.
 *   filter   { key, prelude, cond, cols, bufs, args, mask, prev, changes, start, end }
 *            Filter with change detection: mask[i] = cond(i); rows whose
 *            state differs from prev[i] are written to changes[start..] as i
 *            (now selected) or -i - 1 (no longer selected). Returns the count.
 *   bhist    { col, lo, hi, scale, R, start, end, hist, base, reset }
 *   bscatter { col, lo, hi, scale, R, start, end, cursor, base, perm }
 *            The Map and Scatter steps of a parallel counting sort by an
 *            equal-width bucket of a numeric column (NaN goes to bucket R).
 *   extent   { col, start, end } -> [min, max] ignoring NaN (Reduce).
 */
export function residentWorkerMain(self: any): void {
  const columns = new Map<string, any>();
  const kernels = new Map<string, Function>();
  const ctor: Record<string, any> = {
    f64: Float64Array, f32: Float32Array, i32: Int32Array, u32: Uint32Array, u8: Uint8Array,
  };

  const column = (key: string) => {
    const c = columns.get(key);
    if (!c) throw new Error(`column not loaded in worker: ${key}`);
    return c;
  };
  const views = (bufs: any[] | undefined) =>
    (bufs || []).map(b => (b && b.buffer ? new ctor[b.type || "f64"](b.buffer) : b));
  const compile = (key: string, make: () => Function) => {
    let k = kernels.get(key);
    if (!k) { k = make(); kernels.set(key, k); }
    return k;
  };
  const bucket = (x: number, lo: number, hi: number, scale: number, R: number) => {
    if (x !== x) return R;
    if (x <= lo) return 0;
    if (x >= hi) return R - 1;
    const b = Math.floor((x - lo) * scale);
    return b > R - 1 ? R - 1 : b;
  };

  const handle = (msg: any): any => {
    switch (msg.op) {
      case "column":
        columns.set(msg.key, new ctor[msg.type](msg.buffer));
        return undefined;
      case "drop":
        for (const key of msg.keys) columns.delete(key);
        return undefined;
      case "kernel": {
        const fn = compile(msg.key, () =>
          new Function("cols", "bufs", "args", "start", "end", "idx", msg.src));
        const idx = msg.idx ? new Int32Array(msg.idx) : undefined;
        return fn((msg.cols || []).map(column), views(msg.bufs), msg.args, msg.start, msg.end, idx);
      }
      case "filter": {
        const fn = compile("filter:" + msg.key, () => new Function(
          "cols", "bufs", "args", "mask", "prev", "changes", "start", "end",
          `${msg.prelude}\nlet w = start;\nfor (let i = start; i < end; i++) {\n` +
          `  const m = (${msg.cond}) ? 1 : 0;\n  mask[i] = m;\n` +
          `  if (m !== prev[i]) changes[w++] = m ? i : -i - 1;\n}\nreturn w - start;`));
        return fn((msg.cols || []).map(column), views(msg.bufs), msg.args,
          new Uint8Array(msg.mask), new Uint8Array(msg.prev), new Int32Array(msg.changes),
          msg.start, msg.end);
      }
      case "bhist": {
        const col = column(msg.col), hist = new Int32Array(msg.hist);
        const { lo, hi, scale, R, base } = msg;
        if (msg.reset !== false) hist.fill(0, base, base + R + 1);
        for (let i = msg.start; i < msg.end; i++) hist[base + bucket(col[i], lo, hi, scale, R)]++;
        return undefined;
      }
      case "bscatter": {
        const col = column(msg.col), cursor = new Int32Array(msg.cursor), perm = new Int32Array(msg.perm);
        const { lo, hi, scale, R, base } = msg;
        // The cursor is advanced in place, so consecutive chunks of one
        // worker's range continue where the previous chunk ended.
        const cur = cursor.slice(base, base + R + 1);
        for (let i = msg.start; i < msg.end; i++) perm[cur[bucket(col[i], lo, hi, scale, R)]++] = i;
        cursor.set(cur, base);
        return undefined;
      }
      case "extent": {
        const col = column(msg.col);
        let lo = Infinity, hi = -Infinity;
        for (let i = msg.start; i < msg.end; i++) {
          const x = col[i];
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
        return [lo, hi];
      }
      default:
        throw new Error(`unknown op: ${msg.op}`);
    }
  };

  self.onmessage = (event: { data: any }) => {
    const msg = event.data;
    try {
      const result = handle(msg);
      if (msg.id !== undefined) self.postMessage({ id: msg.id, result });
    } catch (err: any) {
      if (msg.id !== undefined) self.postMessage({ id: msg.id, error: String((err && err.message) || err) });
    }
  };
}

/** Source text of the worker, ready for a Blob URL or `new Function("self", ...)`. */
export const RESIDENT_WORKER_SOURCE = `(${residentWorkerMain.toString()})(self);`;
