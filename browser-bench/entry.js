// Entry point for esbuild to create a browser-compatible bundle of GPU pattern classes.
const { ParallelMapGPU }      = require("../dist/patterns/mapGPU");
const { ParallelFilterGPU }   = require("../dist/patterns/filterGPU");
const { ParallelReduceGPU }   = require("../dist/patterns/reduceGPU");
const { ParallelScanGPU }     = require("../dist/patterns/scanGPU");
const { ParallelMapReduceGPU }= require("../dist/patterns/mapReduceGPU");
const { ParallelScatterGPU }  = require("../dist/patterns/scatterGPU");
const { ParallelStencilGPU }  = require("../dist/patterns/stencilGPU");
const { ParallelFarmGPU }     = require("../dist/patterns/farmGPU");
const { ParallelPipelineGPU } = require("../dist/patterns/pipelineGPU");
const { ParallelDivideAndConquerGPU } = require("../dist/patterns/divideAndConquerGPU");
const { isGPUAvailable }      = require("../dist/core/gpuContext");

window.PW_GPU = {
  Map: ParallelMapGPU,
  Filter: ParallelFilterGPU,
  Reduce: ParallelReduceGPU,
  Scan: ParallelScanGPU,
  MapReduce: ParallelMapReduceGPU,
  Scatter: ParallelScatterGPU,
  Stencil: ParallelStencilGPU,
  Farm: ParallelFarmGPU,
  Pipeline: ParallelPipelineGPU,
  DivideAndConquer: ParallelDivideAndConquerGPU,
  isGPUAvailable,
};
