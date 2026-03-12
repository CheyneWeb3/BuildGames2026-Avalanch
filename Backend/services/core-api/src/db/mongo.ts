import { MongoClient, Db, Collection, IndexSpecification } from 'mongodb';

export type MongoCollections = {
  nonces: Collection<NonceDoc>;
  modules: Collection<ModuleDoc>;
  treasuries: Collection<TreasuryDoc>;
  balances: Collection<BalanceDoc>;
  ledger: Collection<LedgerDoc>;
  vaultIntents: Collection<VaultIntentDoc>;
  tgLinkCodes: Collection<TgLinkCodeDoc>;
  tgLinks: Collection<TgLinkDoc>;
  tgWelcome: Collection<TgWelcomeDoc>;
  tgWelcomeSeen: Collection<TgWelcomeSeenDoc>;
  tgSeenUsers: Collection<TgSeenUserDoc>;
  tgChatActivity: Collection<TgChatActivityDoc>;
  tgSuccessMedia: Collection<TgSuccessMediaDoc>;
  tgMaintenance: Collection<TgMaintenanceDoc>;
  tgAlertPrefs: Collection<TgAlertPrefDoc>;
  tgNotifyOutbox: Collection<TgNotifyOutboxDoc>;
  sessionKeys: Collection<SessionKeyDoc>;
  saasChats: Collection<SaasChatDoc>;
  events: Collection<EventDoc>;
  vaultTokens: Collection<VaultTokenDoc>;
  txTracks: Collection<TxTrackDoc>;
};

// Stores Telegram bot maintenance mode state per module.
// When enabled, bot should refuse non-admin interactions.
export type TgMaintenanceDoc = {
  _id: string; // moduleId
  moduleId: string;
  enabled: boolean;
  updatedAt: Date;
  updatedByTgId?: string | null;
};

// Per-TG-user DM notification preferences
export type TgAlertPrefDoc = {
  _id: string; // `${moduleId}:tg:${tgId}`
  moduleId: string;
  tgId: string;
  enabled: boolean;
  updatedAt: Date;
};

// Tracks recent speakers in Telegram chats (for /rain and /monsoon)
export type TgChatActivityDoc = {
  _id: string; // `${moduleId}:${chatId}:${messageId}`
  moduleId: string;
  chatId: string;
  chatType?: string | null;
  messageId: string;
  tgId: string;
  username?: string | null;
  ts: Date;
  msgType?: string | null;
  textLower?: string | null;
};


// Stores optional media to attach to successful bot actions (tip/rain/monsoon)
export type TgSuccessMediaDoc = {
  _id: string; // `${moduleId}:${key}`
  moduleId: string;
  key: 'tip' | 'rain' | 'monsoon';
  kind: 'photo' | 'video' | 'animation' | null;
  fileId: string | null;
  updatedAt: Date;
};


export type VaultTokenDoc = {
  _id: string; // `${chainId}:${vaultId}:${token}`
  chainId: number;
  vaultId: string;
  vaultAddress: string;
  token: string; // lower
  decimals: number;
  enabled: boolean;
  updatedAt: Date;
};

export type TxTrackDoc = {
  _id: string; // `${accountId}:${chainId}:${txHash}`
  accountId: string;
  chainId: number;
  txHash: string; // lower
  kind: 'deposit' | 'withdraw' | 'session_withdraw' | 'other';
  status: 'tracking' | 'indexed' | 'failed';
  meta?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
};

export type SaasChatRail = {
  chainId: number;
  token: string;
  feeTreasuryId: string;
  chatTreasuryId: string;
};

export type SaasChatSkin = {
  brandName?: string;
  logoUrl?: string;
  bannerUrl?: string;
  accentHex?: string;
  footerText?: string;
};

export type SaasChatDoc = {
  _id: string; // chatId
  chatId: string;
  title?: string;
  adminAddress: string; // EVM address
  planId: string;
  status: 'active' | 'expired' | 'disabled';
  expiresAt: number; // ms
  rails: Record<string, SaasChatRail>; // key = `${chainId}:${token}`
  skin?: SaasChatSkin;
  createdAt: number;
  updatedAt: number;
};

export type NonceDoc = {
  _id: string; // user address lower
  nonce: string;
  expiresAt: Date;
  createdAt: Date;
};

export type ModuleDoc = {
  _id: string; // moduleId
  enabled: boolean;
  controllerAddress: string; // EVM address lower
  apiKeyHash: string; // sha256 hex
  allowedTreasuries: string[]; // treasuryIds
  scopes: string[]; // e.g.
  createdAt: Date;
  updatedAt: Date;
  keyRotatedAt?: Date;
};

export type TreasuryDoc = {
  _id: string; // treasuryId
  moduleId: string; // owner moduleId or 'core'
  label: string;
  chainId: number;
  token: string; // token address lower
  enabled: boolean;
  createdAt: Date;
};

export type BalanceDoc = {
  _id: string; // `${accountId}:${chainId}:${token}`
  accountId: string; // user:0x.. or treasury:...
  chainId: number;
  token: string; // lower address
  balanceRaw: string; // base units as decimal string (uint256)
  updatedAt: Date;
  createdAt?: Date;
};

export type LedgerDoc = {
  _id: string; // refId
  refId: string; // idempotency key
  ts: Date;
  kind: string; // deposit, withdraw, transfer, game_bet...
  chainId: number;
  token: string; // lower address
  amountRaw: string;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  moduleId?: string | null;
  reason?: string;
  meta?: Record<string, any>;
};

export type VaultIntentDoc = {
  _id: string; // intentId
  refId: string; // unique client supplied
  createdAt: Date;
  updatedAt: Date;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed' | 'cancelled';

  chainId: number;
  vaultId: string;
  vaultAddress: string;

  action:
    | 'withdrawWithSig'
    | 'withdrawNativeWithSig'
    | 'withdrawWithSessionSig'
    | 'withdrawNativeWithSessionSig'
    | 'registerSessionWithSig'
    | 'configSessionTokenWithSig'
    | 'bridgeUsdcWithSig'
    | 'bridgeUsdcWithSessionSig';

  // payload
  ownerWallet: string;
  to: string;
  token?: string;
  amountRaw: string;
  deadline: number;
  sig: string;
  sessionKey?: string;
  sessionSig?: string;
  epoch?: string; // uint64 as string
  allowed?: boolean;
  maxPerTxRaw?: string;
  totalRaw?: string;
  destSelector?: string;
  destWallet?: string;

  txHash?: string;
  error?: string;
};

// TG <-> wallet linking
export type TgLinkCodeDoc = {
  _id: string; // random id
  moduleId: string;
  tgId: string;
  code: string;
  // set after wallet submits the code in the web UI (pending TG approval)
  ownerWallet?: string; // lower
  status?: 'created' | 'wallet_confirmed';
  walletConfirmedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
};

export type TgLinkDoc = {
  _id: string; // `${moduleId}:tg:${tgId}`
  moduleId: string;
  tgId: string;
  ownerWallet: string; // lower
  linkedAt: Date;

  };

export type TgWelcomeDoc = {
  _id: string; // moduleId
  moduleId: string;
  text?: string;
  photoFileId?: string;
  updatedAt: Date;
};

export type TgWelcomeSeenDoc = {
  _id: string; // `${moduleId}:tg:${tgId}`
  moduleId: string;
  tgId: string;
  seenAt: Date;
};

// Tracks TG users we've seen (DM or group) so we can tip them *before* wallet linking.
// Keyed by moduleId+tgId to avoid cross-module collisions.
export type TgSeenUserDoc = {
  _id: string; // `${moduleId}:tg:${tgId}`
  moduleId: string;
  tgId: string;
  username?: string | null;
  usernameLower?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  chatType?: string | null;
  lastSeenAt: Date;
};

export type TgNotifyOutboxDoc = {
  _id: string; // `${moduleId}:${tgId}:${refId}`
  moduleId: string;
  tgId: string;
  ownerWallet: string;
  refId: string;
  kind: string;
  chainId: number;
  token: string;
  amountRaw: string;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  status: 'pending' | 'sent';
  createdAt: Date;
  sentAt?: Date;
  meta?: Record<string, any>;
};


// Server-held session key (encrypted)
export type SessionKeyDoc = {
  _id: string; // `${ownerWallet}:${chainId}:${vaultId}`
  ownerWallet: string;
  chainId: number;
  vaultId: string;
  vaultAddress: string;
  sessionKey: string; // address
  encPriv: string; // base64 payload
  status: 'created' | 'active' | 'revoked';
  createdAt: Date;
  updatedAt: Date;
};

export type EventDoc = {
  _id: string;// `::`
  chainId: number;
  vaultId: string;
  vaultAddress: string;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  name: string;
  args: Record<string, any>;
  ts?: Date;
};

let client: MongoClient | null = null;

export async function connectMongo(uri: string): Promise<{ db: Db; collections: MongoCollections }> {
  if (!uri) throw new Error('MONGO_URI is required');

  client = new MongoClient(uri);
  await client.connect();

  const dbName = uri.split('/').pop()?.split('?')[0] || 'hauscashier';
  const db = client.db(dbName);

  const collections: MongoCollections = {
    nonces: db.collection<NonceDoc>('nonces'),
    modules: db.collection<ModuleDoc>('modules'),
    treasuries: db.collection<TreasuryDoc>('treasuries'),
    balances: db.collection<BalanceDoc>('balances'),
    ledger: db.collection<LedgerDoc>('ledger'),
    vaultIntents: db.collection<VaultIntentDoc>('vault_intents'),
    tgLinkCodes: db.collection<TgLinkCodeDoc>('tg_link_codes'),
    tgLinks: db.collection<TgLinkDoc>('tg_links'),
    tgWelcome: db.collection<TgWelcomeDoc>('tg_welcome'),
    tgWelcomeSeen: db.collection<TgWelcomeSeenDoc>('tg_welcome_seen'),
    tgSeenUsers: db.collection<TgSeenUserDoc>('tg_seen_users'),
    tgChatActivity: db.collection<TgChatActivityDoc>('tg_chat_activity'),
    tgSuccessMedia: db.collection<TgSuccessMediaDoc>('tg_success_media'),
    tgMaintenance: db.collection<TgMaintenanceDoc>('tg_maintenance'),
    tgAlertPrefs: db.collection<TgAlertPrefDoc>('tg_alert_prefs'),
    tgNotifyOutbox: db.collection<TgNotifyOutboxDoc>('tg_notify_outbox'),
    sessionKeys: db.collection<SessionKeyDoc>('session_keys'),
    saasChats: db.collection<SaasChatDoc>('saas_chats'),
    events: db.collection<EventDoc>('events'),
    vaultTokens: db.collection<VaultTokenDoc>('vault_tokens'),
    txTracks: db.collection<TxTrackDoc>('tx_tracks')
  };

  // indexes
  await ensureIndexes(collections);

  return { db, collections };
}

async function ensureIndexes(col: MongoCollections): Promise<void> {
  await col.nonces.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await col.ledger.createIndex({ ts: -1 });
  await col.ledger.createIndex({ fromAccountId: 1, ts: -1 });
  await col.ledger.createIndex({ toAccountId: 1, ts: -1 });
  await col.balances.createIndex({ accountId: 1, chainId: 1, token: 1 }, { unique: true });
  await col.vaultIntents.createIndex({ status: 1, createdAt: 1 });

  await col.saasChats.createIndex({ adminAddress: 1, updatedAt: -1 }, { name: 'saas_admin' });
  await col.saasChats.createIndex({ expiresAt: 1 }, { name: 'saas_expires' });

  await col.events.createIndex({ chainId: 1, txHash: 1, logIndex: 1 }, { unique: true, name: "uniq_event" });

  await col.vaultTokens.createIndex({ chainId: 1, vaultId: 1, token: 1 }, { unique: true, name: 'uniq_vault_token' });

  await col.tgAlertPrefs.createIndex({ moduleId: 1, tgId: 1 }, { unique: true, name: 'tg_alert_prefs_unique' });
  await col.vaultTokens.createIndex({ chainId: 1, vaultId: 1, enabled: 1 }, { name: 'vault_token_enabled' });

  await col.txTracks.createIndex({ accountId: 1, chainId: 1, txHash: 1 }, { unique: true, name: 'uniq_tx_track' });
  await col.txTracks.createIndex({ accountId: 1, updatedAt: -1 }, { name: 'tx_track_recent' });
  await col.events.createIndex({ chainId: 1, vaultId: 1, blockNumber: 1 }, { name: "event_block" });
  await col.events.createIndex({ ts: -1 }, { name: "event_ts" });
  await col.vaultIntents.createIndex({ refId: 1 }, { unique: true });

  await col.tgLinkCodes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'tg_link_code_ttl' });
  await col.tgLinkCodes.createIndex({ moduleId: 1, tgId: 1 }, { name: 'tg_link_code_mod_tg' });
  await col.tgLinks.createIndex({ moduleId: 1, tgId: 1 }, { unique: true, name: 'tg_link_unique' });
  await col.tgLinks.createIndex({ moduleId: 1, ownerWallet: 1 }, { name: 'tg_link_owner' });

  await col.tgWelcome.createIndex({ moduleId: 1 }, { unique: true, name: 'tg_welcome_unique' });
  await col.tgWelcomeSeen.createIndex({ moduleId: 1, tgId: 1 }, { unique: true, name: 'tg_welcome_seen_unique' });

  await col.tgSeenUsers.createIndex({ moduleId: 1, tgId: 1 }, { unique: true, name: 'tg_seen_unique' });
  await col.tgSeenUsers.createIndex({ moduleId: 1, usernameLower: 1 }, { name: 'tg_seen_username' });

  // /rain + /monsoon chat speaker tracking
  await col.tgChatActivity.createIndex({ moduleId: 1, chatId: 1, ts: -1 }, { name: 'tg_chat_recent' });
  await col.tgChatActivity.createIndex({ moduleId: 1, chatId: 1, tgId: 1, ts: -1 }, { name: 'tg_chat_user_recent' });
  // Keep a rolling window of activity to avoid unbounded growth (default 14 days)
  await col.tgChatActivity.createIndex({ ts: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60, name: 'tg_chat_ttl_14d' });

  // success media per action key
  await col.tgSuccessMedia.createIndex({ moduleId: 1, key: 1 }, { unique: true, name: 'tg_success_media_unique' });

  // maintenance state per module
  await col.tgMaintenance.createIndex({ moduleId: 1 }, { unique: true, name: 'tg_maintenance_unique' });

  await col.tgNotifyOutbox.createIndex({ moduleId: 1, status: 1, createdAt: 1 }, { name: 'tg_outbox_pending' });
  await col.tgNotifyOutbox.createIndex({ moduleId: 1, tgId: 1, refId: 1 }, { unique: true, name: 'tg_outbox_unique' });

  await col.sessionKeys.createIndex({ ownerWallet: 1, chainId: 1, vaultId: 1 }, { unique: true, name: 'sess_unique' });
}

export async function closeMongo(): Promise<void> {
  if (client) await client.close();
  client = null;
}
