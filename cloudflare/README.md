# Wormish Cloudflare Workers

This directory contains the infrastructure required to build, test, and deploy Cloudflare Workers that complement the Wormish game. The initial worker ships a simple HTTP endpoint that returns the current server time in ISO-8601 format, demonstrating how to scaffold new handlers with automated tests and deployment.

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

This serves the worker on <http://localhost:8787>. Requests return the current time payload.

## Testing

Run the Vitest suite directly:

```bash
npm test
```

For a single-run CI friendly invocation use:

```bash
npm run test:run
```

## Building

Validate the worker bundle without publishing anything:

```bash
npm run build
```

This executes `wrangler deploy --dry-run` and ensures the project builds successfully for deployment.

## Deploying

Deploy the worker to Cloudflare with:

```bash
npm run deploy
```

You must provide the following environment variables (locally and in CI) for Wrangler to authenticate:

- `CLOUDFLARE_API_TOKEN`: an API token with **Workers Scripts** "Edit" permissions and access to the target account.
- `CLOUDFLARE_ACCOUNT_ID`: the account identifier from your Cloudflare dashboard (found under **Workers & Pages → Overview**).

When deployed, the worker URL will be reported by Wrangler in the CLI output. The default route will be `https://wormish-current-time.<your-subdomain>.workers.dev/` unless you configure a custom domain.

## Type checking

Ensure the TypeScript sources still type-check:

```bash
npm run typecheck
```

## Continuous Deployment via GitHub Actions

The repository contains `.github/workflows/cloudflare-deploy.yml`, which installs dependencies, runs tests, performs a dry-run build, and deploys on pushes to `main`. Store the Cloudflare credentials as encrypted secrets named `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` within your GitHub repository settings. The workflow only publishes when both secrets are present and the branch is `main`.

## Project Structure

- `src/index.ts` – main worker module exporting the `fetch` handler.
- `src/index.test.ts` – Vitest suite validating the worker response shape.
- `wrangler.toml` – Wrangler configuration used for local dev and deployments.
- `tsconfig.json` – TypeScript configuration shared by source and tests.
- `package.json` – Scripts and dependency definitions for the worker project.
