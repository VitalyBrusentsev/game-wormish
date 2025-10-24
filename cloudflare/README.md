# Wormish Cloudflare Workers

This directory contains the infrastructure required to build, test, and deploy Cloudflare Workers that complement the Wormish game. The worker exposes a WebRTC registry API used by clients to create short-lived pairing rooms and exchange SDP offers, answers, and ICE candidates ahead of a peer-to-peer match.

## Prerequisites

- Node.js 18 or newer (Cloudflare Workers execute on a runtime compatible with Node 18 / Workers runtime)
- A Cloudflare account with API token capable of deploying Workers

All other tooling (Wrangler, Vitest, TypeScript) is installed via local dependencies, so no global installs are required.

## Getting Started

Install dependencies (if your environment routes traffic through an HTTP proxy, ensure the proxy variables are correctly configured so `npm install` can reach the public registry):

```bash
cd cloudflare
npm install
```

Run a local development worker using Cloudflare's Miniflare-powered emulator:

```bash
npm run dev
```

This serves the worker on <http://localhost:8787>. The endpoints match the API described in [`registry-api-spec.md`](./registry-api-spec.md).

## Testing

Run the Vitest suite directly:

```bash
npm test
```

For a single-run CI friendly invocation use:

```bash
npm run test:run
```

Validate the OpenAPI description before sharing updates:

```bash
npx @redocly/cli lint openapi.yaml
```

## Building

Validate the worker bundle without publishing anything:

```bash
npm run build
```

This executes `wrangler deploy --dry-run` and ensures the project builds successfully for deployment.

## Testing the Registry API Locally

After starting the worker with `npm run dev`, exercise the primary room lifecycle from another terminal. Replace the placeholder values with the actual response payloads returned by each step.

1. **Create a room (host):**

   ```bash
   curl -X POST \
     -H 'content-type: application/json' \
     -H 'x-registry-version: 1' \
     -d '{"hostUserName":"Alice1996"}' \
     http://localhost:8787/rooms
   ```

   The response includes `code`, `joinCode`, `ownerToken`, and `expiresAt`.

2. **Public lookup (guest confirmation):**

   ```bash
   curl http://localhost:8787/rooms/<code>/public
   ```

3. **Join the room (guest):**

   ```bash
   curl -X POST \
     -H 'content-type: application/json' \
     -H 'x-registry-version: 1' \
     -d '{"joinCode":"<joinCode>","guestUserName":"Bob1997"}' \
     http://localhost:8787/rooms/<code>/join
   ```

   Capture the returned `guestToken` for subsequent calls.

4. **Exchange SDP offer and answer:**

   ```bash
   curl -X POST \
     -H 'content-type: application/json' \
     -H 'x-registry-version: 1' \
     -H 'x-access-token: <ownerToken>' \
     -d '{"type":"offer","sdp":"v=0\no=- 0 0 IN IP4 127.0.0.1\ns=-\nt=0 0\nm=audio 9 RTP/AVP 0"}' \
     http://localhost:8787/rooms/<code>/offer

   curl -X POST \
     -H 'content-type: application/json' \
     -H 'x-registry-version: 1' \
     -H 'x-access-token: <guestToken>' \
     -d '{"type":"answer","sdp":"v=0\no=- 0 0 IN IP4 127.0.0.1\ns=-\nt=0 0\nm=audio 9 RTP/AVP 0"}' \
     http://localhost:8787/rooms/<code>/answer
   ```

5. **Post and drain ICE candidates:**

   ```bash
   curl -X POST \
     -H 'content-type: application/json' \
     -H 'x-registry-version: 1' \
     -H 'x-access-token: <ownerToken>' \
     -d '{"candidate":"candidate:1 1 UDP 1 127.0.0.1 3478 typ host"}' \
     http://localhost:8787/rooms/<code>/candidate

   curl -H 'x-access-token: <guestToken>' http://localhost:8787/rooms/<code>/candidates
   ```

6. **Close the room (optional host cleanup):**

   ```bash
   curl -X POST \
     -H 'x-registry-version: 1' \
     -H 'x-access-token: <ownerToken>' \
     http://localhost:8787/rooms/<code>/close
   ```

## Deploying

Production deployments run through the [`cloudflare-deploy.yml`](../.github/workflows/cloudflare-deploy.yml) GitHub Actions workflow. The job rewrites a temporary `wrangler.toml`, replacing the `REGISTRY_KV_ID_PLACEHOLDER` with the `CLOUDFLARE_KV_ID` secret before invoking `wrangler deploy`.

Configure the following repository secrets so the workflow can authenticate, target the production KV namespace, and lock down CORS:

- `CLOUDFLARE_API_TOKEN`: an API token with **Workers Scripts** "Edit" permissions and access to the target account.
- `CLOUDFLARE_ACCOUNT_ID`: the account identifier from your Cloudflare dashboard (found under **Workers & Pages → Overview**).
- `CLOUDFLARE_KV_ID`: the KV namespace identifier for the production `REGISTRY_KV` binding. This value remains private in CI via repository secrets and is injected during the deployment step.
- `CLOUDFLARE_ALLOWED_ORIGIN`: the production origin allowed to access the registry API. Typically this matches the domain serving the front-end client.

When deployed, the worker URL will be reported by Wrangler in the CLI output. The default route will be `https://wormish-current-time.<your-subdomain>.workers.dev/` unless you configure a custom domain.

## Type checking

Ensure the TypeScript sources still type-check:

```bash
npm run typecheck
```

## Continuous Deployment via GitHub Actions

The repository contains `.github/workflows/cloudflare-deploy.yml`, which installs dependencies, runs tests, performs a dry-run build, and deploys on pushes to `main`. Store the Cloudflare credentials as encrypted secrets named `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_KV_ID` within your GitHub repository settings. The workflow only publishes when the required secrets are present and the branch is `main`.

## Project Structure

- `src/index.ts` – main worker module exporting the `fetch` handler.
- `src/index.test.ts` – Vitest suite validating the worker response shape.
- `wrangler.toml` – Wrangler configuration used for local dev and deployments.
- `tsconfig.json` – TypeScript configuration shared by source and tests.
- `package.json` – Scripts and dependency definitions for the worker project.

## Configuration management

The Worker under `cloudflare/` is configured with [`wrangler.toml`](./wrangler.toml). That file remains in source control so every clone of the repository can run `wrangler dev` without extra setup. The committed values are safe defaults for local development:

- The `REGISTRY_KV` binding uses Miniflare's ephemeral namespace while developing.
- `ALLOWED_ORIGINS` defaults to `http://localhost:5173` so the Vite dev server can call the registry while you iterate locally.
- No secrets are stored directly in the configuration. Sensitive data should be provisioned with `wrangler secret put` or environment variables.

### Keeping production-only values private

Real Cloudflare resource identifiers (such as the production KV namespace `id`) should not be committed. `wrangler.toml` keeps placeholders (`REGISTRY_KV_ID_PLACEHOLDER`, `ALLOWED_ORIGIN_PLACEHOLDER`) for the production namespace ID and the allowed CORS origin. The deployment workflow creates a temporary copy of the config with those placeholders replaced by the `CLOUDFLARE_KV_ID` and `CLOUDFLARE_ALLOWED_ORIGIN` secrets supplied by GitHub.
