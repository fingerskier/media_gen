import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main.cjs",
  platform: "node",
  format: "cjs",
  bundle: true,
  external: ["electron"],
  target: "node24",
});
await build({
  entryPoints: ["src/preload/index.ts"],
  outfile: "dist/preload.cjs",
  platform: "node",
  format: "cjs",
  bundle: true,
  external: ["electron"],
  target: "node24",
});
await build({
  entryPoints: ["src/renderer/index.tsx"],
  outfile: "dist/renderer.js",
  platform: "browser",
  format: "iife",
  bundle: true,
  target: "chrome140",
  jsx: "automatic",
});
await copyFile("src/renderer/index.html", "dist/index.html");
console.log("Built Electron main, sandboxed preload, and renderer.");
