# Deploy to your Cloudflare account

Goal: `ssh <project>@box.example.com -p 2222` from Termius → pi in a Durable Object.

Not yet tried against a real account. Things that may need adjusting are
marked **(unverified)**.

## You need

- A Cloudflare account on **Workers Paid** ($5/mo: Durable Objects, Dynamic Workers).
- A domain on Cloudflare on a **Pro or Business** plan (or Spectrum Enterprise).
  There's no separate Spectrum purchase: Pro/Business include one Worker-origin
  TCP app per zone, on one TCP port (public beta). Free zones can't. Buy the domain
  under **Domain Registration**, or add one you own; then the domain → **Overview →
  Plan** → **Pro**.
- An SSH client: Termius on a phone, or plain `ssh`.

## 1. Have an SSH key

- **Laptop:** `ssh-keygen -t ed25519` (skip if `~/.ssh/id_ed25519.pub` exists).
- **Termius:** Keychain → **Generate key** → **ED25519** → save; copy its public key.

Only the public half (`ssh-ed25519 AAAA… label`) goes to Cloudflare; the private
key never leaves your device.

## 2. Deploy the Worker

```sh
npx wrangler login
# edit wrangler.jsonc: PREVIEW_URL = https://do-box.<your-subdomain>.workers.dev,
#                      SSH_HOST    = box.<your-domain> -p 2222
npm run deploy                     # cargo + wasm-bindgen + bundle → dist/, then wrangler deploy
```

Then say who can log in, and set the preview token:

```sh
npm run keys                                # uploads ~/.ssh/id_ed25519.pub
openssl rand -hex 24 | npx wrangler secret put PREVIEW_TOKEN
```

- Several devices: `npm run keys -- ~/.ssh/id_ed25519.pub termius.pub` (one file each,
  e.g. the Termius key saved to a file). Each run **replaces** the whole list, so
  include every key you want to keep; to revoke a device, run it without that key.
- Or paste a key by hand: `npx wrangler secret put AUTHORIZED_KEYS`.
- Changes apply immediately, no redeploy. Until a key is set, every login is refused.

No model key is needed: pi uses Workers AI through the Worker's `AI` binding,
billed to your account. (Optionally add `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`
as secrets for other providers.)

**Likely blocker (unverified):** `wrangler.jsonc` sets the `experimental`
compatibility flag, which `@cloudflare/computer`'s Worker shell backend (pi's
`bash` tool) needs, and Cloudflare's changelog says that flag can't be enabled
in production. If the deploy is rejected over it, that backend needs replacing.
(The TCP `connect()` handler itself needs no flag.)

## 3. Route a TCP port to the Worker (Spectrum)

Dashboard → your domain → **Spectrum** → **Create an Application**:

- Application type: **Workers (tcp)**
- Subdomain: `box`
- Edge port: **2222** (one TCP port; Cloudflare's examples use 50051, and nothing
  says 2222 is refused; pick another high port if it is)
- Origin Worker: `do-box`
- TLS: leave it off (SSH encrypts end to end itself)

If **Workers (tcp)** isn't offered, the beta isn't enabled for your account yet.

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
- Key: the key from step 1

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
  exists. If the secret is missing, **every** login is refused.
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

`npm run deploy`. Projects, pi sessions and the host key
live in Durable Object storage and survive deploys.
