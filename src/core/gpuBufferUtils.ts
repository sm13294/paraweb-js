/**
 * GPU Buffer Utilities - Helpers for creating, uploading, and reading back GPU buffers.
 * WebGPU compute shaders only support f32, so all data is converted to Float32Array.
 */

/**
 * Create a GPU storage buffer and upload data to it.
 */
export function createInputBuffer(device: GPUDevice, data: Float32Array): GPUBuffer {
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Float32Array(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
}

/**
 * Create a GPU storage buffer for output (read/write from shader, copy source for readback).
 */
export function createOutputBuffer(device: GPUDevice, sizeInBytes: number): GPUBuffer {
  return device.createBuffer({
    size: sizeInBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    mappedAtCreation: false,
  });
}

/**
 * Create a GPU storage buffer for read-write use in shaders (e.g., atomic counters).
 */
export function createReadWriteBuffer(device: GPUDevice, sizeInBytes: number): GPUBuffer {
  return device.createBuffer({
    size: sizeInBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    mappedAtCreation: false,
  });
}

/**
 * Create a uniform buffer and write data to it.
 */
export function createUniformBuffer(device: GPUDevice, data: ArrayBuffer): GPUBuffer {
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data));
  buffer.unmap();
  return buffer;
}

/**
 * Read back data from a GPU buffer to a Float32Array.
 */
export async function readbackBuffer(
  device: GPUDevice,
  srcBuffer: GPUBuffer,
  sizeInBytes: number
): Promise<Float32Array> {
  const stagingBuffer = device.createBuffer({
    size: sizeInBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(srcBuffer, 0, stagingBuffer, 0, sizeInBytes);
  device.queue.submit([encoder.finish()]);

  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(stagingBuffer.getMappedRange().slice(0));
  stagingBuffer.unmap();
  stagingBuffer.destroy();

  return result;
}

/**
 * Read back Uint32 data from a GPU buffer.
 */
export async function readbackUint32Buffer(
  device: GPUDevice,
  srcBuffer: GPUBuffer,
  sizeInBytes: number
): Promise<Uint32Array> {
  const stagingBuffer = device.createBuffer({
    size: sizeInBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(srcBuffer, 0, stagingBuffer, 0, sizeInBytes);
  device.queue.submit([encoder.finish()]);

  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const result = new Uint32Array(stagingBuffer.getMappedRange().slice(0));
  stagingBuffer.unmap();
  stagingBuffer.destroy();

  return result;
}

/**
 * Convert number[] to Float32Array for GPU upload.
 */
export function toFloat32(data: number[]): Float32Array {
  return new Float32Array(data);
}

/**
 * Convert Float32Array back to number[].
 */
export function toNumberArray(data: Float32Array): number[] {
  return Array.from(data);
}
