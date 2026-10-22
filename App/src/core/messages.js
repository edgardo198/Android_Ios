export const MESSAGE_HISTORY_LIMIT = 50;

export function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function mergeMessages(current = [], incoming = []) {
  const byId = new Map();
  for (const message of [...current, ...incoming]) {
    if (message?.id !== undefined && message?.id !== null) {
      const key = String(message.id);
      const previous = byId.get(key);
      byId.set(key, {
        ...previous,
        ...message,
        // Read receipts are final; a delayed upload/socket echo must not restore unread status.
        ...(previous?.isNew === false ? { isNew: false } : {}),
      });
    }
  }
  const byClientId = new Map();
  for (const message of byId.values()) {
    const key = message.is_me === true && message.clientId ? `own:${message.clientId}` : `id:${message.id}`;
    const previous = byClientId.get(key);
    const isPending = String(message.id).startsWith('pending:');
    const wasPending = previous && String(previous.id).startsWith('pending:');
    // A confirmed server message replaces its local bubble even before disk cleanup finishes.
    // A local isNew:false does not mean that the recipient has read the server message.
    if (!previous || !isPending || wasPending) byClientId.set(key, message);
  }
  return [...byClientId.values()].sort((first, second) => {
    const timeDifference = (Date.parse(second.created) || 0) - (Date.parse(first.created) || 0);
    if (timeDifference) return timeDifference;
    const firstId = Number(first.id);
    const secondId = Number(second.id);
    return Number.isFinite(firstId) && Number.isFinite(secondId)
      ? secondId - firstId : String(second.id).localeCompare(String(first.id));
  }).slice(0, MESSAGE_HISTORY_LIMIT);
}
