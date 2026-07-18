import { joinCandidatesWithState } from './import-state.mjs';

export const IMPORT_APPROVAL_POLICY = Object.freeze({
  V2_AUTO_APPROVE: 'v2-auto-approve',
});

const SUPPORTED_POLICIES = new Set(Object.values(IMPORT_APPROVAL_POLICY));

export function normalizeImportApprovalPolicy(value) {
  if (value == null || value === '') return null;
  const policy = String(value);
  if (!SUPPORTED_POLICIES.has(policy)) {
    throw new Error(`unsupported import approval policy: ${policy}`);
  }
  return policy;
}

/**
 * Approval model v2 is an explicit CLI-only view over a sealed candidate
 * document. It never writes the workbook and never changes candidate evidence.
 * Rejoining against state deliberately invalidates an older pending/manual
 * decision digest before any verification can be reused.
 */
export function candidatesForImportPolicy(candidates, state, policy) {
  const normalized = normalizeImportApprovalPolicy(policy);
  if (normalized === null) return candidates;
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');

  const approved = candidates.map((candidate) => ({
    ...candidate,
    sourceHumanDecision: '批准',
    humanDecision: '批准',
    workbookEvidenceStale: false,
    approvalStale: false,
    approvalPolicy: normalized,
    humanDecisionSource: `policy:${normalized}`,
  }));
  return joinCandidatesWithState(approved, state);
}
