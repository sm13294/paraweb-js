# ParaWeb

[![npm](https://img.shields.io/npm/v/paraweb.svg)](https://www.npmjs.com/package/paraweb)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

ParaWeb is a TypeScript library of ten parallel programming patterns for Node.js Worker Threads, browser Web Workers, and WebGPU compute shaders. Each pattern exposes three implementation variants (Message Passing, SharedArrayBuffer, GPU) under a single calling convention, so switching between them is a single property access.

**Live demos**: [https://paraweb-js.vercel.app](https://paraweb-js.vercel.app) — interactive per-pattern demos, an all-pattern benchmark dashboard, and an image-convolution case study, running entirely in the browser on MP / Shared / GPU.

## Patterns

| Pattern | Description | Default variant |
|---|---|---|
| `map` | Transform each element | Shared |
| `filter` | Keep elements matching a predicate | Shared |
| `reduce` | Aggregate to a single value (associative operator) | MP |
| `scan` | Inclusive prefix scan (associative operator) | MP |
| `scatter` | Redistribute values by an index array | MP |
| `farm` | Distribute variable-cost tasks across workers | Shared |
| `pipeline` | Sequential stages with intra-stage data parallelism | MP |
| `divideAndConquer` | Recursive problem decomposition | MP |
| `stencil` | Neighborhood computation with overlap regions | MP |
| `mapReduce` | Fused map then reduce | Shared |

## Installation

```bash
npm install paraweb
```

The Shared variants require `SharedArrayBuffer`. In Node.js this is available by default. In the browser, the page must be served with cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`).

The GPU variants require WebGPU. In modern browsers (Chrome 113+, Edge 113+, Firefox 121+, Safari 18+) this is built in. In Node.js, install the optional `webgpu` peer dependency (Dawn-based).

## Quick start

Switching between the three variants is a single property access. The call site is otherwise identical.

```ts
import paraweb from "paraweb";

const f = (x: number) => Math.sin(x) * Math.cos(x * 0.5);
const input = Array.from({ length: 1_000_000 }, (_, i) => i);

const y1 = await paraweb.mp.map(f, input);      // Worker Threads, postMessage
const y2 = await paraweb.shared.map(f, input);  // SharedArrayBuffer, zero-copy
const y3 = await paraweb.gpu.map(               // WebGPU compute shader
  { wgsl: "sin(x) * cos(x * 0.5)" }, input);
```

The bare `paraweb.<pattern>` entry points select the empirically best variant per pattern (see the paper's Section 6 for the full evaluation):

```ts
const y = await paraweb.map(f, input);  // uses Shared internally
```

## Composition

Patterns return `Promise`s and compose with ordinary JavaScript control flow:

```ts
import paraweb from "paraweb";

const denoise  = (x: number) => 0.25 * x + 0.5 * x + 0.25 * x;
const features = (x: number) => Math.tanh(x);
const classify = (x: number) => x > 0.5 ? 1 : 0;

const result = await paraweb.pipeline(
  [denoise, features, classify], pixels, /* threads */ 16);
```

## Public API

```ts
// Data-parallel
paraweb.map(fn, input, threads?);
paraweb.filter(pred, input, threads?);
paraweb.reduce(op, input, identity, threads?);
paraweb.scan(op, input, identity, threads?);
paraweb.scatter(input, indices, default?, conflictFn?, threads?);

// Task-parallel
paraweb.farm(fn, input, threads?);
paraweb.pipeline(stages, input, threads?);
paraweb.divideAndConquer(divideFn, conquerFn, baseFn, input, threads?);

// Specialized
paraweb.stencil(fn, input, window, threads?, edgeOption?);
paraweb.mapReduce(mapFn, reduceOp, input, threads?);
```

Each call returns a `Promise`. `threads` defaults to the number of available CPU cores.

## Constraints

- The user-supplied function passed to a worker must be **self-contained**. Functions are reconstructed inside workers via `new Function()`, which does not preserve the caller's lexical scope. References to external helpers or to captured variables from the enclosing scope will throw at execution time. Inline the helper logic inside the function body, or pass additional data as part of the input array.
- The Shared variants restrict input to numeric arrays (`Float64Array`-compatible) because `SharedArrayBuffer` requires typed-array views.
- The GPU variants accept a WGSL expression string or a built-in operation name instead of a JavaScript function, because the body executes on the device.

## Building from source

```bash
npm install
npm run build
npm run test:functional
```

To run the benchmark suite from the paper:

```bash
npm run test:benchmark
```

## Try the demos online

The interactive per-pattern demos and the all-pattern benchmark dashboard are hosted at **[https://paraweb-js.vercel.app](https://paraweb-js.vercel.app)**. The same setup deploys straight to Vercel from a fork of this repo.

```bash
# Push your fork; in Vercel: New Project → import the repo → Deploy.
# (No build command needed; it serves static files.)
```

No Vercel UI configuration is needed; the included [vercel.json](vercel.json) tells Vercel to skip install/build, serve `browser-demo/` directly, and set the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers required for `SharedArrayBuffer`. All three variants (MP / Shared / GPU) work in the deployed app. The root URL serves the Map demo, with navigation to the [benchmark dashboard](browser-demo/benchmarks.html) and the [image-convolution case study](browser-demo/imageConv.html).

GitHub Pages also works for the MP and GPU variants, but does not support custom headers, so the Shared variant will not run there without a service-worker workaround. Cloudflare Pages and Netlify are equivalent to Vercel.

## Citing

If you use ParaWeb in academic work, please cite:

```
Memeti, S. ParaWeb: Parallel Programming Patterns for Web Development.
International Journal of Parallel Programming, HLPP 2026 special issue (forthcoming).
```

## License

[MIT](LICENSE) © Suejb Memeti
