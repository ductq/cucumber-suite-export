#!/usr/bin/env node

/**
 * Pretty-print minified JSON without parsing numbers (keeps large IDs intact).
 *
 * Usage:
 *   node scripts/beautify-json.mjs
 *   node scripts/beautify-json.mjs --dry-run
 *   node scripts/beautify-json.mjs artifacts/json/json.md artifacts/json/result.md
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const DRY_RUN = process.argv.includes('--dry-run');
const POSITIONAL = process.argv.slice(2).filter((arg) => arg !== '--dry-run');

const INPUT = resolve(ROOT, POSITIONAL[0] || 'artifacts/json/json.md');
const OUTPUT = resolve(ROOT, POSITIONAL[1] || 'artifacts/json/result.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function stripMarkdownFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;

  const opened = trimmed.match(/^```(?:json)?[ \t]*\r?\n?/i);
  if (!opened) fail('Invalid markdown fence.');

  let body = trimmed.slice(opened[0].length);
  const close = body.match(/\r?\n?```[ \t]*$/);
  if (!close) fail('Unclosed markdown fence.');
  body = body.slice(0, body.length - close[0].length);
  return body.trim();
}

function compactJson(source) {
  let out = '';
  let inString = false;
  let escape = false;

  for (const char of source) {
    if (inString) {
      out += char;
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') continue;
    out += char;
  }

  if (inString) fail('Unterminated string.');
  return out;
}

function validateCompact(compact) {
  if (!compact) fail('Empty JSON.');
  if (compact[0] !== '{' && compact[0] !== '[') {
    fail('JSON must start with { or [.');
  }

  const stack = [];
  let inString = false;
  let escape = false;
  let rootEnd = -1;

  for (let i = 0; i < compact.length; i++) {
    const char = compact[i];

    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      stack.push('}');
      continue;
    }
    if (char === '[') {
      stack.push(']');
      continue;
    }
    if (char === '}' || char === ']') {
      if (stack.pop() !== char) fail('Mismatched braces or brackets.');
      if (stack.length === 0) {
        rootEnd = i;
        break;
      }
    }
  }

  if (inString) fail('Unterminated string.');
  if (stack.length !== 0) fail('Unbalanced braces or brackets.');
  if (rootEnd === -1) fail('JSON value did not close.');
  if (rootEnd !== compact.length - 1) fail('Trailing characters after JSON value.');
}

function prettyPrint(compact) {
  let out = '';
  let indent = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < compact.length; i++) {
    const char = compact[i];

    if (inString) {
      out += char;
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === '{' || char === '[') {
      const closer = char === '{' ? '}' : ']';
      if (compact[i + 1] === closer) {
        out += char + closer;
        i += 1;
        continue;
      }
      indent += 1;
      out += char + '\n' + '  '.repeat(indent);
      continue;
    }

    if (char === '}' || char === ']') {
      indent -= 1;
      out += '\n' + '  '.repeat(indent) + char;
      continue;
    }

    if (char === ',') {
      out += ',\n' + '  '.repeat(indent);
      continue;
    }

    if (char === ':') {
      out += ': ';
      continue;
    }

    out += char;
  }

  if (inString) fail('Unterminated string.');
  if (indent !== 0) fail('Unbalanced braces or brackets.');
  if (out[0] !== '{' && out[0] !== '[') fail('JSON must start with { or [.');

  return out.endsWith('\n') ? out : `${out}\n`;
}

function main() {
  let raw;
  try {
    raw = readFileSync(INPUT, 'utf8');
  } catch (err) {
    fail(`Cannot read ${INPUT}: ${err.message}`);
  }

  const compact = compactJson(stripMarkdownFence(raw));
  validateCompact(compact);
  const pretty = prettyPrint(compact);

  if (DRY_RUN) {
    process.stdout.write(pretty);
    return;
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, pretty, 'utf8');
  console.log(`Wrote ${OUTPUT}`);
}

main();
