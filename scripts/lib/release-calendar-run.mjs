/**
 * A failed release refresh is fail-soft only when a sealed cache already
 * exists. On first run there is nothing safe to serve, so the CLI must fail
 * visibly instead of turning an absent source into a green workflow.
 */
export function releaseCalendarCliExitCode({ complete, hadPreviousCache }) {
  if (typeof complete !== 'boolean' || typeof hadPreviousCache !== 'boolean') {
    throw new TypeError('release calendar result flags must be booleans');
  }
  return complete || hadPreviousCache ? 0 : 1;
}
