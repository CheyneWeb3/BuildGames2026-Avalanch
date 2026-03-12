#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const SERVICE_URL = process.env.TUNNEL_SERVICE_URL || "http://127.0.0.1:8088";
const SUBDOMAIN_FILE = process.env.TUNNEL_SUBDOMAIN_FILE || "./tunnel/current_subdomain.txt";
const BIN = process.env.CLOUDFLARED_BIN || "cloudflared";

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function readExisting() {
  try { return fs.readFileSync(SUBDOMAIN_FILE, "utf8").trim(); } catch { return ""; }
}

function writeSlug(slug) {
  const prev = readExisting();
  if (slug && slug === prev) return;
  ensureDir(SUBDOMAIN_FILE);
  fs.writeFileSync(SUBDOMAIN_FILE, slug + "\n", "utf8");
  console.log(`[quick] wrote slug: ${slug}`);
}

function extractSlug(text) {
  const m = text.match(/https?:\/\/([a-z0-9-]+)\.trycloudflare\.com/iu);
  return m ? m[1] : null;
}

// Backoff handling for 429/1015
let backoffMs = 2000;
const BACKOFF_MAX = 5 * 60 * 1000; // 5 min cap (better than 15m spam)
function nextBackoff(isRateLimit) {
  if (!isRateLimit) { backoffMs = 2000; return backoffMs; }
  backoffMs = Math.min(BACKOFF_MAX, Math.floor(backoffMs * 2));
  return backoffMs;
}

async function runOnce() {
  console.log(`[quick] starting cloudflared -> ${SERVICE_URL}`);
  const args = ["tunnel", "--url", SERVICE_URL, "--no-autoupdate"];
  const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

  let sawSlug = false;
  let sawRateLimit = false;

  const onData = (buf) => {
    const s = buf.toString("utf8");
    process.stdout.write(s);

    if (!sawSlug) {
      const slug = extractSlug(s);
      if (slug) { sawSlug = true; writeSlug(slug); }
    }

    // detect rate limiting
    if (s.includes("status_code=\"429") || s.includes("error code: 1015") || s.includes("Too Many Requests")) {
      sawRateLimit = true;
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code: Number(code ?? 1), sawRateLimit, sawSlug };
}

while (true) {
  const { code, sawRateLimit } = await runOnce();
  const wait = nextBackoff(sawRateLimit);
  console.log(`[quick] exited code=${code}. rateLimit=${sawRateLimit}. retry in ${wait}ms`);
  await new Promise((r) => setTimeout(r, wait));
}
