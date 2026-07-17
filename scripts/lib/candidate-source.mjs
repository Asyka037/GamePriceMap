import { assertDocumentDigest } from './candidate-evidence.mjs';
import { validateNintendoSuggestionDocument } from './ns-candidates.mjs';
import { validateSteamCandidateDocument } from './steam-candidates.mjs';

/** Only machine-produced candidate document kinds may enter review/import. */
export function validateCandidateSourceDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('candidate source must be a sealed versioned document');
  }
  assertDocumentDigest(document);
  if (!Number.isSafeInteger(document.schemaVersion) || document.schemaVersion < 1) {
    throw new Error('candidate source schemaVersion is invalid');
  }
  if (!Array.isArray(document.candidates)) throw new Error('candidate source is missing candidates');
  if (document.kind === 'steam-candidates') return validateSteamCandidateDocument(document);
  if (document.kind === 'nintendo-discovery-suggestions') return validateNintendoSuggestionDocument(document);
  throw new Error(`unsupported candidate source kind: ${document.kind ?? '<missing>'}`);
}
