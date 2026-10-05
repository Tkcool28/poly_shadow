/**
 * Static safety gate (PHASE2_REMOVAL_PLAN §6) — runs in CI.
 * Asserts, from source alone, that this repository cannot trade:
 *  1. No signing/trading dependencies in package.json.
 *  2. No network-client construction outside the two declared sites:
 *     fetch() only in src/shadow/egress.ts; `new WebSocket` only in
 *     src/shadow/watcher.ts (which passes through the egress assertion).
 *  3. No signing/key material API usage anywhere in src/.
 * Exits non-zero with a readable report on any violation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const failures = [];

// 1) Dependency ban-list (signing / trading / chain-client SDKs).
const BANNED_DEPS = [
  'ethers', 'web3', 'viem', 'wagmi', 'solana',
  '@solana/web3.js', '@polymarket/clob-client', '@polymarket/sdk',
  'eth-sig-util', '@metamask/eth-sig-util', 'ethereumjs-tx', 'ethereumjs-util',
];
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const allDeps = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
];
for (const dep of allDeps) {
  if (BANNED_DEPS.some((b) => dep === b || dep.startsWith(b + '/'))) {
    failures.push(`banned dependency present: ${dep}`);
  }
}

// 2) + 3) Source scan.
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

const KEY_API = /\b(signTransaction|signMessage|signTypedData|privateKeyToAccount|Wallet\s*\(|fromPrivateKey)\b/;
for (const file of walk('src')) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, ''); // strip line comments
    if (code.includes('fetch(') && file !== join('src', 'shadow', 'egress.ts')) {
      failures.push(`${file}:${i + 1}: fetch() outside egress.ts`);
    }
    if (code.includes('new WebSocket') && file !== join('src', 'shadow', 'watcher.ts')) {
      failures.push(`${file}:${i + 1}: new WebSocket outside watcher.ts`);
    }
    if (KEY_API.test(code)) {
      failures.push(`${file}:${i + 1}: signing/key API usage: ${line.trim()}`);
    }
  });
}

if (failures.length > 0) {
  console.error('STATIC SAFETY GATE FAILED:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`static safety gate: OK (${allDeps.length} deps scanned, src/ clean)`);
