// The meeting's transcription call: whichever provider the learner chose for the
// audio (settings.transcribeProvider), with the Phase 1 policy — 30 s timeout,
// two retries on 429/5xx/network with Retry-After, abort after «Terminar», staged
// Spanish errors, redaction — now implemented once for every provider in
// providers.js. session.js receives this function injected.

import { callTranscribe } from './providers.js';

export { redact, parseRetryAfter, retryDelayMs, isRetryableStatus, RETRIES, MAX_WAIT_MS, TIMEOUT_MS } from './providers.js';

export function transcribe(samples, settings, { signal, sleep } = {}) {
  return callTranscribe(settings, samples, { signal, sleep });
}
