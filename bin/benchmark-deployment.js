#!/usr/bin/env node

/**
 * Benchmarks response times between two deployments of the same application.
 *
 * Usage:
 *   node bin/benchmark-deployment.js [options]
 *
 * Options:
 *   --rounds <n>         Number of rounds per endpoint (default: 10)
 *   --concurrency <n>    Concurrent requests per round (default: 1)
 *   --url1 <url>         First URL to benchmark (default: containerized deployment)
 *   --url2 <url>         Second URL to benchmark (default: non-containerized deployment)
 *   --env-path1 <file>   .env file with API_USER/API_PASSWORD/API_BASE_URL for url1 (optional)
 *   --env-path2 <file>   .env file with API_USER/API_PASSWORD/API_BASE_URL for url2 (optional)
 *   --paths <json>       JSON array of paths to test (default: see PATHS below)
 *   --delay <ms>         Delay between rounds in ms (default: 500)
 *
 * If --env-path1/2 are provided the script logs in and attaches X-Session-ID to each request.
 * Paths that return 401 without auth are still measured (timing includes the 401 response).
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";

const DEFAULTS = {
  rounds: 10,
  concurrency: 1,
  delay: 500,
  paths: [
    "/",
    "/api/v1/plugins",
    "/api/v1/collections",
    "/api/v1/files",
  ],
};

// ---- Arg parsing ----

const args = process.argv.slice(2);

/**
 * Extract a named flag value, removing it from args in-place.
 * @param {string[]} argv
 * @param {string} flag
 * @param {string|number|null} def
 * @returns {string|number|null}
 */
function extractArg(argv, flag, def = null) {
  const i = argv.indexOf(flag);
  if (i === -1) return def;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value ?? def;
}

const envPath1 = extractArg(args, "--env-path1");
const envPath2 = extractArg(args, "--env-path2");
const url1 = extractArg(args, "--url1");
const url2 = extractArg(args, "--url2");
const rounds = parseInt(extractArg(args, "--rounds", DEFAULTS.rounds), 10);
const concurrency = parseInt(extractArg(args, "--concurrency", DEFAULTS.concurrency), 10);
const delay = parseInt(extractArg(args, "--delay", DEFAULTS.delay), 10);
const pathsArg = extractArg(args, "--paths");
const paths = pathsArg ? JSON.parse(pathsArg) : DEFAULTS.paths;

// ---- Auth helpers (mirrored from debug-api.js) ----

/**
 * Parse a .env file into a key→value map (no external dependency).
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function parseEnvFile(filePath) {
  const env = {};
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * @param {string} password
 * @returns {string}
 */
function hashPassword(password) {
  return createHash("sha256").update(password).digest("hex");
}

/**
 * Log in and return session ID.
 * @param {string} baseUrl
 * @param {string} username
 * @param {string} password
 * @returns {Promise<string>}
 */
async function login(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, passwd_hash: hashPassword(password) }),
  });
  if (!res.ok) throw new Error(`Login to ${baseUrl} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const sessionId = data.sessionId || data.session_id;
  if (!sessionId) throw new Error(`Login response missing sessionId: ${JSON.stringify(data)}`);
  return sessionId;
}

/**
 * Resolve session ID from an optional env file, using the base URL from the env or the fallback.
 * @param {string|null} envPath
 * @param {string} fallbackUrl
 * @returns {Promise<{sessionId: string|null, baseUrl: string}>}
 */
async function resolveSession(envPath, fallbackUrl) {
  if (!envPath) return { sessionId: null, baseUrl: fallbackUrl };
  const env = parseEnvFile(envPath);
  const baseUrl = env.API_BASE_URL || fallbackUrl;
  const { API_USER: username, API_PASSWORD: password } = env;
  if (!username || !password) throw new Error(`${envPath} must define API_USER and API_PASSWORD`);
  const sessionId = await login(baseUrl, username, password);
  return { sessionId, baseUrl };
}

// ---- Benchmarking ----

/**
 * Measure end-to-end response time for a single request (including body download).
 * @param {string} url
 * @param {string|null} sessionId
 * @returns {Promise<{status: number, time: number, error?: string}>}
 */
async function measureRequest(url, sessionId) {
  const headers = sessionId ? { "X-Session-ID": sessionId } : {};
  const start = performance.now();
  try {
    const res = await fetch(url, { redirect: "follow", headers });
    await res.text();
    return { status: res.status, time: performance.now() - start };
  } catch (err) {
    return { status: 0, time: performance.now() - start, error: err.message };
  }
}

/**
 * @param {string} url
 * @param {string|null} sessionId
 * @param {number} n
 * @returns {Promise<Array<{status: number, time: number}>>}
 */
async function runConcurrent(url, sessionId, n) {
  return Promise.all(Array.from({ length: n }, () => measureRequest(url, sessionId)));
}

/**
 * @param {number[]} times
 * @returns {{min: number, max: number, mean: number, median: number, p90: number}}
 */
function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((s, v) => s + v, 0) / times.length;
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median: sorted[Math.floor(sorted.length / 2)],
    p90: sorted[Math.floor(sorted.length * 0.9)],
  };
}

/** @param {number} n */
const fmt = (n) => n.toFixed(1).padStart(7);

/**
 * @param {number} value
 * @param {number} max
 * @param {number} [width]
 */
function bar(value, max, width = 30) {
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * @param {string} path
 * @param {string} baseUrl1
 * @param {string|null} sessionId1
 * @param {string} baseUrl2
 * @param {string|null} sessionId2
 */
async function benchmarkPath(path, baseUrl1, sessionId1, baseUrl2, sessionId2) {
  const label1 = new URL(baseUrl1).hostname;
  const label2 = new URL(baseUrl2).hostname;

  console.log(`\n  Path: ${path}`);

  const times1 = [];
  const times2 = [];

  for (let r = 0; r < rounds; r++) {
    const [res1, res2] = await Promise.all([
      runConcurrent(`${baseUrl1}${path}`, sessionId1, concurrency),
      runConcurrent(`${baseUrl2}${path}`, sessionId2, concurrency),
    ]);
    times1.push(...res1.map((r) => r.time));
    times2.push(...res2.map((r) => r.time));
    process.stdout.write(`\r    Round ${r + 1}/${rounds}...`);
    if (delay > 0) await new Promise((res) => setTimeout(res, delay));
  }
  process.stdout.write("\r" + " ".repeat(30) + "\r");

  const s1 = stats(times1);
  const s2 = stats(times2);
  const maxMean = Math.max(s1.mean, s2.mean);

  const header = `    ${"Host".padEnd(32)} ${"min".padStart(7)} ${"mean".padStart(7)} ${"median".padStart(7)} ${"p90".padStart(7)} ${"max".padStart(7)}  Bar (mean)`;
  console.log(header);
  console.log("    " + "-".repeat(header.length - 4));

  for (const [label, s] of [[label1, s1], [label2, s2]]) {
    console.log(`    ${label.padEnd(32)} ${fmt(s.min)} ${fmt(s.mean)} ${fmt(s.median)} ${fmt(s.p90)} ${fmt(s.max)}  ${bar(s.mean, maxMean)} ${s.mean.toFixed(0)}ms`);
  }

  const ratio = s1.mean / s2.mean;
  const slowerLabel = ratio > 1 ? label1 : label2;
  const factor = Math.max(ratio, 1 / ratio).toFixed(2);
  console.log(`\n    ${slowerLabel} is ~${factor}x slower (mean)`);
}

async function main() {
  console.log(`\nBenchmark: ${rounds} rounds × ${concurrency} concurrent requests`);
  console.log(`  A: ${url1}${envPath1 ? ` (credentials: ${envPath1})` : " (unauthenticated)"}`);
  console.log(`  B: ${url2}${envPath2 ? ` (credentials: ${envPath2})` : " (unauthenticated)"}`);
  console.log(`  Paths: ${paths.join(", ")}`);

  process.stdout.write("\nAuthenticating...");
  const [{ sessionId: sid1, baseUrl: base1 }, { sessionId: sid2, baseUrl: base2 }] = await Promise.all([
    resolveSession(envPath1, url1),
    resolveSession(envPath2, url2),
  ]);
  console.log(
    ` ${sid1 ? "A authenticated" : "A unauthenticated"}, ${sid2 ? "B authenticated" : "B unauthenticated"}`
  );

  for (const path of paths) {
    await benchmarkPath(path, base1, sid1, base2, sid2);
  }

  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
