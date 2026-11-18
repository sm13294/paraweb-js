/**
 * GPU side of ParaWeb's resident runtime (WebGPU).
 *
 * ParaWeb's GPU patterns (src/patterns/*GPU.ts) upload their input on every
 * call. Here columns are uploaded once and stay in GPU buffers; a query
 * sends only a few parameters and reads back a small result.
 *
 * Exact comparisons without f64. WGSL has no 64-bit floats, so a Float64
 * column is uploaded as order-preserving keys: the IEEE-754 bit pattern of
 * each value, with all bits inverted for negative values and the sign bit
 * set for the others, as two u32 words (high, low). For any two doubles
 * (with -0 written as +0 and no NaN), a <= b exactly when key(a) <= key(b)
 * in lexicographic u32 order, so range predicates on the GPU give the same
 * answer as in Float64 on the CPU. NaN is given the largest key, so it fails
 * every range with finite or infinite bounds, as `x >= lo && x <= hi` does.
 *
 * Pattern: groupCount = Filter + Map + MapReduce in one dispatch. Rows that
 * pass all range filters are counted per group key k = sum_d code_d[i] *
 * stride_d, where code_d are u32 columns (for example bin indexes computed
 * once on the CPU). Each workgroup counts into a workgroup-local histogram
 * (when the key space fits) and adds it to the global result at the end.
 */
import { getGPUDevice } from "../core/gpuContext";
import { getOrCreatePipeline } from "../core/gpuKernelCache";

declare const GPUBufferUsage: any;
declare const GPUMapMode: any;

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
// Little-endian: u32[1] holds the sign and exponent.
const HI = 1, LO = 0;

/** Order-preserving key of one double, as [high, low]. */
export function orderedKey(x: number): [number, number] {
  if (x !== x) return [0xffffffff, 0xffffffff];
  f64[0] = x === 0 ? 0 : x;
  const h = u32[HI], l = u32[LO];
  return h & 0x80000000 ? [(~h) >>> 0, (~l) >>> 0] : [(h | 0x80000000) >>> 0, l];
}

/** Keys of a whole column, interleaved [h0, l0, h1, l1, ...]. */
export function orderedKeys(col: ArrayLike<number>, out = new Uint32Array(2 * col.length)): Uint32Array {
  const n = col.length;
  const f = col instanceof Float64Array && col.byteOffset % 4 === 0 ? col : Float64Array.from(col);
  const w = new Uint32Array(f.buffer, f.byteOffset, 2 * n);
  for (let i = 0; i < n; i++) {
    let l = w[2 * i], h = w[2 * i + 1];
    if ((h & 0x7ff00000) === 0x7ff00000 && ((h & 0xfffff) | l) !== 0) { h = 0xffffffff; l = 0xffffffff; } // NaN
    else if (h === 0x80000000 && l === 0) { h = 0x80000000; } // -0 -> +0
    else if (h & 0x80000000) { h = ~h >>> 0; l = ~l >>> 0; }
    else h = (h | 0x80000000) >>> 0;
    out[2 * i] = h;
    out[2 * i + 1] = l;
  }
  return out;
}

export interface RangeFilterGPU {
  /** Key of a column uploaded with uploadKeys. */
  col: string;
  lo: number;
  hi: number;
}

export interface GroupDimGPU {
  /** Key of a u32 column uploaded with uploadU32. */
  col: string;
  stride: number;
}

export interface GroupCountCall {
  n: number;
  filters: RangeFilterGPU[];
  dims: GroupDimGPU[];
  /** Number of groups (keys are 0 .. K - 1). */
  K: number;
}

const WG = 256;
const LOCAL_MAX = 4096; // 16 KB of workgroup memory

function groupCountShader(nf: number, nd: number, strides: number[], K: number): string {
  const local = K <= LOCAL_MAX;
  const binds: string[] = [
    "@group(0) @binding(0) var<storage, read> P: array<u32>;",
    "@group(0) @binding(1) var<storage, read_write> outc: array<atomic<u32>>;",
  ];
  for (let j = 0; j < nf; j++) binds.push(`@group(0) @binding(${2 + j}) var<storage, read> f${j}: array<u32>;`);
  for (let d = 0; d < nd; d++) binds.push(`@group(0) @binding(${2 + nf + d}) var<storage, read> d${d}: array<u32>;`);
  const tests: string[] = [];
  for (let j = 0; j < nf; j++) {
    const p = 1 + 4 * j;
    tests.push(
      `let h${j} = f${j}[2u * i]; let l${j} = f${j}[2u * i + 1u];` +
      ` if (!(ge(h${j}, l${j}, P[${p}], P[${p + 1}]) && ge(P[${p + 2}], P[${p + 3}], h${j}, l${j}))) { continue; }`);
  }
  const key = nd ? strides.map((s, d) => `d${d}[i] * ${s}u`).join(" + ") : "0u";
  return `${binds.join("\n")}
${local ? `var<workgroup> hist: array<atomic<u32>, ${K}>;` : ""}
fn ge(ah: u32, al: u32, bh: u32, bl: u32) -> bool { return ah > bh || (ah == bh && al >= bl); }
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32,
        @builtin(num_workgroups) nwg: vec3<u32>) {
  ${local ? `for (var k = li; k < ${K}u; k += ${WG}u) { atomicStore(&hist[k], 0u); }\n  workgroupBarrier();` : ""}
  let n = P[0];
  let step = nwg.x * ${WG}u;
  for (var i = gid.x; i < n; i += step) {
    ${tests.join("\n    ")}
    let k = ${key};
    ${local ? "atomicAdd(&hist[k], 1u);" : "atomicAdd(&outc[k], 1u);"}
  }
  ${local ? `workgroupBarrier();
  for (var k = li; k < ${K}u; k += ${WG}u) {
    let v = atomicLoad(&hist[k]);
    if (v != 0u) { atomicAdd(&outc[k], v); }
  }` : ""}
}`;
}

interface Resident { buffer: GPUBuffer; length: number }

export class ResidentGPU {
  readonly device: GPUDevice;
  private bufs = new Map<string, Resident>();
  /** Workgroups per dispatch (grid-stride loop). */
  workgroups = 1024;
  lost = false;

  private constructor(device: GPUDevice) {
    this.device = device;
    device.lost.then(() => { this.lost = true; this.bufs.clear(); });
  }

  /** Uses ParaWeb's shared device (src/core/gpuContext.ts). */
  static async create(): Promise<ResidentGPU> {
    return new ResidentGPU(await getGPUDevice());
  }

  has(key: string): boolean { return this.bufs.has(key); }

  private upload(key: string, data: Uint32Array) {
    const old = this.bufs.get(key);
    if (old) old.buffer.destroy();
    const buffer = this.device.createBuffer({
      size: Math.max(16, Math.ceil(data.byteLength / 16) * 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Write in slices: some implementations limit a single writeBuffer.
    const SLICE = 1 << 24;
    for (let o = 0; o < data.length; o += SLICE) {
      let part = data.subarray(o, Math.min(data.length, o + SLICE));
      // Not every implementation accepts SharedArrayBuffer sources (Dawn in
      // Node.js does not): copy such slices into an ordinary buffer.
      if (typeof SharedArrayBuffer !== "undefined" && part.buffer instanceof SharedArrayBuffer) part = part.slice();
      this.device.queue.writeBuffer(buffer, o * 4, part.buffer as ArrayBuffer, part.byteOffset, part.byteLength);
    }
    this.bufs.set(key, { buffer, length: data.length });
  }

  /** Upload a Float64 column as order-preserving keys (8 bytes per row). */
  uploadKeys(key: string, col: ArrayLike<number>) {
    this.upload(key, orderedKeys(col));
  }

  /** Upload a u32 column (for example group codes or bin indexes). */
  uploadU32(key: string, col: Uint32Array | Int32Array) {
    this.upload(key, col instanceof Uint32Array ? col : new Uint32Array(col.buffer, col.byteOffset, col.length));
  }

  drop(keys: string[]) {
    for (const k of keys) {
      const r = this.bufs.get(k);
      if (r) { r.buffer.destroy(); this.bufs.delete(k); }
    }
  }

  private get(key: string): GPUBuffer {
    const r = this.bufs.get(key);
    if (!r) throw new Error(`GPU column not uploaded: ${key}`);
    return r.buffer;
  }

  /**
   * Count rows passing every range filter, grouped by key. Bounds with NaN
   * select nothing (as in Float64 on the CPU).
   */
  async groupCount(call: GroupCountCall): Promise<Uint32Array> {
    const { n, filters, dims, K } = call;
    if (filters.some(f => f.lo !== f.lo || f.hi !== f.hi) || n === 0) return new Uint32Array(K);
    const device = this.device;
    const code = groupCountShader(filters.length, dims.length, dims.map(d => d.stride), K);
    const pipeline = getOrCreatePipeline(device, code, "main");

    const P = new Uint32Array(1 + 4 * filters.length);
    P[0] = n;
    filters.forEach((f, j) => {
      const [lh, ll] = orderedKey(f.lo), [hh, hl] = orderedKey(f.hi);
      P.set([lh, ll, hh, hl], 1 + 4 * j);
    });
    const pBuf = device.createBuffer({ size: Math.max(16, P.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(pBuf, 0, P);
    const bytes = Math.max(16, K * 4);
    const out = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: pBuf } },
      { binding: 1, resource: { buffer: out } },
      ...filters.map((f, j) => ({ binding: 2 + j, resource: { buffer: this.get(f.col) } })),
      ...dims.map((d, j) => ({ binding: 2 + filters.length + j, resource: { buffer: this.get(d.col) } })),
    ];
    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const enc = device.createCommandEncoder();
    enc.clearBuffer(out);
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.min(this.workgroups, Math.ceil(n / WG)));
    pass.end();
    enc.copyBufferToBuffer(out, 0, staging, 0, bytes);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(staging.getMappedRange().slice(0, K * 4));
    staging.unmap();
    staging.destroy(); out.destroy(); pBuf.destroy();
    return result;
  }

  destroy() {
    this.drop([...this.bufs.keys()]);
  }
}
