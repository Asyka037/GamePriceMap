import { normTitle } from './match.mjs';

const ALLOWED_PLATFORMS = new Set(['pc', 'ps4', 'ps5', 'xbox', 'switch', 'switch-2', 'mobile']);
const NSUID_GROUPS = ['americas', 'europe', 'japan'];

function hasNsuid(nsuids) {
  return nsuids && NSUID_GROUPS.some((group) => Boolean(nsuids[group]));
}

function assertBaseNsuid(value, label) {
  if (value != null && !/^7001\d{10}$/.test(String(value))) throw new Error(`${label}: malformed base NSUID ${value}`);
}

export function validateCatalogGame(game) {
  const label = `catalog ${game?.slug ?? '<unknown>'}`;
  if (!game || typeof game !== 'object' || Array.isArray(game)) throw new Error('catalog game must be an object');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(game.slug ?? '')) throw new Error(`${label}: bad slug`);
  if (!(typeof game.title === 'string' && game.title.trim())) throw new Error(`${label}: missing title`);
  if (game.steamAppId !== null && game.steamAppId !== undefined && !(Number.isInteger(game.steamAppId) && game.steamAppId > 0)) {
    throw new Error(`${label}: bad steamAppId`);
  }
  if (!Array.isArray(game.platforms) || game.platforms.length === 0 || game.platforms.some((platform) => !ALLOWED_PLATFORMS.has(platform))) {
    throw new Error(`${label}: bad platforms`);
  }
  if (new Set(game.platforms).size !== game.platforms.length) throw new Error(`${label}: duplicate platforms`);
  if (Number.isInteger(game.steamAppId) && !game.platforms.includes('pc')) throw new Error(`${label}: Steam mapping requires pc platform`);
  if (game.nsuids != null) {
    if (typeof game.nsuids !== 'object' || Array.isArray(game.nsuids)) throw new Error(`${label}: bad nsuids object`);
    for (const group of Object.keys(game.nsuids)) {
      if (!NSUID_GROUPS.includes(group)) throw new Error(`${label}: unknown NSUID group ${group}`);
      assertBaseNsuid(game.nsuids[group], `${label} ${group}`);
    }
  }
  if (hasNsuid(game.nsuids) && !game.platforms.some((platform) => platform === 'switch' || platform === 'switch-2')) {
    throw new Error(`${label}: Nintendo mapping requires a Switch platform`);
  }
  if (!Number.isInteger(game.steamAppId) && !hasNsuid(game.nsuids)) throw new Error(`${label}: no supported store mapping`);
  if (!Number.isInteger(game.steamAppId) && !(game.nsuids?.americas && game.nintendoUsSlug)) {
    throw new Error(`${label}: Nintendo-only metadata requires Americas NSUID and reviewed US product slug`);
  }
  if (game.nintendoUsSlug != null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(game.nintendoUsSlug)) {
    throw new Error(`${label}: bad nintendoUsSlug`);
  }
  if (game.nintendoUsSlug && !game.nsuids?.americas) throw new Error(`${label}: nintendoUsSlug requires Americas NSUID`);
  if (!['core', 'extended'].includes(game.tier)) throw new Error(`${label}: bad tier`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(game.addedAt ?? '') || Number.isNaN(Date.parse(`${game.addedAt}T00:00:00Z`))) {
    throw new Error(`${label}: bad addedAt`);
  }
  if (game.primaryRegionalChannel != null && !['steam', 'eshop'].includes(game.primaryRegionalChannel)) {
    throw new Error(`${label}: bad primaryRegionalChannel`);
  }
  return game;
}

export function catalogIndexes(catalog) {
  if (!catalog || !Array.isArray(catalog.games)) throw new Error('catalog.games must be an array');
  const bySlug = new Map();
  const bySteamAppId = new Map();
  const byNsuid = new Map();
  for (const game of catalog.games) {
    validateCatalogGame(game);
    if (bySlug.has(game.slug)) throw new Error(`duplicate catalog slug ${game.slug}`);
    bySlug.set(game.slug, game);
    if (Number.isInteger(game.steamAppId)) {
      if (bySteamAppId.has(game.steamAppId)) throw new Error(`duplicate Steam AppID ${game.steamAppId}`);
      bySteamAppId.set(game.steamAppId, game.slug);
    }
    for (const id of Object.values(game.nsuids ?? {}).filter(Boolean).map(String)) {
      if (byNsuid.has(id)) throw new Error(`duplicate Nintendo NSUID ${id}`);
      byNsuid.set(id, game.slug);
    }
  }
  return { bySlug, bySteamAppId, byNsuid };
}

function itemFields(item, addedAt) {
  const game = {
    slug: item.slug,
    title: item.title.trim(),
  };
  if (item.nintendoUsSlug) game.nintendoUsSlug = item.nintendoUsSlug;
  game.steamAppId = Number.isInteger(item.steamAppId) ? item.steamAppId : null;
  game.nsuids = hasNsuid(item.nsuids)
    ? Object.fromEntries(NSUID_GROUPS.filter((group) => item.nsuids?.[group]).map((group) => [group, String(item.nsuids[group])]))
    : null;
  game.platforms = [...new Set(item.platforms)];
  game.tier = 'extended';
  game.addedAt = addedAt;
  if (item.primaryRegionalChannel) game.primaryRegionalChannel = item.primaryRegionalChannel;
  return game;
}

export function applyBatchToCatalog(catalog, plan) {
  const next = structuredClone(catalog);
  const indexes = catalogIndexes(next);

  for (const item of plan.items) {
    const steamOwner = Number.isInteger(item.steamAppId) ? indexes.bySteamAppId.get(item.steamAppId) : null;
    const nsuidOwners = [...new Set(Object.values(item.nsuids ?? {}).filter(Boolean).map(String).map((id) => indexes.byNsuid.get(id)).filter(Boolean))];
    if (steamOwner && steamOwner !== item.slug) throw new Error(`${item.key}: Steam AppID already belongs to ${steamOwner}`);
    if (nsuidOwners.some((owner) => owner !== item.slug)) throw new Error(`${item.key}: NSUID already belongs to ${nsuidOwners.join(', ')}`);

    if (item.catalogAction === 'new_game') {
      if (indexes.bySlug.has(item.slug)) throw new Error(`${item.key}: slug already exists`);
      const game = itemFields(item, plan.addedAt);
      validateCatalogGame(game);
      next.games.push(game);
    } else if (item.catalogAction === 'add_platform_mapping') {
      const existing = indexes.bySlug.get(item.slug);
      if (!existing) throw new Error(`${item.key}: mapping target slug does not exist`);
      if (!normTitle(item.title) || normTitle(item.title) !== normTitle(existing.title)) {
        throw new Error(`${item.key}: title does not exactly match mapping target ${existing.title}`);
      }
      if (Number.isInteger(item.steamAppId) && existing.steamAppId != null && existing.steamAppId !== item.steamAppId) {
        throw new Error(`${item.key}: refuses to replace existing Steam AppID`);
      }
      for (const [group, id] of Object.entries(item.nsuids ?? {}).filter(([, value]) => value)) {
        if (existing.nsuids?.[group] && String(existing.nsuids[group]) !== String(id)) {
          throw new Error(`${item.key}: refuses to replace existing ${group} NSUID`);
        }
      }
      if (item.nintendoUsSlug && existing.nintendoUsSlug && existing.nintendoUsSlug !== item.nintendoUsSlug) {
        throw new Error(`${item.key}: refuses to replace existing Nintendo US product slug`);
      }
      const incomingNintendoPlatforms = item.platforms.filter((platform) => platform === 'switch' || platform === 'switch-2');
      const existingNintendoPlatforms = existing.platforms.filter((platform) => platform === 'switch' || platform === 'switch-2');
      if (hasNsuid(item.nsuids) && existingNintendoPlatforms.length > 0) {
        if (existingNintendoPlatforms.length !== 1 || incomingNintendoPlatforms[0] !== existingNintendoPlatforms[0]) {
          throw new Error(`${item.key}: Nintendo platform generation conflicts with the existing logical game`);
        }
      }
      existing.steamAppId ??= Number.isInteger(item.steamAppId) ? item.steamAppId : null;
      if (hasNsuid(item.nsuids)) existing.nsuids = { ...(existing.nsuids ?? {}), ...itemFields(item, plan.addedAt).nsuids };
      existing.platforms = [...new Set([...existing.platforms, ...item.platforms])];
      if (item.nintendoUsSlug) existing.nintendoUsSlug ??= item.nintendoUsSlug;
      if (item.primaryRegionalChannel) existing.primaryRegionalChannel ??= item.primaryRegionalChannel;
      validateCatalogGame(existing);
    }

    const refreshed = catalogIndexes(next);
    indexes.bySlug = refreshed.bySlug;
    indexes.bySteamAppId = refreshed.bySteamAppId;
    indexes.byNsuid = refreshed.byNsuid;
  }
  return next;
}

export function expectedImportArtifacts(plan) {
  const files = new Set(['data/catalog.json', `data/imports/${plan.batchId}.json`]);
  for (const item of plan.items) {
    if (Number.isInteger(item.steamAppId)) files.add(`data/snapshots/steam/${item.slug}.json`);
    if (hasNsuid(item.nsuids)) files.add(`data/snapshots/eshop/${item.slug}.json`);
    files.add(`data/meta/${item.slug}.json`);
    files.add(`data/history/${item.slug}.json`);
  }
  return [...files].sort();
}

export function importAllowlist(plan) {
  return [
    ...expectedImportArtifacts(plan),
    'data/health.json',
    'data/rates/usd.json',
  ];
}
