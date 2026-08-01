#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shared = resolve(here, "../shared/run.mjs");
const result = spawnSync(process.execPath, [
  shared,
  ...process.argv.slice(2),
  "--delivery=lambda",
  `--output-dir=${resolve(here, "results")}`,
], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
