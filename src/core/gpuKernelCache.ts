/**
 * GPU Kernel Cache - Caches compiled compute pipelines to avoid recompilation.
 */

const pipelineCache = new Map<string, GPUComputePipeline>();

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

  const cached = pipelineCache.get(key);
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
  pipelineCache.set(key, pipeline);
  return pipeline;
}

/**
 * Clear the pipeline cache (useful for cleanup or testing).
 */
export function clearPipelineCache(): void {
  pipelineCache.clear();
}
