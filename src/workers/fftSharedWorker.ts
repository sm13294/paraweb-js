/**
 * Parallel Cooley-Tukey FFT worker (Shared variant). Per-stage dispatch model:
 * the main thread sends one message per stage, workers compute their slice of
 * butterflies, post `done`, and the main thread issues the next stage. The
 * shared data buffer stays on the worker side so each round-trip transfers
 * only the small uniform — log2(N) round-trips total.
 */
const { parentPort } = require("node:worker_threads");

interface FFTStageMessage {
  dataBuffer: SharedArrayBuffer;
  N: number;
  numWorkers: number;
  workerId: number;
  stage: number;
}

export type Message = FFTStageMessage | string;

parentPort.on("message", (message: Message) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
    return;
  }
  try {
    const { dataBuffer, N, numWorkers, workerId, stage } = message as FFTStageMessage;
    const data = new Float64Array(dataBuffer);
    const totalButterflies = N >>> 1;
    const per = Math.ceil(totalButterflies / numWorkers);
    const start = Math.min(workerId * per, totalButterflies);
    const end = Math.min(start + per, totalButterflies);

    const m = 1 << stage;
    const half = m >> 1;
    const angleStep = -2 * Math.PI / m;
    for (let t = start; t < end; t++) {
      const j = t % half;
      const lo = ((t / half) | 0) * m + j;
      const hi = lo + half;
      const wRe = Math.cos(angleStep * j);
      const wIm = Math.sin(angleStep * j);
      const oRe = data[2 * hi],     oIm = data[2 * hi + 1];
      const tRe = wRe * oRe - wIm * oIm;
      const tIm = wRe * oIm + wIm * oRe;
      const eRe = data[2 * lo],     eIm = data[2 * lo + 1];
      data[2 * hi]     = eRe - tRe;
      data[2 * hi + 1] = eIm - tIm;
      data[2 * lo]     = eRe + tRe;
      data[2 * lo + 1] = eIm + tIm;
    }
    parentPort.postMessage("done");
  } catch (error) {
    console.error("Error in fftSharedWorker:", error);
    parentPort.postMessage("error");
  }
});
