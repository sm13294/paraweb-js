/**
 * Functional tests of the resident runtime (src/resident): every pattern is
 * checked against a sequential reference, with worker_threads and with the
 * inline factory, and the priority scheduler is checked for ordering.
 *
 *   npm run build && node dist/test/testResident.js
 */
import { isGPUAvailable } from "../core/gpuContext";
import {
  FilterState, Priority, ResidentGPU, ResidentPool, inlineWorkerFactory, nodeWorkerFactory, orderedKey, orderedKeys,
  residentCountingSort, residentExtent, residentFilter, residentMap, residentMapReduce,
} from "../resident";
import paraweb = require("../index");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++; else { fail++; console.log(`FAIL ${name} ${detail}`); }
}

function data(n: number, seed: number): Float64Array {
  const a = new Float64Array(new SharedArrayBuffer(8 * n));
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    a[i] = i % 97 === 0 ? NaN : (s / 4294967296) * 200 - 50;
  }
  return a;
}

async function suite(label: string, pool: ResidentPool, n: number) {
  const x = data(n, 7), y = data(n, 11);
  // Column keys must be unique per data: the pool sends a key only once.
  const X = `x${n}`, Y = `y${n}`;
  pool.ensureColumn(X, "f64", x.buffer as SharedArrayBuffer);
  pool.ensureColumn(Y, "f64", y.buffer as SharedArrayBuffer);

  // Map: square into a shared output column; result is the chunk length.
  const out = new Float64Array(new SharedArrayBuffer(8 * n));
  const res = await residentMap(pool, { key: "sq", src: "const c = cols[0], o = bufs[0]; for (let i = start; i < end; i++) o[i] = c[i] * c[i]; return end - start;" },
    { n, cols: [X], bufs: [{ buffer: out.buffer as SharedArrayBuffer, type: "f64" }], chunkRows: 1000 });
  let okMap = res.flat().reduce((a: number, b: number) => a + b, 0) === n;
  for (let i = 0; i < n && okMap; i++) okMap = Object.is(out[i], x[i] * x[i]);
  check(`${label} map`, okMap);

  // MapReduce: per-bucket count and sum of y, grouped by floor(x / 10) over 0..19 (other -> 20).
  const K = 21, A = 2;
  const map = { key: "grp", src: `
    const cx = cols[0], cy = cols[1], out = bufs[0], base = args.base;
    if (args.first) out.fill(0, base, base + ${K * A});
    for (let i = start; i < end; i++) {
      const v = cx[i]; let k = Math.floor(v / 10); if (!(k >= 0 && k < 20)) k = 20;
      const o = base + k * ${A}; out[o] += 1; out[o + 1] += cy[i] === cy[i] ? cy[i] : 0;
    }` };
  const combine = { key: "grpc", src: `
    const p = bufs[0], d = bufs[1];
    for (let k = start; k < end; k++) for (let s = 0; s < ${A}; s++) {
      let v = 0; for (let t = 0; t < args.T; t++) v += p[t * args.region + k * ${A} + s]; d[k * ${A} + s] = v;
    }` };
  const ref = new Float64Array(K * A);
  for (let i = 0; i < n; i++) {
    let k = Math.floor(x[i] / 10); if (!(k >= 0 && k < 20)) k = 20;
    ref[k * A] += 1; ref[k * A + 1] += y[i] === y[i] ? y[i] : 0;
  }
  for (const pc of [1, 1 << 30]) {
    const r = await residentMapReduce(pool, { map, combine, n, keys: K, slots: A, cols: [X, Y], chunkRows: 777, parallelCombineMin: pc });
    let ok = true;
    for (let k = 0; k < K * A; k++) ok = ok && Math.abs(r.final[k] - ref[k]) <= 1e-9 * Math.max(1, Math.abs(ref[k]));
    check(`${label} mapReduce (${r.combine})`, ok);
  }

  // Extent (Reduce).
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (x[i] < lo) lo = x[i]; if (x[i] > hi) hi = x[i]; }
  const [elo, ehi] = await residentExtent(pool, X, n);
  check(`${label} extent`, elo === lo && ehi === hi);

  // Counting sort (Map + Scan + Scatter), stable within buckets.
  const R = 64, scale = R / (hi - lo);
  const { perm, offsets } = await residentCountingSort(pool, X, n, { lo, hi, scale, R }, { chunkRows: 500, priority: Priority.Low });
  const bucket = (v: number) => (v !== v ? R : v <= lo ? 0 : v >= hi ? R - 1 : Math.min(R - 1, Math.floor((v - lo) * scale)));
  let okSort = offsets[R + 1] === n;
  const seen = new Uint8Array(n);
  for (let b = 0; b <= R && okSort; b++) {
    for (let j = offsets[b]; j < offsets[b + 1]; j++) {
      const i = perm[j];
      if (bucket(x[i]) !== b || seen[i] || (j > offsets[b] && perm[j - 1] > i)) { okSort = false; break; }
      seen[i] = 1;
    }
  }
  check(`${label} counting sort`, okSort);

  // Filter with change detection over a sequence of ranges.
  const state = new FilterState(n);
  const pred = { key: "rng", prelude: "const c = cols[0], a = args.lo, b = args.hi; let v;", cond: "(v = c[i], v >= a && v <= b)" };
  let prev = new Uint8Array(n), okF = true;
  for (const [a, b] of [[0, 10], [5, 30], [-100, 200], [40, 39], [0, 10]]) {
    const d = await residentFilter(pool, pred, state, { cols: [X], args: { lo: a, hi: b } });
    const cur = new Uint8Array(n);
    for (let i = 0; i < n; i++) cur[i] = x[i] >= a && x[i] <= b ? 1 : 0;
    const add = new Set(d.add), rem = new Set(d.rem);
    for (let i = 0; i < n; i++) {
      const want = cur[i] - prev[i];
      if ((want === 1) !== add.has(i) || (want === -1) !== rem.has(i)) { okF = false; break; }
    }
    okF = okF && state.selected === cur.reduce((s, v) => s + v, 0);
    prev = cur;
  }
  check(`${label} filter delta`, okF);
}

async function scheduling() {
  // One worker. Within a priority tasks run in order; Lowest runs last. (A
  // Low task may run between two High tasks through the fair share.)
  const pool = new ResidentPool(1, nodeWorkerFactory());
  const order: string[] = [];
  const k = (tag: string) => ({ op: "kernel", key: "id", src: "return args.tag;", args: { tag } });
  const spin = { op: "kernel", key: "spin", src: "const t = Date.now(); while (Date.now() - t < 30) {} return 'busy';" };
  const busy = pool.run(0, spin, Priority.Low);
  const jobs = [
    pool.run(0, k("lowest"), Priority.Lowest), pool.run(0, k("low1"), Priority.Low),
    pool.run(0, k("high1"), Priority.High), pool.run(0, k("low2"), Priority.Low), pool.run(0, k("high2"), Priority.High),
  ].map(p => p.then((t: string) => order.push(t)));
  await busy; await Promise.all(jobs);
  const pos = (t: string) => order.indexOf(t);
  check("scheduling order", pos("high1") < pos("high2") && pos("low1") < pos("low2") && pos("lowest") === 4 && pos("high1") === 0, order.join(","));
  // Fair share: after a 30 ms High task while Low work waits, one Low task
  // runs before the next High task.
  const order2: string[] = [];
  const busy2 = pool.run(0, spin, Priority.High);
  const jobs2 = [pool.run(0, k("low"), Priority.Low), pool.run(0, k("high"), Priority.High)]
    .map(p => p.then((t: string) => order2.push(t)));
  await busy2; await Promise.all(jobs2);
  check("fair share", order2.join(",") === "low,high", order2.join(","));
  pool.reserveLow(10);
  check("reserveLow counted", pool.lowPendingMs() > 0);
  pool.releaseLow(10);
  check("releaseLow", pool.lowPendingMs() === 0);
  pool.terminate();
}

function keyOrder() {
  // key(a) <= key(b) exactly when a <= b (with -0 == +0), for awkward values.
  const vals = [0, -0, 1, -1, 1e-300, -1e-300, 5e-324, -5e-324, Infinity, -Infinity, 1.5, -1.5,
    Number.MAX_VALUE, -Number.MAX_VALUE, 2 ** 53, 2 ** 53 + 2, 0.1, 0.30000000000000004, 0.3];
  for (let i = 0; i < 2000; i++) vals.push((Math.random() - 0.5) * 10 ** (Math.random() * 40 - 20));
  const keys = orderedKeys(Float64Array.from(vals));
  const cmp = (i: number, j: number) => keys[2 * i] - keys[2 * j] || keys[2 * i + 1] - keys[2 * j + 1];
  let ok = true;
  for (let i = 0; i < vals.length && ok; i++) for (let j = 0; j < vals.length; j++) {
    const want = vals[i] < vals[j] ? -1 : vals[i] > vals[j] ? 1 : 0, got = Math.sign(cmp(i, j));
    if (want !== got) { ok = false; console.log("order", vals[i], vals[j], want, got); break; }
    const [h, l] = orderedKey(vals[i]);
    if (h !== keys[2 * i] || l !== keys[2 * i + 1]) { ok = false; break; }
  }
  const nanKey = orderedKeys(Float64Array.of(NaN, Infinity));
  check("ordered keys", ok && (nanKey[0] > nanKey[2] || (nanKey[0] === nanKey[2] && nanKey[1] > nanKey[3])));
}

async function gpu() {
  if (!(await isGPUAvailable())) { console.log("GPU: not available, skipped"); return; }
  const g = await ResidentGPU.create();
  for (const n of [1, 1000, 300_001]) {
    const x = data(n, 3), y = data(n, 5);
    const K1 = 7, K2 = 5;
    const c1 = new Uint32Array(n), c2 = new Uint32Array(n);
    for (let i = 0; i < n; i++) { c1[i] = i % K1; c2[i] = (i * 7919) % K2; }
    g.uploadKeys(`gx${n}`, x); g.uploadKeys(`gy${n}`, y);
    g.uploadU32(`gc1${n}`, c1); g.uploadU32(`gc2${n}`, c2);
    for (const [a, b, c, d] of [[-10, 20, 0, 100], [5, 5, -Infinity, Infinity], [-0, 0, -50, 150], [30, -30, 0, 1], [NaN, 1, 0, 1]]) {
      for (const big of [false, true]) {
        // big: a key space above the workgroup-local limit (global atomics path)
        const K = big ? K1 * K2 * 200 : K1 * K2;
        const got = await g.groupCount({ n, K, filters: [{ col: `gx${n}`, lo: a, hi: b }, { col: `gy${n}`, lo: c, hi: d }],
          dims: [{ col: `gc1${n}`, stride: big ? 200 * K2 : K2 }, { col: `gc2${n}`, stride: big ? 200 : 1 }] });
        const want = new Uint32Array(K);
        for (let i = 0; i < n; i++) if (x[i] >= a && x[i] <= b && y[i] >= c && y[i] <= d) want[big ? c1[i] * 200 * K2 + c2[i] * 200 : c1[i] * K2 + c2[i]]++;
        let ok = got.length === K;
        for (let k = 0; k < K && ok; k++) ok = got[k] === want[k];
        check(`GPU groupCount n=${n} [${a},${b}]x[${c},${d}]${big ? " global" : ""}`, ok);
      }
    }
  }
  g.destroy();
}

// ---------------------------------------------------------------------------
// Resident forms of the patterns through the paraweb namespace
// ---------------------------------------------------------------------------

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
};

async function api(label: string, pool: ResidentPool, n: number) {
  // Integer data, so that sums are exact in any order.
  const arr: number[] = [];
  let s = 3;
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; arr.push((s % 2001) - 1000); }
  const full = new Float64Array(new SharedArrayBuffer(8 * n || 8));
  full.set(arr);
  const key = `api-${label}-${n}`;
  const o = { pool, key };
  const L = `${label} n=${n}`;

  // Map: first call uploads, the second reuses the resident copy; fn(value, index).
  const m1 = await paraweb.shared.map((x: number, i: number) => x * 2 + i, arr, o);
  const m2 = await paraweb.map((x: number, i: number) => x * 2 + i, arr, o);
  const refM = arr.map((x, i) => x * 2 + i);
  check(`${L} api map`, same(m1, refM) && same(m2, refM));
  if (n > 0 && n < 50_000) check(`${L} api map = per-call shared map`, same(m1, await paraweb.shared.map((x: number, i: number) => x * 2 + i, arr, 4)));

  // Filter.
  const f = await paraweb.shared.filter((x: number) => x > 100, arr, o);
  check(`${L} api filter`, same(f, arr.filter(x => x > 100)));

  // Reduce, on the MP default entry point (resident forms always use shared memory).
  const sum = await paraweb.reduce((a: number, b: number) => a + b, arr, 0, o);
  check(`${L} api reduce sum`, sum === arr.reduce((a, b) => a + b, 0), `${sum}`);
  const mx = await paraweb.mp.reduce((a: number, b: number) => Math.max(a, b), arr, -Infinity, o);
  check(`${L} api reduce max`, mx === arr.reduce((a, b) => Math.max(a, b), -Infinity), `${mx}`);
  const sq = await paraweb.shared.reduce((a: number, b: number) => a + b, arr, 0, o, (x: number) => x * x);
  check(`${L} api reduce with mapFn`, sq === arr.reduce((a, x) => a + x * x, 0));

  // MapReduce.
  const cnt = await paraweb.shared.mapReduce((x: number) => (x >= 0 ? 1 : 0), (a: number, b: number) => a + b, arr, o);
  check(`${L} api mapReduce`, cnt === arr.filter(x => x >= 0).length, `${cnt}`);
  if (n > 0 && n < 50_000) check(`${L} api mapReduce = per-call`, cnt === await paraweb.shared.mapReduce((x: number) => (x >= 0 ? 1 : 0), (a: number, b: number) => a + b, arr, 4));

  // Input by name, input in place over a SharedArrayBuffer, input without key.
  const byName = await paraweb.reduce((a: number, b: number) => a + b, key, 0, { pool });
  check(`${L} api input by name`, byName === sum);
  check(`${L} api input in place`, (await paraweb.reduce((a: number, b: number) => a + b, full, 0, { pool })) === sum);
  check(`${L} api input without key`, (await paraweb.reduce((a: number, b: number) => a + b, arr, 0, { pool })) === sum);

  // A resident key keeps its data until refreshed.
  if (n > 0) {
    const changed = arr.map(x => x + 1);
    const stale = await paraweb.reduce((a: number, b: number) => a + b, changed, 0, o);
    const fresh = await paraweb.reduce((a: number, b: number) => a + b, changed, 0, { ...o, refresh: true });
    check(`${L} api key reuse and refresh`, stale === sum && fresh === sum + n, `${stale} ${fresh}`);
  }

  // Kernel forms: Map, Reduce (extent), MapReduce (histogram), Filter (change lists).
  if (n > 0) {
    const X = `kx-${label}-${n}`;
    pool.ensureColumn(X, "f64", full.buffer as SharedArrayBuffer);
    const out = new Float64Array(new SharedArrayBuffer(8 * n));
    await paraweb.map({ key: "api-neg", src: "const c = cols[0], o = bufs[0]; for (let i = start; i < end; i++) o[i] = -c[i];" },
      { pool, n, cols: [X], bufs: [{ buffer: out.buffer as SharedArrayBuffer, type: "f64" }] });
    check(`${L} api map kernel`, same(out, arr.map(x => -x)));

    const ext = await paraweb.reduce({ key: "api-ext", src: "const c = cols[0]; let lo = Infinity, hi = -Infinity; for (let i = start; i < end; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; } return [lo, hi];" },
      { pool, n, cols: [X], combine: (a: number[], b: number[]) => [Math.min(a[0], b[0]), Math.max(a[1], b[1])] });
    check(`${L} api reduce kernel`, ext[0] === Math.min(...arr) && ext[1] === Math.max(...arr));

    const K = 20;
    const r = await paraweb.mapReduce({
      map: { key: "api-h", src: `const c = cols[0], out = bufs[0], base = args.base; if (args.first) out.fill(0, base, base + ${K});
        for (let i = start; i < end; i++) { let k = Math.floor((c[i] + 1000) / 100.05); out[base + k] += 1; }` },
      combine: { key: "api-hc", src: "const p = bufs[0], d = bufs[1]; for (let k = start; k < end; k++) { let v = 0; for (let t = 0; t < args.T; t++) v += p[t * args.region + k]; d[k] = v; }" },
    }, { pool, n, keys: K, slots: 1, cols: [X] });
    const refH = new Array(K).fill(0);
    for (const x of arr) refH[Math.floor((x + 1000) / 100.05)]++;
    check(`${L} api mapReduce kernels`, same(r.final.subarray(0, K), refH));

    const state = new FilterState(n);
    const d = await paraweb.filter({ key: "api-f", prelude: "const c = cols[0];", cond: "c[i] > args.t" }, state, { pool, cols: [X], args: { t: 0 } });
    check(`${L} api filter kernel`, d.add.length === arr.filter(x => x > 0).length && d.rem.length === 0 && state.selected === d.add.length);
  }

  // Empty input keeps the identities of the per-call patterns.
  if (n === 0) {
    check(`${L} api empty`, (await paraweb.map((x: number) => x, [], { pool })).length === 0
      && (await paraweb.filter((x: number) => true, [], { pool })).length === 0
      && (await paraweb.reduce((a: number, b: number) => a + b, [], 5, { pool })) === 5
      && (await paraweb.mapReduce((x: number) => x, (a: number, b: number) => a * b, [], { pool })) === 1);
  }
}

(async () => {
  keyOrder();
  await gpu();
  for (const [label, factory, T] of [["threads=4", nodeWorkerFactory(), 4], ["threads=16", nodeWorkerFactory(), 16], ["inline", inlineWorkerFactory(), 1]] as const) {
    const pool = new ResidentPool(T, factory);
    for (const n of [1, 13, 100_003]) await suite(`${label} n=${n}`, pool, n);
    for (const n of [0, 1, 13, 100_003]) await api(label, pool, n);
    pool.terminate();
  }
  await scheduling();
  console.log(`${pass}/${pass + fail} resident checks passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
