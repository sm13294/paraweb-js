// Shared top navigation, injected into <div id="nav"> on every demo page.
// Single source of truth so adding/renaming a demo only touches this file.
//
// Usage in each HTML:
//   <div id="nav"></div>
//   <script src="./nav.js"></script>

(() => {
  const links = [
    { href: "./index.html", label: "All Benchmarks" },
    { href: "./map.html", label: "Map" },
    { href: "./filter.html", label: "Filter" },
    { href: "./reduce.html", label: "Reduce" },
    { href: "./scan.html", label: "Scan" },
    { href: "./accumulator.html", label: "Accumulator" },
    { href: "./mapreduce.html", label: "MapReduce" },
    { href: "./scatter.html", label: "Scatter" },
    { href: "./stencil.html", label: "Stencil" },
    { href: "./farm.html", label: "Farm" },
    { href: "./pipeline.html", label: "Pipeline" },
    { href: "./divideandconquer.html", label: "Divide-and-Conquer" },
    { href: "./imageConv.html", label: "Image Convolution" },
  ];

  // Normalise the current path to a basename without trailing slash or
  // ".html" suffix; covers Vercel's cleanUrls (e.g. /scan) and direct
  // file access (e.g. /scan.html), and treats "/" as "index".
  const path = location.pathname;
  let here = path.replace(/\/+$/, "").split("/").pop() || "index";
  here = here.replace(/\.html$/, "");

  const html = links
    .map(({ href, label }) => {
      const file = href.replace(/^\.\//, "").replace(/\.html$/, "");
      return file === here
        ? `<strong>${label}</strong>`
        : `<a href="${href}">${label}</a>`;
    })
    .join(" | ");

  const mount = document.getElementById("nav");
  if (mount) mount.innerHTML = html;
})();
