/**
 * FFT utilities — sequential reference and shared helpers used by the CPU and
 * GPU D&C variants. The Cooley-Tukey radix-2 FFT is implemented bottom-up
 * (iterative) so that every parallel variant can mirror the same stage
 * structure: log2(N) stages, each with N/2 independent butterflies.
 *
 * Complex numbers are stored interleaved in a Float64Array (CPU) or
 * Float32Array (GPU): [re0, im0, re1, im1, ...]. So a transform of N points
 * uses an array of length 2*N.
 */

/** Reverse the low `bits` bits of `x`. Used for the FFT bit-reversal permutation. */
export function bitReverse(x: number, bits: number): number {
  let r = 0;
  for (let i = 0; i < bits; i++) {
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  return r >>> 0;
}

/** True iff n is a positive power of two. */
export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Round n up to the next power of two. */
export function nextPow2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Build a real-valued complex input of N points (interleaved, im=0).
 * `make(i)` supplies the real part for index i.
 */
export function makeComplexFromReal(N: number, make: (i: number) => number): Float64Array {
  const buf = new Float64Array(2 * N);
  for (let i = 0; i < N; i++) buf[2 * i] = make(i);
  return buf;
}

/**
 * Sequential, in-place Cooley-Tukey radix-2 FFT on an interleaved complex
 * array of length 2*N (N must be a power of two). This is the reference used
 * to validate parallel variants.
 */
export function fftSequential(data: Float64Array): Float64Array {
  const N = data.length / 2;
  if (!isPowerOfTwo(N)) throw new Error("fftSequential: N must be power of two, got " + N);
  if (N <= 1) return data;
  const bits = Math.log2(N) | 0;

  // Bit-reversal permutation.
  for (let i = 0; i < N; i++) {
    const j = bitReverse(i, bits);
    if (j > i) {
      const ar = data[2 * i],     ai = data[2 * i + 1];
      data[2 * i]     = data[2 * j];     data[2 * i + 1] = data[2 * j + 1];
      data[2 * j]     = ar;               data[2 * j + 1] = ai;
    }
  }

  // log2(N) stages of butterflies.
  for (let s = 1; s <= bits; s++) {
    const m = 1 << s;
    const half = m >> 1;
    const angleStep = -2 * Math.PI / m;
    for (let k = 0; k < N; k += m) {
      for (let j = 0; j < half; j++) {
        const wRe = Math.cos(angleStep * j);
        const wIm = Math.sin(angleStep * j);
        const oRe = data[2 * (k + j + half)],     oIm = data[2 * (k + j + half) + 1];
        const tRe = wRe * oRe - wIm * oIm;
        const tIm = wRe * oIm + wIm * oRe;
        const eRe = data[2 * (k + j)],            eIm = data[2 * (k + j) + 1];
        data[2 * (k + j + half)]     = eRe - tRe;
        data[2 * (k + j + half) + 1] = eIm - tIm;
        data[2 * (k + j)]            = eRe + tRe;
        data[2 * (k + j) + 1]        = eIm + tIm;
      }
    }
  }
  return data;
}

/**
 * In-place bit-reversal permutation of a complex array. Used by parallel
 * variants before the butterfly stages.
 */
export function bitReversePermute(data: Float64Array): void {
  const N = data.length / 2;
  if (!isPowerOfTwo(N)) throw new Error("bitReversePermute: N must be power of two");
  const bits = Math.log2(N) | 0;
  for (let i = 0; i < N; i++) {
    const j = bitReverse(i, bits);
    if (j > i) {
      const ar = data[2 * i], ai = data[2 * i + 1];
      data[2 * i]     = data[2 * j];     data[2 * i + 1] = data[2 * j + 1];
      data[2 * j]     = ar;               data[2 * j + 1] = ai;
    }
  }
}
