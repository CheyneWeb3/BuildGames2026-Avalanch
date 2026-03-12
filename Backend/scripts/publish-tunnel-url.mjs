#!/usr/bin/env node
import { ethers } from "ethers";

const ABI = [
  "function getTunnel(uint256 tunnelId) view returns (string currentUrl,uint256 lastUpdatedAt,uint256 currentVersion,address currentOperator)",
  "function setTunnelUrl(uint256 tunnelId,string newUrl) external",
  "function operator() view returns (address)"
];

function req(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function isTryCloudflare(url) {
  return /^https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com$/.test(url);
}

async function main() {
  const newUrl = (process.argv[2] || "").trim();
  if (!newUrl) throw new Error("Usage: publish-tunnel-url.mjs <https://xxxx.trycloudflare.com>");

  // allow any https URL, but warn if it's not trycloudflare
  if (!newUrl.startsWith("https://")) throw new Error("URL must start with https://");
  if (!isTryCloudflare(newUrl)) {
    console.warn(`[publisher] warning: url does not look like trycloudflare: ${newUrl}`);
  }

  const chainIdExpected = Number(req("TUNNEL_CHAIN_ID"));
  const rpc = req("BSC_TESTNET_RPC");
  const registryAddr = req("TUNNEL_REGISTRY_ADDRESS");
  const slotId = BigInt(req("TUNNEL_SLOT_ID"));
  const pk = req("TUNNEL_OPERATOR_PRIVATE_KEY");

  const provider = new ethers.JsonRpcProvider(rpc);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== chainIdExpected) {
    throw new Error(`Wrong chainId from RPC. Expected ${chainIdExpected}, got ${net.chainId}`);
  }

  const wallet = new ethers.Wallet(pk, provider);
  const registry = new ethers.Contract(registryAddr, ABI, wallet);

  // sanity: operator check (not strictly required, but catches mistakes early)
  const op = (await registry.operator()).toLowerCase();
  if (wallet.address.toLowerCase() !== op) {
    console.warn(`[publisher] warning: signer ${wallet.address} != contract operator ${op}`);
    // still allowed if signer is owner, but you said we’re using operator
  }

  const [currentUrl] = await registry.getTunnel(slotId);
  if ((currentUrl || "").trim() === newUrl) {
    console.log(`[publisher] no-op: slot ${slotId} already set`);
    return;
  }

  // estimate + send
  const gas = await registry.setTunnelUrl.estimateGas(slotId, newUrl);
  const fee = await provider.getFeeData();

  // BSC testnet commonly uses legacy gasPrice; if maxFee exists it’s fine too.
  const tx = await registry.setTunnelUrl(slotId, newUrl, {
    gasLimit: (gas * 120n) / 100n, // +20%
    gasPrice: fee.gasPrice ?? undefined
  });

  console.log(`[publisher] sent: ${tx.hash} (slot=${slotId}, url=${newUrl})`);
  const rcpt = await tx.wait();
  console.log(`[publisher] confirmed in block ${rcpt.blockNumber}`);
}

main().catch((e) => {
  console.error(`[publisher] error: ${e?.message || e}`);
  process.exit(1);
});
