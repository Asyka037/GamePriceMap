#!/usr/bin/env node
/**
 * One-way promotion of resumable private appdetails cache entries into the
 * compact, sealed evidence directory used by CI. Source files are read-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createSteamAppDetailsEvidence,
  validateSteamAppDetailsEvidence,
} from './lib/steam-candidates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function promoteSteamAppDetailsEvidence({ sourceDir, outputDir }) {
  if (path.resolve(sourceDir) === path.resolve(outputDir)) throw new Error('source and output directories must differ');
  const names = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d+\.json$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  let written = 0;
  let unchanged = 0;
  for (const name of names) {
    const appId = Number.parseInt(name, 10);
    const source = validateSteamAppDetailsEvidence(
      JSON.parse(fs.readFileSync(path.join(sourceDir, name), 'utf8')),
      { appId },
    );
    const compact = createSteamAppDetailsEvidence({
      appId,
      payload: source.payload,
      sourceUrl: source.sourceUrl,
      fetchedAt: source.fetchedAt,
    });
    const bytes = `${JSON.stringify(compact, null, 2)}\n`;
    const destination = path.join(outputDir, name);
    if (fs.existsSync(destination) && fs.readFileSync(destination, 'utf8') === bytes) {
      unchanged += 1;
      continue;
    }
    atomicWrite(destination, bytes);
    written += 1;
  }
  return { scanned: names.length, written, unchanged };
}

function parseArgs(args) {
  let sourceDir = path.join(ROOT, 'private', 'game-library', 'candidate-cache', 'steam', 'appdetails');
  let outputDir = path.join(ROOT, 'data', 'suggestions', 'evidence', 'steam', 'appdetails');
  for (let index = 0; index < args.length; index += 1) {
    const [flag, inline] = args[index].split('=', 2);
    if (!['--source-dir', '--output-dir'].includes(flag)) throw new Error(`unknown argument: ${args[index]}`);
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--source-dir') sourceDir = path.resolve(value);
    if (flag === '--output-dir') outputDir = path.resolve(value);
  }
  return { sourceDir, outputDir };
}

function main() {
  const result = promoteSteamAppDetailsEvidence(parseArgs(process.argv.slice(2)));
  console.log(`appdetails evidence: scanned=${result.scanned} written=${result.written} unchanged=${result.unchanged}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
