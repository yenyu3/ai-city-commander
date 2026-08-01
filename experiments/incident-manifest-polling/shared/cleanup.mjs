#!/usr/bin/env node
/** Safely remove experiment-only incidents and every artefact they created. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function cleanupExperimentEvents({ eventIds, date, dryRun = false }) {
  const { internalBucket, publicBucket, clusterArn, secretArn } = validateCleanupConfiguration();
  const database = process.env.DB_NAME ?? "aicity";
  const uniqueIds = [...new Set(eventIds)];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
  if (!uniqueIds.length) return { eventIds: [], dryRun, deleted: { database: 0, internalObjects: 0, publicNotices: 0 } };
  for (const eventId of uniqueIds) {
    if (!eventId.startsWith("EXP_")) throw new Error(`Refusing to delete non-experiment event '${eventId}'. Only EXP_ IDs are allowed.`);
  }

  const summary = { eventIds: uniqueIds, date, dryRun, deleted: { database: 0, internalObjects: 0, publicNotices: 0, manifestUpdated: false } };
  if (dryRun) return summary;

  // Delete database rows first: the worker then cannot load an event that was
  // queued shortly before cleanup. decision_jobs cascades through its FK.
  for (const eventId of uniqueIds) {
    const result = await awsJson(["rds-data", "execute-statement", "--resource-arn", clusterArn, "--secret-arn", secretArn, "--database", database, "--sql", "DELETE FROM incidents WHERE event_id = :event_id", "--parameters", JSON.stringify([{ name: "event_id", value: { stringValue: eventId } }])]);
    summary.deleted.database += result.numberOfRecordsUpdated ?? 0;
  }

  for (const eventId of uniqueIds) {
    const keys = new Set([
      `incidents/${date}/${eventId}.json`,
      ...(await listKeys(internalBucket, `incidents/${date}/${eventId}/`)),
      ...(await listKeys(internalBucket, `emergency-reports/${date}/${eventId}/`)),
    ]);
    for (const key of keys) {
      await awsJson(["s3api", "delete-object", "--bucket", internalBucket, "--key", key]);
      summary.deleted.internalObjects += 1;
    }
  }

  const manifestKey = `public/${date}/manifest.json`;
  const tempDir = await mkdtemp(join(tmpdir(), "aicity-cleanup-"));
  try {
    const manifestFile = join(tempDir, "manifest.json");
    try {
      await awsJson(["s3api", "get-object", "--bucket", publicBucket, "--key", manifestKey, manifestFile]);
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      const removed = (manifest.notices ?? []).filter((notice) => uniqueIds.includes(notice.eventId) || uniqueIds.includes(notice.alertId) || uniqueIds.some((id) => notice.noticeId?.includes(id)));
      manifest.notices = (manifest.notices ?? []).filter((notice) => !removed.includes(notice));
      for (const notice of removed) {
        if (notice.noticeKey) {
          await awsJson(["s3api", "delete-object", "--bucket", publicBucket, "--key", notice.noticeKey]);
          summary.deleted.publicNotices += 1;
        }
      }
      await writeFile(manifestFile, JSON.stringify(manifest));
      await awsJson(["s3api", "put-object", "--bucket", publicBucket, "--key", manifestKey, "--body", manifestFile, "--content-type", "application/json; charset=utf-8", "--cache-control", "no-store"]);
      summary.deleted.manifestUpdated = true;
    } catch (error) {
      if (!String(error.message).includes("NoSuchKey")) throw error;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  return summary;
}

export function validateCleanupConfiguration() {
  const config = {
    internalBucket: requiredEnv("INTERNAL_RESULTS_BUCKET"),
    publicBucket: requiredEnv("PUBLIC_RESULTS_BUCKET"),
    clusterArn: requiredEnv("AURORA_CLUSTER_ARN"),
    secretArn: requiredEnv("DATABASE_SECRET_ARN"),
  };
  if (!/^arn:aws(?:-[a-z]+)?:rds:[^:]+:\d{12}:cluster:[^/]+$/.test(config.clusterArn)) {
    throw new Error("AURORA_CLUSTER_ARN must be a real Aurora cluster ARN, not a placeholder.");
  }
  // Secrets Manager resource names may contain `/`, e.g.
  // `secret:ai-city-commander-dev/database-ABC123`.
  if (!/^arn:aws(?:-[a-z]+)?:secretsmanager:[^:]+:\d{12}:secret:.+$/.test(config.secretArn)) {
    throw new Error("DATABASE_SECRET_ARN must be a real Secrets Manager ARN, not a placeholder.");
  }
  return config;
}

async function listKeys(bucket, prefix) {
  const keys = [];
  let token;
  do {
    const args = ["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix];
    if (token) args.push("--continuation-token", token);
    const page = await awsJson(args);
    keys.push(...(page.Contents ?? []).map((item) => item.Key));
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}

async function awsJson(args) {
  const { stdout } = await execFileAsync("aws", [...args, "--output", "json"], { maxBuffer: 5 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : {};
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  return process.env[name];
}

function parseArgs(values) {
  return values.reduce((parsed, value, index) => {
    if (!value.startsWith("--")) return parsed;
    const [key, inline] = value.slice(2).split("=", 2);
    parsed[key] = inline ?? (!values[index + 1]?.startsWith("--") ? values[index + 1] : "true");
    return parsed;
  }, {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const eventIds = (args["event-id"] ?? "").split(",").filter(Boolean);
  const result = await cleanupExperimentEvents({ eventIds, date: args.date, dryRun: args["dry-run"] === "true" });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(`cleanup failed: ${error.message}`); process.exitCode = 1; });
}
