export const TYPING_HEARTBEAT_MS = 2000;
export const TYPING_IDLE_MS = 2500;
export const TYPING_EXPIRES_MS = 5000;
export const TYPING_DRAFT_MS = 350;

export function boundedTypingDraft(text) {
  return typeof text === 'string' ? Array.from(text).slice(0, 500).join('') : null;
}

export function ownTypingPreferences(user, previous = null) {
  const revision = Number.isSafeInteger(user?.liveTypingRevision) && user.liveTypingRevision >= 0 ? user.liveTypingRevision : 0;
  if (previous?.username === user?.username && (previous.liveTypingRevision || 0) > revision) {
    return { ...user, liveTypingEnabled: previous.liveTypingEnabled === true, liveTypingRevision: previous.liveTypingRevision };
  }
  return { ...user, liveTypingEnabled: user?.liveTypingEnabled === true, liveTypingRevision: revision };
}

export function createTypingController(send, {
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, getDraft = () => null,
} = {}) {
  let active = false;
  let lastSent = 0;
  let idleTimer = null;
  let draftTimer = null;
  let draftRequest = null;
  let latestText = '';
  let lastDraft = null;
  let sequence = 0;
  let activity = 0;
  const emit = () => {
    const draft = boundedTypingDraft(getDraft(latestText));
    if (send(true, draft) === false) { stop(); return false; }
    active = true;
    lastSent = now();
    lastDraft = draft;
    return true;
  };
  const stop = () => {
    activity += 1;
    sequence += 1;
    clearTimer(idleTimer);
    idleTimer = null;
    clearTimer(draftTimer);
    draftTimer = null;
    draftRequest = null;
    latestText = '';
    lastDraft = null;
    if (!active) return false;
    active = false;
    return send(false, null) !== false;
  };
  return {
    stop,
    change(text) {
      if (!text.trim()) return stop();
      latestText = text;
      const time = now();
      if (!active || time - lastSent >= TYPING_HEARTBEAT_MS) {
        clearTimer(draftTimer); draftTimer = null; draftRequest = null;
        if (!emit()) return false;
      } else if (boundedTypingDraft(getDraft(text)) !== lastDraft && draftTimer == null) {
        const current = activity;
        const request = {};
        draftRequest = request;
        draftTimer = setTimer(() => {
          if (draftRequest !== request) return;
          draftTimer = null;
          draftRequest = null;
          if (active && current === activity && latestText && boundedTypingDraft(getDraft(latestText)) !== lastDraft) emit();
        }, Math.max(0, TYPING_DRAFT_MS - (time - lastSent)));
      }
      clearTimer(idleTimer);
      const current = ++sequence;
      idleTimer = setTimer(() => { if (current === sequence) stop(); }, TYPING_IDLE_MS);
      return true;
    },
  };
}
