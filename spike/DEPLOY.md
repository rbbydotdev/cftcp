# Deploy do-box to Cloudflare and connect with Termius

Goal: `ssh <project>@box.example.com -p 2222` from Termius → pi in a Durable Object.

Not yet tried against a real account. Things that may need adjusting are
marked **(unverified)**.

## You need

- A Cloudflare account on **Workers Paid** (Durable Objects, Dynamic Workers).
- A domain on Cloudflare on a **Pro or Business** plan (or Spectrum Enterprise):
  inbound TCP reaches a Worker through a Spectrum app, and Pro/Business allow
  one Worker-origin app per zone, on one TCP port.
- Termius on your phone or laptop.

## 1. Make your SSH key in Termius

Termius → Keychain → **Generate key** → type **ED25519** → save. Copy its
**public key** (`ssh-ed25519 AAAA… label`). The private key never leaves Termius;
only the public half goes to Cloudflare.

## 2. Deploy the Worker

```sh
cd spike
npx wrangler login
npm run build                      # cargo + wasm-bindgen + bundle → dist/
# edit wrangler.jsonc: set PREVIEW_URL to https://do-box.<your-subdomain>.workers.dev
npx wrangler deploy
```

Then set the secrets. No model key is needed: pi uses Workers AI through the
Worker's `AI` binding, billed to your account. (Optionally add `OPENROUTER_API_KEY`
or `ANTHROPIC_API_KEY` as secrets for other providers.)

```sh
npx wrangler secret put AUTHORIZED_KEYS     # paste the Termius public key (one per line for several)
npx wrangler secret put PREVIEW_TOKEN       # any long random string: openssl rand -hex 24
```

**(unverified)** The `experimental` compatibility flag (needed by the Worker
shell backend) and Worker Loader may need your account to have access.
If deploy rejects them, tell me the error.

## 3. Route a TCP port to the Worker (Spectrum)

Dashboard → your domain → **Spectrum** → **Create an application**:

- Hostname: `box.example.com`
- Protocol: **TCP**, edge port **2222** (any non-standard port is fine)
- Origin: **Worker** → `do-box`
- TLS: off/none (SSH encrypts end to end itself)

Or by API (fields from the Nov 2026 changelog; `origin_worker_id` is the
Worker's 32-character tag from the Workers dashboard, not its name):

```sh
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/spectrum/apps" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json" \
  -d '{"dns":{"type":"CNAME","name":"box.example.com"},
       "protocol":"tcp/2222","traffic_type":"worker","origin_worker_id":"<worker tag>"}'
```

## 4. Connect from Termius

New host:

- Address `box.example.com`, port **2222**
- Username: **the project name** (`clicker`, `todo`, …; a new name makes a new project)
- Key: the ED25519 key from step 1

On first connect Termius shows the box's host key fingerprint. Accept it once;
Termius warns you if it ever changes.

Admin: add another host with username **admin** (same key). It lists your projects
with info cards; tap or ↑/↓ to pick one, **Enter** opens it in pi (quit pi to come back), **Remove** (or `d`) deletes it. Set the
`SSH_HOST` var in `wrangler.jsonc` so its "Open" line shows your real address.

Preview: open `https://do-box.<subdomain>.workers.dev/?token=<PREVIEW_TOKEN>`
once (it sets a cookie), then `/<project>/`.

## How it's protected

- **Key-only SSH.** No passwords, no keyboard-interactive. Only public keys in the
  `AUTHORIZED_KEYS` secret get in; anything else is refused before a shell
  exists. If the secret is missing, **every** login is refused (the "any key"
  mode only exists for local `./try`).
- **Your private key stays in Termius.** Cloudflare only holds the public key.
  Lose the phone? Remove that line from `AUTHORIZED_KEYS` and redeploy the secret.
- **The box's host key** is generated on first boot and kept in the Durable
  Object's storage, so the fingerprint stays stable.
- **Preview is private:** 404 for everything without the `PREVIEW_TOKEN`
  (query once, then an HttpOnly cookie).
- **Secrets** (model keys, tokens) live in Wrangler secrets, not in code.
- **A non-standard port** only cuts down scanner noise; the keys are what keep
  people out.
- **Optional, stronger:** in Spectrum, add an **IP access rule** so only your
  home/phone networks can open the port at all. Strangers then can't even reach
  the SSH handshake, which also protects your Durable Object bill from floods.

## Time limits (wrangler.jsonc vars)

- `IDLE_TIMEOUT_MIN` (30): no keystrokes and no output for this long → disconnect.
  pi working counts as output, so a long agent run isn't "idle".
- `MAX_SESSION_HOURS` (8): hard cap per connection.
- `RUN_TIMEOUT_S` (120): per `run_python` call (`run_js` has 60 s).

Reconnecting resumes the project's pi session. Workers AI usage shows up under
AI → Workers AI in the dashboard; if you add an OpenRouter key, give it a credit
limit too.

## Updating

`npm run build && npx wrangler deploy`. Projects, pi sessions and the host key
live in Durable Object storage and survive deploys.
