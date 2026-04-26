#!/usr/bin/env node
/**
 * Regenerate paper-hlpp/figures.tex from a benchmark run directory.
 *
 * Layout: 10 subplots in a 5x2 grid (two per row) showing speedup vs thread
 * count for Medium / Large / Extremely Large × MP / Shared. Because every
 * panel shares the same 1/2/4/8/16-thread x-axis, only the bottom row keeps
 * the "Number of Threads" label and tick labels — that saves vertical space
 * and lets the individual panels be bigger.
 *
 * Each plot carries stddev error bars derived from the measured per-run
 * stddev in the JSON file (propagated to speedup as speedup * (sigma_t/t)).
 *
 * Usage:
 *   node scripts/regen-figures.js                 # newest run-* dir
 *   node scripts/regen-figures.js <path/to/run>   # specific dir
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAPER_FILE = path.join(ROOT, "paper-hlpp", "figures.tex");

function findLatestRunDir() {
  const base = path.join(ROOT, "benchmark-results");
  const entries = fs.readdirSync(base)
    .filter(n => n.startsWith("run-"))
    .map(n => ({ name: n, mtime: fs.statSync(path.join(base, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (entries.length === 0) throw new Error(`No run-* directories found under ${base}`);
  return path.join(base, entries[0].name);
}

function loadPattern(runDir, name) {
  const f = path.join(runDir, `${name}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// Returns { size -> { threadCount -> { speedup, speedupSigma } } }.
// Error propagation: speedup = t1 / t_n, so
//   sigma(speedup)/speedup = sqrt((sigma_t1/t1)^2 + (sigma_tn/t_n)^2)
// We dominate by sigma(t_n)/t_n in practice because the 1-thread baseline
// tends to have much lower relative noise, but include both terms for
// correctness.
function toSpeedups(results) {
  if (!results) return {};
  const by = {};
  const baseline = {};
  const baselineSigma = {};
  for (const r of results) {
    if (!by[r.size]) by[r.size] = {};
    by[r.size][r.threads] = { time: r.time, sigma: r.stddev };
  }
  // Prefer threads=0 (plain-JS sequential baseline) where available;
  // fall back to threads=1 (parallel-1T) for older runs that did not
  // measure the sequential baseline.
  for (const [size, rec] of Object.entries(by)) {
    if (rec[0]) {
      baseline[size] = rec[0].time;
      baselineSigma[size] = rec[0].sigma;
    } else if (rec[1]) {
      baseline[size] = rec[1].time;
      baselineSigma[size] = rec[1].sigma;
    }
  }
  const out = {};
  for (const [size, rec] of Object.entries(by)) {
    const b = baseline[size];
    const bs = baselineSigma[size] || 0;
    if (!b) continue;
    out[size] = {};
    for (const [t, { time, sigma }] of Object.entries(rec)) {
      if (Number(t) === 0) continue; // sequential is the implicit baseline
      // Drop the parallel-1T data point: it measures framework overhead
      // (worker spawn + postMessage or SAB setup at N=1), not useful parallelism.
      // Sequential is the reference; plotted points start at threads=2.
      if (Number(t) === 1) continue;
      const speedup = b / time;
      const relTimeErr = time > 0 ? (sigma || 0) / time : 0;
      const relBaseErr = b > 0 ? bs / b : 0;
      const relErr = Math.sqrt(relTimeErr * relTimeErr + relBaseErr * relBaseErr);
      out[size][t] = { speedup, speedupSigma: speedup * relErr };
    }
  }
  return out;
}

function coordLine(color, marker, dashed, coords) {
  const style = `color=${color},mark=${marker},thick${dashed ? ",dashed" : ""}`;
  const body = coords.map(([t, s]) => `(${t},${s.toFixed(2)})`).join(" ");
  return `\\addplot[${style}] coordinates { ${body} };`;
}

const SIZE_COLORS = {
  "Medium":          "blue",
  "Large":           "red",
  "Extremely Large": "green!60!black",
};
const SIZE_MARKERS_MP     = { "Medium": "*",       "Large": "square*", "Extremely Large": "triangle*" };
const SIZE_MARKERS_SHARED = { "Medium": "o",       "Large": "square",  "Extremely Large": "triangle"  };
const SIZES = ["Medium", "Large", "Extremely Large"];
const THREADS = [1, 2, 4, 8, 16];

// Emit the \addplot lines for a single pattern (used as the body of a
// \nextgroupplot inside the shared groupplots environment).
function panelPlots(mpSpeedups, sharedSpeedups) {
  const lines = [];
  for (const size of SIZES) {
    const color = SIZE_COLORS[size];
    for (const [_variantName, speedups, markers, dashed] of [
      ["mp",     mpSpeedups,     SIZE_MARKERS_MP,     false],
      ["shared", sharedSpeedups, SIZE_MARKERS_SHARED, true],
    ]) {
      const bySize = speedups[size] || {};
      const coords = THREADS
        .map(t => {
          const cell = bySize[t];
          return cell ? [t, cell.speedup] : null;
        })
        .filter(Boolean);
      if (coords.length === 0) continue;
      lines.push(coordLine(color, markers[size], dashed, coords));
    }
  }
  return lines.join("\n\n");
}

function main() {
  const runDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : findLatestRunDir();
  console.log(`Reading run directory: ${runDir}`);

  const patterns = [
    { label: "map",      caption: "Map",                mp: "MapMP",                shared: "MapShared" },
    { label: "filter",   caption: "Filter",             mp: "FilterMP",             shared: "FilterShared" },
    { label: "reduce",   caption: "Reduce",             mp: "ReduceMP",             shared: "ReduceShared" },
    { label: "scan",     caption: "Scan",               mp: "Scan",                 shared: "ScanShared" },
    { label: "scatter",  caption: "Scatter",            mp: "ScatterMP",            shared: "ScatterShared" },
    { label: "stencil",  caption: "Stencil",            mp: "StencilMP",            shared: "StencilShared" },
    { label: "farm",     caption: "Farm",               mp: "FarmMP",               shared: "FarmShared" },
    { label: "pipeline", caption: "Pipeline",           mp: "PipelineMP",           shared: "PipelineShared" },
    // D&C MP suppressed from the figure: every MP point is below 1x at every
    // size (the worker-thread postMessage channel structured-clones each chunk
    // per call, so MP can't produce positive speedup on FFT). The omission is
    // noted in the §6.3 D&C paragraph; only the Shared curve is plotted.
    { label: "dac",      caption: "D\\&C",              barCaption: "D\\&C", mp: null,                   shared: "DivideAndConquerShared" },
    { label: "mapreduce",caption: "MapReduce",          mp: "MapReduceMP",          shared: "MapReduceShared" },
  ];

  const present = patterns
    .map(p => ({ p, mp: toSpeedups(loadPattern(runDir, p.mp)), sh: toSpeedups(loadPattern(runDir, p.shared)) }))
    .filter(x => Object.keys(x.mp).length > 0 || Object.keys(x.sh).length > 0);

  // --- Figure 3: 5x2 small-multiples with shared log y-axis -----------------
  // Use pgfplots `groupplots` so adjacent panels share their axes visually:
  //   - `yticklabels at=edge left`  -> only the leftmost panel of each row has y-tick labels
  //   - `xticklabels at=edge bottom` -> only the bottom row has x-tick labels
  // Y is log10 so speedups spanning 0.4x (sub-linear) to 40x+ all stay readable
  // in the same panel. The figure is emitted inside `figure*` so it can span
  // both columns of the IEEE two-column layout and fit 5 panels per row.
  const COLS = 5;
  const ROWS_ = Math.ceil(present.length / COLS);

  // Both rows now share the same y-range (1x..14x). With D&C MP omitted from
  // the figure, every plotted point at 2+ threads lands above 1x, so the
  // 0.5x tick is no longer needed on either row.
  const groupPlotBlocks = present.map((x, i) => {
    const row = Math.floor(i / COLS);
    const col = i % COLS;
    const isBottomRow = row === ROWS_ - 1;
    const isLeftCol = col === 0;
    const isMiddleBottom = isBottomRow && col === Math.floor(COLS / 2);
    const xlabelPart = isMiddleBottom ? ", xlabel={\\# threads}" : "";
    // Both rows: ymin=1 with no 0.5x tick. Only the leftmost panel of each row
    // shows y-tick labels — matching the `edge left` convention.
    const rowOverride = isLeftCol
      ? ", ymin=1, ytick={1,2,5,10}, yticklabels={1x,2x,5x,10x}"
      : ", ymin=1, ytick={1,2,5,10}, yticklabels={}";
    const body = panelPlots(x.mp, x.sh);
    return `\\nextgroupplot[title={${x.p.caption}}${rowOverride}${xlabelPart}]
${body}`;
  }).join("\n\n");

  const groupPlot = `\\begin{tikzpicture}
\\begin{groupplot}[
  group style={
    group size=${COLS} by ${ROWS_},
    horizontal sep=4pt,
    vertical sep=22pt,
    xticklabels at=edge bottom,
    yticklabels at=edge left,
  },
  width=3.9cm,
  height=4.0cm,
  ymode=log,
  log basis y=10,
  ytick={1,2,5,10},
  yticklabels={1x,2x,5x,10x},
  ymin=1, ymax=14,
  xmode=log,
  log basis x=2,
  xtick={2,4,8,16},
  xticklabels={2,4,8,16},
  xmin=1.7, xmax=18,
  grid=major,
  title style={at={(axis description cs:0.04, 0.95)}, anchor=north west, font=\\scriptsize, fill=white, inner sep=1.5pt},
  tick label style={font=\\footnotesize},
  label style={font=\\footnotesize},
  every axis y label/.style={at={(axis description cs:-0.22, 0.5)}, rotate=90, anchor=south},
  every axis x label/.style={at={(axis description cs:0.5, -0.30)}, anchor=north},
]
${groupPlotBlocks}
\\end{groupplot}
\\end{tikzpicture}`;

  const caption = "Speedup relative to a plain-JavaScript sequential baseline (main thread, no workers, no SharedArrayBuffer) for all ten patterns across data sizes and thread counts (2--16). The y-axis is log$_{10}$-scaled; the 1x gridline marks the sequential baseline. Lines below 1x indicate that the parallel variant is slower than the sequential loop.";

  // Shared legend drawn once below the grid of subplots. Separating the two
  // encoding axes (size = colour, variant = dash style) into two visual
  // rows keeps the total key count small (5 items) and lets the reader
  // parse each axis independently.
  const sharedLegend = String.raw`\begin{tikzpicture}[baseline, every node/.style={font=\small, inner sep=2pt}]
    \draw[blue,thick]            (0.0,0.4) -- (0.5,0.4) node[circle, fill=blue, inner sep=1.3pt] {} -- (1.0,0.4);
    \node[anchor=west] at (1.05,0.4) {Medium (100K)};
    \draw[red,thick]             (4.2,0.4) -- (4.7,0.4) node[rectangle, fill=red, minimum size=3pt, inner sep=0pt] {} -- (5.2,0.4);
    \node[anchor=west] at (5.25,0.4) {Large (1M)};
    \draw[green!60!black,thick]  (7.0,0.4) -- (7.5,0.4) node[regular polygon, regular polygon sides=3, fill=green!60!black, minimum size=4pt, inner sep=0pt] {} -- (8.0,0.4);
    \node[anchor=west] at (8.05,0.4) {Extremely Large (5--10M)};
    \draw[thick]                 (0.0,-0.1) -- (1.0,-0.1);
    \node[anchor=west] at (1.05,-0.1) {MP};
    \draw[thick,dashed]          (2.5,-0.1) -- (3.5,-0.1);
    \node[anchor=west] at (3.55,-0.1) {Shared};
  \end{tikzpicture}`;

  // --- Second figure: one big grouped bar chart -----------------------------
  // Built but emitted inside a LaTeX \iffalse..\fi so it doesn't render in
  // the paper. The line-plot small-multiples (Fig.~\ref{fig:all_speedups})
  // tells the scaling story across three data sizes more directly, so the
  // bar chart is redundant with Table 1 for the HLPP submission. The code
  // stays here so a future venue can re-enable it by flipping \iffalse →
  // \iftrue.
  const barChart = buildBarChart(present);

  const out =
`% Auto-generated: groupplots 5x2 small-multiples on log y-scale.
% Regenerate: node scripts/regen-figures.js <run-dir>

\\begin{figure*}[!htbp]
\\centering
${groupPlot}

\\vspace{0.5em}
${sharedLegend}
\\caption{${caption}}\\label{fig:all_speedups}
\\end{figure*}

\\iffalse % grouped-bar variant, kept for future use
${barChart}
\\fi
`;

  fs.writeFileSync(PAPER_FILE, out);
  console.log(`Wrote ${PAPER_FILE} (${present.length} patterns in ${COLS}x${ROWS_} groupplot layout)`);
}

// Build a single grouped bar chart. Ten pattern groups on the x-axis; each
// group contains five thread counts × two variants = 10 bars. The five fill
// patterns encode the thread count and are used for BOTH MP and Shared (i.e.,
// MP 4T and Shared 4T share the same pattern). MP / Shared is distinguished
// by position only (MP is the left sub-cluster, Shared is the right one),
// with sub-labels drawn directly beneath each cluster. Bars are taken at the
// largest measured size for each pattern (Extremely Large — 10M for most,
// 5M for D&C).
function buildBarChart(present) {
  // Five fills, one per thread count. Each fill is drawn identically for MP
  // and Shared — the reader tells them apart by position within the pattern
  // group (MP on the left, Shared on the right).
  // 1-thread bars are omitted because their speedup is 1.00 by definition
  // (they are the reference point for the other thread counts). Mentioned
  // in the figure caption so the reader knows the implicit baseline.
  const THREAD_FILLS = [
    { threads: 2,  label: "2 threads",  fill: null,        pattern: "north east lines" },  // //
    { threads: 4,  label: "4 threads",  fill: null,        pattern: "north west lines" },  // \\
    { threads: 8,  label: "8 threads",  fill: null,        pattern: "crosshatch" },        // xx
    { threads: 16, label: "16 threads", fill: "black!80",  pattern: null },
  ];

  // Layout per pattern group (bar width = 4pt, 4 bars per sub-cluster):
  //   MP cluster spans x = −18..−2pt (4 bars glued, centres at −16..−4pt)
  //   Shared cluster spans x = +2..+18pt (centres at +4..+16pt)
  //   Gap between MP and Shared = 4pt (one bar width)
  // Cluster centres stay at ±10pt so the MP/Shared sub-labels don't move.
  const BAR_WIDTH = 4; // pt
  const mpShiftFor     = (i) => -16 + i * 4;   // i in 0..3 → -16,-12,-8,-4
  const sharedShiftFor = (i) =>   4 + i * 4;   // i in 0..3 → +4,+8,+12,+16
  const clusterCentreMP     = -10;  // mean of MP shifts: (-16-12-8-4)/4 = -10
  const clusterCentreShared = +10;

  // Use the largest size that has data for each pattern.
  const sizePriority = ["Extremely Large", "Large", "Medium", "Small"];
  const groups = present.map(({ p, mp, sh }) => {
    const pickSize = (sp) => sizePriority.find(s => sp[s] && Object.keys(sp[s]).length > 0);
    return { p, mp, sh, sizeMp: pickSize(mp), sizeSh: pickSize(sh) };
  });

  const xLabelOf = (g) => g.p.barCaption || g.p.caption;
  const symbolicCoords = groups.map(xLabelOf).join(", ");

  // Alternating light-gray / white background stripes, one per pattern group.
  // pgfplots' symbolic x coords reject fractional numeric positions in
  // `axis cs:`, so instead we draw the stripes in `rel axis cs:` (axis-
  // relative units, 0=left edge, 1=right edge). For N patterns spaced one
  // unit apart with `enlarge x limits=ENL` on each side (a ratio of the
  // N-1 range), pattern i (1-indexed) sits at numeric x=i in the data
  // space, and the axis spans [xMin, xMax] with
  //   xMin = 1 - ENL*(N-1);   xMax = N + ENL*(N-1)
  // The left and right edges of pattern i's stripe ([i-0.5, i+0.5]) map
  // linearly to rel-axis-cs positions (i - 0.5 - xMin) / (xMax - xMin)
  // and (i + 0.5 - xMin) / (xMax - xMin).
  const BG_YMAX = 11;
  const ENL = 0.06;
  const N = groups.length;
  const xMin = 1 - ENL * (N - 1);
  const xMax = N + ENL * (N - 1);
  const xRange = xMax - xMin;
  const toRel = (x) => (x - xMin) / xRange;
  const backgroundStripes = groups.map((_, i) => {
    if (i % 2 !== 0) return null; // even-indexed → light gray; odd → white
    const pos = i + 1; // 1-based
    const left = toRel(pos - 0.5).toFixed(5);
    const right = toRel(pos + 0.5).toFixed(5);
    return `\\path[fill=gray!18] (rel axis cs:${left},0) rectangle (rel axis cs:${right},1);`;
  }).filter(Boolean).join("\n");

  // Emit 10 \addplot calls: MP series first (5), then Shared (5). Each carries
  // the same fill for the same thread count but a different bar shift.
  const plotLines = [];
  THREAD_FILLS.forEach((t, i) => {
    const coords = groups.map(g => {
      const cell = g.sizeMp ? (g.mp[g.sizeMp] || {})[t.threads] : undefined;
      return `(${xLabelOf(g)},${cell ? cell.speedup.toFixed(2) : 0})`;
    }).join(" ");
    const style = buildFillStyle(t, mpShiftFor(i));
    plotLines.push(`\\addplot[${style},forget plot] coordinates { ${coords} };`);
  });
  THREAD_FILLS.forEach((t, i) => {
    const coords = groups.map(g => {
      const cell = g.sizeSh ? (g.sh[g.sizeSh] || {})[t.threads] : undefined;
      return `(${xLabelOf(g)},${cell ? cell.speedup.toFixed(2) : 0})`;
    }).join(" ");
    const style = buildFillStyle(t, sharedShiftFor(i));
    // Only the Shared-side addplots contribute legend entries — one per
    // thread count — so the legend has exactly five keys.
    plotLines.push(`\\addplot[${style}] coordinates { ${coords} };`);
  });
  const plots = plotLines.join("\n");

  const legend = THREAD_FILLS.map(t => t.label).join(", ");

  // After the data plots, drop MP / Shared sub-labels directly under each
  // pattern's two sub-clusters. `axis cs:` is in data coords; xshift moves
  // by the cluster centre (pt). `anchor=north` + yshift places them between
  // the axis line and the pattern-name tick label. The `clip=false` axis
  // option is required so the nodes don't get cut off by pgfplots' default
  // axis clipping region (they sit below y=0).
  const subLabels = groups.map(g => {
    const x = xLabelOf(g);
    return `\\node[anchor=north, font=\\tiny, yshift=-2pt, xshift=${clusterCentreMP}pt] at (axis cs:${x}, 0) {MP};
\\node[anchor=north, font=\\tiny, yshift=-2pt, xshift=${clusterCentreShared}pt] at (axis cs:${x}, 0) {Shared};`;
  }).join("\n");

  // `figure*` on its own doesn't widen the figure in single-column Springer
  // Nature — \textwidth is the bound. Instead we wrap the tikzpicture in
  // \resizebox so the chart stretches to \textwidth while preserving the
  // aspect ratio of the underlying 17cm × 8cm axis.
  return `% Bar-chart view of the same speedups (for comparison with Fig.~\\ref{fig:all_speedups}).
\\begin{figure}[!htbp]
\\centering
\\resizebox{\\textwidth}{!}{%
\\begin{tikzpicture}
\\begin{axis}[
  ybar,
  width=17cm,
  height=8cm,
  bar width=${BAR_WIDTH}pt,
  ymin=0,
  ymax=${BG_YMAX},
  % Draw the axis frame + grid + ticks AFTER the plots so the grid is
  % visible on top of the alternating background stripes (which are
  % emitted as plot-layer paths). This also means grid lines render over
  % the bars themselves, at the 0.2pt thickness they are that's barely
  % visible on the filled/patterned bars.
  axis on top=true,
  symbolic x coords={${symbolicCoords}},
  xtick=data,
  % The pattern name sits ~2em below the axis line so the MP/Sh. sub-labels
  % (drawn at yshift=-2pt just below y=0) fit between them and the axis.
  x tick label style={font=\\footnotesize, yshift=-2em},
  tick label style={font=\\footnotesize},
  % Proportional padding. Each pattern's outermost bar sits at ~18pt from
  % the pattern's centre; at 10 patterns the pattern-to-pattern spacing is
  % roughly 47pt, so the padding needs to cover ~0.4 of a unit to keep
  % those outer bars inside the axis. 0.06 gives a little extra margin.
  enlarge x limits=0.06,
  % Sub-labels are drawn as nodes at (axis cs:..., 0); pgfplots clips
  % everything below y=0 by default so we disable clipping.
  clip=false,
  % Each legend entry gets a single tall-and-narrow rectangle swatch,
  % matching the orientation of the bars themselves.
  legend image code/.code={\\draw[#1] (0cm,0pt) rectangle (${BAR_WIDTH}pt,10pt);},
  legend style={at={(0.5,-0.26)}, anchor=north, legend columns=4, font=\\footnotesize, /tikz/every even column/.append style={column sep=0.6em}},
  legend cell align=left,
  % Grid: horizontal major y-lines, plus two kinds of vertical lines:
  %   - between adjacent patterns (minor x-grid, positions 1.5, 2.5, ...)
  %     → thicker so the reader sees where one pattern ends and the next
  %     → alternating background stripes do the pattern-separation job.
  %   - at each pattern centre, exactly in the MP/Shared gap (major x-grid
  %     at positions 1, 2, ...) → thin separator inside the group.
  % The MP cluster spans -18..-2pt and the Shared cluster +2..+18pt, so
  % the major x-grid line at x=0 offset lands in the 4pt gap and does not
  % cross any bar.
  ymajorgrids=true,
  xmajorgrids=true,
  % One y-tick per integer speedup so the reader can read bar heights
  % without eyeballing. The y=1 line doubles as the implicit 1-thread
  % baseline; everything above it is a speed-up, everything below is a
  % slow-down.
  ytick={0,1,2,3,4,5,6,7,8,9,10,${BG_YMAX}},
  % Grid colour picked to stay visible on BOTH the white and gray!18 stripe
  % backgrounds; anything lighter than ~gray!65 vanishes on the stripes.
  major grid style={line width=0.2pt, draw=gray!75},
  % Emphasise the y=1 line so the baseline reads at a glance without
  % counting gridlines.
  extra y ticks={1},
  extra y tick labels={},
  extra y tick style={grid style={line width=0.5pt, draw=black!75}, tick style={draw=none}},
  scaled y ticks=false
]
% Background stripes first, so subsequent addplot bars sit on top.
${backgroundStripes}
${plots}
\\legend{${legend}}
${subLabels}
\\end{axis}
\\end{tikzpicture}%
}
\\caption{Grouped-bar view of the same speedup data as Fig.~\\ref{fig:all_speedups} (Extremely Large input; D\\&C uses its 5M-element bucket). Each pattern group has two sub-clusters of four bars: \\textbf{MP} on the left, \\textbf{Shared} on the right. Bar fill encodes thread count (see legend) and is the same on both sides of the sub-cluster divider. The 1-thread baseline is omitted — it is 1.0x by definition for every configuration.}\\label{fig:all_speedups_bars}
\\end{figure}`;
}

// Build the pgfplots style string for one bar series (fill / pattern / outline
// plus the per-series bar shift).
function buildFillStyle(t, barShift) {
  const parts = [];
  if (t.fill) parts.push(`fill=${t.fill}`);
  if (t.pattern) parts.push(`pattern=${t.pattern}`, `pattern color=black`);
  parts.push("draw=black", "line width=0.3pt", `bar shift=${barShift}pt`);
  return parts.join(",");
}

main();
