#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const ABI = [
  "function setTunnelUrl(uint256 tunnelId, string newUrl) external",
  "function url(uint256 tunnelId) view returns (string)",
];

function readTextSafe(fp) {
  try {
    return fs.readFileSync(fp, "utf8").trim();
  } catch {
    return "";
  }
}

function writeTextSafe(fp, value) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${value}\n`);
}

function ensure0x(pk) {
  if (!pk) return "";
  return pk.startsWith("0x") ? pk : `0x${pk}`;
}

function normalizeValue(v) {
  return v.trim();
}

async function main() {
  const rpcUrl = String(process.env.RPC_URL || "").trim();
  const contractAddr = String(process.env.CONTRACT_ADDRESS || "").trim();
  const pk = ensure0x(String(process.env.OPERATOR_PRIVATE_KEY || "").trim());
  const chainId = Number(process.env.CHAIN_ID || "43113");
  const slot = Number(process.env.SLOT || "11");
  const intervalSec = Math.max(5, Number(process.env.PUBLISH_INTERVAL_SECONDS || "15"));

  const subFile = path.resolve(
    process.cwd(),
    process.env.TUNNEL_SUBDOMAIN_FILE || "./tunnel/current_subdomain.txt"
  );
  const lastFile = path.resolve(
    process.cwd(),
    `./tunnel/last_published_slot${slot}.txt`
  );

  if (!rpcUrl || !contractAddr || !pk) {
    throw new Error("Missing RPC_URL / CONTRACT_ADDRESS / OPERATOR_PRIVATE_KEY");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
  const wallet = new ethers.Wallet(pk, provider);
  const contract = new ethers.Contract(contractAddr, ABI, wallet);

  let lastPublished = readTextSafe(lastFile);
  let isRunning = false;

  async function publishIfChanged() {
    if (isRunning) return;
    isRunning = true;
    try {
      const raw = readTextSafe(subFile);
      if (!raw) return;

      const v = normalizeValue(raw);
      if (!v) return;
      if (v === lastPublished) return;

      const onchain = await contract.url(slot).catch(() => "");
      console.log(`[pub] slot=${slot} file=${v} onchain=${onchain}`);

      if (onchain === v) {
        lastPublished = v;
        writeTextSafe(lastFile, v);
        return;
      }

      const tx = await contract.setTunnelUrl(slot, v);
      console.log(`[pub] tx: ${tx.hash}`);
      const rcpt = await tx.wait();
      console.log(`[pub] confirmed block=${rcpt.blockNumber}`);

      lastPublished = v;
      writeTextSafe(lastFile, v);
    } catch (e) {
      console.error(`[pub] publish error:`, e?.message || e);
    } finally {
      isRunning = false;
    }
  }

  await publishIfChanged();
  console.log(`[pub] watching ${subFile} every ${intervalSec}s`);

  setInterval(() => {
    publishIfChanged().catch((e) => {
      console.error(`[pub] interval error:`, e?.message || e);
    });
  }, intervalSec * 1000);
}

main().catch((e) => {
  console.error(`[pub] fatal:`, e?.message || e);
  process.exit(1);
});
