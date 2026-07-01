#!/usr/bin/env node

/**
 * CucumberStudio Feature File Exporter
 *
 * Authenticates with the CucumberStudio REST API, discovers the full folder
 * hierarchy under the project's Features section, downloads the Gherkin
 * .feature content for every folder, and saves each file into the correct
 * local directory structure under ./features/.
 *
 * Usage:  node export-features.mjs
 *
 * Required .env keys: BASE_URL, EMAIL, PASSWORD, PROJECT_ID
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ---------------------------------------------------------------------------
// 1. Parse .env
// ---------------------------------------------------------------------------

function loadEnv(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    env[key] = value;
  }
  return env;
}

const ENV_PATH = resolve(process.cwd(), '.env');
const env = loadEnv(ENV_PATH);

const API_BASE = 'https://studio.cucumberstudio.com/api';
const EMAIL = env.EMAIL;
const PASSWORD = env.PASSWORD;
const PROJECT_ID = env.PROJECT_ID;

if (!EMAIL || !PASSWORD || !PROJECT_ID) {
  console.error('❌  Missing required .env keys: EMAIL, PASSWORD, PROJECT_ID');
  process.exit(1);
}

console.log(`📦  Project ID: ${PROJECT_ID}`);
console.log(`👤  User: ${EMAIL}`);

// ---------------------------------------------------------------------------
// 2. API helpers
// ---------------------------------------------------------------------------

const JSON_API_ACCEPT = 'application/vnd.api+json; version=1';

/** Small delay to stay under 200 req/min rate limit. */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let authHeaders = {};

async function authenticate() {
  console.log('\n🔑  Authenticating…');
  const res = await fetch(`${API_BASE}/auth/sign_in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Auth failed (${res.status}): ${body}`);
  }

  authHeaders = {
    'access-token': res.headers.get('access-token'),
    client: res.headers.get('client'),
    uid: res.headers.get('uid'),
    accept: JSON_API_ACCEPT,
  };
  console.log('✅  Authenticated');
}

async function apiGet(path) {
  await delay(350); // ~170 req/min max cadence
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, { headers: authHeaders });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function apiGetText(path) {
  await delay(350);
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, { headers: authHeaders });
  
  if (res.status === 204) return ''; // No content
  
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} failed (${res.status}): ${body}`);
  }
  
  const content = await res.text();
  try {
    const json = JSON.parse(content);
    if (json?.data?.attributes?.feature) {
      return json.data.attributes.feature;
    }
  } catch (e) {
    // If not JSON, return as is
  }
  return content;
}

// ---------------------------------------------------------------------------
// 3. Fetch folder hierarchy
// ---------------------------------------------------------------------------

async function fetchAllFolders() {
  console.log('\n📂  Fetching folder list…');
  const json = await apiGet(`/projects/${PROJECT_ID}/folders`);
  const folders = json.data.map((f) => ({
    id: f.id,
    name: f.attributes.name,
    parentId: f.attributes['parent-id'],
  }));
  console.log(`   Found ${folders.length} folders`);
  return folders;
}

// ---------------------------------------------------------------------------
// 4. Build tree & compute paths
// ---------------------------------------------------------------------------

function sanitizeName(name) {
  // Remove characters invalid in file/dir names, trim whitespace
  return name.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

function buildTree(folders) {
  const byId = new Map();
  for (const f of folders) byId.set(String(f.id), f);

  // Compute full path for each folder by walking up parent chain
  function getPath(folder) {
    const parts = [];
    let current = folder;
    while (current) {
      parts.unshift(sanitizeName(current.name));
      current = current.parentId ? byId.get(String(current.parentId)) : null;
    }
    return parts.join('/');
  }

  return folders.map((f) => ({
    ...f,
    path: getPath(f),
  }));
}

// ---------------------------------------------------------------------------
// 5. Download features & save
// ---------------------------------------------------------------------------

const OUTPUT_DIR = resolve(process.cwd(), 'features');

async function downloadAndSave(foldersWithPaths) {
  console.log(`\n⬇️   Downloading features into ${OUTPUT_DIR}\n`);

  let downloaded = 0;
  let skipped = 0;
  let empty = 0;

  for (const folder of foldersWithPaths) {
    const dirPath = join(OUTPUT_DIR, folder.path);
    mkdirSync(dirPath, { recursive: true });

    try {
      const featureText = await apiGetText(
        `/projects/${PROJECT_ID}/folders/${folder.id}/feature`
      );

      const fileName = `${sanitizeName(folder.name)}.feature`;
      const filePath = join(dirPath, fileName);

      if (!featureText || featureText.trim().length === 0) {
        // Empty feature — still create file per user request
        writeFileSync(filePath, `Feature: ${folder.name}\n`, 'utf-8');
        empty++;
        console.log(`   📄  (empty) ${folder.path}/${fileName}`);
      } else {
        writeFileSync(filePath, featureText, 'utf-8');
        downloaded++;
        console.log(`   ✅  ${folder.path}/${fileName}`);
      }
    } catch (err) {
      // Some folders may not support feature download (e.g. root)
      console.warn(`   ⚠️   Skipped ${folder.path}: ${err.message}`);
      skipped++;
    }
  }

  console.log(
    `\n📊  Done! Downloaded: ${downloaded}, Empty: ${empty}, Skipped: ${skipped}`
  );
}

// ---------------------------------------------------------------------------
// 6. Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🚀  CucumberStudio Feature Exporter\n');
  await authenticate();
  const folders = await fetchAllFolders();
  const foldersWithPaths = buildTree(folders);

  // Print tree for verification
  console.log('\n🗂️   Folder tree:');
  for (const f of foldersWithPaths) {
    const depth = f.path.split('/').length - 1;
    console.log(`   ${'  '.repeat(depth)}├── ${f.name} (id: ${f.id})`);
  }

  await downloadAndSave(foldersWithPaths);
}

main().catch((err) => {
  console.error('\n💥  Fatal error:', err.message);
  process.exit(1);
});
