#!/usr/bin/env node
/**
 * End-to-end experiment for the emergency-publication path:
 *
 * POST /api/incidents -> poll CloudFront manifest -> fetch notice JSON.
 *
 * Network impairment is deliberately applied on the client. It models the
 * user's last-mile connection, without changing API Gateway, CloudFront or S3.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanupExperimentEvents, validateCleanupConfiguration } from "./cleanup.mjs";
import { PROFILES } from "./profiles.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help === "true") {
  console.log(`Usage: npm run run -- --api-base=<API Gateway URL> --public-base=<CloudFront URL> [options]

Options: --profile=fast|slow-3g|unstable --runs=<n> --poll-interval-ms=<n>
         --max-wait-ms=<n> --output-dir=<path> --scenario-at=<ISO-8601>
         --skip-inject=true --event-id=<existing event id> --cleanup-wait-ms=<n>
         --cleanup-recheck-ms=<n>`);
  process.exit(0);
}
const apiBase = required("api-base", args["api-base"] ?? process.env.API_BASE).replace(/\/$/, "");
const delivery = args.delivery ?? "cloudfront";
if (!["cloudfront", "lambda"].includes(delivery)) throw new Error("--delivery must be 'cloudfront' or 'lambda'");
const configuredPublicBase = args["public-base"] ?? process.env.PUBLIC_RESULTS_BASE;
const publicBase = configuredPublicBase?.replace(/\/$/, "");
if (delivery === "cloudfront" && !publicBase) required("public-base", publicBase);
const scenarioAt = args["scenario-at"] ?? "2026-05-20T22:10:00+08:00";
const profileName = args.profile ?? "fast";
const profile = PROFILES[profileName];
if (!profile) throw new Error(`Unknown profile '${profileName}'. Use: ${Object.keys(PROFILES).join(", ")}`);

const runs = integerArg(args.runs ?? "1", "runs", 1);
const pollIntervalMs = integerArg(args["poll-interval-ms"] ?? "2000", "poll-interval-ms", 100);
const maxWaitMs = integerArg(args["max-wait-ms"] ?? "120000", "max-wait-ms", 1_000);
const outputDir = resolve(args["output-dir"] ?? "./results");
const skipInject = args["skip-inject"] === "true";
const cleanup = !skipInject;
const cleanupWaitMs = integerArg(args["cleanup-wait-ms"] ?? "10000", "cleanup-wait-ms", 0);
const cleanupRecheckMs = integerArg(args["cleanup-recheck-ms"] ?? "10000", "cleanup-recheck-ms", 0);
const suppliedEventId = args["event-id"];

if (skipInject && !suppliedEventId) throw new Error("--event-id is required with --skip-inject=true");
if (suppliedEventId && runs !== 1 && !skipInject) throw new Error("--event-id can only be used with --runs=1");
// Fail before POSTing anything. A test may only inject data when the matching
// cleanup credentials/configuration are already present.
if (cleanup) validateCleanupConfiguration();

const date = scenarioAt.slice(0, 10);
const manifestUrl = delivery === "cloudfront"
  ? `${publicBase}/public/${date}/manifest.json`
  : `${apiBase}/api/experiments/public-notices?date=${encodeURIComponent(date)}`;
const report = {
  startedAt: new Date().toISOString(),
  configuration: { apiBase, publicBase: publicBase ?? null, delivery, scenarioAt, manifestUrl, profileName, profile, runs, pollIntervalMs, maxWaitMs, skipInject, cleanup, cleanupWaitMs, cleanupRecheckMs },
  runs: [],
};

for (let index = 1; index <= runs; index += 1) {
  const eventId = suppliedEventId ?? `EXP_${Date.now()}_${String(index).padStart(3, "0")}`;
  console.log(`run ${index}/${runs}: ${eventId}`);
  const result = await executeRun({ eventId, index });
  report.runs.push(result);
  console.log(`  ${result.status}; manifest polls=${result.manifest.polls}; end-to-end=${result.timings.endToEndMs ?? "n/a"}ms`);
}

report.completedAt = new Date().toISOString();
report.summary = summarize(report.runs);
await mkdir(outputDir, { recursive: true });
const stamp = report.startedAt.replaceAll(":", "-").replaceAll(".", "-");
const jsonPath = `${outputDir}/incident-manifest-${profileName}-${stamp}.json`;
const csvPath = `${outputDir}/incident-manifest-${profileName}-${stamp}.csv`;
await writeFile(jsonPath, JSON.stringify(report, null, 2));
await writeFile(csvPath, toCsv(report.runs));
if (cleanup) {
  // The incident worker is asynchronous. A second pass catches artefacts
  // written after the first pass by a Worker that had loaded the event.
  await sleep(cleanupWaitMs);
  const cleanupInput = { eventIds: report.runs.map((run) => run.eventId), date };
  const firstPass = await cleanupExperimentEvents(cleanupInput);
  await sleep(cleanupRecheckMs);
  const secondPass = await cleanupExperimentEvents(cleanupInput);
  report.cleanup = { firstPass, secondPass };
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
}
console.log(`\nJSON: ${jsonPath}\nCSV:  ${csvPath}`);
console.log(JSON.stringify(report.summary, null, 2));

async function executeRun({ eventId, index }) {
  const started = performance.now();
  const result = {
    run: index,
    eventId,
    status: "failed",
    timings: { startedAt: new Date().toISOString() },
    injection: null,
    manifest: { url: manifestUrl, polls: 0, successes: 0, failures: 0, bytes: 0, attempts: [] },
    notice: null,
  };

  if (!skipInject) {
    const injection = await impairedFetch(`${apiBase}/api/incidents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: { scenarioAt }, incident: makeIncident(eventId, scenarioAt) }),
    }, profile);
    result.injection = compactFetch(injection);
    if (!injection.ok || injection.status !== 202) {
      result.status = "injection_failed";
      result.timings.endToEndMs = elapsed(started);
      return result;
    }
  }

  const deadline = performance.now() + maxWaitMs;
  while (performance.now() < deadline) {
    result.manifest.polls += 1;
    const attemptStarted = performance.now();
    const manifest = await impairedFetch(withQuery(manifestUrl, { experiment: eventId, poll: result.manifest.polls }), {}, profile);
    const attempt = compactFetch(manifest);
    attempt.atMs = elapsed(started);
    attempt.durationMs = elapsed(attemptStarted);
    result.manifest.attempts.push(attempt);
    result.manifest.bytes += manifest.bytes ?? 0;

    if (manifest.ok) {
      result.manifest.successes += 1;
      const entry = findNotice(manifest.json, eventId);
      if (entry) {
        result.timings.manifestDetectedMs = elapsed(started);
        const noticeRequestUrl = buildNoticeUrl(entry);
        const notice = await impairedFetch(noticeRequestUrl, {}, profile);
        result.notice = { url: noticeRequestUrl, ...compactFetch(notice) };
        result.timings.noticeFetchedMs = elapsed(started);
        result.timings.endToEndMs = elapsed(started);
        result.status = notice.ok ? "ready" : "notice_fetch_failed";
        return result;
      }
    } else {
      result.manifest.failures += 1;
    }
    await sleep(pollIntervalMs);
  }
  result.status = "manifest_timeout";
  result.timings.endToEndMs = elapsed(started);
  return result;
}

function makeIncident(eventId, occurredAt) {
  return {
    eventId,
    type: "Road_Collapse_Accident",
    location: "實驗：光復南路與忠孝東路口南側",
    affectedSegmentId: "RD_TPE_002",
    status: "Closed",
    severity: "Critical",
    description: "效能實驗用人工注入事件；請勿作為實際交通事件處理。",
    occurredAt,
  };
}

function findNotice(manifest, eventId) {
  return manifest?.notices?.find((notice) => notice.eventId === eventId || notice.alertId === eventId || notice.noticeId?.includes(eventId));
}

function buildNoticeUrl(entry) {
  if (delivery === "lambda") {
    return `${apiBase}/api/experiments/public-notices?date=${encodeURIComponent(date)}&noticeId=${encodeURIComponent(entry.noticeId)}`;
  }
  if (!entry.noticeKey) throw new Error("Manifest notice is missing noticeKey");
  return `${publicBase}/${entry.noticeKey.replace(/^\//, "")}`;
}

function withQuery(rawUrl, params) {
  const url = new URL(rawUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function impairedFetch(url, init, network) {
  if (Math.random() < network.failureRate) return { ok: false, error: "simulated_network_failure", bytes: 0, durationMs: 0 };
  await sleep(network.latencyMs + randomBetween(-network.jitterMs, network.jitterMs));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), network.timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const body = await consumeAtBandwidth(response, network.downlinkKbps);
    const contentType = response.headers.get("content-type") ?? "";
    let json;
    if (contentType.includes("application/json")) {
      try { json = JSON.parse(new TextDecoder().decode(body)); } catch { /* response remains measurable */ }
    }
    return { ok: response.ok, status: response.status, bytes: body.byteLength, json, durationMs: elapsed(started) };
  } catch (error) {
    return { ok: false, error: error.name === "AbortError" ? "timeout" : error.message, bytes: 0, durationMs: elapsed(started) };
  } finally {
    clearTimeout(timeout);
  }
}

async function consumeAtBandwidth(response, downlinkKbps) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    // kbps is kilobits/s; delay reproduces a constrained downstream link.
    await sleep((value.byteLength * 8 * 1000) / (downlinkKbps * 1000));
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return all;
}

function compactFetch(result) {
  return { ok: result.ok, status: result.status ?? null, error: result.error ?? null, bytes: result.bytes ?? 0, durationMs: round(result.durationMs ?? 0) };
}

function summarize(runs) {
  const ready = runs.filter((run) => run.status === "ready");
  const values = ready.map((run) => run.timings.endToEndMs).sort((a, b) => a - b);
  return {
    totalRuns: runs.length,
    readyRuns: ready.length,
    failedRuns: runs.length - ready.length,
    successRate: round(runs.length ? ready.length / runs.length : 0),
    endToEndMs: values.length ? { min: round(values[0]), p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), max: round(values.at(-1)) } : null,
  };
}

function toCsv(runs) {
  const headers = ["run", "eventId", "status", "injectionMs", "manifestPolls", "manifestSuccesses", "manifestFailures", "manifestBytes", "manifestDetectedMs", "noticeFetchMs", "endToEndMs", "noticeBytes"];
  const rows = runs.map((run) => [run.run, run.eventId, run.status, run.injection?.durationMs, run.manifest.polls, run.manifest.successes, run.manifest.failures, run.manifest.bytes, run.timings.manifestDetectedMs, run.notice?.durationMs, run.timings.endToEndMs, run.notice?.bytes]);
  return [headers, ...rows].map((row) => row.map(csv).join(",")).join("\n") + "\n";
}

function parseArgs(values) {
  return values.reduce((parsed, value, index) => {
    if (!value.startsWith("--")) return parsed;
    const [key, inline] = value.slice(2).split("=", 2);
    parsed[key] = inline ?? (!values[index + 1]?.startsWith("--") ? values[index + 1] : "true");
    return parsed;
  }, {});
}
function required(name, value) { if (!value) throw new Error(`Missing --${name} or its environment variable.`); return value; }
function integerArg(value, name, min) { const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || parsed < min) throw new Error(`--${name} must be an integer >= ${min}`); return parsed; }
function randomBetween(min, max) { return Math.random() * (max - min) + min; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))); }
function elapsed(started) { return round(performance.now() - started); }
function round(value) { return Math.round(value * 100) / 100; }
function percentile(values, p) { return values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]; }
function csv(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
