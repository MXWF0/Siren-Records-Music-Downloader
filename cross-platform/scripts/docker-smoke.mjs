import { execFileSync, spawnSync } from 'node:child_process';

const suffix = `${process.pid}-${Date.now()}`;
const image = `siren-records-web-smoke:${suffix}`;
const container = `siren-records-web-smoke-${suffix}`;

function docker(...args) {
  execFileSync('docker', args, { stdio: 'inherit' });
}

async function waitFor(path, attempts = 30) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:4174${path}`, { cache: 'no-store' });
      if (response.ok) return response;
      lastError = new Error(`${path} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError || new Error(`${path} did not become ready`);
}

try {
  docker('build', '-t', image, '.');
  docker('run', '--detach', '--name', container, '--publish', '4174:4173', image);
  await waitFor('/api/health');
  await waitFor('/');
  await waitFor('/api/catalog');
  console.log('Docker smoke checks passed: /api/health, /, /api/catalog');
} finally {
  spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
  spawnSync('docker', ['image', 'rm', '--force', image], { stdio: 'ignore' });
}
