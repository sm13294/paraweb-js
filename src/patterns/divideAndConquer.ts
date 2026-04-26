import { defaultNumThreads } from "../utils/utilities";
import { WorkerPool } from "../core/workerPool";
import { bitReversePermute, isPowerOfTwo } from "../core/fftUtils";

interface ParallelDivideAndConquerInterface {
  divideAndConquer(
    divideFn: Function,
    conquerFn: Function,
    baseCaseFn: Function,
    inputData: any,
    numThreads?: number
  ): Promise<any>;
}

// Tree node used to track the divide structure for recombination
type DivideNode =
  | { type: "leaf"; leafIndex: number; data: any }
  | { type: "branch"; children: DivideNode[] };

class ParallelDivideAndConquer implements ParallelDivideAndConquerInterface {
  /**
   * Recursively divide on the main thread until we have enough leaf
   * subproblems to fill all workers. Returns a tree structure that
   * records how to recombine results, plus a flat list of leaves.
   */
  private expandToLeaves(
    divideFn: Function,
    baseCaseFn: Function,
    inputData: any,
    targetLeaves: number
  ): { tree: DivideNode; leaves: any[] } {
    const leaves: any[] = [];

    const expand = (data: any, depth: number): DivideNode => {
      // Base case or enough leaves already
      if (baseCaseFn(data) || leaves.length >= targetLeaves) {
        const idx = leaves.length;
        leaves.push(data);
        return { type: "leaf", leafIndex: idx, data };
      }

      const subproblems = divideFn(data);
      if (!Array.isArray(subproblems) || subproblems.length === 0) {
        const idx = leaves.length;
        leaves.push(data);
        return { type: "leaf", leafIndex: idx, data };
      }

      if (subproblems.length === 1) {
        return expand(subproblems[0], depth + 1);
      }

      // Keep dividing if we have not reached enough leaves yet
      if (leaves.length + subproblems.length < targetLeaves) {
        const children = subproblems.map((sp: any) => expand(sp, depth + 1));
        return { type: "branch", children };
      }

      // We have enough — make these subproblems into leaves
      const children = subproblems.map((sp: any) => {
        const idx = leaves.length;
        leaves.push(sp);
        return { type: "leaf", leafIndex: idx, data: sp } as DivideNode;
      });
      return { type: "branch", children };
    };

    const tree = expand(inputData, 0);
    return { tree, leaves };
  }

  /**
   * Reconstruct the result tree from flat worker results using the
   * divide tree structure, applying conquerFn at each branch.
   */
  private recombine(
    conquerFn: Function,
    tree: DivideNode,
    leafResults: any[]
  ): any {
    if (tree.type === "leaf") {
      return leafResults[tree.leafIndex];
    }
    const childResults = tree.children.map((child: DivideNode) =>
      this.recombine(conquerFn, child, leafResults)
    );
    return conquerFn(childResults);
  }

  async divideAndConquer(
    divideFn: Function,
    conquerFn: Function,
    baseCaseFn: Function,
    inputData: any,
    numThreads: number = defaultNumThreads
  ): Promise<any> {
    // Single thread: run entirely sequentially
    if (numThreads <= 1) {
      return this.solveSequential(divideFn, conquerFn, baseCaseFn, inputData);
    }

    // Expand the divide tree on the main thread until we have >= numThreads leaves
    const { tree, leaves } = this.expandToLeaves(
      divideFn,
      baseCaseFn,
      inputData,
      numThreads * 2 // aim for ~2x leaves per thread for better load balancing
    );

    // If only 1 leaf, no parallelism possible
    if (leaves.length <= 1) {
      return this.solveSequential(divideFn, conquerFn, baseCaseFn, inputData);
    }

    // Distribute leaves to workers
    const workerCount = Math.min(numThreads, leaves.length);
    const pool = WorkerPool.getPool(
      "./dist/workers/divideAndConquerWorker.js",
      workerCount
    );

    // Round-robin assign leaves to worker groups
    const taskGroups: Array<Array<{ index: number; data: any }>> = Array.from(
      { length: workerCount },
      () => []
    );
    leaves.forEach((leaf, index) => {
      taskGroups[index % workerCount].push({ index, data: leaf });
    });

    const messages = taskGroups.map((group) => ({
      divideFn: divideFn.toString(),
      conquerFn: conquerFn.toString(),
      baseCaseFn: baseCaseFn.toString(),
      tasks: group,
    }));

    const groupedResults = await pool.execAll(messages);

    // Collect flat leaf results
    const leafResults = new Array(leaves.length);
    groupedResults.flat().forEach((entry: { index: number; result: any }) => {
      leafResults[entry.index] = entry.result;
    });

    // Recombine using the tree structure
    return this.recombine(conquerFn, tree, leafResults);
  }

  private solveSequential(
    divideFn: Function,
    conquerFn: Function,
    baseCaseFn: Function,
    inputData: any
  ): any {
    if (baseCaseFn(inputData)) {
      return inputData;
    }

    const subproblems = divideFn(inputData);
    if (!Array.isArray(subproblems) || subproblems.length === 0) {
      return inputData;
    }
    if (subproblems.length === 1) {
      return this.solveSequential(divideFn, conquerFn, baseCaseFn, subproblems[0]);
    }

    const subResults = subproblems.map((sp: any) =>
      this.solveSequential(divideFn, conquerFn, baseCaseFn, sp)
    );
    return conquerFn(subResults);
  }

  /**
   * Parallel Cooley-Tukey radix-2 FFT (MP variant). The main thread bit-reverses
   * the input and splits it into `p` equal-size chunks; each worker runs the
   * local stages (butterfly span <= chunk length) on its chunk and ships the
   * result back. The remaining log2(p) global stages — whose butterflies span
   * across worker chunks — run on the main thread after merging the results.
   */
  async fft(
    complexData: Float64Array | number[],
    numThreads: number = defaultNumThreads
  ): Promise<Float64Array> {
    const N = (complexData.length / 2) | 0;
    if (N <= 1) return Float64Array.from(complexData as ArrayLike<number>);
    if (!isPowerOfTwo(N)) throw new Error(`fft: N must be power of two, got ${N}`);

    const data = new Float64Array(2 * N);
    if (complexData instanceof Float64Array) data.set(complexData);
    else for (let i = 0; i < 2 * N; i++) data[i] = (complexData as number[])[i];
    bitReversePermute(data);

    const bits = Math.log2(N) | 0;
    let p = Math.max(1, Math.min(numThreads, N >> 1));
    // p must divide N and be a power of two so each worker holds a power-of-two
    // chunk of consecutive complex points (local stages are a self-contained FFT).
    while (!isPowerOfTwo(p)) p--;
    const chunkN = N / p;            // power of two
    const localBits = Math.log2(chunkN) | 0;

    if (p > 1) {
      const pool = WorkerPool.getPool("./dist/workers/fftWorker.js", p);
      const messages = Array.from({ length: p }, (_, w) => ({
        chunk: Array.from(data.subarray(w * 2 * chunkN, (w + 1) * 2 * chunkN)),
        chunkN,
      }));
      const results = await pool.execAll(messages) as number[][];
      for (let w = 0; w < p; w++) {
        for (let i = 0; i < 2 * chunkN; i++) data[w * 2 * chunkN + i] = results[w][i];
      }
    } else {
      // Single-thread path: do the local stages inline so we still cover the
      // local-stages portion of the algorithm before falling through to global.
      this.fftStagesInPlace(data, N, 1, localBits);
    }

    // Remaining global stages on the main thread.
    if (localBits < bits) this.fftStagesInPlace(data, N, localBits + 1, bits);
    return data;
  }

  private fftStagesInPlace(data: Float64Array, N: number, fromStage: number, toStage: number): void {
    for (let s = fromStage; s <= toStage; s++) {
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
  }
}

export { ParallelDivideAndConquer };
