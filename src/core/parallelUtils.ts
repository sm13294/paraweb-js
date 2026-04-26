const buildRanges = (length: number, numThreads: number) => {
  const chunkSize = Math.ceil(length / numThreads);
  return Array.from({ length: numThreads }, (_, i) => {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, length);
    return { start, end };
  });
};

const chunkArray = <T>(input: Array<T>, numThreads: number): Array<Array<T>> => {
  const chunkSize = Math.ceil(input.length / numThreads);
  return Array.from({ length: numThreads }, (_, i) =>
    input.slice(i * chunkSize, (i + 1) * chunkSize)
  );
};

const detectIdentityElement = (fn: Function, initialValue: number): number => {
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
    // Ignore and fall back to initialValue
  }

  if (initialValue === 1) {
    return 1;
  }

  return 0;
};

const initSharedFloat64 = (length: number, fill?: number) => {
  const buffer = new SharedArrayBuffer(
    Float64Array.BYTES_PER_ELEMENT * length
  );
  const view = new Float64Array(buffer);
  if (fill !== undefined) {
    view.fill(fill);
  }
  return { buffer, view };
};

const initSharedInt32 = (length: number, fill?: number) => {
  const buffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * length
  );
  const view = new Int32Array(buffer);
  if (fill !== undefined) {
    view.fill(fill);
  }
  return { buffer, view };
};

const initSharedUint8 = (length: number, fill?: number) => {
  const buffer = new SharedArrayBuffer(
    Uint8Array.BYTES_PER_ELEMENT * length
  );
  const view = new Uint8Array(buffer);
  if (fill !== undefined) {
    view.fill(fill);
  }
  return { buffer, view };
};

const initSharedFloat64FromArray = (input: Array<number>) => {
  const { buffer, view } = initSharedFloat64(input.length);
  for (let i = 0; i < input.length; i++) {
    view[i] = input[i];
  }
  return { buffer, view };
};

const initSharedInt32FromArray = (input: Array<number>) => {
  const { buffer, view } = initSharedInt32(input.length);
  for (let i = 0; i < input.length; i++) {
    view[i] = input[i];
  }
  return { buffer, view };
};

export {
  buildRanges,
  chunkArray,
  detectIdentityElement,
  initSharedFloat64,
  initSharedInt32,
  initSharedUint8,
  initSharedFloat64FromArray,
  initSharedInt32FromArray,
};
