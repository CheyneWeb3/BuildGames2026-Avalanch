// src/pages/SwapAggrigator/VeloraSwapPage.tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Container,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
  Alert,
} from "@mui/material";
import { BrowserProvider, Contract, formatUnits, parseUnits } from "ethers";
import { useAppKitAccount, useAppKitNetwork, useAppKitProvider } from "../../config";

import TokenPicker from "./TokenListModal/TokenModal"; // your uploaded TokenModal.tsx exports React.memo(TokenPicker)
import { useTokenList, TokenEntry } from "./TokenListModal/useTokenList";

const VELORA_PARTNER = "0x0b696783f18522c7de21e6eeb1080a2bd7cfa137";
const VELORA_PARTNER_FEE_BPS = "30"; // 30 bps = 0.30%
const VELORA_PARTNER_NAME = "HausCashier"; // analytics tag (optional)

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const ERC20_PERMIT_ABI = [
  "function nonces(address owner) view returns (uint256)",
  // not all tokens expose these, but we try
  "function name() view returns (string)",
];

function isNative(t?: TokenEntry | null) {
  if (!t) return false;
  // Your token list likely marks native as address empty or "0xEeeee..." etc.
  // Adjust if your TokenEntry has a native flag.
  const a = (t.address || "").toLowerCase();
  return a === "" || a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
}

function toVeloraTokenAddress(t: TokenEntry) {
  // Paraswap/Velora commonly uses 0xEeee.. for native token
  if (isNative(t)) return "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  return t.address;
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const txt = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(txt);
  } catch {
    // keep raw text
  }
  if (!res.ok) {
    const msg = json?.error || json?.message || txt || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

async function buildPermitSigIfPossible(args: {
  provider: BrowserProvider;
  tokenAddress: string;
  owner: string;
  spender: string;
  value: bigint;
  chainId: number;
  deadline: number; // seconds
}): Promise<string | null> {
  const { provider, tokenAddress, owner, spender, value, chainId, deadline } = args;

  // If token doesn't support nonces(), bail out quickly.
  const token = new Contract(tokenAddress, ERC20_PERMIT_ABI, await provider.getSigner());
  let nonce: bigint;
  let name: string;

  try {
    nonce = await token.nonces(owner);
  } catch {
    return null;
  }

  try {
    name = await token.name();
  } catch {
    // Some tokens break name()—still not worth proceeding
    return null;
  }

  // Try common versions (many are "1"; some are "2")
  const signer = await provider.getSigner();

  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const message = {
    owner,
    spender,
    value: value.toString(),
    nonce: nonce.toString(),
    deadline,
  };

  const tryVersions = ["1", "2"];
  for (const version of tryVersions) {
    try {
      const domain = {
        name,
        version,
        chainId,
        verifyingContract: tokenAddress,
      };

      // ethers v6: signer.signTypedData(domain, types, message)
      const sig = await signer.signTypedData(domain as any, types as any, message as any);

      // Velora expects "Hex string for the signature used for Permit" :contentReference[oaicite:1]{index=1}
      return sig; // 0x...
    } catch {
      // try next version
    }
  }

  return null;
}

export default function VeloraSwapPage() {
  const { address, isConnected } = useAppKitAccount();
  const { chainId } = useAppKitNetwork();
  const { walletProvider } = useAppKitProvider("eip155");

  const { tokensByChain } = useTokenList(); // assumes your hook returns tokens keyed by chainId
  const chainTokens: TokenEntry[] = useMemo(() => {
    if (!chainId) return [];
    return tokensByChain?.[chainId] || [];
  }, [tokensByChain, chainId]);

  const [fromToken, setFromToken] = useState<TokenEntry | null>(null);
  const [toToken, setToToken] = useState<TokenEntry | null>(null);
  const [fromAmtUi, setFromAmtUi] = useState<string>("");

  const [slippageBps, setSlippageBps] = useState<number>(100); // 1%
  const [preferPermit, setPreferPermit] = useState<boolean>(true);

  const [quoteBusy, setQuoteBusy] = useState(false);
  const [swapBusy, setSwapBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [quote, setQuote] = useState<any | null>(null); // raw /prices response
  const [destAmountUi, setDestAmountUi] = useState<string>("");

  // TokenModal control
  const [pickFromOpen, setPickFromOpen] = useState(false);
  const [pickToOpen, setPickToOpen] = useState(false);

  // set defaults when chain changes
  useEffect(() => {
    setQuote(null);
    setDestAmountUi("");
    setErr(null);

    // basic defaults: first 2 tokens
    if (chainTokens.length >= 2) {
      setFromToken(chainTokens[0]);
      setToToken(chainTokens[1]);
    } else {
      setFromToken(chainTokens[0] || null);
      setToToken(chainTokens[1] || null);
    }
  }, [chainTokens]);

  const provider = useMemo(() => {
    if (!walletProvider) return null;
    return new BrowserProvider(walletProvider as any);
  }, [walletProvider]);

  const canQuote = !!provider && !!chainId && !!fromToken && !!toToken && !!fromAmtUi && Number(fromAmtUi) > 0;

  const onQuote = useCallback(async () => {
    setErr(null);
    setQuote(null);
    setDestAmountUi("");

    if (!provider || !chainId || !fromToken || !toToken) return;
    if (!fromAmtUi || Number(fromAmtUi) <= 0) return;

    try {
      setQuoteBusy(true);

      const src = toVeloraTokenAddress(fromToken);
      const dst = toVeloraTokenAddress(toToken);

      const srcDecimals = fromToken.decimals;
      const dstDecimals = toToken.decimals;

      const srcAmount = parseUnits(fromAmtUi, srcDecimals).toString();

      // Velora “/prices” endpoint (Retrieve a price: /prices) then /transactions :contentReference[oaicite:2]{index=2}
      const qs = new URLSearchParams({
        network: String(chainId),
        srcToken: src,
        destToken: dst,
        srcDecimals: String(srcDecimals),
        destDecimals: String(dstDecimals),
        amount: srcAmount,
        side: "SELL",
        version: "6.2",
        includeContractMethods: "simpleSwap,multiSwap,megaSwap",
      });

      const url = `https://api.paraswap.io/prices?${qs.toString()}`;
      const q = await fetchJson(url);

      // For SELL, expect destAmount in the response (commonly q.priceRoute.destAmount or q.destAmount)
      const pr = q?.priceRoute || q;
      const destAmountRaw = pr?.destAmount ?? pr?.toAmount ?? pr?.destAmountWithSlippage ?? q?.destAmount;

      if (destAmountRaw) {
        setDestAmountUi(formatUnits(BigInt(destAmountRaw), dstDecimals));
      }

      setQuote(q);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setQuoteBusy(false);
    }
  }, [provider, chainId, fromToken, toToken, fromAmtUi]);

  const ensureAllowanceIfNeeded = useCallback(
    async (spender: string, srcAmount: bigint) => {
      if (!provider || !address || !fromToken) throw new Error("Wallet not ready");
      if (isNative(fromToken)) return; // native doesn’t need approval
      const signer = await provider.getSigner();
      const token = new Contract(fromToken.address, ERC20_ABI, signer);

      const allowance: bigint = await token.allowance(address, spender);
      if (allowance >= srcAmount) return;

      // approve exact amount (safer than infinite); you can switch to MaxUint256 if you prefer
      const tx = await token.approve(spender, srcAmount);
      await tx.wait();
    },
    [provider, address, fromToken]
  );

  const onSwap = useCallback(async () => {
    setErr(null);
    if (!provider || !chainId || !address || !fromToken || !toToken) return;
    if (!quote) {
      setErr("Get a quote first.");
      return;
    }

    try {
      setSwapBusy(true);

      const pr = quote?.priceRoute || quote;
      const tokenTransferProxy: string | undefined =
        pr?.tokenTransferProxy || quote?.tokenTransferProxy;

      if (!tokenTransferProxy) {
        throw new Error("Velora quote missing tokenTransferProxy (spender). Re-quote.");
      }

      const srcDecimals = fromToken.decimals;
      const srcAmount = parseUnits(fromAmtUi, srcDecimals);
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 mins

      let permitSig: string | null = null;

      // Permit-first (toggle)
      if (preferPermit && !isNative(fromToken)) {
        permitSig = await buildPermitSigIfPossible({
          provider,
          tokenAddress: fromToken.address,
          owner: address,
          spender: tokenTransferProxy,
          value: srcAmount,
          chainId,
          deadline,
        });
      }

      // If no permit, fallback to approve
      if (!permitSig) {
        await ensureAllowanceIfNeeded(tokenTransferProxy, srcAmount);
      }

      // Build tx via /transactions/:network :contentReference[oaicite:3]{index=3}
      const body: any = {
        priceRoute: pr, // must be EXACT as returned :contentReference[oaicite:4]{index=4}
        slippage: slippageBps,
        userAddress: address, // msg.sender :contentReference[oaicite:5]{index=5}

        // Integrator fee
        partner: VELORA_PARTNER_NAME,
        partnerAddress: VELORA_PARTNER,
        partnerFeeBps: VELORA_PARTNER_FEE_BPS,
        takeSurplus: true, // required with isDirectFeeTransfer in common error note :contentReference[oaicite:6]{index=6}
        isDirectFeeTransfer: true,

        deadline,
      };

      if (permitSig) body.permit = permitSig;

      const txBuild = await fetchJson(`https://api.paraswap.io/transactions/${chainId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      // txBuild usually contains: to, data, value, from, gas, etc.
      const to = txBuild?.to;
      const data = txBuild?.data;
      const value = txBuild?.value ?? "0";

      if (!to || !data) throw new Error("Velora tx build missing {to,data}.");

      const signer = await provider.getSigner();
      const tx = await signer.sendTransaction({
        to,
        data,
        value: BigInt(value),
      });

      await tx.wait();

      // refresh quote after swap
      await onQuote();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSwapBusy(false);
    }
  }, [
    provider,
    chainId,
    address,
    fromToken,
    toToken,
    quote,
    fromAmtUi,
    preferPermit,
    slippageBps,
    ensureAllowanceIfNeeded,
    onQuote,
  ]);

  return (
    <Container maxWidth="sm" sx={{ py: 3 }}>
      <Stack spacing={2}>
        <Typography variant="h5" fontWeight={800}>
          Swap (Velora)
        </Typography>

        {!isConnected && (
          <Alert severity="info">Connect your wallet to swap.</Alert>
        )}

        {!!chainId && (
          <Typography variant="body2" sx={{ opacity: 0.8 }}>
            Chain ID: {chainId} • Fee: {Number(VELORA_PARTNER_FEE_BPS) / 100}% to {VELORA_PARTNER.slice(0, 6)}…{VELORA_PARTNER.slice(-4)}
          </Typography>
        )}

        {err && <Alert severity="error">{err}</Alert>}

        <Divider />

        <Stack spacing={1}>
          <Typography variant="subtitle2">From</Typography>
          <Button variant="outlined" onClick={() => setPickFromOpen(true)} disabled={!chainId}>
            {fromToken ? `${fromToken.symbol}` : "Select token"}
          </Button>

          <TextField
            label="Amount"
            value={fromAmtUi}
            onChange={(e) => setFromAmtUi(e.target.value)}
            inputMode="decimal"
            placeholder="0.0"
            fullWidth
          />
        </Stack>

        <Stack spacing={1}>
          <Typography variant="subtitle2">To</Typography>
          <Button variant="outlined" onClick={() => setPickToOpen(true)} disabled={!chainId}>
            {toToken ? `${toToken.symbol}` : "Select token"}
          </Button>

          <TextField
            label="Estimated received"
            value={destAmountUi}
            fullWidth
            InputProps={{ readOnly: true }}
          />
        </Stack>

        <Stack direction="row" spacing={2} alignItems="center">
          <TextField
            label="Slippage (bps)"
            value={slippageBps}
            onChange={(e) => setSlippageBps(Number(e.target.value || 0))}
            type="number"
            sx={{ maxWidth: 180 }}
          />
          <FormControlLabel
            control={
              <Switch
                checked={preferPermit}
                onChange={(e) => setPreferPermit(e.target.checked)}
              />
            }
            label="Prefer Permit"
          />
        </Stack>

        <Stack direction="row" spacing={2}>
          <Button
            variant="outlined"
            fullWidth
            onClick={onQuote}
            disabled={!isConnected || !canQuote || quoteBusy}
          >
            {quoteBusy ? <CircularProgress size={18} /> : "Get quote"}
          </Button>

          <Button
            variant="contained"
            fullWidth
            onClick={onSwap}
            disabled={!isConnected || !quote || swapBusy}
          >
            {swapBusy ? <CircularProgress size={18} /> : "Swap"}
          </Button>
        </Stack>

        {/* Token pickers */}
        <TokenPicker
          label="From token"
          value={fromToken}
          onPick={(t: TokenEntry) => {
            setFromToken(t);
            setPickFromOpen(false);
            setQuote(null);
            setDestAmountUi("");
          }}
          open={pickFromOpen}
          onOpenChange={setPickFromOpen}
        />

        <TokenPicker
          label="To token"
          value={toToken}
          onPick={(t: TokenEntry) => {
            setToToken(t);
            setPickToOpen(false);
            setQuote(null);
            setDestAmountUi("");
          }}
          open={pickToOpen}
          onOpenChange={setPickToOpen}
        />
      </Stack>
    </Container>
  );
}
