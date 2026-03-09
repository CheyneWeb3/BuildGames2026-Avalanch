// TokenModal.tsx — MULTICHAIN READY (2025-10-21)
// CONTROLLED + SNAPSHOT-ON-OPEN (no reorder while open)

import React, {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from 'react';
import {
  Avatar, Box, Button, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, IconButton, InputAdornment, List,
  useTheme, ListItemButton, ListItemAvatar, ListItemText, TextField, Tooltip,
  Typography, useMediaQuery,
} from '@mui/material';
import ClearIcon      from '@mui/icons-material/Clear';
import DeleteIcon     from '@mui/icons-material/Delete';
import ManageSearchIc from '@mui/icons-material/ManageSearch';

import {
  TokenEntry, saveCustomToken, removeCustomToken, loadCustomTokens,
  useTokenList
} from './useTokenList';

// 🔴 use per-chain config (pins, etc.)
import { useChain } from './constantsNEW';

import { useTokenBalances } from './useTokenBalances';

import { BrowserProvider, Contract, Interface, formatUnits } from 'ethers';
import { useAppKitAccount, useAppKitNetwork, useAppKitProvider, getChainById } from '../../../config';

/* ───────── helpers ───────── */
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

function pretty (bal: bigint, dec: number) {
  const s = formatUnits(bal, dec);
  if (!s.includes('.')) return s;
  const [i, f] = s.split('.');
  const trimmed = f.slice(0, 6).replace(/0+$/, '');
  return trimmed ? `${i}.${trimmed}` : i;
}

function trimTo6(s: string) {
  if (!s) return '0';
  const [i, f = ''] = s.split('.');
  const t = f.slice(0, 6).replace(/0+$/, '');
  return t ? `${i}.${t}` : i;
}

const AVATAR_SIZES = {
  chip: 18,     // Chip logo size
  row: 45,      // Token list row avatar
  input: 32,    // Selected token adornment
};

function azWithPins(tokens: TokenEntry[], PINS: string[]) {
  const arr = [...tokens].sort((a,b)=>a.symbol.localeCompare(b.symbol));
  arr.sort((a,b)=>{
    const ia = PINS.indexOf(a.symbol.toUpperCase());
    const ib = PINS.indexOf(b.symbol.toUpperCase());
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    return 0;
  });
  return arr;
}

function orderWithHeldFirst(tokens: TokenEntry[], bal: Record<string,bigint>, PINS: string[]) {
  const held: TokenEntry[] = [];
  const rest: TokenEntry[] = [];
  tokens.forEach(t=>{
    const raw = t.isNative ? (bal.native ?? 0n) : (bal[t.address.toLowerCase()] ?? 0n);
    (raw>0n?held:rest).push(t);
  });
  held.sort((a,b)=>a.symbol.localeCompare(b.symbol));
  rest.sort((a,b)=>a.symbol.localeCompare(b.symbol));
  const merged = [...held, ...rest];
  merged.sort((a,b)=>{
    const ia = PINS.indexOf(a.symbol.toUpperCase());
    const ib = PINS.indexOf(b.symbol.toUpperCase());
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    return 0;
  });
  return merged;
}

/* ordering helper when parent passes balances as strings */
function orderWithHeldFirstStrings(tokens: TokenEntry[], map: Record<string,string>, nativeKey: string, PINS: string[]) {
  const held: TokenEntry[] = [];
  const rest: TokenEntry[] = [];
  tokens.forEach(t=>{
    const key = t.isNative ? nativeKey : t.address.toLowerCase();
    const amt = Number(map[key] ?? '0');
    (amt>0 ? held : rest).push(t);
  });
  held.sort((a,b)=>a.symbol.localeCompare(b.symbol));
  rest.sort((a,b)=>a.symbol.localeCompare(b.symbol));
  const merged = [...held, ...rest];
  merged.sort((a,b)=>{
    const ia = PINS.indexOf(a.symbol.toUpperCase());
    const ib = PINS.indexOf(b.symbol.toUpperCase());
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    return 0;
  });
  return merged;
}

/* ───────── props ───────── */
interface Props {
  label?: string;
  value : TokenEntry | null | undefined;
  onPick(t: TokenEntry): void;

  open: boolean;
  onOpenChange(v: boolean): void;

  keepMounted?: boolean;
  disableRestoreFocus?: boolean;

  /* Parent may provide already-fetched balances (strings) */
  balancesByKey?: Record<string, string>; // keys: lowercased ERC-20 address or nativeKey for native
  nativeKey?: string; // legacy default was "RBAT"; we'll auto-fix for other chains if omitted

  /* local/bundled tokens to append after API tokens if missing from API */
  appendLocalTokens?: TokenEntry[];
}

/* ───────── component ───────── */
function TokenPicker({
  label = 'Token',
  value,
  onPick,
  open,
  onOpenChange,
  keepMounted = true,
  disableRestoreFocus = true,
  balancesByKey,
  nativeKey: nativeKeyProp,
  appendLocalTokens = [],
}: Props) {
  /* wallet / provider */
  const { address }        = useAppKitAccount();
  const { chainId }        = useAppKitNetwork();      // can be undefined early on Swap page
  const { walletProvider } = useAppKitProvider('eip155');
  const provider           = useMemo(
    () => walletProvider ? new BrowserProvider(walletProvider) : undefined,
    [walletProvider]
  );

  /* chain config */
  const { id, PINNED_TOKENS } = useChain();
  const PINS = useMemo(() => (PINNED_TOKENS ?? []).map(s => s.toUpperCase()), [PINNED_TOKENS]);

  /* token universe (API) */
  const { tokens: apiTokens, loading } = useTokenList();

  /* balances (used for display & initial ordering) */
  const balances = useTokenBalances(address ?? null, apiTokens, provider);

  /* custom tokens (user-saved, from localStorage) */
  const [custom, setCustom] = useState<TokenEntry[]>(
    () => {
      const all = loadCustomTokens();
      // If chainId is unknown, don't filter yet — include all and we’ll naturally de-dup with API
      return chainId == null ? all : all.filter(t => t.chainId === chainId);
    }
  );

  useEffect(() => {
    const sync = () => {
      const all = loadCustomTokens();
      setCustom(chainId == null ? all : all.filter(t => t.chainId === chainId));
    };
    addEventListener('storage', sync);
    return () => removeEventListener('storage', sync);
  }, [chainId]);

  /* MAIN list = custom (first) + API (second), deduped by address:symbol
     IMPORTANT: if chainId is not yet known, we DO NOT filter by chain to avoid empty list. */
  const mainTokens = useMemo(() => {
    const seen = new Set<string>();
    const restrictByChain = chainId != null;
    const add = (acc: TokenEntry[], t: TokenEntry) => {
      if (restrictByChain && t.chainId !== chainId) return acc;
      const key = `${t.address.toLowerCase()}:${t.symbol.toLowerCase()}`;
      if (seen.has(key)) return acc;
      seen.add(key);
      acc.push(t);
      return acc;
    };
    let acc: TokenEntry[] = [];
    custom.forEach(t => { acc = add(acc, t); });
    apiTokens.forEach(t => { acc = add(acc, t); });
    return acc;
  }, [custom, apiTokens, chainId]);

  /* BOTTOM EXTRAS = local tokens that are NOT present in mainTokens, deduped
     Also skip chain filter until chainId is known. */
  const bottomExtras = useMemo(() => {
    if (!appendLocalTokens?.length) return [] as TokenEntry[];
    const restrictByChain = chainId != null;

    const baseKeys = new Set(mainTokens.map(t => `${t.address.toLowerCase()}:${t.symbol.toLowerCase()}`));
    const seen = new Set<string>();
    const extras: TokenEntry[] = [];
    appendLocalTokens.forEach(t => {
      if (restrictByChain && t.chainId !== chainId) return;
      const key = `${t.address.toLowerCase()}:${t.symbol.toLowerCase()}`;
      if (baseKeys.has(key)) return;     // already in API/custom
      if (seen.has(key)) return;         // duplicate in provided list
      seen.add(key);
      extras.push(t);
    });
    // keep extras alphabetical; do NOT pin them so they truly stay at the bottom
    extras.sort((a,b)=>a.symbol.localeCompare(b.symbol));
    return extras;
  }, [appendLocalTokens, chainId, mainTokens]);

  /* For featured chips we resolve by per-chain pins (symbols) */
  const allTokens = useMemo(() => [...mainTokens, ...bottomExtras], [mainTokens, bottomExtras]);

  const featuredTokens: TokenEntry[] = useMemo(() => {
    if (!PINS.length) return [];
    const out: TokenEntry[] = [];
    const seen = new Set<string>();
    for (const symU of PINS) {
      const hit = allTokens.find(t => t.symbol.toUpperCase() === symU);
      if (hit && !seen.has(symU)) { out.push(hit); seen.add(symU); }
    }
    return out;
  }, [PINS, allTokens]);

  // native symbol to use for balancesByKey mode
  const chainMeta = useMemo(() => getChainById(chainId ?? id), [chainId, id]);
  const fallbackNativeSymbol = useMemo(
    () => (chainMeta?.nativeCurrency?.symbol || 'ETH').toUpperCase(),
    [chainMeta]
  );

  const dynamicNativeSymbol = useMemo(() => {
    // Prefer native token from list (it is injected by useTokenList), otherwise fall back to src/config.ts.
    const nativeTok = allTokens.find(t => t.isNative);
    if (nativeTok?.symbol) return String(nativeTok.symbol).toUpperCase();
    return fallbackNativeSymbol;
  }, [allTokens, fallbackNativeSymbol]);

  const nativeKeyEffective = useMemo(() => {
    // This MUST match the keys used by balancesByKey in the parent (lowercase symbol is the safe default)
    return (nativeKeyProp && nativeKeyProp.trim())
      ? nativeKeyProp.trim()
      : dynamicNativeSymbol.toLowerCase();
  }, [nativeKeyProp, dynamicNativeSymbol]);


  /* UI state */
  const [manage, setManage] = useState(false);
  const [filter, setFilter] = useState('');

  /* address paste → fetch custom token metadata */
  const fTrim  = filter.trim();
  const isAddr = /^0x[a-f0-9]{40}$/i.test(fTrim);
  const exists = allTokens.find(t => t.address.toLowerCase() === fTrim.toLowerCase());
  const [fetching, setFetching] = useState(false);
  const [fetched , setFetched ] = useState<TokenEntry | null>(null);
  const [fetchErr, setFetchErr] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  useEffect(() => {
    let dead = false;
    setFetched(null); setFetchErr('');
    if (!isAddr || exists) return;
    if (!provider) { setFetchErr('Connect wallet to fetch token data'); return; }

    (async () => {
      try {
        setFetching(true);
        const erc = new Contract(fTrim, new Interface(ERC20_ABI), provider);
        const [name, symbol, dec] = await Promise.all([erc.name(), erc.symbol(), erc.decimals()]);
        if (!dead) setFetched({
          name, symbol, decimals:Number(dec),
          address:fTrim, chainId: Number(chainId ?? id), logoURI:undefined
        });
      } catch { if (!dead) setFetchErr('Unable to fetch token metadata'); }
      finally { if (!dead) setFetching(false); }
    })();

    return () => { dead = true; };
  }, [isAddr, exists, provider, fTrim, chainId, id]);

  /* ── SNAPSHOT ORDER ON OPEN ── */
  const snapshotRef = useRef<TokenEntry[] | null>(null);
  // Drop snapshot + UI state when chain changes (prevents "hung" list on network switch)
  useEffect(() => {
    snapshotRef.current = null;   // force re-snapshot using the NEW chain token set
    setFilter('');
    setFetched(null);
    setFetchErr('');
    setManage(false);

    // optional: if you prefer to hard-close the modal on chain switch:
    // if (open) onOpenChange(false);
  }, [chainId, id]);


  const fallbackOrdered = useMemo(
    () => [...azWithPins(mainTokens, PINS), ...bottomExtras],
    [mainTokens, bottomExtras, PINS]
  );

  const baseList = useMemo(() => {
    const hasData = (mainTokens.length + bottomExtras.length) > 0;

    if (open) {
      if (!snapshotRef.current && hasData && !loading) {
        const orderedMain = balancesByKey
          ? orderWithHeldFirstStrings(mainTokens, balancesByKey, nativeKeyEffective, PINS)
          : orderWithHeldFirst(mainTokens, balances, PINS);
        snapshotRef.current = [...orderedMain, ...bottomExtras];
      }
      return snapshotRef.current ?? fallbackOrdered;
    }

    // When closed, reset the snapshot so next open re-snapshots with fresh data.
    snapshotRef.current = null;
    return fallbackOrdered;
  }, [
    open, loading,
    mainTokens, bottomExtras,
    balancesByKey, nativeKeyEffective, balances,
    fallbackOrdered
  ]);

  /* filter */
  const visible = useMemo(() => {
    const k = fTrim.toLowerCase();
    if (!k) return baseList;
    return baseList.filter(t =>
      t.symbol.toLowerCase().includes(k) ||
      t.name  ?.toLowerCase().includes(k) ||
      t.address.toLowerCase() === k
    );
  }, [baseList, fTrim]);

  /* handlers */
  const pick = useCallback((t: TokenEntry) => {
    onPick(t);
    setFilter('');
    onOpenChange(false);
  }, [onPick, onOpenChange]);

  const row = (t:TokenEntry) => {
    /* Prefer balances from parent if provided (string map) */
    if (balancesByKey) {
      const key   = t.isNative ? nativeKeyEffective : t.address.toLowerCase();
      const dec   = balancesByKey[key] ?? '0';
      const show  = trimTo6(dec);
      const muted = Number(dec) === 0;
      return (
        <ListItemButton
          key={`${t.address}-${t.symbol}`}
          selected={
            !!value &&
            value.address?.toLowerCase() === t.address.toLowerCase() &&
            value.symbol ?.toLowerCase() === t.symbol.toLowerCase()
          }
          onClick={() => pick(t)}
        >
          <ListItemAvatar>
            <Avatar src={t.logoURI} sx={{ width: AVATAR_SIZES.row, height: AVATAR_SIZES.row }}>
              {t.symbol[0]}
            </Avatar>
          </ListItemAvatar>
          <ListItemText
            primary={
              <>
                {t.symbol}
                <Typography
                  component="span"
                  sx={{ float:'right', fontWeight:500, opacity: muted ? 0.55 : 1 }}
                >
                  {show}
                </Typography>
              </>
            }
            secondary={t.name}
          />
        </ListItemButton>
      );
    }

    /* Fallback: hook bigint balances */
    const raw   = t.isNative ? (balances.native ?? 0n) : (balances[t.address.toLowerCase()] ?? 0n);
    const show  = pretty(raw, t.decimals);
    const muted = raw === 0n;

    return (
      <ListItemButton
        key={`${t.address}-${t.symbol}`}
        selected={
          !!value &&
          value.address?.toLowerCase() === t.address.toLowerCase() &&
          value.symbol ?.toLowerCase() === t.symbol.toLowerCase()
        }
        onClick={() => pick(t)}
      >
        <ListItemAvatar>
          <Avatar src={t.logoURI} sx={{ width: AVATAR_SIZES.row, height: AVATAR_SIZES.row }}>
            {t.symbol[0]}
          </Avatar>
        </ListItemAvatar>

        <ListItemText
          primary={
            <>
              {t.symbol}
              <Typography
                component="span"
                sx={{ float:'right', fontWeight:500, opacity: muted ? 0.55 : 1 }}
              >
                {show}
              </Typography>
            </>
          }
          secondary={t.name}
        />
      </ListItemButton>
    );
  };

  /* ───────── render ───────── */
  return (
    <>
      {/* trigger */}
      <TextField
        label={label}
        value={value?.symbol ?? ''}
        placeholder="Select token"
        fullWidth
        variant="standard"
        onClick={() => onOpenChange(true)}
        InputProps={{
          readOnly: true,
          disableUnderline: true,
          startAdornment: value ? (
            <InputAdornment position="start" sx={{ mr: 1 }}>
              <Avatar
                src={value.logoURI}
                sx={{ width: AVATAR_SIZES.input, height: AVATAR_SIZES.input }}
                onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/images/fallback-logo.png'; }}
              >
                {value?.symbol?.[0] ?? '?'}
              </Avatar>
            </InputAdornment>
          ) : undefined,
        }}
        sx={{
          '& .MuiInputBase-root': { px: 1, py: 0.75, background: 'transparent' },
          '& .MuiInputBase-input': { color: 'white', fontWeight: 600 },
        }}
      />

      {/* main modal */}
      <Dialog
        open={open}
        onClose={() => onOpenChange(false)}
        fullWidth
        maxWidth="xs"
        scroll="paper"
        fullScreen={isMobile}   // optional, keep if you want fullscreen on phone
        sx={{
          zIndex: (t) => t.zIndex.modal + 200,

          // ✅ desktop centered again
          '& .MuiDialog-container': {
            alignItems: isMobile ? 'flex-start' : 'center',
          },

          // paper tweaks
          '& .MuiPaper-root': {
            mt: isMobile ? 2 : 0,          // give mobile a little top gap, desktop none
            borderRadius: isMobile ? 2 : 2,
            overflow: 'hidden',
          },
        }}
        PaperProps={{
          sx: {
            backgroundColor: 'rgba(8,68,0,0.6)',
            borderRadius: 2,
            boxShadow: (theme) => `0 0 12px ${theme.palette.primary.main}80`,
            backdropFilter: 'blur(6px)',
          },
        }}
        slotProps={{
          backdrop: { sx: { backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)' } },
        }}
      >

        <DialogTitle sx={{ display:'flex', alignItems:'center' }}>
          Select token
          <Box flexGrow={1}/>
          <Tooltip title="Manage custom tokens">
            <IconButton size="small" onClick={()=>setManage(true)}>
              <ManageSearchIc fontSize="small"/>
            </IconButton>
          </Tooltip>
        </DialogTitle>

        {/* search & chips */}
        <Box sx={{ p:2, pt:0 }}>
          <TextField
            value={filter}
            onChange={e=>setFilter(e.target.value)}
            fullWidth
            placeholder="Search name / symbol / paste address"
            InputProps={{
              endAdornment: filter && (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={()=>setFilter('')}>
                    <ClearIcon fontSize="small"/>
                  </IconButton>
                </InputAdornment>
              )
            }}
          />

          {/* featured chips from per-chain pins (no placeholders) */}
          {!!featuredTokens.length && (
            <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'center' }}>
              {featuredTokens.map(tok => (
                <Chip
                  key={`${tok.symbol}:${tok.address}`}
                  avatar={<Avatar src={tok.logoURI} sx={{ width: AVATAR_SIZES.chip, height: AVATAR_SIZES.chip }} />}
                  label={tok.symbol}
                  clickable
                  color={
                    !!value &&
                    value.address?.toLowerCase() === tok.address.toLowerCase() &&
                    value.symbol ?.toLowerCase()  === tok.symbol .toLowerCase()
                      ? 'secondary' : 'default'
                  }
                  onClick={()=>pick(tok)}
                  sx={{
                    '& .MuiChip-avatar': { width: AVATAR_SIZES.chip, height: AVATAR_SIZES.chip },
                    '& .MuiChip-icon'  : { width: AVATAR_SIZES.chip, height: AVATAR_SIZES.chip },
                  }}
                />
              ))}
            </Box>
          )}
        </Box>

        <DialogContent
          dividers
          sx={{
            p: 0,
            maxHeight: isMobile ? 'calc(100vh - 220px)' : 480,
          }}
        >

          {loading && mainTokens.length === 0 ? (
            <CircularProgress sx={{ mx:'auto', my:4, display:'block' }}/>
          ) : (
            <>
              {/* custom-token banner */}
              {isAddr && !exists && (
                <Box sx={{ p:2, borderBottom:'1px solid #eee' }}>
                  {fetching && <Typography>Fetching token info…</Typography>}
                  {fetchErr && <Typography color="error">{fetchErr}</Typography>}
                  {fetched && (
                    <>
                      <Typography fontWeight={500} gutterBottom>⚠ Add custom token</Typography>
                      <Typography variant="body2" sx={{ opacity:.7 }}>
                        {fetched.name} ({fetched.symbol}) · decimals {fetched.decimals}
                      </Typography>
                      <Button
                        variant="contained"
                        size="small"
                        sx={{ mt:1 }}
                        onClick={()=>{
                          saveCustomToken(fetched);
                          setCustom(c=>[...c, fetched]);
                          pick(fetched);
                        }}
                      >
                        Add token
                      </Button>
                    </>
                  )}
                </Box>
              )}

              <List dense>
                {visible.map(row)}
              </List>
            </>
          )}
        </DialogContent>

        {/* footer under scrollable section */}
        <Box
          sx={{
            px: 2,
            py: 1,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            backgroundColor: 'rgba(0,0,0,0.25)',
          }}
        >
          <Typography
            variant="caption"
            component="a"
            href="/getlisted" // TODO: update to actual route
            target="_blank"
            rel="noreferrer"
            sx={{
              textDecoration: 'underline',
              cursor: 'pointer',
              color: 'primary.light',
              '&:hover': { color: 'primary.main' },
            }}
          >
            Get your token whitelisted
          </Typography>

          <Typography
            variant="caption"
            sx={{
              textDecoration: 'underline',
              cursor: 'pointer',
              color: 'secondary.light',
              '&:hover': { color: 'secondary.main' },
            }}
            onClick={()=>setManage(true)}
          >
            Manage tokens
          </Typography>
        </Box>
      </Dialog>

      {/* manage sheet */}
      <Dialog
        open={manage}
        onClose={()=>setManage(false)}
        fullWidth
        maxWidth="xs"
        keepMounted={keepMounted}
        disableRestoreFocus={disableRestoreFocus}
        disableEnforceFocus
        disableAutoFocus
        disablePortal
      >
        <DialogTitle>Manage custom tokens</DialogTitle>
        <DialogContent dividers sx={{ p:0 }}>
          <List dense>
            {custom.map(t=>(
              <ListItemButton key={`${t.address}:${t.symbol}`}>
                <ListItemAvatar>
                  <Avatar src={t.logoURI} sx={{ width: AVATAR_SIZES.row, height: AVATAR_SIZES.row }}>
                    {t.symbol[0]}
                  </Avatar>
                </ListItemAvatar>
                <ListItemText
                  primary={`${t.symbol} (${t.decimals})`}
                  secondary={t.address.slice(0,10)+'…'}
                />
                <IconButton
                  edge="end"
                  onClick={()=>{
                    removeCustomToken(t.address, t.symbol); // multichain-safe
                    setCustom(c=>c.filter(x=>(x.address!==t.address || x.symbol!==t.symbol)));
                  }}
                >
                  <DeleteIcon fontSize="small"/>
                </IconButton>
              </ListItemButton>
            ))}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={()=>setManage(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export default React.memo(TokenPicker);
