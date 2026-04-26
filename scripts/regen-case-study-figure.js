#!/usr/bin/env node
/**
 * Generate paper-hlpp/case-study-figure.tex from a browser-demo CSV export.
 *
 * Input: CSV produced by the "Run benchmark" button on browser-demo/imageConv.html
 *   (file path may be passed as argv[2]; defaults to the most recent
 *   paraweb-imgconv-*.csv in the repo root).
 *
 * Output: a LaTeX figure using pgfplots groupplot with 5 panels (one per
 * filter), shared log y-axis, kernel-radius on the x-axis, and one line per
 * parallel variant (Shared 4T / 8T / 16T, GPU). Same visual language as
 * Figure 3 (the pattern-level scaling plot) but wider since there are fewer
 * panels in a single row.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "paper-hlpp", "case-study-figure.tex");

// Default to the 4K case-study CSV since that is the size the paper prose
// and caption are written around. Fall back to any other paraweb-imgconv-*
// file if no 4K run exists. An explicit path via argv[2] always wins.
function findDefaultCsv() {
  const entries = fs.readdirSync(ROOT)
    .filter(n => /^paraweb-imgconv-.+\.csv$/.test(n))
    .map(n => ({ n, mt: fs.statSync(path.join(ROOT, n)).mtimeMs }));
  if (entries.length === 0) throw new Error("No paraweb-imgconv-*.csv in repo root");
  const fourK = entries
    .filter(e => e.n.includes("3840x2160"))
    .sort((a, b) => b.mt - a.mt);
  if (fourK.length > 0) return path.join(ROOT, fourK[0].n);
  entries.sort((a, b) => b.mt - a.mt);
  return path.join(ROOT, entries[0].n);
}

function parseCsv(file) {
  const txt = fs.readFileSync(file, "utf8");
  const lines = txt.split("\n");
  const header = { image: null };
  const data = [];
  for (const line of lines) {
    if (line.startsWith("# image=")) header.image = line.substring(8).trim();
    if (!line || line.startsWith("#") || line.startsWith("filter,")) continue;
    const [filter, variant, sweep, mean, median, stddev, min, max, speedup] = line.split(",");
    if (!speedup) continue;
    data.push({
      filter, variant, sweep: Number(sweep),
      mean: Number(mean), speedup: Number(speedup),
    });
  }
  return { header, data };
}

const FILTERS = ["gaussian", "box", "sharpen", "emboss", "edge"];
const FILTER_TITLES = {
  gaussian: "Gaussian", box: "Box", sharpen: "Sharpen",
  emboss: "Emboss", edge: "Edge (DoG)",
};
// Same plotted variants as the browser demo. 'seq' is the 1.00x baseline.
const VARIANTS = [
  { key: "shared-4",  color: "orange!70!yellow", mark: "o",        label: "Shared 4T"  },
  { key: "shared-8",  color: "orange!90!black",  mark: "square",   label: "Shared 8T"  },
  { key: "shared-16", color: "red!80!black",     mark: "triangle", label: "Shared 16T" },
  { key: "gpu",       color: "blue!60!black",    mark: "*",        label: "GPU"        },
];

function main() {
  const csvPath = process.argv[2] ? path.resolve(process.argv[2]) : findDefaultCsv();
  console.log("Reading", csvPath);
  const { header, data } = parseCsv(csvPath);

  const sweepValues = [...new Set(data.map(d => d.sweep))].sort((a, b) => a - b);
  const xMax = Math.max(...sweepValues);

  // speedups keyed by (filter, variant, sweep)
  const get = (f, v, s) => {
    const r = data.find(d => d.filter === f && d.variant === v && d.sweep === s);
    return r && !Number.isNaN(r.speedup) ? r.speedup : null;
  };

  // y range: round max up to the next "nice" log tick so the axis ceiling
  // doesn't cut off the tallest line (typically emboss GPU at r=20).
  const allSpeedups = data.filter(d => d.variant !== "seq").map(d => d.speedup);
  const yRawMax = Math.max(...allSpeedups);
  const logCeil = (v) => {
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    for (const m of [1, 2, 5, 10]) if (v <= base * m * 1.001) return base * m;
    return base * 10;
  };
  const yMax = logCeil(yRawMax * 1.05);

  const panels = FILTERS.map((f, i) => {
    const title = FILTER_TITLES[f];
    const plots = VARIANTS.map(v => {
      const coords = sweepValues
        .map(s => {
          const sp = get(f, v.key, s);
          return sp == null ? null : `(${s},${sp.toFixed(2)})`;
        })
        .filter(Boolean)
        .join(" ");
      return `\\addplot[color=${v.color},mark=${v.mark},thick] coordinates { ${coords} };`;
    }).join("\n");
    // Only the middle (3rd) panel carries the x-axis label.
    const xlabelPart = i === 2 ? ", xlabel={kernel radius}" : "";
    return `\\nextgroupplot[title={${title}}${xlabelPart}]
${plots}`;
  }).join("\n\n");

  const legend = String.raw`\begin{tikzpicture}[baseline, every node/.style={font=\small, inner sep=2pt}]
    \draw[orange!70!yellow,thick] (0.0,0) -- (0.5,0) node[circle, draw=orange!70!yellow, fill=orange!70!yellow, inner sep=1.5pt] {} -- (1.0,0);
    \node[anchor=west] at (1.05,0) {Shared 4T};
    \draw[orange!90!black,thick] (2.7,0) -- (3.2,0) node[rectangle, draw=orange!90!black, fill=orange!90!black, minimum size=3pt, inner sep=0pt] {} -- (3.7,0);
    \node[anchor=west] at (3.75,0) {Shared 8T};
    \draw[red!80!black,thick] (5.4,0) -- (5.9,0) node[regular polygon, regular polygon sides=3, draw=red!80!black, fill=red!80!black, minimum size=4pt, inner sep=0pt] {} -- (6.4,0);
    \node[anchor=west] at (6.45,0) {Shared 16T};
    \draw[blue!60!black,thick] (8.3,0) -- (8.8,0) node[circle, draw=blue!60!black, fill=blue!60!black, inner sep=1.3pt] {} -- (9.3,0);
    \node[anchor=west] at (9.35,0) {GPU};
  \end{tikzpicture}`;

  const xticks = sweepValues.join(",");
  const caption = `Image-convolution case study (${header.image}): speedup relative to the sequential CPU baseline as the kernel radius grows, for each of the five filters. Y-axis is log$_{10}$-scaled.`;

  const out =
`% Auto-generated: case-study image convolution speedup curves.
% Regenerate: node scripts/regen-case-study-figure.js [csv-path]

\\begin{figure*}[!htbp]
\\centering
\\begin{tikzpicture}
\\begin{groupplot}[
  group style={
    group size=5 by 1,
    horizontal sep=4pt,
    xticklabels at=edge bottom,
    yticklabels at=edge left,
  },
  width=3.9cm,
  height=5.2cm,
  ymode=log,
  log basis y=10,
  ytick={1,2,5,10,20,50,100,200,500},
  yticklabels={1x,2x,5x,10x,20x,50x,100x,200x,500x},
  ymin=2, ymax=${yMax},
  xmin=0, xmax=${xMax + 1},
  xtick={${xticks}},
  xticklabels={${xticks}},
  grid=major,
  title style={at={(axis description cs:0.04, 0.95)}, anchor=north west, font=\\scriptsize, fill=white, inner sep=1.5pt},
  tick label style={font=\\footnotesize},
  label style={font=\\footnotesize},
  every axis x label/.style={at={(axis description cs:0.5, -0.22)}, anchor=north},
]
${panels}
\\end{groupplot}
\\end{tikzpicture}

\\vspace{0.3em}
${legend}
\\caption{${caption}}\\label{fig:casestudy_scaling}
\\end{figure*}
`;

  fs.writeFileSync(OUT, out);
  console.log("Wrote", OUT);
}

main();
