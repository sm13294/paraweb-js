import { parentPort } from "node:worker_threads";

interface ConvMessage {
  input: SharedArrayBuffer;
  output: SharedArrayBuffer;
  width: number;
  height: number;
  kernel: number[];
  kernelSize: number;
  yStart: number;
  yEnd: number;
}

parentPort!.on("message", (msg: ConvMessage | string) => {
  if (msg === "terminate") return;
  const m = msg as ConvMessage;

  const inView = new Float32Array(m.input);
  const outView = new Float32Array(m.output);
  const w = m.width;
  const h = m.height;
  const k = m.kernel;
  const ks = m.kernelSize;
  const khalf = Math.floor(ks / 2);

  for (let y = m.yStart; y < m.yEnd; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let ky = -khalf; ky <= khalf; ky++) {
        const yy = y + ky;
        if (yy < 0 || yy >= h) continue;
        for (let kx = -khalf; kx <= khalf; kx++) {
          const xx = x + kx;
          if (xx < 0 || xx >= w) continue;
          acc += inView[yy * w + xx] * k[(ky + khalf) * ks + (kx + khalf)];
        }
      }
      outView[y * w + x] = acc;
    }
  }

  parentPort!.postMessage("done");
});
