#!/usr/bin/env node
/**
 * Reserve one scheduled PSN job's complete 60-request UTC-day allowance.
 *
 * This command performs no network I/O. Workflows must commit and push the
 * tracked ledger it writes before invoking a scraper. The private lease path,
 * owner and purpose are bound through explicit job environment variables and
 * are re-checked before every physical storefront request.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PSN_US_PAGE_DAILY_LIMIT,
  psnUsRunLeaseConfig,
  reservePsnUsRunBudget,
} from './lib/psn-request-budget.mjs';

const USAGE = 'Usage: node scripts/reserve-psn-run-budget.mjs --purpose=calendar|price';

export function parseReservePsnRunBudgetArgs(argv, env = process.env) {
  if (!Array.isArray(argv) || argv.length !== 1) throw new Error(USAGE);
  const match = String(argv[0]).match(/^--purpose=(calendar|price)$/u);
  if (!match) throw new Error(USAGE);
  if (env.PSN_AUTOMATION_AUTHORIZED !== 'true') {
    throw new Error('PSN run-budget reservation requires PSN_AUTOMATION_AUTHORIZED=true');
  }
  const config = psnUsRunLeaseConfig(env, { required: true });
  if (config.purpose !== match[1]) {
    throw new Error(`PSN run-budget purpose mismatch: CLI=${match[1]} env=${config.purpose}`);
  }
  return config;
}

export function reserveScheduledPsnRun({ argv = process.argv.slice(2), env = process.env } = {}) {
  const config = parseReservePsnRunBudgetArgs(argv, env);
  return reservePsnUsRunBudget({
    ...config,
    requests: PSN_US_PAGE_DAILY_LIMIT,
  });
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const reservation = reserveScheduledPsnRun();
    console.log(`Reserved PSN ${reservation.lease.purpose} run ${reservation.lease.leaseId}: ${reservation.reserved}/${PSN_US_PAGE_DAILY_LIMIT} requests for ${reservation.day}`);
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 2;
  }
}
