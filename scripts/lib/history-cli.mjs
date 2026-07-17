/** Pure CLI parsing for build-history; flags must never become slug filters. */
export function parseHistoryArgs(args) {
  let observationsOnly = false;
  let maxLookups = 150;
  const onlySlugs = [];

  for (const arg of args) {
    if (arg === '--observations-only') {
      observationsOnly = true;
      continue;
    }
    if (arg.startsWith('--max-lookups=')) {
      maxLookups = Number(arg.slice('--max-lookups='.length));
      if (!(Number.isInteger(maxLookups) && maxLookups >= 0)) {
        throw new Error(`bad --max-lookups value: ${arg}`);
      }
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    onlySlugs.push(arg);
  }

  return { observationsOnly, maxLookups, onlySlugs };
}
