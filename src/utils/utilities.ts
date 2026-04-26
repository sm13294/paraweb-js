const defaultNumThreads =
  typeof navigator === "undefined"
    ? require("os").cpus().length
    : navigator.hardwareConcurrency;

// Helper function to spawn workers and wait for their completion

export { defaultNumThreads };
