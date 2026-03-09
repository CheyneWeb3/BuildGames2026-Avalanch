# FUJIMVP – TG Module Auth Setup on a New Server

This guide shows how to bring up the **Telegram module auth** correctly on a fresh server so the bot can authenticate to `thehaus-core-api` without hitting:

- `MODULE_DISABLED`
- `BAD_MODULE_KEY`
- endless `401` on `/modules/tg/tg/notify/pull`

This is based on the working fix from your current system.

---

## What the actual issue was

The core API middleware checks module auth like this:

- reads headers:
  - `x-module-id`
  - `x-module-key`
- hashes the plain `x-module-key` with SHA-256
- looks up the module in Mongo by **`_id`**
- compares the hash against `apiKeyHash`

Important detail:

```ts
const doc = await col.modules.findOne({ _id: moduleId });
```

That means the Mongo document must use:

- `_id: "tg"`

Not just:

- `moduleId: "tg"`

If you only create a doc like:

```js
{ moduleId: "tg", enabled: true }
```

with Mongo auto-generating an `ObjectId`, auth will still fail because the code is **not** querying by `moduleId`. It is querying by `_id`.

---

## Working end state

You want all 3 of these to match:

1. TG bot `.env`
   - `TG_MODULE_ID=tg`
   - `TG_MODULE_KEY=<plain module key>`

2. Mongo `modules` collection document
   - `_id: "tg"`
   - `enabled: true`
   - `apiKeyHash: <sha256 of TG_MODULE_KEY>`

3. Core API logs
   - `POST /modules/tg/tg/notify/pull` returns `200`

---

## Example values from the working system

Example plain key:

```text
yk_656322e6929a2a0e09e2098b05c26c35e4bd467b3280168658863626c6683cc8
```

Its SHA-256 hash:

```text
76866d3fd9d4184e8f93798f02b7d2b9eaa8b3c4cc6a3ed86e07dbf6b8d3a0ed
```

---

## Step 1 – Set the TG bot env

Edit:

```bash
cd /opt/FUJIMVP/services/tg-bot
nano .env
```

Make sure these exist:

```env
CORE_API_URL=http://127.0.0.1:8088
TG_MODULE_ID=tg
TG_MODULE_KEY=yk_656322e6929a2a0e09e2098b05c26c35e4bd467b3280168658863626c6683cc8
```

Notes:

- `TG_MODULE_ID` must be `tg`
- `TG_MODULE_KEY` is the **plain key**, not the hash
- `CORE_API_URL` must point to the local core API actually serving the bot

---

## Step 2 – Confirm the hash of the module key

Run:

```bash
printf '%s' 'yk_656322e6929a2a0e09e2098b05c26c35e4bd467b3280168658863626c6683cc8' | sha256sum
```

Expected output:

```text
76866d3fd9d4184e8f93798f02b7d2b9eaa8b3c4cc6a3ed86e07dbf6b8d3a0ed  -
```

Use the hash value only:

```text
76866d3fd9d4184e8f93798f02b7d2b9eaa8b3c4cc6a3ed86e07dbf6b8d3a0ed
```

---

## Step 3 – Connect to Mongo

Run:

```bash
mongosh "mongodb://127.0.0.1:27018/fujimvp?replicaSet=rs0&directConnection=true"
```

Adjust host, port, DB name, or replica set if your new server differs.

---

## Step 4 – Create the module doc the correct way

Inside `mongosh`, run this exact pattern:

```javascript
db.modules.updateOne(
  { _id: "tg" },
  {
    $set: {
      moduleId: "tg",
      enabled: true,
      apiKeyHash: "76866d3fd9d4184e8f93798f02b7d2b9eaa8b3c4cc6a3ed86e07dbf6b8d3a0ed",
      updatedAt: new Date()
    },
    $setOnInsert: {
      createdAt: new Date()
    }
  },
  { upsert: true }
)
```

Then verify it:

```javascript
db.modules.find({ _id: "tg" }).pretty()
```

You want output shaped like:

```javascript
[
  {
    _id: 'tg',
    moduleId: 'tg',
    enabled: true,
    apiKeyHash: '76866d3fd9d4184e8f93798f02b7d2b9eaa8b3c4cc6a3ed86e07dbf6b8d3a0ed',
    createdAt: ISODate('...'),
    updatedAt: ISODate('...')
  }
]
```

### Important

Do **not** rely on this pattern alone:

```javascript
db.modules.updateOne(
  { moduleId: "tg" },
  { ... },
  { upsert: true }
)
```

That can create a document with an auto-generated `ObjectId` `_id`, which **will not match** the middleware lookup.

The working fix is:

```javascript
{ _id: "tg" }
```

---

## Step 5 – Restart services

Back in shell:

```bash
pm2 restart thehaus-core-api --update-env
pm2 restart thehaus-tg-bot --update-env
```

Check both are online:

```bash
pm2 ls
```

---

## Step 6 – Verify core API is listening

Run:

```bash
ss -ltnp | grep 8088
curl -i http://127.0.0.1:8088/health
```

Expected health response should include something like:

```json
{"ok":true,"service":"thehaus-core-api","env":"dev"}
```

---

## Step 7 – Verify module auth is now working

Tail core API logs:

```bash
pm2 logs thehaus-core-api --lines 50
```

You are looking for this route:

```text
POST /modules/tg/tg/notify/pull
```

### Bad result

If auth is still broken, you will see:

```text
statusCode":401
```

### Good result

When fixed, you will see:

```text
statusCode":200
```

That `200` is the proof that:

- `x-module-id` matches
- `x-module-key` hash matches
- Mongo module doc is found correctly
- module is enabled

---

## One-shot checklist

Use this on a fresh server:

### A. Bot env

```env
CORE_API_URL=http://127.0.0.1:8088
TG_MODULE_ID=tg
TG_MODULE_KEY=<plain key>
```

### B. Hash the plain key

```bash
printf '%s' '<plain key>' | sha256sum
```

### C. Store hash in Mongo under `_id: "tg"`

```javascript
db.modules.updateOne(
  { _id: "tg" },
  {
    $set: {
      moduleId: "tg",
      enabled: true,
      apiKeyHash: "<sha256 hash>",
      updatedAt: new Date()
    },
    $setOnInsert: {
      createdAt: new Date()
    }
  },
  { upsert: true }
)
```

### D. Restart PM2 processes

```bash
pm2 restart thehaus-core-api --update-env
pm2 restart thehaus-tg-bot --update-env
```

### E. Confirm success in logs

```bash
pm2 logs thehaus-core-api --lines 50
```

Look for:

```text
POST /modules/tg/tg/notify/pull
statusCode":200
```

---

## Fast troubleshooting

### Problem: `MODULE_DISABLED`

Cause:
- no Mongo module doc found, or `enabled` is false

Fix:
- make sure doc exists with `_id: "tg"`
- make sure `enabled: true`

---

### Problem: `BAD_MODULE_KEY`

Cause:
- plain key in tg-bot `.env` does not hash to the Mongo `apiKeyHash`

Fix:
- re-run:

```bash
printf '%s' '<plain key>' | sha256sum
```

- store that exact hash in Mongo
- restart both PM2 services

---

### Problem: you created the doc but auth still fails

Cause:
- document was created with `ObjectId(...)` instead of `_id: "tg"`

Fix:
- create/update the correct document with:

```javascript
{ _id: "tg" }
```

- verify with:

```javascript
db.modules.find({ _id: "tg" }).pretty()
```

---

### Problem: `/modules/tg/health` or `/modules/tg/tg/health` returns 404

Cause:
- those routes do not prove module auth is working
- the real auth traffic from tg-bot is `POST /modules/tg/tg/notify/pull`

Fix:
- stop testing random health paths for this issue
- watch the real route in the core logs instead

---

### Problem: warning about `X-Forwarded-For` / `trust proxy`

Cause:
- Express is behind Cloudflare/tunnel and `trust proxy` is not configured

Effect:
- warning noise in logs
- separate from tg module auth

This is **not** what caused the `401` module auth failure.

---

## Commands recap

### Check the current tg bot env key

```bash
cd /opt/FUJIMVP/services/tg-bot
grep -n "CORE_API_URL\|TG_MODULE_ID\|TG_MODULE_KEY" .env
```

### Hash the key

```bash
printf '%s' 'YOUR_PLAIN_KEY_HERE' | sha256sum
```

### Check core API health

```bash
curl -i http://127.0.0.1:8088/health
```

### Restart services

```bash
pm2 restart thehaus-core-api --update-env
pm2 restart thehaus-tg-bot --update-env
```

### Watch live core logs

```bash
pm2 logs thehaus-core-api --lines 50
```

---

## Final rule to remember

For this codebase as it currently stands:

- the bot sends `x-module-id: tg`
- the core API looks up Mongo with:

```ts
findOne({ _id: moduleId })
```

So your Mongo module document must exist as:

```javascript
{ _id: "tg" }
```

That is the key detail that makes the hash auth work on a new server.
