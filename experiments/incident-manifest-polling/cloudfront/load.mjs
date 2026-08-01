#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, [resolve(here, "../shared/load.mjs"), ...process.argv.slice(2), "--delivery=cloudfront", `--output-dir=${resolve(here, "results")}`], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
