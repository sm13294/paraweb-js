import { ParallelDivideAndConquer as ParallelDivideAndConquerMP } from "./patterns/divideAndConquer";
import { ParallelDivideAndConquerShared } from "./patterns/divideAndConquerShared";
import { ParallelFarm as ParallelFarmMP } from "./patterns/farm";
import { ParallelFarmShared } from "./patterns/farmShared";
import { ParallelFilter as ParallelFilterMP } from "./patterns/filter";
import { ParallelFilterShared } from "./patterns/filterShared";
import { ParallelMap as ParallelMapMP } from "./patterns/map";
import { ParallelMapShared } from "./patterns/mapShared";
import { ParallelMapReduce as ParallelMapReduceMP } from "./patterns/mapReduce";
import { ParallelMapReduceShared } from "./patterns/mapReduceShared";
import { ParallelPipeline as ParallelPipelineMP } from "./patterns/pipeline";
import { ParallelPipelineShared } from "./patterns/pipelineShared";
import { ParallelReduce as ParallelReduceMP } from "./patterns/reduce";
import { ParallelReduceShared } from "./patterns/reduceShared";
import { ParallelScan as ParallelScanMP } from "./patterns/scan";
import { ParallelScanShared } from "./patterns/scanShared";
import { ParallelScatter as ParallelScatterMP } from "./patterns/scatter";
import { ParallelScatterShared } from "./patterns/scatterShared";
import { ParallelStencil as ParallelStencilMP } from "./patterns/stencil";
import { ParallelStencilShared } from "./patterns/stencilShared";

// GPU variants (WebGPU compute shaders)
import { ParallelMapGPU } from "./patterns/mapGPU";
import { ParallelFilterGPU } from "./patterns/filterGPU";
import { ParallelReduceGPU } from "./patterns/reduceGPU";
import { ParallelScanGPU } from "./patterns/scanGPU";
import { ParallelMapReduceGPU } from "./patterns/mapReduceGPU";
import { ParallelScatterGPU } from "./patterns/scatterGPU";
import { ParallelStencilGPU } from "./patterns/stencilGPU";
import { ParallelFarmGPU } from "./patterns/farmGPU";
import { ParallelPipelineGPU } from "./patterns/pipelineGPU";
import { ParallelDivideAndConquerGPU } from "./patterns/divideAndConquerGPU";

// Smart per-pattern defaults (picked empirically in Section 6).
const ParallelDivideAndConquer = ParallelDivideAndConquerMP;
const ParallelPipeline = ParallelPipelineMP;
const ParallelReduce = ParallelReduceMP;
const ParallelScan = ParallelScanMP;
const ParallelScatter = ParallelScatterMP;
const ParallelStencil = ParallelStencilMP;

const ParallelFarm = ParallelFarmShared;
const ParallelFilter = ParallelFilterShared;
const ParallelMap = ParallelMapShared;
const ParallelMapReduce = ParallelMapReduceShared;

// Build a flat callable namespace. For each (pattern, variant) we expose a
// free function that instantiates the underlying class once per call and
// forwards all arguments. Pattern classes are stateless holders, and the
// worker pool is memoised inside `WorkerPool.getPool`, so per-call
// instantiation is free.
const call = (Cls: any, method: string) =>
  (...args: any[]) => new Cls()[method](...args);

const buildVariant = (
  Map_: any, Filter_: any, Reduce_: any, Scan_: any, Scatter_: any,
  Stencil_: any, Farm_: any, Pipeline_: any, Dac_: any, MapReduce_: any,
) => ({
  map:              call(Map_, "map"),
  filter:           call(Filter_, "filter"),
  reduce:           call(Reduce_, "reduce"),
  scan:             call(Scan_, "scan"),
  scatter:          call(Scatter_, "scatter"),
  stencil:          call(Stencil_, "stencil"),
  farm:             call(Farm_, "farm"),
  pipeline:         call(Pipeline_, "pipeline"),
  divideAndConquer: call(Dac_, "divideAndConquer"),
  mapReduce:        call(MapReduce_, "mapReduce"),
});

const paraweb: any = {
  // Smart-default entry points: paraweb.map(...), paraweb.reduce(...), etc.
  ...buildVariant(
    ParallelMap, ParallelFilter, ParallelReduce, ParallelScan,
    ParallelScatter, ParallelStencil, ParallelFarm, ParallelPipeline,
    ParallelDivideAndConquer, ParallelMapReduce,
  ),

  // Explicit variant namespaces: paraweb.mp.map(...), paraweb.shared.map(...),
  // paraweb.gpu.map(...), and so on for all ten patterns.
  mp: buildVariant(
    ParallelMapMP, ParallelFilterMP, ParallelReduceMP, ParallelScanMP,
    ParallelScatterMP, ParallelStencilMP, ParallelFarmMP, ParallelPipelineMP,
    ParallelDivideAndConquerMP, ParallelMapReduceMP,
  ),
  shared: buildVariant(
    ParallelMapShared, ParallelFilterShared, ParallelReduceShared, ParallelScanShared,
    ParallelScatterShared, ParallelStencilShared, ParallelFarmShared, ParallelPipelineShared,
    ParallelDivideAndConquerShared, ParallelMapReduceShared,
  ),
  gpu: buildVariant(
    ParallelMapGPU, ParallelFilterGPU, ParallelReduceGPU, ParallelScanGPU,
    ParallelScatterGPU, ParallelStencilGPU, ParallelFarmGPU, ParallelPipelineGPU,
    ParallelDivideAndConquerGPU, ParallelMapReduceGPU,
  ),

  // Class exports retained for advanced use and backward compatibility.
  ParallelDivideAndConquer,
  ParallelDivideAndConquerShared,
  ParallelDivideAndConquerMP,
  ParallelDivideAndConquerGPU,
  ParallelFarm,
  ParallelFarmShared,
  ParallelFarmMP,
  ParallelFarmGPU,
  ParallelFilter,
  ParallelFilterShared,
  ParallelFilterMP,
  ParallelFilterGPU,
  ParallelMap,
  ParallelMapShared,
  ParallelMapMP,
  ParallelMapGPU,
  ParallelMapReduce,
  ParallelMapReduceShared,
  ParallelMapReduceMP,
  ParallelMapReduceGPU,
  ParallelPipeline,
  ParallelPipelineShared,
  ParallelPipelineMP,
  ParallelPipelineGPU,
  ParallelReduce,
  ParallelReduceShared,
  ParallelReduceMP,
  ParallelReduceGPU,
  ParallelScan,
  ParallelScanShared,
  ParallelScanMP,
  ParallelScanGPU,
  ParallelScatter,
  ParallelScatterShared,
  ParallelScatterMP,
  ParallelScatterGPU,
  ParallelStencil,
  ParallelStencilShared,
  ParallelStencilMP,
  ParallelStencilGPU,
};

export = paraweb;
