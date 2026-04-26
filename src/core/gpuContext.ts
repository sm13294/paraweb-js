/**
 * GPU Context - Singleton management of WebGPU device.
 * Provides GPU device acquisition, caching, and availability detection.
 */

let cachedGPU: GPU | null | undefined = undefined; // undefined = not yet checked
let cachedDevice: GPUDevice | null = null;

/**
 * Check if WebGPU is available in the current environment.
 */
export async function isGPUAvailable(): Promise<boolean> {
  try {
    const gpu = getGPU();
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

/**
 * Get or create a cached GPU instance (singleton).
 */
function getGPU(): GPU | null {
  if (cachedGPU !== undefined) return cachedGPU;

  // Browser environment
  if (typeof navigator !== "undefined" && navigator.gpu) {
    cachedGPU = navigator.gpu;
    return cachedGPU;
  }

  // Node.js: try the 'webgpu' npm package (Dawn-based)
  try {
    const webgpu = require("webgpu");
    // Register WebGPU globals (GPUBufferUsage, GPUMapMode, etc.)
    if (webgpu.globals) {
      for (const [key, value] of Object.entries(webgpu.globals)) {
        if (!(key in globalThis)) {
          (globalThis as any)[key] = value;
        }
      }
    }
    if (webgpu.create) {
      cachedGPU = webgpu.create([]) as GPU;
      return cachedGPU;
    }
    cachedGPU = webgpu.gpu || null;
    return cachedGPU as GPU | null;
  } catch {
    cachedGPU = null;
    return null;
  }
}

/**
 * Get or create a cached GPUDevice.
 */
export async function getGPUDevice(): Promise<GPUDevice> {
  if (cachedDevice) return cachedDevice;

  const gpu = getGPU();
  if (!gpu) {
    throw new Error(
      "WebGPU is not available. Install the 'webgpu' npm package for Node.js, or use a WebGPU-capable browser."
    );
  }

  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error("Failed to get GPU adapter. No compatible GPU found.");
  }

  cachedDevice = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
      maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
    },
  });

  cachedDevice.lost.then(() => {
    cachedDevice = null;
  });

  return cachedDevice;
}

/**
 * Release the cached GPU device.
 */
export function releaseGPUDevice(): void {
  if (cachedDevice) {
    cachedDevice.destroy();
    cachedDevice = null;
  }
}
