import { ethers } from 'ethers';

// Typed-data builders for hausCashierVaultV3.
// MUST match the Solidity typehash strings exactly.

export type Eip712Domain = {
  name: string;
  version: string;
  chainId: bigint | number;
  verifyingContract: string;
};

const ABI = [
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function nonces(address owner) view returns (uint256)',
  'function sessions(address owner, address sessionKey) view returns (bool enabled, uint48 expiry, uint32 scopes, uint64 epoch, uint256 nonce)',
  'function activeSessionKey(address owner) view returns (address)',
  'function sessionTokenAllowed(address owner, address sessionKey, uint64 epoch, address token) view returns (bool)',
  'function sessionRemaining(address owner, address sessionKey, uint64 epoch, address token) view returns (uint256)',
  'function sessionMaxPerTx(address owner, address sessionKey, uint64 epoch, address token) view returns (uint256)'
];

export function vaultContract(addr: string, provider: ethers.Provider): ethers.Contract {
  return new ethers.Contract(addr, ABI, provider);
}

export async function getEip712Domain(vaultAddr: string, provider: ethers.Provider): Promise<Eip712Domain> {
  const c = vaultContract(vaultAddr, provider);
  const d = await c.eip712Domain();
  return {
    name: String(d.name),
    version: String(d.version),
    // JSON responses cannot serialize BigInt. Domain.chainId is safe to downcast.
    chainId: Number(d.chainId),
    verifyingContract: String(d.verifyingContract)
  };
}

export async function getOwnerNonce(vaultAddr: string, provider: ethers.Provider, ownerWallet: string): Promise<bigint> {
  const c = vaultContract(vaultAddr, provider);
  return BigInt(await c.nonces(ownerWallet));
}

export async function getSessionState(
  vaultAddr: string,
  provider: ethers.Provider,
  ownerWallet: string,
  sessionKey: string
): Promise<{ enabled: boolean; expiry: number; scopes: number; epoch: bigint; nonce: bigint }> {
  const c = vaultContract(vaultAddr, provider);
  const s = await c.sessions(ownerWallet, sessionKey);
  return {
    enabled: Boolean(s.enabled),
    expiry: Number(s.expiry),
    scopes: Number(s.scopes),
    epoch: BigInt(s.epoch),
    nonce: BigInt(s.nonce)
  };
}

export async function getSessionTokenCaps(
  vaultAddr: string,
  provider: ethers.Provider,
  ownerWallet: string,
  sessionKey: string,
  epoch: bigint,
  token: string
): Promise<{ allowed: boolean; remaining: bigint; maxPerTx: bigint }> {
  const c = vaultContract(vaultAddr, provider);
  const [allowed, remaining, maxPerTx] = await Promise.all([
    c.sessionTokenAllowed(ownerWallet, sessionKey, epoch, token),
    c.sessionRemaining(ownerWallet, sessionKey, epoch, token),
    c.sessionMaxPerTx(ownerWallet, sessionKey, epoch, token)
  ]);
  return {
    allowed: Boolean(allowed),
    remaining: BigInt(remaining),
    maxPerTx: BigInt(maxPerTx)
  };
}

// RegisterSession includes newEpoch in the signed message.
// Solidity computes newEpoch = sessions[owner][sessionKey].epoch + 1.
export async function getNextSessionEpoch(
  vaultAddr: string,
  provider: ethers.Provider,
  ownerWallet: string,
  sessionKey: string
): Promise<bigint> {
  const c = vaultContract(vaultAddr, provider);
  const s = await c.sessions(ownerWallet, sessionKey);
  const epoch = BigInt(s.epoch);
  return epoch + 1n;
}

// -------- Typed Data payloads --------

export function typedDataWithdraw(domain: Eip712Domain, msg: {
  ownerWallet: string;
  token: string;
  to: string;
  amount: string;
  nonce: string;
  deadline: string;
}) {
  const types = {
    Withdraw: [
      { name: 'ownerWallet', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  } as const;
  return { domain, types, primaryType: 'Withdraw', message: msg };
}

export function typedDataWithdrawNative(domain: Eip712Domain, msg: {
  ownerWallet: string;
  to: string;
  amount: string;
  nonce: string;
  deadline: string;
}) {
  const types = {
    WithdrawNative: [
      { name: 'ownerWallet', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  } as const;
  return { domain, types, primaryType: 'WithdrawNative', message: msg };
}

export function typedDataRegisterSession(domain: Eip712Domain, msg: {
  ownerWallet: string;
  sessionKey: string;
  newEpoch: string;
  expiry: number;
  scopes: number;
  nonce: string;
  deadline: string;
}) {
  const types = {
    RegisterSession: [
      { name: 'ownerWallet', type: 'address' },
      { name: 'sessionKey', type: 'address' },
      { name: 'newEpoch', type: 'uint64' },
      { name: 'expiry', type: 'uint48' },
      { name: 'scopes', type: 'uint32' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  } as const;
  return { domain, types, primaryType: 'RegisterSession', message: msg };
}

export function typedDataConfigSessionToken(domain: Eip712Domain, msg: {
  ownerWallet: string;
  sessionKey: string;
  epoch: string;
  token: string;
  allowed: boolean;
  maxPerTx: string;
  total: string;
  nonce: string;
  deadline: string;
}) {
  const types = {
    ConfigSessionToken: [
      { name: 'ownerWallet', type: 'address' },
      { name: 'sessionKey', type: 'address' },
      { name: 'epoch', type: 'uint64' },
      { name: 'token', type: 'address' },
      { name: 'allowed', type: 'bool' },
      { name: 'maxPerTx', type: 'uint256' },
      { name: 'total', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  } as const;
  return { domain, types, primaryType: 'ConfigSessionToken', message: msg };
}

export function typedDataSessionWithdraw(domain: Eip712Domain, msg: {
  ownerWallet: string;
  sessionKey: string;
  epoch: string;
  token: string;
  to: string;
  amount: string;
  sessionNonce: string;
  deadline: string;
}) {
  const types = {
    SessionWithdraw: [
      { name: 'ownerWallet', type: 'address' },
      { name: 'sessionKey', type: 'address' },
      { name: 'epoch', type: 'uint64' },
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'sessionNonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  } as const;
  return { domain, types, primaryType: 'SessionWithdraw', message: msg };
}

export function typedDataSessionWithdrawNative(domain: Eip712Domain, msg: {
  ownerWallet: string;
  sessionKey: string;
  epoch: string;
  to: string;
  amount: string;
  sessionNonce: string;
  deadline: string;
}) {
  const types = {
    SessionWithdrawNative: [
      { name: 'ownerWallet', type: 'address' },
      { name: 'sessionKey', type: 'address' },
      { name: 'epoch', type: 'uint64' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'sessionNonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  } as const;
  return { domain, types, primaryType: 'SessionWithdrawNative', message: msg };
}

export function typedDataBridgeUSDC(domain: Eip712Domain, msg: {
  ownerWallet: string;
  destSelector: string;
  destWallet: string;
  amount: string;
  nonce: string;
  deadline: string;
}) {
  const types = {
    BridgeUSDC: [
      { name: 'ownerWallet', type: 'address' },
      { name: 'destSelector', type: 'uint64' },
      { name: 'destWallet', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  } as const;
  return { domain, types, primaryType: 'BridgeUSDC', message: msg };
}

export function typedDataSessionBridgeUSDC(domain: Eip712Domain, msg: {
  ownerWallet: string;
  sessionKey: string;
  epoch: string;
  destSelector: string;
  destWallet: string;
  amount: string;
  sessionNonce: string;
  deadline: string;
}) {
  const types = {
    SessionBridgeUSDC: [
      { name: 'ownerWallet', type: 'address' },
      { name: 'sessionKey', type: 'address' },
      { name: 'epoch', type: 'uint64' },
      { name: 'destSelector', type: 'uint64' },
      { name: 'destWallet', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'sessionNonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  } as const;
  return { domain, types, primaryType: 'SessionBridgeUSDC', message: msg };
}
