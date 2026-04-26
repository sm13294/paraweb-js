# Contributing to ParaWeb

Thanks for your interest in ParaWeb. This document describes how to set up the project for development, run the test suite, and submit changes.

## Development setup

```bash
git clone https://github.com/sm13294/paraweb-js.git
cd paraweb-js
npm install
npm run build
```

For GPU development on Node.js, the `webgpu` peer dependency is optional. Install it if you want to run the GPU benchmarks under Node:

```bash
npm install --save-optional webgpu
```

## Project layout

```
src/
  index.ts          Entry point; exports the namespace and class variants.
  patterns/         Per-pattern implementations (one file per variant).
  workers/          Worker scripts (Node Worker Threads / browser Web Workers).
  core/             Shared utilities: chunking, worker pool, GPU context, FFT.
  utils/            CPU-count detection.
  test/             Functional tests and benchmark runner.
```

Each pattern has up to three variants:
- `<pattern>.ts` — Message-passing (MP) variant.
- `<pattern>Shared.ts` — SharedArrayBuffer variant.
- `<pattern>GPU.ts` — WebGPU compute-shader variant.

Workers follow the same naming: `<pattern>Worker.ts`, `<pattern>SharedWorker.ts`.

## Running tests

```bash
npm run test:functional         # Full functional suite (all variants).
npm run test:mp:functional      # MP variants only.
npm run test:shared:functional  # Shared variants only.
npm run test:gpu:functional     # GPU variants (requires WebGPU).

npm run test:map                # Single pattern, both CPU variants.
npm run test:map:functional     # Single pattern, functional only.
npm run test:map:benchmark      # Single pattern, benchmark only.
```

Functional tests verify correctness against a sequential reference. Benchmarks measure speedup across thread counts and data sizes.

## Adding a new pattern

1. Add `src/patterns/<pattern>.ts`, `<pattern>Shared.ts`, `<pattern>GPU.ts`.
2. Add `src/workers/<pattern>Worker.ts` and `<pattern>SharedWorker.ts`.
3. Export the new classes from `src/index.ts` and add them to the `paraweb` namespace.
4. Add `src/test/test<Pattern>.ts`, `test<Pattern>Shared.ts`, `test<Pattern>GPU.ts` mirroring the existing test structure.
5. Wire the new test files into `package.json` scripts.

## Code style

- TypeScript with strict mode enabled.
- ES `import` syntax for source files; `require` is used inside worker bodies (where the function is reconstructed via `new Function()`).
- Functions passed to workers must be self-contained (see README for the lexical-scope caveat).
- Workers report errors via the `"error"` string protocol and shut down on `"terminate"`.

## Submitting changes

1. Fork and create a feature branch.
2. Run `npm run build && npm run test:functional` and confirm green.
3. Open a pull request describing the change.

For larger changes (new patterns, variant strategies, API changes), please open an issue first to discuss the approach.
