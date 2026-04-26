export const buildChunks = (input, threads) => {
  const chunkSize = Math.ceil(input.length / threads);
  return Array.from({ length: threads }, (_, i) =>
    input.slice(i * chunkSize, (i + 1) * chunkSize)
  );
};

export const buildRanges = (length, threads) => {
  const chunkSize = Math.ceil(length / threads);
  return Array.from({ length: threads }, (_, i) => {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, length);
    return { start, end };
  });
};

export const createWorkerUrl = (source) => {
  const blob = new Blob([source], { type: "application/javascript" });
  return URL.createObjectURL(blob);
};

export const ensureSharedArrayBuffer = () => {
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error(
      "SharedArrayBuffer is not available. Enable cross-origin isolation (COOP/COEP)."
    );
  }
  if (typeof crossOriginIsolated !== "undefined" && !crossOriginIsolated) {
    throw new Error(
      "SharedArrayBuffer requires cross-origin isolation (COOP/COEP)."
    );
  }
};

export const detectIdentityElement = (fn, initialValue) => {
  try {
    const testValue = 5;
    const resultWith0 = fn(0, testValue);
    if (resultWith0 === testValue && typeof resultWith0 === "number") {
      return 0;
    }
    const resultWith1 = fn(1, testValue);
    if (resultWith1 === testValue && typeof resultWith1 === "number") {
      return 1;
    }
  } catch (e) {
    // Fall back to initialValue
  }
  if (initialValue === 1) {
    return 1;
  }
  return 0;
};

export const initSharedFloat64 = (length, fill) => {
  const buffer = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * length);
  const view = new Float64Array(buffer);
  if (fill !== undefined) {
    view.fill(fill);
  }
  return { buffer, view };
};

export const initSharedInt32 = (length, fill) => {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * length);
  const view = new Int32Array(buffer);
  if (fill !== undefined) {
    view.fill(fill);
  }
  return { buffer, view };
};

export const initSharedUint8 = (length, fill) => {
  const buffer = new SharedArrayBuffer(Uint8Array.BYTES_PER_ELEMENT * length);
  const view = new Uint8Array(buffer);
  if (fill !== undefined) {
    view.fill(fill);
  }
  return { buffer, view };
};

export const initSharedFloat64FromArray = (input) => {
  const { buffer, view } = initSharedFloat64(input.length);
  for (let i = 0; i < input.length; i++) {
    view[i] = input[i];
  }
  return { buffer, view };
};

export const initSharedInt32FromArray = (input) => {
  const { buffer, view } = initSharedInt32(input.length);
  for (let i = 0; i < input.length; i++) {
    view[i] = input[i];
  }
  return { buffer, view };
};
