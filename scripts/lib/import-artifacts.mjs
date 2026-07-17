import fs from 'node:fs';
import path from 'node:path';
import { STEAM_REGIONS } from './steam.mjs';
import { ESHOP_REGIONS } from './eshop.mjs';
import { fileSha256 } from './import-run.mjs';
import { normTitle, titleMatches } from './match.mjs';

function readJson(root, rel) {
  const absolute = path.join(root, rel);
  if (!fs.existsSync(absolute)) throw new Error(`missing required import artifact ${rel}`);
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`invalid JSON import artifact ${rel}: ${error.message}`);
  }
}

function requiredCoverage(actual, expected, label, minimumRatio) {
  const minimum = Math.ceil(expected * minimumRatio);
  if (actual < minimum) throw new Error(`${label}: coverage ${actual}/${expected} below import minimum ${minimum}/${expected}`);
}

function validateSnapshot(snapshot, { slug, label, expectedCcs, requireUs, minimumRatio }) {
  if (snapshot.slug !== slug) throw new Error(`${label}: slug ${snapshot.slug} does not match ${slug}`);
  if (!Array.isArray(snapshot.regions) || snapshot.regions.length === 0) throw new Error(`${label}: no regions`);
  const rows = new Map(snapshot.regions.map((row) => [String(row.cc).toUpperCase(), row]));
  if (rows.size !== snapshot.regions.length) throw new Error(`${label}: duplicate regions`);
  const covered = expectedCcs.filter((cc) => rows.has(cc)).length;
  requiredCoverage(covered, expectedCcs.length, label, minimumRatio);
  if (requireUs) {
    const us = rows.get('US');
    if (!us || us.currency !== 'USD' || !(us.amount > 0)) throw new Error(`${label}: missing native US/USD paid observation`);
  }
}

export function validateImportArtifacts(root, plan, { minimumCoverageRatio = 0.8 } = {}) {
  if (!(minimumCoverageRatio > 0 && minimumCoverageRatio <= 1)) throw new Error('bad minimumCoverageRatio');
  const catalog = readJson(root, 'data/catalog.json');
  const bySlug = new Map(catalog.games.map((game) => [game.slug, game]));
  const files = new Set(['data/catalog.json']);
  const items = [];

  for (const item of plan.items) {
    const game = bySlug.get(item.slug);
    if (!game) throw new Error(`${item.key}: catalog entry ${item.slug} missing after staging`);
    if (!normTitle(game.title) || normTitle(game.title) !== normTitle(item.title)) {
      throw new Error(`${item.key}: staged catalog title drifted`);
    }
    if (Number.isInteger(item.steamAppId) && game.steamAppId !== item.steamAppId) throw new Error(`${item.key}: staged Steam mapping drifted`);
    for (const [group, nsuid] of Object.entries(item.nsuids ?? {}).filter(([, value]) => value)) {
      if (String(game.nsuids?.[group]) !== String(nsuid)) throw new Error(`${item.key}: staged ${group} NSUID drifted`);
    }
    if (item.nintendoUsSlug && game.nintendoUsSlug !== item.nintendoUsSlug) {
      throw new Error(`${item.key}: staged Nintendo US product slug drifted`);
    }
    if (item.nsuids && Object.values(item.nsuids).some(Boolean)) {
      const expectedGeneration = item.platforms?.filter((platform) => platform === 'switch' || platform === 'switch-2');
      const actualGeneration = game.platforms?.filter((platform) => platform === 'switch' || platform === 'switch-2');
      if (expectedGeneration?.length !== 1 || actualGeneration?.length !== 1 || expectedGeneration[0] !== actualGeneration[0]) {
        throw new Error(`${item.key}: staged Nintendo platform generation drifted`);
      }
    }

    const channels = [];
    if (Number.isInteger(item.steamAppId)) {
      const rel = `data/snapshots/steam/${item.slug}.json`;
      const snapshot = readJson(root, rel);
      validateSnapshot(snapshot, {
        slug: item.slug,
        label: rel,
        expectedCcs: STEAM_REGIONS.map((cc) => cc.toUpperCase()),
        requireUs: true,
        minimumRatio: minimumCoverageRatio,
      });
      files.add(rel);
      channels.push('steam');
    }

    if (item.nsuids && Object.values(item.nsuids).some(Boolean)) {
      const rel = `data/snapshots/eshop/${item.slug}.json`;
      const snapshot = readJson(root, rel);
      const expectedCcs = ESHOP_REGIONS
        .filter(({ group }) => item.nsuids?.[group])
        .map(({ cc }) => cc.toUpperCase());
      validateSnapshot(snapshot, {
        slug: item.slug,
        label: rel,
        expectedCcs,
        requireUs: Boolean(item.nsuids.americas),
        minimumRatio: minimumCoverageRatio,
      });
      files.add(rel);
      if (item.nsuids.americas) channels.push('eshop');
    }

    const metaRel = `data/meta/${item.slug}.json`;
    const meta = readJson(root, metaRel);
    if (meta.slug !== item.slug || !(typeof meta.name === 'string' && titleMatches(meta.name, item.title)) || !(typeof meta.headerImage === 'string' && /^https:\/\//.test(meta.headerImage))) {
      throw new Error(`${metaRel}: incomplete reviewed metadata`);
    }
    files.add(metaRel);

    const historyRel = `data/history/${item.slug}.json`;
    const history = readJson(root, historyRel);
    if (history.slug !== item.slug || !Array.isArray(history.events)) throw new Error(`${historyRel}: malformed history`);
    for (const channel of channels) {
      if (!history.events.some((event) => event.ch === channel && event.cc === 'US' && event.usd > 0)) {
        throw new Error(`${historyRel}: missing first ${channel} US observation event`);
      }
    }
    files.add(historyRel);
    items.push({ key: item.key, slug: item.slug, channels });
  }

  return {
    checkedAt: new Date().toISOString(),
    minimumCoverageRatio,
    items,
    files: Object.fromEntries([...files].sort().map((rel) => [rel, fileSha256(path.join(root, rel))])),
  };
}
