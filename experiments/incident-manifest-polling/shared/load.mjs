#!/usr/bin/env node
/**
 * Fan-out/load experiment for one public incident.
 *
 * One POST publishes an event; N simulated citizens then start together and
 * read manifest -> notice. `--shared-cell=true` divides the selected radio
 * profile's downlink capacity by N, modelling many people contending for one
 * overloaded mobile cell. This is intentionally an application-level model,
 * not a replacement for a carrier-network emulator.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanupExperimentEvents, validateCleanupConfiguration } from "./cleanup.mjs";
import { PROFILES } from "./profiles.mjs";

const args = parseArgs(process.argv.slice(2));
const apiBase = required("api-base", args["api-base"] ?? process.env.API_BASE).replace(/\/$/, "");
const delivery = args.delivery ?? "cloudfront";
if (!["cloudfront", "lambda"].includes(delivery)) throw new Error("--delivery must be 'cloudfront' or 'lambda'");
const publicBase = (args["public-base"] ?? process.env.PUBLIC_RESULTS_BASE)?.replace(/\/$/, "");
if (delivery === "cloudfront" && !publicBase) required("public-base", publicBase);
const scenarioAt = args["scenario-at"] ?? "2026-05-20T22:10:00+08:00";
const date = scenarioAt.slice(0, 10);
const profileName = args.profile ?? "crowded-cell";
const baseProfile = PROFILES[profileName];
if (!baseProfile) throw new Error(`Unknown profile '${profileName}'. Use: ${Object.keys(PROFILES).join(", ")}`);
const clients = integer(args.clients ?? "50", "clients", 1, 40_000);
const cells = integer(args.cells ?? "1", "cells", 1, clients);
const sharedCell = args["shared-cell"] !== "false";
const noticeRetries = integer(args["notice-retries"] ?? "2", "notice-retries", 0, 10);
const retryBaseMs = integer(args["retry-base-ms"] ?? "500", "retry-base-ms", 1, 60_000);
const pollIntervalMs = integer(args["poll-interval-ms"] ?? "2000", "poll-interval-ms", 100, 60_000);
const maxWaitMs = integer(args["max-wait-ms"] ?? "120000", "max-wait-ms", 1_000, 600_000);
const cleanupWaitMs = integer(args["cleanup-wait-ms"] ?? "10000", "cleanup-wait-ms", 0, 120_000);
const cleanupRecheckMs = integer(args["cleanup-recheck-ms"] ?? "10000", "cleanup-recheck-ms", 0, 120_000);
const outputDir = resolve(args["output-dir"] ?? "./results");
if (clients > 10_000 && args["confirm-large-load"] !== "true") {
  throw new Error("More than 10,000 clients needs --confirm-large-load=true; this may exhaust the local load generator.");
}
validateCleanupConfiguration();

const effectiveProfile = {
  ...baseProfile,
  // `downlinkKbps` is the per-cell capacity in the selected profile. Divide
  // it across average users per cell, instead of unrealistically forcing a
  // whole city into a single radio cell.  0.1 Kbps is a safety floor so a
  // deliberately extreme test still makes progress.
  downlinkKbps: sharedCell ? Math.max(0.1, (baseProfile.downlinkKbps * cells) / clients) : baseProfile.downlinkKbps,
};
const manifestUrl = delivery === "cloudfront"
  ? `${publicBase}/public/${date}/manifest.json`
  : `${apiBase}/api/experiments/public-notices?date=${encodeURIComponent(date)}`;
const eventId = `EXP_LOAD_${Date.now()}`;
const report = {
  startedAt: new Date().toISOString(),
  configuration: { delivery, profileName, baseProfile, effectiveProfile, clients, cells, averageClientsPerCell: clients / cells, sharedCell, noticeRetries, retryBaseMs, pollIntervalMs, maxWaitMs, scenarioAt, manifestUrl, largeLoad: clients > 10_000 },
  eventId,
  injection: null,
  clients: [],
};

console.log(`publishing ${eventId}; starting ${clients} concurrent clients via ${delivery}`);
const injection = await impairedFetch(`${apiBase}/api/incidents`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ context: { scenarioAt }, incident: makeIncident(eventId, scenarioAt) }),
}, PROFILES.fast); // government/control connection is not the congested public cell
report.injection = compact(injection);
if (!injection.ok || injection.status !== 202) throw new Error(`incident injection failed: ${injection.error ?? injection.status}`);

const fanoutStarted = performance.now();
report.clients = await Promise.all(Array.from({ length: clients }, (_, index) => consumeNotice(index + 1, fanoutStarted)));
report.summary = summarize(report.clients);

await mkdir(outputDir, { recursive: true });
const stamp = report.startedAt.replaceAll(":", "-").replaceAll(".", "-");
const jsonPath = `${outputDir}/fanout-${delivery}-${profileName}-${stamp}.json`;
const csvPath = `${outputDir}/fanout-${delivery}-${profileName}-${stamp}.csv`;
await writeFile(jsonPath, JSON.stringify(report, null, 2));
await writeFile(csvPath, toCsv(report.clients));

await sleep(cleanupWaitMs);
const cleanupInput = { eventIds: [eventId], date };
const firstPass = await cleanupExperimentEvents(cleanupInput);
await sleep(cleanupRecheckMs);
const secondPass = await cleanupExperimentEvents(cleanupInput);
report.cleanup = { firstPass, secondPass };
await writeFile(jsonPath, JSON.stringify(report, null, 2));
console.log(`JSON: ${jsonPath}\nCSV:  ${csvPath}`);
console.log(JSON.stringify(report.summary, null, 2));

async function consumeNotice(clientId, started) {
  const result = { clientId, status: "failed", manifestRequests: 0, noticeRequests: 0, noticeRetries: 0, bytes: 0, timings: {} };
  const deadline = performance.now() + maxWaitMs;
  while (performance.now() < deadline) {
    result.manifestRequests += 1;
    const manifest = await impairedFetch(withQuery(manifestUrl, { client: clientId, poll: result.manifestRequests }), {}, effectiveProfile);
    result.bytes += manifest.bytes ?? 0;
    if (manifest.ok) {
      const entry = manifest.json?.notices?.find((notice) => notice.eventId === eventId || notice.alertId === eventId || notice.noticeId?.includes(eventId));
      if (entry) {
        result.timings.manifestDetectedMs = elapsed(started);
        for (let attempt = 0; attempt <= noticeRetries; attempt += 1) {
          result.noticeRequests += 1;
          const notice = await impairedFetch(buildNoticeUrl(entry), {}, effectiveProfile);
          result.bytes += notice.bytes ?? 0;
          if (notice.ok) {
            result.status = "ready";
            result.timings.endToEndMs = elapsed(started);
            return result;
          }
          if (attempt < noticeRetries) {
            result.noticeRetries += 1;
            // Backoff + jitter prevents perfectly synchronised retry bursts.
            await sleep(retryBaseMs * (2 ** attempt) + Math.random() * retryBaseMs);
          }
        }
        result.status = "notice_fetch_failed";
        result.timings.endToEndMs = elapsed(started);
        return result;
      }
    }
    await sleep(pollIntervalMs + Math.random() * pollIntervalMs * 0.25);
  }
  result.status = "manifest_timeout";
  result.timings.endToEndMs = elapsed(started);
  return result;
}

function buildNoticeUrl(entry) {
  if (delivery === "lambda") return `${apiBase}/api/experiments/public-notices?date=${encodeURIComponent(date)}&noticeId=${encodeURIComponent(entry.noticeId)}`;
  return `${publicBase}/${entry.noticeKey.replace(/^\//, "")}`;
}
function makeIncident(eventId, occurredAt) {
  return { eventId, type: "Road_Collapse_Accident", location: "實驗：大量公告讀取", affectedSegmentId: "RD_TPE_002", status: "Closed", severity: "Critical", description: "大量使用者公告讀取效能實驗；請勿作為實際交通事件處理。", occurredAt };
}
async function impairedFetch(url, init, profile) {
  if (Math.random() < profile.failureRate) return { ok: false, error: "simulated_network_failure", bytes: 0 };
  await sleep(profile.latencyMs + random(-profile.jitterMs, profile.jitterMs));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile.timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const bytes = await bodyAtBandwidth(response, profile.downlinkKbps);
    let json;
    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* measured but malformed */ }
    }
    return { ok: response.ok, status: response.status, bytes: bytes.byteLength, json };
  } catch (error) { return { ok: false, error: error.name === "AbortError" ? "timeout" : error.message, bytes: 0 }; }
  finally { clearTimeout(timeout); }
}
async function bodyAtBandwidth(response, kbps) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); total += value.byteLength; await sleep(value.byteLength * 8 / kbps); }
  const body = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
function summarize(clients) {
  const ready = clients.filter((client) => client.status === "ready");
  const times = ready.map((client) => client.timings.endToEndMs).sort((a, b) => a - b);
  return { totalClients: clients.length, readyClients: ready.length, failedClients: clients.length - ready.length, successRate: Math.round((ready.length / clients.length) * 10_000) / 10_000, totalManifestRequests: clients.reduce((n, c) => n + c.manifestRequests, 0), totalNoticeRequests: clients.reduce((n, c) => n + c.noticeRequests, 0), totalNoticeRetries: clients.reduce((n, c) => n + c.noticeRetries, 0), totalBytes: clients.reduce((n, c) => n + c.bytes, 0), deliveryMs: times.length ? { min: times[0], p50: percentile(times, 0.5), p95: percentile(times, 0.95), max: times.at(-1) } : null };
}
function toCsv(clients) { return ["clientId,status,manifestRequests,noticeRequests,noticeRetries,bytes,manifestDetectedMs,endToEndMs", ...clients.map((c) => [c.clientId, c.status, c.manifestRequests, c.noticeRequests, c.noticeRetries, c.bytes, c.timings.manifestDetectedMs ?? "", c.timings.endToEndMs ?? ""].join(","))].join("\n") + "\n"; }
function parseArgs(values) { return values.reduce((parsed, value, index) => { if (!value.startsWith("--")) return parsed; const [key, inline] = value.slice(2).split("=", 2); parsed[key] = inline ?? (!values[index + 1]?.startsWith("--") ? values[index + 1] : "true"); return parsed; }, {}); }
function required(name, value) { if (!value) throw new Error(`Missing --${name} or its environment variable.`); return value; }
function integer(value, name, min, max) { const n = Number.parseInt(value, 10); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer from ${min} to ${max}`); return n; }
function withQuery(raw, params) { const url = new URL(raw); for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value)); return url.toString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))); }
function random(min, max) { return Math.random() * (max - min) + min; }
function elapsed(started) { return round(performance.now() - started); }
function round(value) { return Math.round(value * 100) / 100; }
function percentile(values, p) { return values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]; }
function compact(result) { return { ok: result.ok, status: result.status ?? null, error: result.error ?? null, bytes: result.bytes ?? 0 }; }
