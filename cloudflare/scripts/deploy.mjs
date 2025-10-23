import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const kvId = process.env.CLOUDFLARE_KV_ID;

if (!kvId) {
  console.error('CLOUDFLARE_KV_ID environment variable must be set for production deployments.');
  process.exit(1);
}

const configPath = new URL('../wrangler.toml', import.meta.url);
const configSource = readFileSync(configPath, 'utf8');
const placeholder = 'REGISTRY_KV_ID_PLACEHOLDER';

if (!configSource.includes(placeholder)) {
  console.error(`Unable to find the KV namespace placeholder ("${placeholder}") in wrangler.toml.`);
  process.exit(1);
}

const patchedConfig = configSource.replace(
  `id = "${placeholder}"`,
  `id = "${kvId}"`,
);

const tempDir = mkdtempSync(join(tmpdir(), 'wrangler-config-'));
const tempConfigPath = join(tempDir, 'wrangler.toml');
writeFileSync(tempConfigPath, patchedConfig, 'utf8');

const result = spawnSync(
  'npx',
  ['wrangler', 'deploy', '--env', 'production', '--config', tempConfigPath],
  {
    stdio: 'inherit',
    env: process.env,
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(result.status ?? 1);
}

process.exit(result.status ?? 0);
