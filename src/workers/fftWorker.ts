/**
 * Cooley-Tukey FFT worker (MP variant). Each worker receives a chunk of the
 * already bit-reversed input (interleaved [re, im] in a regular array), runs
 * the local stages (butterfly span <= chunk length), and posts the resulting
 * chunk back to the main thread. The remaining log2(p) global stages run on
 * the main thread because their butterflies span across worker chunks and
 * cannot proceed without merging the data.
 */
const { parentPort } = require("node:worker_threads");

interface FFTMessage {
  chunk: number[];          // interleaved complex, length 2*chunkN
  chunkN: number;           // power of two; number of complex points in chunk
}

export type Message = FFTMessage | string;

parentPort.on("message", (message: Message) => {
  if (typeof message === "string") {
    if (message === "terminate") {
      parentPort.postMessage("terminated");
      parentPort.close();
    }
    return;
  }
  try {
    const { chunk, chunkN } = message as FFTMessage;
    const data = chunk; // mutate in place
    const bits = Math.log2(chunkN) | 0;
    for (let s = 1; s <= bits; s++) {
      const m = 1 << s;
      const half = m >> 1;
      const angleStep = -2 * Math.PI / m;
      for (let k = 0; k < chunkN; k += m) {
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
    parentPort.postMessage(data);
  } catch (error) {
    console.error("Error in fftWorker:", error);
    parentPort.postMessage("error");
  }
});
