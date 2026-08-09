import { execFileSync, spawnSync } from 'node:child_process';

const suffix = `${process.pid}-${Date.now()}`;
const image = `siren-records-web-smoke:${suffix}`;
const container = `siren-records-web-smoke-${suffix}`;

function docker(...args) {
  execFileSync('docker', args, { stdio: 'inherit' });
}

async function waitFor(path, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const check = spawnSync('docker', [
      'exec', container, 'node', '-e',
      `fetch('http://127.0.0.1:4173${path}').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`
    ], { stdio: 'ignore' });
    if (check.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${path} did not become ready inside the container`);
}

try {
  docker('build', '-t', image, '.');
  docker('run', '--detach', '--name', container, '--publish', '4174:4173', image);
  try {
    await waitFor('/api/health');
    await waitFor('/');
    await waitFor('/api/catalog');
    console.log('Docker smoke checks passed: /api/health, /, /api/catalog');
  } catch (error) {
    spawnSync('docker', ['logs', container], { stdio: 'inherit' });
    throw error;
  }
} finally {
  spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
  spawnSync('docker', ['image', 'rm', '--force', image], { stdio: 'ignore' });
}
