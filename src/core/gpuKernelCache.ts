/**
 * GPU Kernel Cache - Caches compiled compute pipelines to avoid recompilation.
 */

// Keyed by device first: a pipeline belongs to the device that created it,
// so after a device loss and re-acquisition the old entries must not be
// reused. A WeakMap also lets destroyed devices and their pipelines be
// collected.
let pipelineCache = new WeakMap<GPUDevice, Map<string, GPUComputePipeline>>();

/**
 * Get or create a cached compute pipeline for the given shader source.
 */
export function getOrCreatePipeline(
  device: GPUDevice,
  shaderSource: string,
  entryPoint: string = "main",
  bindGroupLayout?: GPUBindGroupLayout
): GPUComputePipeline {
  const key = shaderSource + "::" + entryPoint;

  let perDevice = pipelineCache.get(device);
  if (!perDevice) {
    perDevice = new Map();
    pipelineCache.set(device, perDevice);
  }
  const cached = perDevice.get(key);
  if (cached) return cached;

  const shaderModule = device.createShaderModule({ code: shaderSource });

  const pipelineDesc: GPUComputePipelineDescriptor = {
    layout: bindGroupLayout
      ? device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] })
      : "auto",
    compute: {
      module: shaderModule,
      entryPoint,
    },
  };

  const pipeline = device.createComputePipeline(pipelineDesc);
  perDevice.set(key, pipeline);
  return pipeline;
}

/**
 * Clear the pipeline cache (useful for cleanup or testing).
 */
export function clearPipelineCache(): void {
  pipelineCache = new WeakMap();
}
