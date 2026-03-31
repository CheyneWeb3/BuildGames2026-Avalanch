import { MongoClient, Db, Collection } from 'mongodb';

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
  googleUsers: Collection<GoogleUserDoc>;
  googleLinkTokens: Collection<GoogleLinkTokenDoc>;
  blackjackHands: Collection<BlackjackHandDoc>;
};

// Stores Telegram bot maintenance mode state per module.
export type TgMaintenanceDoc = {
  _id: string;
  moduleId: string;
  enabled: boolean;
  updatedAt: Date;
  updatedByTgId?: string | null;
};

// Per-TG-user DM notification preferences
export type TgAlertPrefDoc = {
  _id: string;
  moduleId: string;
  tgId: string;
  enabled: boolean;
  updatedAt: Date;
};

// Tracks recent speakers in Telegram chats
export type TgChatActivityDoc = {
  _id: string;
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

// Stores optional media to attach to successful bot actions
export type TgSuccessMediaDoc = {
  _id: string;
  moduleId: string;
  key: 'tip' | 'rain' | 'monsoon';
  kind: 'photo' | 'video' | 'animation' | null;
  fileId: string | null;
  updatedAt: Date;
};

export type VaultTokenDoc = {
  _id: string;
  chainId: number;
  vaultId: string;
  vaultAddress: string;
  token: string;
  decimals: number;
  enabled: boolean;
  updatedAt: Date;
};

export type TxTrackDoc = {
  _id: string;
  accountId: string;
  chainId: number;
  txHash: string;
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
  _id: string;
  chatId: string;
  title?: string;
  adminAddress: string;
  planId: string;
  status: 'active' | 'expired' | 'disabled';
  expiresAt: number;
  rails: Record<string, SaasChatRail>;
  skin?: SaasChatSkin;
  createdAt: number;
  updatedAt: number;
};

export type NonceDoc = {
  _id: string;
  nonce: string;
  expiresAt: Date;
  createdAt: Date;
};

export type ModuleDoc = {
  _id: string;
  enabled: boolean;
  controllerAddress: string;
  apiKeyHash: string;
  allowedTreasuries: string[];
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
  keyRotatedAt?: Date;
};

export type TreasuryDoc = {
  _id: string;
  moduleId: string;
  label: string;
  chainId: number;
  token: string;
  enabled: boolean;
  createdAt: Date;
};

export type BalanceDoc = {
  _id: string;
  accountId: string;
  chainId: number;
  token: string;
  balanceRaw: string;
  updatedAt: Date;
  createdAt?: Date;
};

export type LedgerDoc = {
  _id: string;
  refId: string;
  ts: Date;
  kind: string;
  chainId: number;
  token: string;
  amountRaw: string;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  moduleId?: string | null;
  reason?: string;
  meta?: Record<string, any>;
};

export type VaultIntentDoc = {
  _id: string;
  refId: string;
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

  ownerWallet: string;
  to: string;
  token?: string;
  amountRaw: string;
  deadline: number;
  sig: string;
  sessionKey?: string;
  sessionSig?: string;
  epoch?: string;
  allowed?: boolean;
  maxPerTxRaw?: string;
  totalRaw?: string;
  destSelector?: string;
  destWallet?: string;

  txHash?: string;
  error?: string;
};

export type TgLinkCodeDoc = {
  _id: string;
  moduleId: string;
  tgId: string;
  code: string;
  ownerWallet?: string;
  status?: 'created' | 'wallet_confirmed';
  walletConfirmedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
};

export type TgLinkDoc = {
  _id: string;
  moduleId: string;
  tgId: string;
  ownerWallet: string;
  linkedAt: Date;
};

export type TgWelcomeDoc = {
  _id: string;
  moduleId: string;
  text?: string;
  photoFileId?: string;
  updatedAt: Date;
};

export type TgWelcomeSeenDoc = {
  _id: string;
  moduleId: string;
  tgId: string;
  seenAt: Date;
};

export type TgSeenUserDoc = {
  _id: string;
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
  _id: string;
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

export type SessionKeyDoc = {
  _id: string;
  ownerWallet: string;
  chainId: number;
  vaultId: string;
  vaultAddress: string;
  sessionKey: string;
  encPriv: string;
  status: 'created' | 'active' | 'revoked';
  createdAt: Date;
  updatedAt: Date;
};

export type EventDoc = {
  _id: string;
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

export type GoogleUserDoc = {
  _id: string;
  googleSub: string;
  email: string | null;
  emailLower: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  ownerWallet: string | null;
  createdAt: Date;
  updatedAt: Date;
  linkedAt?: Date | null;
  lastLoginAt?: Date | null;
};

export type GoogleLinkTokenDoc = {
  _id: string;
  googleSub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  expiresAt: Date;
  createdAt: Date;
};

export type BlackjackCardDoc = {
  rank: string;
  suit: string;
};

export type BlackjackHandDoc = {
  _id: string; // round id
  moduleId: string; // "blackjack"
  accountId: string; // user:0x... or tg:moduleId:tgId
  ownerWallet: string | null;
  tgId: string | null;

  chainId: number;
  token: string; // lower; USDC only in module logic
  symbol: string; // "USDC"
  decimals: number; // usually 6

  betRaw: string;
  doubled: boolean;

  status:
    | 'PLAYER_TURN'
    | 'DEALER_TURN'
    | 'PLAYER_BUST'
    | 'PUSH'
    | 'PLAYER_WIN'
    | 'DEALER_WIN'
    | 'PLAYER_BLACKJACK'
    | 'DEALER_BLACKJACK';

  deck: BlackjackCardDoc[];
  playerCards: BlackjackCardDoc[];
  dealerCards: BlackjackCardDoc[];
  dealerHidden: boolean;

  payoutRaw: string;

  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;

  refStart: string;
  refSettle: string | null;
  clientRequestId: string | null;
};

let client: MongoClient | null = null;

export async function connectMongo(uri: string): Promise<{ db: Db; collections: MongoCollections }> {
  if (!uri) throw new Error('MONGO_URI is required');

  client = new MongoClient(uri);
  await client.connect();

  const dbName = uri.split('/').pop()?.split('?')[0] || 'yeticashier';
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
    txTracks: db.collection<TxTrackDoc>('tx_tracks'),
    googleUsers: db.collection<GoogleUserDoc>('google_users'),
    googleLinkTokens: db.collection<GoogleLinkTokenDoc>('google_link_tokens'),
    blackjackHands: db.collection<BlackjackHandDoc>('blackjack_hands'),
  };

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
  await col.vaultIntents.createIndex({ refId: 1 }, { unique: true });

  await col.saasChats.createIndex({ adminAddress: 1, updatedAt: -1 }, { name: 'saas_admin' });
  await col.saasChats.createIndex({ expiresAt: 1 }, { name: 'saas_expires' });

  await col.events.createIndex({ chainId: 1, txHash: 1, logIndex: 1 }, { unique: true, name: 'uniq_event' });
  await col.events.createIndex({ chainId: 1, vaultId: 1, blockNumber: 1 }, { name: 'event_block' });
  await col.events.createIndex({ ts: -1 }, { name: 'event_ts' });

  await col.vaultTokens.createIndex({ chainId: 1, vaultId: 1, token: 1 }, { unique: true, name: 'uniq_vault_token' });
  await col.vaultTokens.createIndex({ chainId: 1, vaultId: 1, enabled: 1 }, { name: 'vault_token_enabled' });

  await col.txTracks.createIndex({ accountId: 1, chainId: 1, txHash: 1 }, { unique: true, name: 'uniq_tx_track' });
  await col.txTracks.createIndex({ accountId: 1, updatedAt: -1 }, { name: 'tx_track_recent' });

  await col.tgAlertPrefs.createIndex({ moduleId: 1, tgId: 1 }, { unique: true, name: 'tg_alert_prefs_unique' });

  await col.tgLinkCodes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'tg_link_code_ttl' });
  await col.tgLinkCodes.createIndex({ moduleId: 1, tgId: 1 }, { name: 'tg_link_code_mod_tg' });

  await col.tgLinks.createIndex({ moduleId: 1, tgId: 1 }, { unique: true, name: 'tg_link_unique' });
  await col.tgLinks.createIndex({ moduleId: 1, ownerWallet: 1 }, { name: 'tg_link_owner' });

  await col.tgWelcome.createIndex({ moduleId: 1 }, { unique: true, name: 'tg_welcome_unique' });
  await col.tgWelcomeSeen.createIndex({ moduleId: 1, tgId: 1 }, { unique: true, name: 'tg_welcome_seen_unique' });

  await col.tgSeenUsers.createIndex({ moduleId: 1, tgId: 1 }, { unique: true, name: 'tg_seen_unique' });
  await col.tgSeenUsers.createIndex({ moduleId: 1, usernameLower: 1 }, { name: 'tg_seen_username' });

  await col.tgChatActivity.createIndex({ moduleId: 1, chatId: 1, ts: -1 }, { name: 'tg_chat_recent' });
  await col.tgChatActivity.createIndex({ moduleId: 1, chatId: 1, tgId: 1, ts: -1 }, { name: 'tg_chat_user_recent' });
  await col.tgChatActivity.createIndex({ ts: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60, name: 'tg_chat_ttl_14d' });

  await col.tgSuccessMedia.createIndex({ moduleId: 1, key: 1 }, { unique: true, name: 'tg_success_media_unique' });

  await col.tgMaintenance.createIndex({ moduleId: 1 }, { unique: true, name: 'tg_maintenance_unique' });

  await col.tgNotifyOutbox.createIndex({ moduleId: 1, status: 1, createdAt: 1 }, { name: 'tg_outbox_pending' });
  await col.tgNotifyOutbox.createIndex({ moduleId: 1, tgId: 1, refId: 1 }, { unique: true, name: 'tg_outbox_unique' });

  await col.googleUsers.createIndex({ googleSub: 1 }, { unique: true, name: 'google_users_sub_unique' });
  await col.googleUsers.createIndex({ ownerWallet: 1 }, { name: 'google_users_owner' });
  await col.googleUsers.createIndex({ emailLower: 1 }, { name: 'google_users_email' });

  await col.googleLinkTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'google_link_tokens_ttl' });
  await col.googleLinkTokens.createIndex({ googleSub: 1 }, { name: 'google_link_tokens_sub' });

  await col.sessionKeys.createIndex({ ownerWallet: 1, chainId: 1, vaultId: 1 }, { unique: true, name: 'sess_unique' });

  await col.blackjackHands.createIndex(
    { accountId: 1, chainId: 1, status: 1, createdAt: -1 },
    { name: 'blackjack_active_lookup' }
  );

  await col.blackjackHands.createIndex(
    { accountId: 1, chainId: 1, createdAt: -1 },
    { name: 'blackjack_history_lookup' }
  );

  await col.blackjackHands.createIndex(
    { moduleId: 1, createdAt: -1 },
    { name: 'blackjack_module_recent' }
  );

  await col.blackjackHands.createIndex(
    { clientRequestId: 1 },
    {
      name: 'blackjack_client_req',
      partialFilterExpression: { clientRequestId: { $type: 'string' } },
    }
  );
}

export async function closeMongo(): Promise<void> {
  if (client) await client.close();
  client = null;
}
