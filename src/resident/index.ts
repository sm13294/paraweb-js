/**
 * ParaWeb resident runtime: persistent workers, resident shared columns,
 * cached string kernels and priority scheduling, with the Map, MapReduce,
 * Filter (with change detection), Scan + Scatter (counting sort) and Reduce
 * patterns restated for data that stays in the workers between calls.
 */
export * from "./residentPool";
export * from "./residentPatterns";
export { RESIDENT_WORKER_SOURCE, residentWorkerMain } from "./residentWorker";
export { ResidentGPU, orderedKey, orderedKeys } from "./residentGPU";
export type { GroupCountCall, GroupDimGPU, RangeFilterGPU } from "./residentGPU";
export {
  map, filter, reduce, mapReduce, isResidentCall, isResidentOptions, isKernel, isMapReduceKernels, isPredicate,
} from "./residentApi";
export type {
  ResidentOptions, ResidentInput, KernelCall, MapReduceKernels, MapReduceKernelCall, FilterKernelCall, ReduceKernelCall,
} from "./residentApi";
