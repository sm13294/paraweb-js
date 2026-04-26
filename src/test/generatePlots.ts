const fs = require("fs");
const path = require("path");

interface BenchmarkResult {
  pattern: string;
  size: string;
  sizeValue: number;
  description: string;
  threads: number;
  time: number;
  timestamp: string;
}

function generateHTMLPlot(pattern: string, results: BenchmarkResult[]) {
  // Group by size
  const bySize = new Map<string, BenchmarkResult[]>();
  for (const result of results) {
    const key = result.size;
    if (!bySize.has(key)) {
      bySize.set(key, []);
    }
    bySize.get(key)!.push(result);
  }

  const sizes = Array.from(bySize.keys());
  const threadCounts = Array.from(new Set(results.map((r) => r.threads))).sort(
    (a, b) => a - b
  );

  // Get the latest timestamp from results for display
  const latestTimestamp =
    results.length > 0
      ? new Date(
          Math.max(...results.map((r) => new Date(r.timestamp).getTime()))
        )
      : new Date();

  // Generate data arrays for Chart.js
  // For each size/thread combination, use the most recent result if duplicates exist
  const datasets = sizes.map((size, index) => {
    const data = threadCounts.map((threads) => {
      const sizeResults = bySize
        .get(size)!
        .filter((r) => r.threads === threads);
      if (sizeResults.length === 0) return null;
      // If multiple results exist, use the most recent one
      const latest = sizeResults.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )[0];
      return latest.time;
    });
    return {
      label: size,
      data: data,
      borderColor: `hsl(${(index * 360) / sizes.length}, 70%, 50%)`,
      backgroundColor: `hsla(${(index * 360) / sizes.length}, 70%, 50%, 0.1)`,
      tension: 0.4,
    };
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pattern} Pattern - Performance Benchmark</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', Arial, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .chart-container {
      background: white;
      padding: 20px;
      margin: 20px 0;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #333;
      text-align: center;
    }
    .info {
      background: #e3f2fd;
      padding: 15px;
      border-radius: 4px;
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <h1>${pattern.toUpperCase()} Pattern - Performance Benchmark</h1>
  
  <div class="info">
    <h3>Test Configuration</h3>
    <p><strong>Thread Counts:</strong> ${threadCounts.join(", ")}</p>
    <p><strong>Data Sizes:</strong> ${sizes
      .map((s) => {
        const r = results.find((res) => res.size === s);
        return r ? `${s} (${r.sizeValue.toLocaleString()} elements)` : s;
      })
      .join(", ")}</p>
    <p><strong>Last Updated:</strong> ${latestTimestamp.toLocaleString()}</p>
  </div>

  <div class="chart-container">
    <canvas id="timeChart"></canvas>
  </div>

  <div class="chart-container">
    <canvas id="speedupChart"></canvas>
  </div>

  <script>
    const threadLabels = ${JSON.stringify(
      threadCounts.map((t) => `${t} threads`)
    )};
    const datasets = ${JSON.stringify(datasets)};

    // Time Chart
    const timeCtx = document.getElementById('timeChart').getContext('2d');
    new Chart(timeCtx, {
      type: 'line',
      data: {
        labels: threadLabels,
        datasets: datasets
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: 'Execution Time by Thread Count',
            font: { size: 18 }
          },
          legend: {
            position: 'top'
          }
        },
        scales: {
          y: {
            title: {
              display: true,
              text: 'Time (ms)'
            },
            beginAtZero: true
          },
          x: {
            title: {
              display: true,
              text: 'Number of Threads'
            }
          }
        }
      }
    });

    // Speedup Chart (relative to 1 thread)
    const speedupDatasets = datasets.map(dataset => {
      const baseline = dataset.data[0]; // 1 thread time
      return {
        ...dataset,
        data: dataset.data.map((time, i) => {
          if (i === 0 || !time || !baseline) return 1;
          return baseline / time;
        })
      };
    });

    const speedupCtx = document.getElementById('speedupChart').getContext('2d');
    new Chart(speedupCtx, {
      type: 'line',
      data: {
        labels: threadLabels,
        datasets: speedupDatasets
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: 'Speedup Relative to 1 Thread',
            font: { size: 18 }
          },
          legend: {
            position: 'top'
          }
        },
        scales: {
          y: {
            title: {
              display: true,
              text: 'Speedup (x)'
            },
            beginAtZero: true
          },
          x: {
            title: {
              display: true,
              text: 'Number of Threads'
            }
          }
        }
      }
    });
  </script>
</body>
</html>`;

  return html;
}

function generateIndexHTML(
  plotFiles: Array<{ pattern: string; filename: string }>
): string {
  const patterns = [
    { name: "Map", description: "Parallel transformation of each element" },
    { name: "Filter", description: "Parallel filtering based on predicate" },
    { name: "Reduce", description: "Parallel reduction to a single value" },
    {
      name: "Accumulator",
      description: "Parallel accumulation with initial value",
    },
    { name: "MapReduce", description: "Combined map and reduce operations" },
    { name: "Stencil", description: "Neighborhood-based parallel computation" },
    { name: "Farm", description: "Dynamic task distribution pattern" },
    {
      name: "DivideAndConquer",
      description: "Recursive divide and conquer pattern",
    },
    {
      name: "Pipeline",
      description: "Sequential stages with parallel processing",
    },
  ];

  // Sort plotFiles to match the pattern order
  const sortedFiles = patterns
    .filter((p) => plotFiles.some((f) => f.pattern === p.name))
    .map((p) => plotFiles.find((f) => f.pattern === p.name)!);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ParaWeb - Benchmark Results Index</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 40px 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px;
      text-align: center;
    }
    .header h1 {
      font-size: 2.5em;
      margin-bottom: 10px;
      font-weight: 700;
    }
    .header p {
      font-size: 1.1em;
      opacity: 0.9;
    }
    .content {
      padding: 40px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }
    .stat-card {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
      border: 2px solid #e9ecef;
    }
    .stat-card .number {
      font-size: 2.5em;
      font-weight: 700;
      color: #667eea;
      margin-bottom: 5px;
    }
    .stat-card .label {
      color: #6c757d;
      font-size: 0.9em;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .patterns-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 20px;
    }
    .pattern-card {
      background: #f8f9fa;
      border: 2px solid #e9ecef;
      border-radius: 8px;
      padding: 25px;
      transition: all 0.3s ease;
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      display: block;
    }
    .pattern-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 10px 25px rgba(0,0,0,0.15);
      border-color: #667eea;
    }
    .pattern-card .pattern-name {
      font-size: 1.5em;
      font-weight: 700;
      color: #667eea;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .pattern-card .pattern-name::before {
      content: "📊";
      font-size: 1.2em;
      font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;
    }
    .pattern-card .pattern-description {
      color: #6c757d;
      font-size: 0.95em;
      line-height: 1.5;
    }
    .pattern-card .pattern-link {
      margin-top: 15px;
      display: inline-block;
      color: #667eea;
      font-weight: 600;
      font-size: 0.9em;
    }
    .pattern-card:hover .pattern-link {
      text-decoration: underline;
    }
    .footer {
      background: #f8f9fa;
      padding: 20px;
      text-align: center;
      color: #6c757d;
      font-size: 0.9em;
      border-top: 1px solid #e9ecef;
    }
    .no-results {
      text-align: center;
      padding: 60px 20px;
      color: #6c757d;
    }
    .no-results h2 {
      font-size: 1.8em;
      margin-bottom: 10px;
      color: #495057;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1><span style="font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;">🚀</span> ParaWeb Benchmark Results</h1>
      <p>Parallel Programming Patterns Performance Analysis</p>
    </div>
    <div class="content">
      ${
        sortedFiles.length > 0
          ? `
      <div class="stats">
        <div class="stat-card">
          <div class="number">${sortedFiles.length}</div>
          <div class="label">Patterns Tested</div>
        </div>
        <div class="stat-card">
          <div class="number">${new Date().toLocaleDateString()}</div>
          <div class="label">Last Updated</div>
        </div>
        <div class="stat-card">
          <div class="number">5</div>
          <div class="label">Thread Counts</div>
        </div>
        <div class="stat-card">
          <div class="number">4</div>
          <div class="label">Data Sizes</div>
        </div>
      </div>
      
      <h2 style="margin-bottom: 20px; color: #495057;">Available Benchmark Plots</h2>
      <div class="patterns-grid">
        ${sortedFiles
          .map((file) => {
            const patternInfo = patterns.find((p) => p.name === file.pattern);
            return `
        <a href="${file.filename}" class="pattern-card">
          <div class="pattern-name">${file.pattern}</div>
          <div class="pattern-description">${
            patternInfo
              ? patternInfo.description
              : "Performance benchmark results"
          }</div>
          <div class="pattern-link">View Plot →</div>
        </a>`;
          })
          .join("")}
      </div>
      `
          : `
      <div class="no-results">
        <h2>No Benchmark Results Found</h2>
        <p>Run benchmarks first using: <code>npm run test:benchmark</code></p>
      </div>
      `
      }
    </div>
    <div class="footer">
      <p>Generated by ParaWeb Benchmark System | <a href="https://github.com" style="color: #667eea;">View on GitHub</a></p>
    </div>
  </div>
</body>
</html>`;

  return html;
}

function generatePlots() {
  const resultsDir = path.join(process.cwd(), "benchmark-results");
  if (!fs.existsSync(resultsDir)) {
    console.log("No benchmark results directory found.");
    return;
  }

  // Find all JSON result files
  const files = fs
    .readdirSync(resultsDir)
    .filter((f: string) => f.includes("-benchmark-") && f.endsWith(".json"))
    .map((f: string) => {
      const filepath = path.join(resultsDir, f);
      const stats = fs.statSync(filepath);
      return { filename: f, filepath, mtime: stats.mtime.getTime() };
    })
    .sort(
      (
        a: { filename: string; filepath: string; mtime: number },
        b: { filename: string; filepath: string; mtime: number }
      ) => b.mtime - a.mtime
    ); // Sort by modification time, newest first

  // Group by pattern, using only the latest results
  const byPattern = new Map<string, BenchmarkResult[]>();
  const processedPatterns = new Set<string>();

  for (const file of files) {
    const content = fs.readFileSync(file.filepath, "utf-8");
    const results: BenchmarkResult[] = JSON.parse(content);

    for (const result of results) {
      // Only use results from the first (latest) file we encounter for each pattern
      if (!processedPatterns.has(result.pattern)) {
        if (!byPattern.has(result.pattern)) {
          byPattern.set(result.pattern, []);
        }
        byPattern.get(result.pattern)!.push(result);
      }
    }

    // Mark patterns as processed after reading from this file
    for (const result of results) {
      processedPatterns.add(result.pattern);
    }
  }

  // Generate HTML plots for each pattern
  const plotFiles: Array<{ pattern: string; filename: string }> = [];
  for (const [pattern, results] of byPattern.entries()) {
    const html = generateHTMLPlot(pattern, results);
    const htmlPath = path.join(resultsDir, `${pattern}-plot.html`);
    fs.writeFileSync(htmlPath, html, "utf8");
    plotFiles.push({ pattern, filename: `${pattern}-plot.html` });
    console.log(`📊 Generated plot: ${htmlPath}`);
  }

  // Generate index.html
  if (plotFiles.length > 0) {
    const indexHtml = generateIndexHTML(plotFiles);
    const indexPath = path.join(resultsDir, "index.html");
    fs.writeFileSync(indexPath, indexHtml, "utf8");
    console.log(`📋 Generated index: ${indexPath}`);
  }

  console.log(
    `\n✅ Generated ${byPattern.size} plot(s) and index.html. Open index.html in a browser to view all plots.`
  );
}

// Run if called directly
if (require.main === module) {
  generatePlots();
}

export { generatePlots, generateHTMLPlot };
