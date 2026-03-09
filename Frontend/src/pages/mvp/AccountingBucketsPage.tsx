// src/pages/AccountingBucketsPage.tsx
import React, { useMemo, useState } from "react";
import { formatUnits } from "ethers";
import "./VaultAdminPage.css";

const CORE_API_URL = (import.meta as any).env?.VITE_CORE_API_URL || "http://127.0.0.1:8088";
const LS_JWT = "haus_admin_jwt";

function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "ghost" | "danger" }
) {
  const kind = props.kind ?? "primary";
  const cls =
    "va-btn " +
    (kind === "primary" ? "va-btnPrimary" : kind === "danger" ? "va-btnDanger" : "va-btnGhost") +
    (props.disabled ? " va-btnDisabled" : "");
  return <button {...props} className={cls} />;
}

function short(s?: string, n = 10) {
  if (!s) return "—";
  if (s.length <= n + 6) return s;
  return s.slice(0, n) + "…" + s.slice(-4);
}

async function apiJson(path: string, jwt?: string) {
  const url = CORE_API_URL.replace(/\/$/, "") + path;
  const r = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
  });
  const txt = await r.text();
  let data: any = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = { raw: txt };
  }
  if (!r.ok) throw new Error(data?.error || data?.message || `${r.status} ${r.statusText}`);
  return data;
}

type BalRow = {
  accountId: string;
  chainId: number;
  token: string;
  symbol: string;
  decimals: number;
  balanceRaw: string;
  updatedAt?: string;
};

type LedgerRow = {
  refId: string;
  ts: string;
  kind: string;
  chainId: number;
  token: string;
  symbol: string;
  decimals: number;
  amountRaw: string;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  moduleId?: string | null;
};

export default function AccountingBucketsPage() {
  const [jwt, setJwt] = useState<string>(() => localStorage.getItem(LS_JWT) || "");
  const [status, setStatus] = useState<string>("");

  const [prefix, setPrefix] = useState<string>("treasury:");
  const [accountId, setAccountId] = useState<string>(""); // exact override
  const [limit, setLimit] = useState<number>(500);

  const [balances, setBalances] = useState<BalRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>("");

  const [busy, setBusy] = useState(false);

  function persistJwt(v: string) {
    setJwt(v);
    if (v) localStorage.setItem(LS_JWT, v);
    else localStorage.removeItem(LS_JWT);
  }

  function fmtHuman(raw: string, decimals: number) {
    try {
      return formatUnits(BigInt(raw || "0"), decimals);
    } catch {
      return raw;
    }
  }

  const grouped = useMemo(() => {
    const m = new Map<string, BalRow[]>();
    for (const b of balances) {
      const k = b.accountId;
      const arr = m.get(k) || [];
      arr.push(b);
      m.set(k, arr);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [balances]);

  async function loadBalances() {
    if (!jwt) return setStatus("Missing admin JWT (paste it at top).");
    setBusy(true);
    setStatus("");
    try {
      const q = accountId
        ? `?accountId=${encodeURIComponent(accountId)}&limit=${limit}`
        : `?prefix=${encodeURIComponent(prefix)}&limit=${limit}`;
      const out = await apiJson(`/admin/accounting/balances${q}`, jwt);
      setBalances(out?.items || []);
      setStatus(`Loaded ${out?.count ?? (out?.items?.length ?? 0)} balance rows.`);
    } catch (e: any) {
      setStatus(e?.message || "Failed to load balances.");
    } finally {
      setBusy(false);
    }
  }

  async function loadLedger(acct: string) {
    if (!jwt) return setStatus("Missing admin JWT.");
    setBusy(true);
    setStatus("");
    try {
      const out = await apiJson(`/admin/accounting/ledger?accountId=${encodeURIComponent(acct)}&limit=200`, jwt);
      setLedger(out?.items || []);
      setSelectedAccount(acct);
      setStatus(`Loaded ${out?.count ?? (out?.items?.length ?? 0)} ledger rows for ${acct}.`);
    } catch (e: any) {
      setStatus(e?.message || "Failed to load ledger.");
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    const rows = balances;
    const header = ["accountId", "chainId", "token", "symbol", "decimals", "balanceRaw", "balanceHuman"].join(",");
    const lines = rows.map((r) =>
      [
        r.accountId,
        r.chainId,
        r.token,
        r.symbol,
        r.decimals,
        r.balanceRaw,
        fmtHuman(r.balanceRaw, r.decimals),
      ]
        .map((x) => `"${String(x).replace(/"/g, '""')}"`)
        .join(",")
    );
    const blob = new Blob([header + "\n" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `balances_${accountId ? "account" : prefix.replace(/[^a-z0-9:_-]/gi, "")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="va-page">
      <div className="va-header">
        <div>
          <div className="va-title">Accounting • Buckets</div>
          <div className="va-subtitle">
            Admin view of balances + ledger. Buckets are accountIds like <span className="va-mono">treasury:fees</span> and{" "}
            <span className="va-mono">user:0x..:escrow</span>.
          </div>
        </div>
        <div className="va-actions">
          <Button kind="ghost" onClick={() => persistJwt("")} disabled={busy}>
            Clear JWT
          </Button>
          <Button onClick={loadBalances} disabled={busy || !jwt}>
            Refresh balances
          </Button>
        </div>
      </div>

      <div className="va-topbar">
        <div className="va-kvline" style={{ flex: 1, minWidth: 260 }}>
          <div className="va-kvlabel">Admin JWT</div>
          <input
            className="va-input"
            placeholder="paste your admin JWT here (stored in localStorage)"
            value={jwt}
            onChange={(e) => persistJwt(e.target.value.trim())}
          />
        </div>

        <div className="va-kvline" style={{ minWidth: 220 }}>
          <div className="va-kvlabel">Prefix</div>
          <select className="va-select" value={prefix} onChange={(e) => setPrefix(e.target.value)}>
            <option value="treasury:">treasury:</option>
            <option value="user:">user:</option>
            <option value="user:0x">user:0x (all users)</option>
          </select>
        </div>

        <div className="va-kvline" style={{ flex: 1, minWidth: 280 }}>
          <div className="va-kvlabel">Exact accountId</div>
          <input
            className="va-input"
            placeholder='optional (overrides prefix), e.g. "treasury:fees"'
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          />
        </div>

        <div className="va-kvline" style={{ width: 140 }}>
          <div className="va-kvlabel">Limit</div>
          <input
            className="va-input"
            value={String(limit)}
            onChange={(e) => setLimit(Number(e.target.value || 0))}
          />
        </div>

        <Button kind="ghost" onClick={exportCsv} disabled={!balances.length}>
          Export CSV
        </Button>
      </div>

      {status ? <div className="va-notice">{status}</div> : null}

      <div className="va-card">
        <div className="va-cardTitle">Balances</div>
        <div className="va-cardSub">Click an accountId to load its ledger audit trail.</div>

        <div className="va-tableWrap">
          <table className="va-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Chain</th>
                <th>Token</th>
                <th>Symbol</th>
                <th>Balance (human)</th>
                <th>Balance (raw)</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {grouped.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ color: "rgba(255,255,255,0.7)" }}>
                    No rows loaded yet.
                  </td>
                </tr>
              ) : (
                grouped.map(([acct, rows]) =>
                  rows.map((r, idx) => (
                    <tr key={`${r.accountId}:${r.chainId}:${r.token}`}>
                      {idx === 0 ? (
                        <td rowSpan={rows.length}>
                          <button
                            className="va-btn va-btnGhost"
                            style={{ padding: "8px 10px" }}
                            onClick={() => loadLedger(acct)}
                            disabled={busy}
                            title={acct}
                          >
                            {acct.startsWith("user:0x") ? `user:${short(acct.slice(5), 10)}` : acct}
                          </button>
                        </td>
                      ) : null}
                      <td>{r.chainId}</td>
                      <td className="va-mono" title={r.token}>
                        {short(r.token, 8)}
                      </td>
                      <td>{r.symbol}</td>
                      <td className="va-mono">{fmtHuman(r.balanceRaw, r.decimals)}</td>
                      <td className="va-mono">{r.balanceRaw}</td>
                      <td className="va-mono">{r.updatedAt ? String(r.updatedAt) : "—"}</td>
                    </tr>
                  ))
                )
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="va-card" style={{ marginTop: 12 }}>
        <div className="va-cardTitle">Ledger</div>
        <div className="va-cardSub">
          {selectedAccount ? (
            <>
              Showing latest entries touching <span className="va-mono">{selectedAccount}</span>
            </>
          ) : (
            "Select an account above."
          )}
        </div>

        <div className="va-tableWrap">
          <table className="va-table" style={{ minWidth: 1100 }}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Kind</th>
                <th>Token</th>
                <th>Amount (human)</th>
                <th>From</th>
                <th>To</th>
                <th>RefId</th>
              </tr>
            </thead>
            <tbody>
              {!ledger.length ? (
                <tr>
                  <td colSpan={7} style={{ color: "rgba(255,255,255,0.7)" }}>
                    No ledger rows loaded.
                  </td>
                </tr>
              ) : (
                ledger.map((e) => (
                  <tr key={e.refId}>
                    <td className="va-mono">{String(e.ts)}</td>
                    <td>{e.kind}</td>
                    <td className="va-mono" title={e.token}>
                      {e.symbol} ({short(e.token, 8)})
                    </td>
                    <td className="va-mono">{fmtHuman(e.amountRaw, e.decimals)}</td>
                    <td className="va-mono" title={e.fromAccountId || ""}>
                      {e.fromAccountId ? short(e.fromAccountId, 18) : "—"}
                    </td>
                    <td className="va-mono" title={e.toAccountId || ""}>
                      {e.toAccountId ? short(e.toAccountId, 18) : "—"}
                    </td>
                    <td className="va-mono" title={e.refId}>
                      {short(e.refId, 22)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
