import fs from "node:fs/promises";
import { build } from "esbuild";
await fs.mkdir("public/vendor", { recursive: true });
await build({
  entryPoints: ["src/app.mjs"],
  bundle: true,
  format: "esm",
  outfile: "public/app.js",
  minify: true,
});
await fs.copyFile(
  "node_modules/pdfjs-dist/build/pdf.mjs",
  "public/vendor/pdf.mjs",
);
await fs.copyFile(
  "node_modules/pdfjs-dist/build/pdf.worker.mjs",
  "public/vendor/pdf.worker.mjs",
);
await fs.cp("node_modules/pdfjs-dist/cmaps", "public/vendor/cmaps", {
  recursive: true,
});
await fs.cp(
  "node_modules/pdfjs-dist/standard_fonts",
  "public/vendor/standard_fonts",
  { recursive: true },
);
await fs.cp("node_modules/katex/dist/fonts", "public/fonts", {
  recursive: true,
});
await fs.copyFile("node_modules/katex/dist/katex.min.css", "public/katex.css");
console.log("Frontend built.");
