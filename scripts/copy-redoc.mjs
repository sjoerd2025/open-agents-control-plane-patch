#!/usr/bin/env node
//
// Copy Redoc's pre-built standalone bundle from node_modules into
// frontend/static so Vite's `publicDir` picks it up and ships it as
// /redoc.standalone.js. The dashboard's API Reference view loads it
// inside an iframe (frontend/static/redoc.html); the standalone bundle
// is fully self-contained, which sidesteps the CJS-in-ESM and dynamic
// `require()` issues that break Redoc when imported as a React
// component into a Vite build.
//
// Idempotent: skips the copy when source and destination already
// match by mtime+size. Designed to run on `prebuild` alongside the
// other generators.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = resolve(root, "node_modules/redoc/bundles/redoc.standalone.js");
const dstDir = resolve(root, "frontend/static");
const dst = resolve(dstDir, "redoc.standalone.js");

if (!existsSync(src)) {
  console.error(
    `[copy-redoc] missing ${src} — run 'npm install' first (redoc is a devDependency)`,
  );
  process.exit(1);
}

mkdirSync(dstDir, { recursive: true });

if (existsSync(dst)) {
  const a = statSync(src);
  const b = statSync(dst);
  if (a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000) {
    console.log("[copy-redoc] redoc.standalone.js up-to-date");
    process.exit(0);
  }
}

copyFileSync(src, dst);
const { size } = statSync(dst);
console.log(
  `[copy-redoc] copied redoc.standalone.js (${(size / 1024).toFixed(0)} KB) → frontend/static/`,
);
