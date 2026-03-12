import 'dotenv/config';

// Prevent server crashes when a BigInt ends up in a JSON response.
// (Node/Express uses JSON.stringify internally, which cannot serialize BigInt.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

import { loadSystemConfig } from './config/loadConfig';
import { connectMongo } from './db/mongo';
import { createApp } from './http/app';
import { readFeeSweepEnv, sweepFeeTreasuryOnce } from './fees/feeSweep';

async function main() {
  const cfg = loadSystemConfig();
  const port = Number(process.env.PORT || 8088);
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI missing');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET missing');
  if (!process.env.RELAYER_SHARED_KEY) throw new Error('RELAYER_SHARED_KEY missing');

  const mongo = await connectMongo(process.env.MONGO_URI);
  const app = createApp(mongo.db, mongo.collections, cfg);

  app.listen(port, "127.0.0.1", () => {
    console.log(`[core-api] listening on :${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
