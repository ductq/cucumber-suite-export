#!/usr/bin/env node

/**
 * CucumberStudio Feature File Uploader
 *
 * Reverse of export-features.mjs: reads a local folder-as-feature tree
 * (default ./upload) and mirrors it into the CucumberStudio project so the
 * remote Features tree matches the local tree exactly — create missing
 * folders, update Gherkin, delete extra remote folders, and wipe leftover
 * scenarios.
 *
 * Usage:
 *   node upload-features.mjs                  # dry-run (no writes)
 *   node upload-features.mjs --apply          # write; type yes if deletes
 *   node upload-features.mjs --apply --yes    # write without prompt
 *   node upload-features.mjs --dir ./upload   # override source directory
 *
 * Required .env keys: EMAIL, PASSWORD, PROJECT_ID
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// ---------------------------------------------------------------------------
// 1. CLI + .env
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { apply: false, yes: false, dir: 'upload' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--dir' && argv[i + 1]) args.dir = argv[++i];
    else if (a.startsWith('--dir=')) args.dir = a.slice('--dir='.length);
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

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

const CLI = parseArgs(process.argv.slice(2));

if (CLI.help) {
  console.log(`Usage: node upload-features.mjs [--dir <path>] [--apply] [--yes]

  --dir <path>   Local source tree (default: ./upload)
  --apply        Write changes to CucumberStudio (default is dry-run)
  --yes          Skip the confirmation prompt when deletes are planned
`);
  process.exit(0);
}

const ENV_PATH = resolve(process.cwd(), '.env');
if (!existsSync(ENV_PATH)) {
  console.error('❌  Missing .env file. Copy .env.example to .env and fill in EMAIL, PASSWORD, PROJECT_ID.');
  process.exit(1);
}
const env = loadEnv(ENV_PATH);

const API_BASE = 'https://studio.cucumberstudio.com/api';
const EMAIL = env.EMAIL;
const PASSWORD = env.PASSWORD;
const PROJECT_ID = env.PROJECT_ID;
const UPLOAD_DIR = resolve(process.cwd(), CLI.dir);
const IMPORT_TIMEOUT_MS = 30_000;

if (!EMAIL || !PASSWORD || !PROJECT_ID) {
  console.error('❌  Missing required .env keys: EMAIL, PASSWORD, PROJECT_ID');
  process.exit(1);
}

console.log(`📦  Project ID: ${PROJECT_ID}`);
console.log(`👤  User: ${EMAIL}`);
console.log(`📁  Source: ${UPLOAD_DIR}`);
console.log(`🛠️   Mode: ${CLI.apply ? 'APPLY (writes to CucumberStudio)' : 'DRY-RUN (no writes)'}`);

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
  await delay(350);
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

  if (res.status === 204) return '';

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
  } catch {
    // If not JSON, return as is
  }
  return content;
}

async function apiSend(method, path, body) {
  await delay(350);
  const headers = { ...authHeaders };
  const opts = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// 3. Names, trees, Gherkin
// ---------------------------------------------------------------------------

function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
}

function normalizeGherkin(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

function parseScenarioNames(gherkin) {
  const names = [];
  for (const line of String(gherkin ?? '').split('\n')) {
    const m = line.trim().match(/^(Scenario(?: Outline)?):\s*(.+)$/i);
    if (m) names.push(m[2].trim());
  }
  return names;
}

function parentPath(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function pathDepth(p) {
  return p.split('/').filter(Boolean).length;
}

function sortByDepthAsc(paths) {
  return [...paths].sort(
    (a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b)
  );
}

function sortByDepthDesc(paths) {
  return [...paths].sort(
    (a, b) => pathDepth(b) - pathDepth(a) || a.localeCompare(b)
  );
}

function buildTree(folders) {
  const byId = new Map();
  for (const f of folders) byId.set(String(f.id), f);

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

/**
 * If Studio wraps the suite under a scenarios-root folder that export/local
 * trees do not include as a path prefix, strip that prefix for matching.
 */
function stripScenariosRootPrefix(foldersWithPaths, rootId, localPaths) {
  if (!rootId) return foldersWithPaths;
  const root = foldersWithPaths.find((f) => String(f.id) === String(rootId));
  if (!root || !root.path) return foldersWithPaths;
  const prefix = `${root.path}/`;
  const others = foldersWithPaths.filter((f) => String(f.id) !== String(rootId));
  if (others.length === 0) return foldersWithPaths;
  const allPrefixed = others.every((f) => f.path.startsWith(prefix));
  const localHasPrefix = [...localPaths].some(
    (p) => p === root.path || p.startsWith(prefix)
  );
  if (!allPrefixed || localHasPrefix) return foldersWithPaths;
  return foldersWithPaths.map((f) => {
    if (String(f.id) === String(rootId)) return f;
    if (f.path.startsWith(prefix)) return { ...f, path: f.path.slice(prefix.length) };
    return f;
  });
}

// ---------------------------------------------------------------------------
// 4. Scan local ./upload tree
// ---------------------------------------------------------------------------

function countFeatureFiles(dir) {
  let count = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) count += countFeatureFiles(abs);
    else if (e.isFile() && e.name.endsWith('.feature')) count += 1;
  }
  return count;
}

/**
 * Each directory is a CucumberStudio folder. Gherkin comes from
 * `{folderName}.feature` inside it. Extra `.feature` files whose stem is not
 * the parent folder name become additional child folders.
 *
 * @returns {Map<string, { path: string, name: string, featureText: string }>}
 */
function scanLocalTree(rootDir) {
  const nodes = new Map();

  function walk(absDir, relativePath, folderName) {
    const entries = readdirSync(absDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    const files = entries.filter((e) => e.isFile());

    if (relativePath) {
      const expected = `${folderName}.feature`;
      const expectedSanitized = `${sanitizeName(folderName)}.feature`;
      const matching = files.find(
        (f) => f.name === expected || f.name === expectedSanitized
      );
      const featureText = matching
        ? readFileSync(join(absDir, matching.name), 'utf-8')
        : `Feature: ${folderName}\n`;
      nodes.set(relativePath, {
        path: relativePath,
        name: folderName,
        featureText,
      });
    }

    for (const f of files) {
      if (!f.name.endsWith('.feature')) continue;
      const stem = f.name.slice(0, -'.feature'.length);
      if (
        relativePath &&
        (stem === folderName || stem === sanitizeName(folderName))
      ) {
        continue;
      }
      const childPath = relativePath
        ? `${relativePath}/${sanitizeName(stem)}`
        : sanitizeName(stem);
      nodes.set(childPath, {
        path: childPath,
        name: stem,
        featureText: readFileSync(join(absDir, f.name), 'utf-8'),
      });
    }

    for (const d of dirs) {
      const childRel = relativePath
        ? `${relativePath}/${sanitizeName(d.name)}`
        : sanitizeName(d.name);
      walk(join(absDir, d.name), childRel, d.name);
    }
  }

  walk(rootDir, '', '');
  return nodes;
}

// ---------------------------------------------------------------------------
// 5. Remote folders + scenarios-root
// ---------------------------------------------------------------------------

async function fetchAllFolders() {
  console.log('\n📂  Fetching folder list…');
  const json = await apiGet(`/projects/${PROJECT_ID}/folders`);
  const folders = (json.data || []).map((f) => ({
    id: f.id,
    name: f.attributes.name,
    parentId: f.attributes['parent-id'],
  }));
  console.log(`   Found ${folders.length} folders`);
  return folders;
}

async function fetchScenariosRootId() {
  try {
    const json = await apiGet(`/projects/${PROJECT_ID}?include=scenarios-folder`);
    const rel =
      json?.data?.relationships?.['scenarios-folder']?.data ??
      json?.data?.relationships?.['scenarios_folder']?.data;
    if (rel?.id) return String(rel.id);
    const included = json?.included || [];
    const folder = included.find((i) => i.type === 'folders');
    if (folder?.id) return String(folder.id);
  } catch (err) {
    console.warn(`   ⚠️   Could not resolve scenarios-folder: ${err.message}`);
  }
  return null;
}

async function fetchFolderScenarios(folderId) {
  const json = await apiGet(
    `/projects/${PROJECT_ID}/folders/${folderId}/scenarios`
  );
  return (json.data || []).map((s) => s.attributes?.name).filter(Boolean);
}

async function waitForImport(folderId) {
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const json = await apiGet(`/projects/${PROJECT_ID}/folders/${folderId}`);
    const running =
      json?.data?.attributes?.['running-feature-imports'] ||
      json?.data?.attributes?.['running_feature_imports'] ||
      [];
    if (!Array.isArray(running) || running.length === 0) return;
  }
  throw new Error(`Import still running after ${IMPORT_TIMEOUT_MS / 1000}s (folder ${folderId})`);
}

function featurePayload(featureText) {
  return { data: { attributes: { feature: featureText } } };
}

// ---------------------------------------------------------------------------
// 6. Diff
// ---------------------------------------------------------------------------

async function buildPlan(localByPath, remoteByPath) {
  const creates = [];
  const updates = [];
  const skips = [];
  const deletes = [];

  for (const path of sortByDepthAsc([...localByPath.keys()])) {
    const local = localByPath.get(path);
    const remote = remoteByPath.get(path);
    if (!remote) {
      creates.push({ path, name: local.name });
      continue;
    }
    try {
      const remoteFeature = await apiGetText(
        `/projects/${PROJECT_ID}/folders/${remote.id}/feature`
      );
      if (normalizeGherkin(local.featureText) === normalizeGherkin(remoteFeature)) {
        skips.push({ path, id: remote.id });
      } else {
        updates.push({ path, id: remote.id, name: local.name });
      }
    } catch (err) {
      // Folder may not support feature download yet — treat as update.
      updates.push({ path, id: remote.id, name: local.name, note: err.message });
    }
  }

  for (const [path, remote] of remoteByPath) {
    if (!localByPath.has(path)) {
      deletes.push({ path, id: remote.id, name: remote.name });
    }
  }

  deletes.sort((a, b) => pathDepth(b.path) - pathDepth(a.path) || a.path.localeCompare(b.path));

  return { creates, updates, skips, deletes };
}

function extraSubtreeRoots(deletes) {
  const extraPaths = new Set(deletes.map((d) => d.path));
  return deletes.filter((d) => {
    const parent = parentPath(d.path);
    return !parent || !extraPaths.has(parent);
  });
}

function printPlan(plan) {
  console.log('\n🗂️   Planned operations:\n');

  if (plan.creates.length) {
    console.log(`   CREATE (${plan.creates.length})`);
    for (const c of plan.creates) console.log(`      + ${c.path}`);
  }
  if (plan.updates.length) {
    console.log(`   UPDATE (${plan.updates.length})`);
    for (const u of plan.updates) console.log(`      ~ ${u.path}`);
  }
  if (plan.skips.length) {
    console.log(`   SKIP same Gherkin (${plan.skips.length})`);
    for (const s of plan.skips) console.log(`      = ${s.path}`);
  }
  if (plan.deletes.length) {
    console.log(`   DELETE (${plan.deletes.length})  — extra remote folders`);
    for (const d of plan.deletes) console.log(`      - ${d.path} (id: ${d.id})`);
  }
  if (
    !plan.creates.length &&
    !plan.updates.length &&
    !plan.deletes.length
  ) {
    console.log('   (no changes — remote already matches ./upload)');
  }
}

async function confirmDeletes(plan) {
  if (!plan.deletes.length) return true;
  console.log(
    `\n⚠️   ${plan.deletes.length} remote folder(s) will be permanently deleted (including children and scenarios).`
  );
  console.log('    Type yes to continue.');
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('    Confirm: ');
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// 7. Apply
// ---------------------------------------------------------------------------

async function createFolder(name, parentId) {
  const attributes = { name };
  if (parentId != null && parentId !== '') attributes['parent-id'] = parentId;
  const json = await apiSend('POST', `/projects/${PROJECT_ID}/folders`, {
    data: { attributes },
  });
  const id = json?.data?.id;
  if (!id) throw new Error(`Create folder "${name}" returned no id`);
  return String(id);
}

async function importNew(folderId, featureText) {
  await apiSend(
    'POST',
    `/projects/${PROJECT_ID}/folders/${folderId}/create_from_feature`,
    featurePayload(featureText)
  );
  await waitForImport(folderId);
}

async function importUpdate(folderId, featureText) {
  await apiSend(
    'PATCH',
    `/projects/${PROJECT_ID}/folders/${folderId}/update_from_feature`,
    featurePayload(featureText)
  );
  await waitForImport(folderId);
}

async function wipeAndImport(folderId, featureText) {
  await apiSend(
    'DELETE',
    `/projects/${PROJECT_ID}/folders/${folderId}/scenarios`
  );
  await importNew(folderId, featureText);
}

async function remoteHasExtraScenarios(folderId, localFeatureText) {
  const localNames = new Set(parseScenarioNames(localFeatureText));
  let remoteNames = [];
  try {
    remoteNames = await fetchFolderScenarios(folderId);
  } catch {
    return false;
  }
  return remoteNames.some((n) => !localNames.has(n));
}

async function applyPlan(plan, localByPath, remoteByPath, scenariosRootId) {
  const stats = {
    created: 0,
    updated: 0,
    skipped: plan.skips.length,
    deleted: 0,
    wiped: 0,
    errors: 0,
  };

  const idByPath = new Map();
  for (const [path, remote] of remoteByPath) {
    idByPath.set(path, String(remote.id));
  }

  function resolveParentId(path) {
    const parent = parentPath(path);
    if (!parent) return scenariosRootId;
    return idByPath.get(parent) ?? null;
  }

  for (const c of plan.creates) {
    const local = localByPath.get(c.path);
    try {
      const parentId = resolveParentId(c.path);
      if (parentPath(c.path) && !parentId) {
        throw new Error(`Parent folder not found for ${c.path}`);
      }
      console.log(`   ➕  Creating ${c.path}`);
      const id = await createFolder(local.name, parentId);
      idByPath.set(c.path, id);
      await importNew(id, local.featureText);
      stats.created++;
      console.log(`      ✅  ${c.path} (id: ${id})`);
    } catch (err) {
      stats.errors++;
      console.error(`      ❌  ${c.path}: ${err.message}`);
    }
  }

  for (const u of plan.updates) {
    const local = localByPath.get(u.path);
    const folderId = u.id || idByPath.get(u.path);
    try {
      console.log(`   📝  Updating ${u.path}`);
      await importUpdate(folderId, local.featureText);
      if (await remoteHasExtraScenarios(folderId, local.featureText)) {
        console.log(`      🧹  Extra scenarios — wiping then re-importing`);
        await wipeAndImport(folderId, local.featureText);
        stats.wiped++;
      }
      stats.updated++;
      console.log(`      ✅  ${u.path}`);
    } catch (err) {
      stats.errors++;
      console.error(`      ❌  ${u.path}: ${err.message}`);
    }
  }

  for (const s of plan.skips) {
    const local = localByPath.get(s.path);
    try {
      if (await remoteHasExtraScenarios(s.id, local.featureText)) {
        console.log(`   🧹  Extra scenarios on otherwise-same ${s.path} — wiping then re-importing`);
        await wipeAndImport(s.id, local.featureText);
        stats.wiped++;
        stats.updated++;
        stats.skipped--;
      }
    } catch (err) {
      stats.errors++;
      console.error(`      ❌  ${s.path}: ${err.message}`);
    }
  }

  const deleteRoots = extraSubtreeRoots(plan.deletes);
  for (const d of sortByDepthDesc(deleteRoots.map((x) => x.path))) {
    const item = deleteRoots.find((x) => x.path === d);
    try {
      console.log(`   🗑️   Deleting ${item.path} (id: ${item.id})`);
      await apiSend(
        'DELETE',
        `/projects/${PROJECT_ID}/folders/${item.id}`
      );
      stats.deleted++;
      const descendants = plan.deletes.filter(
        (x) => x.path === item.path || x.path.startsWith(`${item.path}/`)
      ).length;
      console.log(
        `      ✅  ${item.path}${descendants > 1 ? ` (+${descendants - 1} children)` : ''}`
      );
    } catch (err) {
      stats.errors++;
      console.error(`      ❌  ${item.path}: ${err.message}`);
    }
  }

  return stats;
}

function printSummary(stats, apply) {
  const verb = apply ? 'Done' : 'Dry-run';
  console.log(
    `\n📊  ${verb}! Created: ${stats.created}, Updated: ${stats.updated}, ` +
      `Skipped: ${stats.skipped}, Deleted: ${stats.deleted}, ` +
      `Wiped-scenarios: ${stats.wiped}, Errors: ${stats.errors}`
  );
  if (!apply) {
    console.log('   Re-run with --apply to write these changes to CucumberStudio.');
  }
}

// ---------------------------------------------------------------------------
// 8. Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🚀  CucumberStudio Feature Uploader\n');

  if (!existsSync(UPLOAD_DIR) || !statSync(UPLOAD_DIR).isDirectory()) {
    console.error(
      `❌  Source folder not found: ${UPLOAD_DIR}\n` +
        `    Copy your feature tree into ./upload (or pass --dir) and try again.`
    );
    process.exit(1);
  }

  const featureCount = countFeatureFiles(UPLOAD_DIR);
  if (featureCount === 0) {
    console.error(
      `❌  No .feature files under ${UPLOAD_DIR}.\n` +
        `    Copy the suite into ./upload first. Refusing to continue so the remote project is not wiped.`
    );
    process.exit(1);
  }

  const localByPath = scanLocalTree(UPLOAD_DIR);
  console.log(
    `📄  Local tree: ${localByPath.size} folder(s), ${featureCount} .feature file(s)`
  );
  for (const path of sortByDepthAsc([...localByPath.keys()])) {
    const depth = pathDepth(path) - 1;
    const node = localByPath.get(path);
    console.log(`   ${'  '.repeat(Math.max(0, depth))}├── ${node.name}`);
  }

  await authenticate();
  const scenariosRootId = await fetchScenariosRootId();
  if (scenariosRootId) {
    console.log(`   Scenarios root folder id: ${scenariosRootId}`);
  }

  const folders = await fetchAllFolders();
  let foldersWithPaths = buildTree(folders);
  foldersWithPaths = stripScenariosRootPrefix(
    foldersWithPaths,
    scenariosRootId,
    localByPath.keys()
  );

  const remoteByPath = new Map();
  for (const f of foldersWithPaths) {
    if (scenariosRootId && String(f.id) === String(scenariosRootId)) continue;
    if (!f.path) continue;
    remoteByPath.set(f.path, f);
  }

  console.log('\n⏳  Comparing local Gherkin with remote features…');
  const plan = await buildPlan(localByPath, remoteByPath);
  printPlan(plan);

  if (!CLI.apply) {
    printSummary(
      {
        created: plan.creates.length,
        updated: plan.updates.length,
        skipped: plan.skips.length,
        deleted: plan.deletes.length,
        wiped: 0,
        errors: 0,
      },
      false
    );
    return;
  }

  if (plan.deletes.length && !CLI.yes) {
    const ok = await confirmDeletes(plan);
    if (!ok) {
      console.log('\n🚫  Aborted. No changes were written.');
      process.exit(1);
    }
  }

  console.log('\n⬆️   Applying mirror…\n');
  const stats = await applyPlan(
    plan,
    localByPath,
    remoteByPath,
    scenariosRootId
  );
  printSummary(stats, true);
}

main().catch((err) => {
  console.error('\n💥  Fatal error:', err.message);
  process.exit(1);
});
