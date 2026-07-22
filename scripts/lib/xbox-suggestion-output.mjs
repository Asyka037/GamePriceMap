import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const XBOX_SUGGESTION_PATH = path.join(ROOT, 'data', 'suggestions', 'xbox-candidates.json');

/** Atomically replace the one permitted Xbox suggestion artifact. */
export function writeXboxSuggestionDocument(document, { root = ROOT } = {}) {
  const resolvedRoot = path.resolve(root);
  const output = path.join(resolvedRoot, 'data', 'suggestions', 'xbox-candidates.json');
  const payload = `${JSON.stringify(document, null, 2)}\n`;
  for (const directory of [path.join(resolvedRoot, 'data'), path.dirname(output)]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Xbox suggestion output directory is unsafe');
    }
  }
  let destination = null;
  try { destination = fs.lstatSync(output); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (destination && (!destination.isFile() || destination.isSymbolicLink())) {
    throw new Error('Xbox suggestion output must be a regular file');
  }

  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, payload);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, output);
    const directory = fs.openSync(path.dirname(output), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return output;
}
