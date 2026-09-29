// Ordering policy for the serial transcription queue.
//
// The live line outranks the archive: a learner follows the conversation with the
// provisional text, and the authoritative turn can land a beat later without
// costing them anything. So previews go ahead of queued real segments — but on a
// budget. One queued preview per speaker bounds how much provisional work can
// wait at once; MAX_PREVIEW_BYPASS bounds how many passes a given real segment
// yields to in total, because with two lanes offering every PREVIEW_EVERY_MS a
// front-of-queue slot refills faster than a slow engine drains it, and "the
// transcript can wait" must never become "the transcript never lands".

// What the other speaker says is urgent for following the conversation; your own
// turns can wait — but not forever. Soft cuts make a monologue produce a 'them'
// segment every few seconds, so an unbounded priority would starve queued 'me'
// turns for as long as the other person keeps talking. Each 'me' segment can be
// overtaken at most MAX_BYPASS times; after that, new 'them' segments queue
// behind it. Order within each voice is never disturbed.
export const MAX_BYPASS = 3;

// How many preview passes may run ahead of one queued real segment. Spent, the
// segment moves ahead of new previews and lands on the next drain.
export const MAX_PREVIEW_BYPASS = 3;

// A queued preview is a snapshot that ages while it waits: replacing it with the
// fresher offer costs nothing, saves a pass over audio the next one covers, and
// charges no segment twice — the slot already paid its way in.
export function insertPreview(queue, seg, maxBypass = MAX_PREVIEW_BYPASS) {
  const entry = { ...seg, preview: true };
  const stale = queue.findIndex((s) => s.preview && s.speaker === seg.speaker);
  if (stale >= 0) {
    queue[stale] = entry;
    return;
  }
  let at = 0;
  while (at < queue.length
    && (queue[at].preview || (queue[at].previewBypassed || 0) >= maxBypass)) at++;
  for (let j = at; j < queue.length; j++) {
    if (!queue[j].preview) queue[j].previewBypassed = (queue[j].previewBypassed || 0) + 1;
  }
  queue.splice(at, 0, entry);
}

export function insertReal(queue, seg, maxBypass = MAX_BYPASS) {
  // Everything a queued preview of this speaker holds is audio from before the
  // cut, which the authoritative segment now carries whole.
  const stale = queue.findIndex((s) => s.preview && s.speaker === seg.speaker);
  if (stale >= 0) queue.splice(stale, 1);

  if (seg.speaker === 'them') {
    const i = queue.findIndex((s) => !s.preview && s.speaker === 'me' && (s.bypassed || 0) < maxBypass);
    if (i >= 0) {
      for (let j = i; j < queue.length; j++) {
        if (!queue[j].preview && queue[j].speaker === 'me') queue[j].bypassed = (queue[j].bypassed || 0) + 1;
      }
      queue.splice(i, 0, seg);
      return;
    }
  }
  queue.push(seg);
}

// Each lane takes the first segment that is its to transcribe and leaves the
// others where they are, so two lanes draining the same queue never reorder it.
export function takeNext(queue, wants) {
  const i = queue.findIndex(wants);
  return i < 0 ? null : queue.splice(i, 1)[0];
}
