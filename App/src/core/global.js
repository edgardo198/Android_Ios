import { Alert, AppState, Platform } from 'react-native';
import { create } from 'zustand';
import api, { getAccessToken, getWsBaseUrl, resetAuthSession, setSessionExpiredHandler } from './api';
import secure from './secure';
import { getAudio, getDocument, getImage, getVideo } from './utils';
import { mergeMessages, normalizeUsername } from './messages';
import { boundedTypingDraft, ownTypingPreferences, TYPING_EXPIRES_MS } from './typing';
import { createPendingMessage, enqueueMessage, loadOutbox, TEXT_MESSAGE_LIMIT, updateOutbox } from './outbox';

let socketGeneration = 0;
let socketConnectPromise = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let sessionGeneration = 0;
let initializationPromise = null;
let messageRequestSequence = 0;
const receivedMessageIds = new Set();
const confirmedOutboxIds = new Set();
const discardingOutboxIds = new Set();
let outboxFlight = null;
let outboxLoadPromise = null;
let outboxIdentityPromise = null;
const conversationClearRequests = new Map();
const conversationPurgeRequests = new Map();
const MESSAGE_ACK_TIMEOUT = 15000;
let typingTimer = null;
const typingOrder = new Map();
const typingClientSequence = new WeakMap();
let liveTypingUpdate = null;
let profilePreferenceWrite = Promise.resolve();

function persistTypingPreference(get, snapshot) {
  const writing = profilePreferenceWrite.catch(() => {}).then(async () => {
    if (!get().isAuthSessionCurrent(snapshot)) return;
    await secure.set('user', get().user);
  });
  profilePreferenceWrite = writing;
  return writing;
}

function clearTyping(set) {
  clearTimeout(typingTimer);
  typingTimer = null;
  set({ messagesTyping: null });
}

function authSessionChanged() {
  const error = new Error('La sesión cambió. Vuelve a abrir la pantalla.');
  error.code = 'SESSION_CHANGED';
  return error;
}

function responseAuthInvalidated(_set, get, data) {
  void get().invalidateAuthSession(data?.authVersion, get().user?.username);
}

function outboxSession(get) {
  const generation = sessionGeneration;
  const username = get().user?.username;
  return {
    username,
    active: () => generation === sessionGeneration && get().authenticated && get().user?.username === username,
  };
}

function pauseOutbox(set, get) {
  if (!outboxFlight) return;
  clearTimeout(outboxFlight.timer);
  const clientId = outboxFlight.clientId;
  outboxFlight = null;
  set({ pendingMessages: get().pendingMessages.map((message) => message.clientId === clientId
    ? { ...message, deliveryStatus: 'pending', deliveryError: undefined } : message) });
}

function resetOutboxRuntime() {
  typingOrder.clear();
  liveTypingUpdate = null;
  conversationClearRequests.forEach((operation) => operation.controller.abort());
  conversationClearRequests.clear();
  conversationPurgeRequests.clear();
  if (outboxFlight) clearTimeout(outboxFlight.timer);
  outboxFlight = null;
  outboxLoadPromise = null;
  outboxIdentityPromise = null;
  confirmedOutboxIds.clear();
  discardingOutboxIds.clear();
}

function publishOutbox(set, get, queue, resetClientId = null) {
  const previous = new Map(get().pendingMessages.map((message) => [message.clientId, message]));
  set({ pendingMessages: queue.filter((message) => !confirmedOutboxIds.has(message.clientId) &&
    (message.historyRevision || 0) >= (get().conversationHistory[String(message.connectionId)]?.revision || 0)).map((message) => {
    if (outboxFlight?.clientId === message.clientId) return { ...message, deliveryStatus: 'sending' };
    const old = previous.get(message.clientId);
    // A concurrent enqueue must not undo a timeout which is still being written to disk.
    if (old?.deliveryStatus === 'failed' && message.deliveryStatus === 'pending' && message.clientId !== resetClientId) {
      return { ...message, deliveryStatus: 'failed', deliveryError: old.deliveryError };
    }
    return message;
  }) });
}

async function persistOutboxChange(set, get, session, transform, resetClientId = null) {
  try {
    const queue = await updateOutbox(session.username, transform, session.active);
    if (!session.active()) return false;
    publishOutbox(set, get, queue, resetClientId);
    return true;
  } catch (error) {
    if (session.active() && error.code !== 'SESSION_CHANGED') {
      set({ outboxError: error.message || 'No se pudo guardar la cola de mensajes en este dispositivo.' });
    }
    return false;
  }
}

function canRunOutbox(get) {
  return get().authenticated && get().outboxReady && get().outboxIdentityVerified &&
    (!AppState?.currentState || AppState.currentState === 'active');
}

async function applyVerifiedProfile(set, get, user) {
  user = ownTypingPreferences(user, get().user);
  const changesAccount = get().user?.username !== user.username;
  if (changesAccount) {
    clearTyping(set);
    pauseOutbox(set, get);
    resetOutboxRuntime();
    receivedMessageIds.clear();
  }
  set({ initialized: true, authenticated: true, user, outboxIdentityVerified: true,
    ...(changesAccount ? { pendingMessages: [], outboxReady: false, friendList: [], messagesList: [],
      conversationHistory: {}, conversationHistoryReady: false, conversationClearing: {} } : {}) });
  if (changesAccount || !get().outboxReady) await get().loadPendingMessages();
  else get().flushPendingMessages();
}

function rememberMessage(message) {
  const key = String(message.id);
  const duplicate = receivedMessageIds.has(key);
  receivedMessageIds.add(key);
  if (receivedMessageIds.size > 2000) {
    receivedMessageIds.delete(receivedMessageIds.values().next().value);
  }
  return duplicate;
}

function processMessage(message) {
  const processed = { ...message };
  for (const [field, resolver] of Object.entries({ image: getImage, audio: getAudio, video: getVideo, document: getDocument })) {
    if (processed[field]) {
      processed[field] = resolver(processed[field])?.uri || processed[field];
    }
  }
  return processed;
}

function normalizeFriend(item, previous = {}) {
  const message = item?.message;
  const incomingUnread = Number(item?.unreadCount);
  const unreadCount = Number.isFinite(incomingUnread)
    ? Math.max(0, incomingUnread)
    : previous.unreadCount || (message?.isNew && !message?.is_me ? 1 : 0);
  const content = message?.content || message?.[message?.type];
  const normalizedMessage = message && processMessage({ ...message, [message.type]: content });
  return {
    ...item,
    unreadCount,
    isNew: unreadCount > 0,
    message: normalizedMessage && { ...normalizedMessage, content: normalizedMessage[message.type] || content },
  };
}

const SESSION_RESET_STATE = {
  authenticated: false,
  user: {},
  friendList: [],
  searchList: [],
  requestList: [],
  messagesList: [],
  pendingMessages: [],
  outboxReady: false,
  outboxIdentityVerified: false,
  liveTypingUpdating: false,
  outboxError: null,
  conversationHistory: {},
  conversationHistoryReady: false,
  conversationClearing: {},
  messagesTyping: null,
  messagesUsername: null,
  messagesConnectionId: null,
  messagesLoading: false,
  messagesRequestId: null,
  socket: null,
  socketConnected: false,
  socketShouldReconnect: false,
  lastReceivedMessageId: null,
};

function responseFriendList(set, get, friendList) {
  if (!Array.isArray(friendList)) return;
  const rows = (Array.isArray(friendList) ? friendList : []).filter((item) => item?.id && item.friend?.username);
  rows.forEach((item) => applyConversationHistory(set, get, { ...item, connectionId: item.id }));
  const previous = new Map(get().friendList.map((item) => [String(item.id), item]));
  set(() => ({
    friendList: rows.map((item) => {
      const history = get().conversationHistory[String(item.id)];
      const current = previous.get(String(item.id));
      if (history && Number(item.revision || 0) < history.revision) return current || normalizeFriend({ ...item, message: null, unreadCount: 0 });
      const value = item.message && Number(item.message.id) <= (history?.clearedThrough || 0) ? { ...item, message: null, unreadCount: 0 } : item;
      return normalizeFriend(value, current);
    }),
    conversationHistoryReady: true,
  }));
  get().flushPendingMessages();
}

function visibleMessage(get, connectionId, message) {
  return Number(message?.id) > (get().conversationHistory[String(connectionId)]?.clearedThrough || 0);
}

function purgeConversationOutbox(set, get, key, revision) {
  const previous = conversationPurgeRequests.get(key);
  if (previous?.running && previous.revision >= revision) return;
  const session = outboxSession(get);
  const operation = { revision, running: true };
  conversationPurgeRequests.set(key, operation);
  void persistOutboxChange(set, get, session, (queue) => queue.filter((item) =>
    String(item.connectionId) !== key || (item.historyRevision || 0) >= (get().conversationHistory[key]?.revision || revision)))
    .then((success) => {
      if (conversationPurgeRequests.get(key) !== operation) return;
      if (success) conversationPurgeRequests.delete(key);
      else operation.running = false;
    });
}

function applyConversationHistory(set, get, data, reloadThread = true) {
  const connectionId = Number(data?.connectionId);
  const revision = Number(data?.revision);
  const clearedThrough = Number(data?.clearedThrough);
  if (!Number.isSafeInteger(connectionId) || connectionId <= 0 || !Number.isSafeInteger(revision) || revision < 0 ||
      !Number.isSafeInteger(clearedThrough) || clearedThrough < 0) return false;
  const key = String(connectionId);
  const previous = get().conversationHistory[key];
  if (previous && (revision < previous.revision || clearedThrough < previous.clearedThrough)) return false;
  if (previous && revision === previous.revision && clearedThrough === previous.clearedThrough) {
    if (revision > 0 && conversationPurgeRequests.has(key)) purgeConversationOutbox(set, get, key, revision);
    return true;
  }
  const next = { revision, clearedThrough, clearedAt: data.clearedAt || null };
  const advanced = revision > (previous?.revision || 0) || clearedThrough > (previous?.clearedThrough || 0);
  if (advanced && String(get().messagesConnectionId) === key) clearTyping(set);
  if (outboxFlight && String(outboxFlight.connectionId) === key &&
      (get().pendingMessages.find((item) => item.clientId === outboxFlight.clientId)?.historyRevision || 0) < revision) {
    clearTimeout(outboxFlight.timer);
    outboxFlight = null;
  }
  const history = { ...get().conversationHistory, [key]: next };
  set({ conversationHistory: history,
    pendingMessages: get().pendingMessages.filter((item) => String(item.connectionId) !== key || (item.historyRevision || 0) >= revision),
    friendList: get().friendList.map((item) => String(item.id) === key ? { ...item, ...next,
      ...(item.message && Number(item.message.id) <= clearedThrough ? { message: null, preview: '', unreadCount: 0, isNew: false } : {}) } : item),
    ...(String(get().messagesConnectionId) === key ? {
      messagesList: get().messagesList.filter((item) => Number(item.id) > clearedThrough),
      ...(advanced ? { messagesTyping: null, messagesLoading: false, messagesRequestId: null } : {}),
    } : {}),
  });
  if (revision > 0) purgeConversationOutbox(set, get, key, revision);
  if (advanced && reloadThread && String(get().messagesConnectionId) === key) get().messageList(connectionId);
  return true;
}

function responseHistoryCleared(set, get, data) {
  if (applyConversationHistory(set, get, data)) get().flushPendingMessages();
}

function responseHiddenAck(set, get, data) {
  if (data?.historyCleared !== true || typeof data.clientId !== 'string') return;
  applyConversationHistory(set, get, data);
  get().confirmPendingMessages([{ is_me: true, clientId: data.clientId }], data.connectionId);
}

function responseFriendNew(set, get, friend) {
  if (!friend?.id || !friend.friend?.username) {
    return;
  }
  applyConversationHistory(set, get, { ...friend, connectionId: friend.id });
  const currentFriendList = Array.isArray(get().friendList) ? get().friendList : [];
  const history = get().conversationHistory[String(friend.id)];
  if (history && Number(friend.revision || 0) < history.revision) return;
  const visibleFriend = friend.message && Number(friend.message.id) <= (history?.clearedThrough || 0)
    ? { ...friend, message: null, unreadCount: 0 } : friend;
  set(() => ({
    friendList: [normalizeFriend(visibleFriend), ...currentFriendList.filter((item) => String(item.id) !== String(friend.id))],
  }));
}

function normalizeBase64Payload(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmedValue = value.trim();
  return trimmedValue.includes(',') ? trimmedValue.split(',', 2)[1].trim() : trimmedValue;
}

function sendBase64OverSocket(socket, source, connectionId, base64, filename, historyRevision = 0) {
  if (socket?.readyState !== WebSocket.OPEN) {
    return false;
  }

  const base64Data = normalizeBase64Payload(base64);
  const safeFilename = typeof filename === 'string' ? filename.trim() : '';
  if (!base64Data || !safeFilename) {
    console.warn(`WARNING: Payload Base64 invalido para ${source}.`);
    return false;
  }

  socket.send(
    JSON.stringify({
      source,
      connectionId,
      historyRevision,
      base64: base64Data,
      filename: safeFilename,
    })
  );
  return true;
}

function responseMessageList(set, get, data) {
  const state = get();
  if (!state.messagesLoading ||
    normalizeUsername(data?.friend?.username) !== normalizeUsername(state.messagesUsername) ||
    (data?.connectionId !== undefined && String(data.connectionId) !== String(state.messagesConnectionId)) ||
    (data?.page !== undefined && Number(data.page) !== 0) ||
    (data?.requestId !== undefined && data?.requestId !== null && data.requestId !== state.messagesRequestId)) {
    return;
  }
  const connectionId = data.connectionId ?? state.messagesConnectionId;
  applyConversationHistory(set, get, { ...data, connectionId }, false);
  const processedMessages = (Array.isArray(data?.messages) ? data.messages : [])
    .filter((message) => message?.id !== undefined && message?.id !== null)
    .filter((message) => visibleMessage(get, connectionId, message))
    .map(processMessage);
  processedMessages.forEach(rememberMessage);
  get().confirmPendingMessages(processedMessages, data.connectionId ?? state.messagesConnectionId);
  set({
    messagesList: mergeMessages(get().messagesList, processedMessages),
    messagesLoading: false,
  });
  get().markFriendAsRead(data.friend.username, connectionId);
}

const updateFriendPreview = (
  set,
  get,
  username,
  preview,
  created,
  isMe,
  type = 'text',
  content = null,
  message = null,
  isCurrentConversation = false,
  connectionId = null
) => {
  if (!username) {
    console.warn('WARNING: Username invalido o vacio en updateFriendPreview.');
    return;
  }

  const friendList = get().friendList;
  if (!Array.isArray(friendList)) {
    return;
  }

  const friendIndex = friendList.findIndex(
    (item) => connectionId != null ? String(item.id) === String(connectionId)
      : item?.friend?.username === username.trim()
  );

  if (friendIndex === -1) {
    console.warn(`[updateFriendPreview] WARNING: No se encontro al amigo ${username}.`);
    return;
  }

  const item = friendList[friendIndex];
  if (!item) {
    return;
  }

  const fixedPreview =
    type === 'text'
      ? preview
      : type === 'image'
        ? '[Imagen]'
        : type === 'audio'
          ? '[Audio]'
          : type === 'video'
            ? '[Video]'
            : type === 'document'
              ? '[Documento]'
              : '[Mensaje]';

  const unreadCount = isCurrentConversation ? 0 : (item.unreadCount || 0) + (isMe ? 0 : 1);
  const nextItem = {
    ...item,
    updated: created,
    preview: fixedPreview,
    isNew: unreadCount > 0,
    unreadCount,
    message: { ...message, type, content, text: fixedPreview, is_me: isMe },
  };

  const nextFriendList = [...friendList];
  nextFriendList.splice(friendIndex, 1);
  nextFriendList.unshift(nextItem);
  set({ friendList: nextFriendList });
};

function markFriendAsReadFn(set, get, username, connectionId = null) {
  const friendList = Array.isArray(get().friendList) ? get().friendList : [];
  const matches = (item) => connectionId != null ? String(item.id) === String(connectionId)
    : item?.friend?.username === username?.trim();
  const updatedList = friendList.map((item) =>
    matches(item)
      ? { ...item, unreadCount: 0, isNew: false }
      : item
  );
  set({ friendList: updatedList });
  const connection = friendList.find(matches);
  const socket = get().socket;
  if (connection && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ source: 'message.read', connectionId: connection.id }));
  }
}

function responseMessageSendCommon(set, get, data, typeOverride = null) {
  const currentUser = get().user;
  if (!currentUser?.username || data?.message?.id === undefined || data?.message?.id === null) {
    console.warn('WARNING: Payload de mensaje incompleto.');
    return;
  }

  let sender;
  let receiver;

  if (data.sender && data.receiver) {
    sender = typeof data.sender === 'string' ? { username: data.sender } : data.sender;
    receiver = typeof data.receiver === 'string' ? { username: data.receiver } : data.receiver;
  } else if (data.friend) {
    const fallbackFriendUsername =
      typeof data.friend === 'string'
        ? data.friend.trim()
        : (data.friend?.username || '').trim();

    if (!fallbackFriendUsername) {
      console.warn('WARNING: data.friend esta vacio.');
      return;
    }

    if (typeof data.message.is_me === 'boolean') {
      if (data.message.is_me) {
        sender = currentUser;
        receiver = { username: fallbackFriendUsername };
      } else {
        sender = { username: fallbackFriendUsername };
        receiver = currentUser;
      }
    } else {
      sender = currentUser;
      receiver = { username: fallbackFriendUsername };
    }
  } else {
    console.warn('WARNING: No fue posible determinar sender y receiver.');
    return;
  }

  const currentName = currentUser.username.trim().toLowerCase();
  const senderName = sender?.username?.trim().toLowerCase();
  const receiverName = receiver?.username?.trim().toLowerCase();

  if (!senderName || !receiverName) {
    console.warn('WARNING: El payload no contiene usernames validos.');
    return;
  }

  let friendUsername = '';
  if (currentName === senderName && currentName !== receiverName) {
    friendUsername = receiver.username;
  } else if (currentName === receiverName && currentName !== senderName) {
    friendUsername = sender.username;
  } else {
    friendUsername = data.friend
      ? typeof data.friend === 'string'
        ? data.friend
        : data.friend.username
      : '';
  }

  if (!friendUsername || friendUsername.trim() === currentUser.username.trim()) {
    console.warn('WARNING: No se pudo determinar la contraparte del mensaje.');
    return;
  }

  const isMe = typeof data.message.is_me === 'boolean' ? data.message.is_me : currentName === senderName;
  const finalType = typeOverride || data.message.type;
  const processedMessage = processMessage({ ...data.message, type: finalType, is_me: isMe });
  const connectionId = data.connectionId ?? processedMessage.connectionId ?? get().friendList.find((item) =>
    item.friend?.username === friendUsername.trim())?.id;
  applyConversationHistory(set, get, { ...data, connectionId });
  if (isMe && processedMessage.clientId) {
    get().confirmPendingMessages([processedMessage], data.connectionId ?? processedMessage.connectionId);
  }
  if (!visibleMessage(get, connectionId, processedMessage)) return;
  const duplicate = rememberMessage(processedMessage);
  const isCurrentConversation = connectionId != null && get().messagesConnectionId != null
    ? String(connectionId) === String(get().messagesConnectionId)
    : get().messagesUsername === friendUsername.trim();

  const previewText =
    finalType === 'text'
      ? processedMessage.text || ''
      : finalType === 'image'
        ? '[Imagen]'
        : finalType === 'audio'
          ? '[Audio]'
          : finalType === 'video'
            ? '[Video]'
            : finalType === 'document'
              ? '[Documento]'
              : '[Mensaje]';

  const contentValue =
    finalType === 'text'
      ? processedMessage.text
      : finalType === 'image'
        ? processedMessage.image
        : finalType === 'audio'
          ? processedMessage.audio
          : finalType === 'video'
            ? processedMessage.video
            : finalType === 'document'
              ? processedMessage.document
              : null;

  if (!duplicate) updateFriendPreview(
    set,
    get,
    friendUsername,
    previewText,
    processedMessage.created,
    isMe,
    finalType,
    contentValue,
    processedMessage,
    isCurrentConversation,
    connectionId
  );

  if (!isMe && !duplicate && !isCurrentConversation) {
    set({ lastReceivedMessageId: processedMessage.id });
  }

  if (!isCurrentConversation) {
    return;
  }

  const currentMessages = Array.isArray(get().messagesList) ? get().messagesList : [];
  const nextMessages = mergeMessages(currentMessages, [processedMessage]);

  set({
    messagesList: nextMessages,
  });
  if (!isMe) clearTyping(set);
  if (!isMe && !duplicate) {
    get().markFriendAsRead(friendUsername, connectionId);
  }
}

function responseMessageRead(set, get, data) {
  if (Array.isArray(data?.messageIds)) {
    const ids = new Set(data.messageIds.map(String));
    set({ messagesList: get().messagesList.map((message) => ids.has(String(message.id)) ? { ...message, isNew: false } : message) });
    return;
  }
  if (!data?.message?.id) {
    return;
  }
  const messages = get().messagesList;
  if (messages.some((message) => String(message.id) === String(data.message.id))) {
    set({ messagesList: mergeMessages(messages, [processMessage(data.message)]) });
  }
}

function responseMessageSend(set, get, data) {
  responseMessageSendCommon(set, get, data);
}

function responseMessageSendImage(set, get, data) {
  responseMessageSendCommon(set, get, data, 'image');
}

function responseMessageSendAudio(set, get, data) {
  responseMessageSendCommon(set, get, data, 'audio');
}

function responseMessageSendVideo(set, get, data) {
  responseMessageSendCommon(set, get, data, 'video');
}

function responseMessageSendDocument(set, get, data) {
  responseMessageSendCommon(set, get, data, 'document');
}

function responseMessageType(set, get, data) {
  const state = get();
  if (!state.authenticated || !state.messagesUsername || data?.username !== state.messagesUsername ||
      data.connectionId == null || String(data.connectionId) !== String(state.messagesConnectionId) ||
      state.conversationClearing[String(data.connectionId)] ||
      Number(data.revision || 0) !== (state.conversationHistory[String(data.connectionId)]?.revision || 0)) return;
  if (data.isTyping !== undefined && typeof data.isTyping !== 'boolean') return;
  const ordered = typeof data.streamId === 'string' && data.streamId.length > 0 && data.streamId.length <= 80 &&
    Number.isSafeInteger(data.sequence) && data.sequence > 0 && Number.isSafeInteger(data.draftRevision) && data.draftRevision >= 0;
  const key = `${data.connectionId}:${data.username}:${data.revision || 0}`;
  const previous = typingOrder.get(key);
  const preferenceAdvanced = ordered && previous && data.draftRevision > previous.draftRevision;
  if (ordered) {
    if (previous && (data.sequence <= previous.sequence || data.draftRevision < previous.draftRevision)) return;
    typingOrder.set(key, { sequence: data.sequence, draftRevision: data.draftRevision });
    if (typingOrder.size > 128) typingOrder.delete(typingOrder.keys().next().value);
    if (preferenceAdvanced) clearTyping(set);
  } else if (previous) return;
  if (data.isTyping === false) {
    if (!ordered || preferenceAdvanced || !state.messagesTyping?.streamId || state.messagesTyping.streamId === data.streamId) clearTyping(set);
    return;
  }
  const expiresIn = data.expiresAt == null ? TYPING_EXPIRES_MS : Date.parse(data.expiresAt) - Date.now();
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return;
  const typing = { username: data.username, connectionId: data.connectionId,
    ...(ordered ? { streamId: data.streamId, sequence: data.sequence, draftRevision: data.draftRevision } : {}),
    draft: state.outboxIdentityVerified && ordered && typeof data.draft === 'string' ? boundedTypingDraft(data.draft) : null };
  clearTimeout(typingTimer);
  set({ messagesTyping: typing });
  typingTimer = setTimeout(() => {
    if (get().messagesTyping === typing) clearTyping(set);
  }, Math.min(expiresIn, TYPING_EXPIRES_MS));
}

function responseTypingSettings(set, get, data) {
  if (!get().authenticated || !get().outboxIdentityVerified || typeof data?.liveTypingEnabled !== 'boolean' ||
      !Number.isSafeInteger(data.liveTypingRevision) || data.liveTypingRevision < 0 ||
      data.liveTypingRevision < (get().user?.liveTypingRevision || 0)) return;
  const snapshot = get().captureAuthSession();
  get().messageType(get().messagesConnectionId, false);
  set({ user: ownTypingPreferences({ ...get().user, ...data }, get().user) });
  void persistTypingPreference(get, snapshot).catch(() => {});
}

function responseRequestAccept(set, get, connection) {
  const user = get().user;
  if (!user?.username || !connection) {
    return;
  }

  if (user.username === connection.receiver?.username) {
    const requestList = Array.isArray(get().requestList) ? [...get().requestList] : [];
    const requestIndex = requestList.findIndex((request) => request.id === connection.id);
    if (requestIndex >= 0) {
      requestList.splice(requestIndex, 1);
      set(() => ({ requestList }));
    }
  }

  const searchList = Array.isArray(get().searchList) ? [...get().searchList] : [];
  let searchIndex = -1;

  if (user.username === connection.receiver?.username) {
    searchIndex = searchList.findIndex(
      (searchUser) => searchUser.username === connection.sender?.username
    );
  } else {
    searchIndex = searchList.findIndex(
      (searchUser) => searchUser.username === connection.receiver?.username
    );
  }

  if (searchIndex >= 0) {
    searchList[searchIndex] = { ...searchList[searchIndex], status: 'connected' };
    set(() => ({ searchList }));
  }
}

function responseRequestConnect(set, get, data) {
  const user = get().user;
  if (!user?.username || !data?.sender?.username || !data?.receiver?.username) {
    return;
  }

  if (user.username === data.sender.username) {
    const searchList = Array.isArray(get().searchList) ? [...get().searchList] : [];
    const searchIndex = searchList.findIndex(
      (request) => request.username === data.receiver.username
    );
    if (searchIndex >= 0) {
      searchList[searchIndex] = { ...searchList[searchIndex], status: 'pending-them' };
      set(() => ({ searchList }));
    }
  } else {
    const requestList = Array.isArray(get().requestList) ? [...get().requestList] : [];
    const requestIndex = requestList.findIndex(
      (request) => String(request.id) === String(data.id) || request.sender?.username === data.sender.username
    );
    if (requestIndex === -1) {
      requestList.push(data);
      set(() => ({ requestList }));
    }
  }
}

function responseRequestList(set, get, requestList) {
  set(() => ({
    requestList: Array.isArray(requestList) ? requestList : [],
  }));
}

function responseSearch(set, get, data) {
  set(() => ({
    searchList: Array.isArray(data) ? data : [],
  }));
}

function responseMiniatura(set, get, data) {
  if (!data?.username) {
    return;
  }
  set(() => ({
    user: { ...get().user, ...data },
  }));
  secure.set('user', get().user).catch((error) => console.warn('No se pudo guardar el perfil:', error.message));
}

function responseError(set, get, data) {
  if (data?.code === 'history_cleared') {
    responseHistoryCleared(set, get, data);
    return;
  }
  const message =
    typeof data === 'string'
      ? data
      : data?.message || 'Se produjo un error al comunicarse con el servidor.';

  if (data?.clientId) {
    get().failPendingMessage(data.clientId, data.connectionId, message);
    return;
  }

  console.error('Error del socket:', message);
  set({ messagesLoading: false });

  if (Platform.OS !== 'web') {
    Alert.alert('Error', message);
  }
}

const useGlobal = create((set, get) => ({
  initialized: false,
  ...SESSION_RESET_STATE,

  captureAuthSession: () => get().authenticated ? {
    generation: sessionGeneration, username: get().user?.username, userId: get().user?.id ?? null,
  } : null,

  isAuthSessionCurrent: (snapshot) => !!snapshot && get().authenticated && snapshot.generation === sessionGeneration &&
    snapshot.username === get().user?.username && (snapshot.userId == null || String(snapshot.userId) === String(get().user?.id)),

  updateEmail: async (email, currentPassword) => {
    const snapshot = get().captureAuthSession();
    if (!get().isAuthSessionCurrent(snapshot)) throw authSessionChanged();
    const response = await api.patch('/chat/me/', { email: String(email || '').trim(), current_password: currentPassword });
    if (!get().isAuthSessionCurrent(snapshot)) throw authSessionChanged();
    const user = response.data?.user;
    if (!user || user.username !== snapshot.username || (snapshot.userId != null && user.id != null && String(user.id) !== String(snapshot.userId))) {
      throw new Error('No se pudo confirmar el cambio de correo. Intenta nuevamente.');
    }
    let updated = ownTypingPreferences({ ...get().user, ...user }, get().user);
    await secure.set('user', updated);
    if (!get().isAuthSessionCurrent(snapshot)) throw authSessionChanged();
    updated = ownTypingPreferences(updated, get().user);
    set({ user: updated });
    return updated;
  },

  updateLiveTyping: async (enabled) => {
    const snapshot = get().captureAuthSession();
    if (typeof enabled !== 'boolean' || !get().isAuthSessionCurrent(snapshot) || !get().outboxIdentityVerified) throw authSessionChanged();
    if (liveTypingUpdate) throw new Error('Espera a que termine el cambio anterior.');
    const operation = {};
    liveTypingUpdate = operation;
    get().messageType(get().messagesConnectionId, false);
    set({ liveTypingUpdating: true });
    try {
      const response = await api.patch('/chat/me/', { liveTypingEnabled: enabled });
      if (!get().isAuthSessionCurrent(snapshot)) throw authSessionChanged();
      const user = response.data?.user;
      if (user?.username !== snapshot.username || (snapshot.userId != null && user.id != null && String(user.id) !== String(snapshot.userId)) || typeof user.liveTypingEnabled !== 'boolean' ||
          !Number.isSafeInteger(user.liveTypingRevision) || user.liveTypingRevision < 0) {
        throw new Error('No se pudo confirmar la opción. Intenta nuevamente.');
      }
      set({ user: ownTypingPreferences({ ...get().user, ...user }, get().user) });
      await persistTypingPreference(get, snapshot);
      if (!get().isAuthSessionCurrent(snapshot)) throw authSessionChanged();
      return get().user;
    } finally {
      if (liveTypingUpdate === operation) {
        liveTypingUpdate = null;
        if (get().isAuthSessionCurrent(snapshot)) set({ liveTypingUpdating: false });
      }
    }
  },

  completePasswordReset: async (username, snapshot) => {
    if (typeof username !== 'string' || username !== snapshot?.username || !get().isAuthSessionCurrent(snapshot)) return false;
    await get().logout();
    return true;
  },

  invalidateAuthSession: async (authVersion, username) => {
    const currentVersion = Number.isSafeInteger(get().user?.authVersion) ? get().user.authVersion : 0;
    if (!get().authenticated || typeof username !== 'string' || username !== get().user?.username ||
        !Number.isSafeInteger(authVersion) || authVersion <= currentVersion) return false;
    await get().logout();
    return true;
  },

  init: () => {
    if (get().initialized) return Promise.resolve();
    if (initializationPromise) return initializationPromise;
    const generation = sessionGeneration;
    const pending = (async () => {
      try {
        // Migrate existing installations away from storing account passwords.
        await secure.remove('credentials');
        const [tokens, cachedUser] = await Promise.all([secure.get('tokens'), secure.get('user')]);
        if (generation !== sessionGeneration) return;
        if (!tokens?.access) {
          set({ ...SESSION_RESET_STATE, initialized: true });
          return;
        }
        if (cachedUser?.username) {
          set({ ...SESSION_RESET_STATE, initialized: true, authenticated: true, user: ownTypingPreferences(cachedUser) });
          await get().loadPendingMessages();
          if (generation !== sessionGeneration) return;
        }
        const response = await api.get('/chat/me/');
        if (generation !== sessionGeneration) return;
        const user = response.data?.user;
        if (!user?.username) throw new Error('Respuesta de perfil invalida.');
        await secure.set('user', user);
        if (generation === sessionGeneration) {
          await applyVerifiedProfile(set, get, user);
        }
      } catch (error) {
        console.warn('No se pudo actualizar la sesion:', error?.message || error);
        if (generation === sessionGeneration) {
          // A network outage must not erase a valid saved session.
          set({ initialized: true });
        }
      }
    })();
    initializationPromise = pending;
    pending.finally(() => {
      if (initializationPromise === pending) initializationPromise = null;
    });
    return pending;
  },

  login: async (_credentials, user, tokens) => {
    if (!user?.username || !tokens?.access || !tokens?.refresh) {
      throw new Error('Respuesta de sesion invalida.');
    }
    const generation = ++sessionGeneration;
    user = ownTypingPreferences(user);
    resetAuthSession();
    get().socketClose(false);
    receivedMessageIds.clear();
    resetOutboxRuntime();
    set({ ...SESSION_RESET_STATE, initialized: true });
    await secure.set('tokens', tokens);
    if (generation !== sessionGeneration) return;
    await secure.set('user', user);
    if (generation !== sessionGeneration) return;
    await secure.remove('credentials');
    if (generation === sessionGeneration) {
      set({ ...SESSION_RESET_STATE, initialized: true, authenticated: true, user, outboxIdentityVerified: true });
      await get().loadPendingMessages();
    }
  },

  logout: async () => {
    sessionGeneration += 1;
    resetAuthSession();
    get().socketClose(false);
    receivedMessageIds.clear();
    resetOutboxRuntime();
    set({ ...SESSION_RESET_STATE, initialized: true });
    try {
      await secure.wipe();
    } catch (error) {
      console.error('No se pudo borrar la sesion guardada:', error.message);
    }
  },

  socketConnect: () => {
    if (!get().authenticated) return Promise.resolve();
    set({ socketShouldReconnect: true });
    const existingSocket = get().socket;
    if (existingSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(existingSocket.readyState)) {
      return Promise.resolve();
    }
    if (socketConnectPromise) return socketConnectPromise;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const generation = socketGeneration;

    const scheduleReconnect = () => {
      if (generation !== socketGeneration || reconnectTimer || !get().socketShouldReconnect || !get().authenticated) return;
      const delay = Math.min(1000 * (2 ** reconnectAttempts), 30000);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (generation === socketGeneration && get().socketShouldReconnect && get().authenticated) {
          get().socketConnect();
        }
      }, delay);
    };

    const pending = (async () => {
      try {
        const token = await getAccessToken();
        const wsBaseUrl = await getWsBaseUrl();
        if (generation !== socketGeneration || !get().authenticated || !get().socketShouldReconnect) return;
        if (!token) {
          await get().logout();
          return;
        }
        const socket = new WebSocket(`${wsBaseUrl}/ws/chat/?token=${encodeURIComponent(token)}`);
        const isCurrent = () => generation === socketGeneration && get().socket === socket;
        set({ socket, socketConnected: false, conversationHistoryReady: false });

        socket.onopen = () => {
          if (!isCurrent() || !get().authenticated || !get().socketShouldReconnect) {
            socket.close();
            return;
          }
          reconnectAttempts = 0;
          set({ socketConnected: true });
          socket.send(JSON.stringify({ source: 'request.list' }));
          socket.send(JSON.stringify({ source: 'friend.list' }));
          socket.send(JSON.stringify({ source: 'typing.settings' }));
          if (get().messagesConnectionId) get().messageList(get().messagesConnectionId);
          if (get().outboxIdentityVerified) get().flushPendingMessages();
          else void get().verifyOutboxIdentity();
        };

        socket.onmessage = (event) => {
          if (!isCurrent()) return;
          try {
            const parsed = JSON.parse(event.data);
            const responses = {
              'auth.invalidated': responseAuthInvalidated,
              'typing.settings': responseTypingSettings,
              'friend.list': responseFriendList,
              'friend.new': responseFriendNew,
              'message.list': responseMessageList,
              'message_history_cleared': responseHistoryCleared,
              'message.ack': responseHiddenAck,
              'message.send': responseMessageSend,
              'message.send_image': responseMessageSendImage,
              'message.send_audio': responseMessageSendAudio,
              'message.send_video': responseMessageSendVideo,
              'message.send_document': responseMessageSendDocument,
              'message.read': responseMessageRead,
              'message.type': responseMessageType,
              'request.accept': responseRequestAccept,
              'request.connect': responseRequestConnect,
              'request.list': responseRequestList,
              search: responseSearch,
              miniatura: responseMiniatura,
              error: responseError,
            };
            const payload = parsed.source === 'error' ? {
              ...(parsed.data && typeof parsed.data === 'object' ? parsed.data : {}),
              message: parsed.data?.message ?? parsed.message,
              clientId: parsed.data?.clientId ?? parsed.clientId,
              connectionId: parsed.data?.connectionId ?? parsed.connectionId,
              code: parsed.data?.code ?? parsed.code,
            } : parsed.data ?? parsed.message;
            responses[parsed.source]?.(set, get, payload);
          } catch (error) {
            console.error('Error al procesar mensaje del socket:', error.message || error);
          }
        };

        const disconnected = () => {
          if (!isCurrent()) return;
          clearTyping(set);
          pauseOutbox(set, get);
          set({ socket: null, socketConnected: false, conversationHistoryReady: false, messagesLoading: false });
          scheduleReconnect();
        };
        socket.onerror = () => {
          disconnected();
          socket.close();
        };
        socket.onclose = disconnected;
      } catch (error) {
        console.warn('No se pudo conectar el chat:', error.message || error);
        scheduleReconnect();
      }
    })();
    socketConnectPromise = pending;
    pending.finally(() => {
      if (socketConnectPromise === pending) socketConnectPromise = null;
    });
    return pending;
  },

  socketClose: (shouldReconnect = false) => {
    const { socket } = get();
    pauseOutbox(set, get);
    clearTyping(set);
    socketGeneration += 1;
    socketConnectPromise = null;
    reconnectAttempts = 0;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    set({ socket: null, socketConnected: false, conversationHistoryReady: false, socketShouldReconnect: shouldReconnect, messagesLoading: false });
    socket?.close();
    if (shouldReconnect && get().authenticated) get().socketConnect();
  },

  searchUsers: (query) => {
    const socket = get().socket;
    if (query && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ source: 'search', query }));
    } else {
      set(() => ({ searchList: [] }));
    }
  },

  clearMessages: () => {
    clearTyping(set);
    set(() => ({
      messagesList: [],
      messagesTyping: null,
      messagesUsername: null,
      messagesConnectionId: null,
      messagesLoading: false,
      messagesRequestId: null,
    }));
  },

  openMessagesThread: (username, connectionId = null) => {
    clearTyping(set);
    const changesConversation = connectionId != null && get().messagesConnectionId != null
      ? String(get().messagesConnectionId) !== String(connectionId) : get().messagesUsername !== username;
    set(() => ({
      ...(changesConversation ? { messagesList: [], messagesLoading: false } : {}),
      messagesUsername: typeof username === 'string' ? username.trim() : null,
      messagesConnectionId: connectionId,
      messagesTyping: null,
    }));
  },

  ingestMessagePayload: (payload) => {
    responseMessageSendCommon(set, get, payload);
  },

  messageList: (connectionId) => {
    if (!connectionId || get().messagesLoading) return false;
    const socket = get().socket;
    if (socket?.readyState === WebSocket.OPEN) {
      const friend = get().friendList.find((item) => String(item.id) === String(connectionId));
      const requestId = ++messageRequestSequence;
      set({
        messagesConnectionId: connectionId,
        messagesUsername: get().messagesUsername || friend?.friend?.username || null,
        messagesLoading: true,
        messagesRequestId: requestId,
        messagesTyping: null,
      });
      socket.send(
        JSON.stringify({
          source: 'message.list',
          connectionId,
          page: 0,
          requestId,
        })
      );
      return true;
    }
    return false;
  },

  verifyOutboxIdentity: () => {
    if (get().outboxIdentityVerified) return Promise.resolve(true);
    if (outboxIdentityPromise) return outboxIdentityPromise;
    const session = outboxSession(get);
    if (!session.active()) return Promise.resolve(false);
    const pending = (async () => {
      try {
        const response = await api.get('/chat/me/');
        if (!session.active()) return false;
        const user = response.data?.user;
        if (!user?.username) throw new Error('Respuesta de perfil inválida.');
        await secure.set('user', user);
        if (!session.active()) return false;
        await applyVerifiedProfile(set, get, user);
        return true;
      } catch (error) {
        if (session.active()) set({ outboxError: 'No se pudo verificar tu sesión. Tus mensajes siguen guardados en este dispositivo.' });
        return false;
      }
    })();
    outboxIdentityPromise = pending;
    pending.finally(() => { if (outboxIdentityPromise === pending) outboxIdentityPromise = null; });
    return pending;
  },

  loadPendingMessages: () => {
    if (outboxLoadPromise) return outboxLoadPromise;
    const session = outboxSession(get);
    if (!session.active() || !session.username) return Promise.resolve(false);
    set({ pendingMessages: [], outboxReady: false, outboxError: null });
    const pending = (async () => {
      try {
        const queue = await loadOutbox(session.username);
        if (!session.active()) return false;
        publishOutbox(set, get, queue);
        set({ outboxReady: true });
        get().flushPendingMessages();
        return true;
      } catch (error) {
        if (session.active()) set({ outboxError: error.message || 'No se pudo recuperar la cola de mensajes.' });
        return false;
      }
    })();
    outboxLoadPromise = pending;
    pending.finally(() => { if (outboxLoadPromise === pending) outboxLoadPromise = null; });
    return pending;
  },

  flushPendingMessages: () => {
    const socket = get().socket;
    if (outboxFlight || !canRunOutbox(get) || !get().conversationHistoryReady || socket?.readyState !== WebSocket.OPEN) return;
    const message = get().pendingMessages.find((item) => item.deliveryStatus === 'pending' &&
      !confirmedOutboxIds.has(item.clientId) && !discardingOutboxIds.has(item.clientId) &&
      !get().conversationClearing[String(item.connectionId)] &&
      (item.historyRevision || 0) >= (get().conversationHistory[String(item.connectionId)]?.revision || 0));
    if (!message) return;
    const session = outboxSession(get);
    const flight = { clientId: message.clientId, connectionId: message.connectionId, socket, timer: null };
    outboxFlight = flight;
    set({ pendingMessages: get().pendingMessages.map((item) => item.clientId === message.clientId
      ? { ...item, deliveryStatus: 'sending', deliveryError: undefined } : item) });
    flight.timer = setTimeout(() => {
      if (outboxFlight !== flight || !session.active()) return;
      get().failPendingMessage(message.clientId, message.connectionId,
        'No llegó la confirmación del servidor. Reintenta el envío.');
    }, MESSAGE_ACK_TIMEOUT);
    try {
      socket.send(JSON.stringify({ source: 'message.send', connectionId: message.connectionId,
        message: message.text, clientId: message.clientId, historyRevision: message.historyRevision || 0 }));
    } catch {
      // The message is already on disk. A lost transport leaves it pending for the next connection.
      pauseOutbox(set, get);
      socket.close();
    }
  },

  confirmPendingMessages: (messages, connectionId) => {
    const ids = new Set((Array.isArray(messages) ? messages : []).filter((message) =>
      message?.is_me === true && message.clientId).map((message) => message.clientId.toLowerCase()));
    const matches = get().pendingMessages.filter((message) => ids.has(message.clientId) &&
      String(message.connectionId) === String(connectionId));
    if (!matches.length) return;
    const session = outboxSession(get);
    const confirmed = new Set(matches.map((message) => message.clientId));
    confirmed.forEach((clientId) => confirmedOutboxIds.add(clientId));
    if (confirmed.has(outboxFlight?.clientId)) {
      clearTimeout(outboxFlight.timer);
      outboxFlight = null;
    }
    set({ pendingMessages: get().pendingMessages.filter((message) => !confirmed.has(message.clientId)) });
    void persistOutboxChange(set, get, session, (queue) => queue.filter((message) =>
      !(confirmed.has(message.clientId) && String(message.connectionId) === String(connectionId))));
    get().flushPendingMessages();
  },

  failPendingMessage: (clientId, connectionId, explanation) => {
    if (typeof clientId !== 'string') return false;
    const id = clientId.toLowerCase();
    if (confirmedOutboxIds.has(id)) return true;
    const message = get().pendingMessages.find((item) => item.clientId === id &&
      String(item.connectionId) === String(connectionId));
    if (!message) return false;
    const session = outboxSession(get);
    const deliveryError = typeof explanation === 'string' ? explanation.slice(0, 300) : 'No se pudo enviar el mensaje.';
    if (outboxFlight?.clientId === id) {
      clearTimeout(outboxFlight.timer);
      outboxFlight = null;
    }
    set({ pendingMessages: get().pendingMessages.map((item) => item.clientId === id
      ? { ...item, deliveryStatus: 'failed', deliveryError } : item) });
    void persistOutboxChange(set, get, session, (queue) => queue.map((item) => item.clientId === id
      ? { ...item, deliveryStatus: 'failed', deliveryError } : item));
    get().flushPendingMessages();
    return true;
  },

  clearConversation: async (connectionId) => {
    const id = Number(connectionId);
    const key = String(id);
    const session = outboxSession(get);
    if (!session.active() || !Number.isSafeInteger(id) || id <= 0) throw new Error('La conversación no es válida.');
    if (conversationClearRequests.has(key)) throw new Error('El borrado ya está en curso.');
    const operation = { controller: new AbortController(), session };
    conversationClearRequests.set(key, operation);
    set({ conversationClearing: { ...get().conversationClearing, [key]: true } });
    if (String(outboxFlight?.connectionId) === key) pauseOutbox(set, get);
    get().flushPendingMessages();
    try {
      const response = await api.delete(`/chat/connections/${id}/history/`, { signal: operation.controller.signal, timeout: 15000 });
      if (!session.active()) throw Object.assign(new Error('La sesión cambió.'), { code: 'SESSION_CHANGED' });
      const data = response.data;
      if (Number(data?.connectionId) !== id || !Number.isSafeInteger(data?.revision) || data.revision < 1 ||
          !Number.isSafeInteger(data?.clearedThrough) || data.clearedThrough < 0) throw new Error('No se pudo confirmar el borrado.');
      applyConversationHistory(set, get, data);
      const persisted = await persistOutboxChange(set, get, session, (queue) => queue.filter((item) =>
        String(item.connectionId) !== key || (item.historyRevision || 0) >= (get().conversationHistory[key]?.revision || data.revision)));
      if (!session.active()) throw Object.assign(new Error('La sesión cambió.'), { code: 'SESSION_CHANGED' });
      if (!persisted) throw new Error('El historial se borró, pero no se pudo limpiar la cola local. Se volverá a comprobar al conectar.');
      return data;
    } catch (error) {
      if (error.code === 'SESSION_CHANGED') throw error;
      if (typeof error.response?.data?.detail === 'string') throw new Error(error.response.data.detail);
      throw new Error(error.message?.startsWith('El historial se borró') ? error.message : 'No se pudo confirmar el borrado. Revisa tu conexión.');
    } finally {
      if (conversationClearRequests.get(key) === operation) conversationClearRequests.delete(key);
      if (session.active()) {
        const next = { ...get().conversationClearing };
        delete next[key];
        set({ conversationClearing: next });
        get().flushPendingMessages();
      }
    }
  },

  messageSend: async (connectionId, message) => {
    const session = outboxSession(get);
    if (!session.active() || !session.username) return false;
    if (get().conversationClearing[String(connectionId)]) return false;
    const revision = get().conversationHistory[String(connectionId)]?.revision || 0;
    if (outboxLoadPromise) await outboxLoadPromise;
    if (!session.active()) return false;
    if (!get().outboxReady) {
      set({ outboxError: get().outboxError || 'No se pudo abrir la cola local de mensajes. Vuelve a iniciar sesión.' });
      return false;
    }
    const text = typeof message === 'string' ? message.trim() : '';
    const validConnection = Number.isSafeInteger(Number(connectionId)) && Number(connectionId) > 0;
    if (!validConnection || !text || text.length > TEXT_MESSAGE_LIMIT) {
      set({ outboxError: text.length > TEXT_MESSAGE_LIMIT ? 'El mensaje supera los 10.000 caracteres.' : 'El mensaje o la conversación no son válidos.' });
      return false;
    }
    try {
      const pending = createPendingMessage(connectionId, text, revision);
      const queue = await enqueueMessage(session.username, pending, session.active);
      if (!session.active()) return false;
      if (revision < (get().conversationHistory[String(connectionId)]?.revision || 0)) {
        await persistOutboxChange(set, get, session, (items) => items.filter((item) => item.clientId !== pending.clientId));
        return false;
      }
      publishOutbox(set, get, queue);
      set({ outboxError: null });
      get().flushPendingMessages();
      if (!get().outboxIdentityVerified && (!AppState?.currentState || AppState.currentState === 'active')) void get().verifyOutboxIdentity();
      if (canRunOutbox(get) && get().socket?.readyState !== WebSocket.OPEN) void get().socketConnect();
      return true;
    } catch (error) {
      if (session.active() && error.code !== 'SESSION_CHANGED') {
        set({ outboxError: error.message || 'No se pudo guardar el mensaje en este dispositivo.' });
      }
      return false;
    }
  },

  retryPendingMessage: async (clientId) => {
    const session = outboxSession(get);
    const message = get().pendingMessages.find((item) => item.clientId === clientId);
    if (!session.active() || !get().outboxReady || !message || message.deliveryStatus === 'sending') return false;
    const saved = await persistOutboxChange(set, get, session, (queue) => queue.map((item) => item.clientId === clientId
      ? { ...item, deliveryStatus: 'pending', deliveryError: undefined } : item), clientId);
    if (saved) {
      set({ outboxError: null });
      get().flushPendingMessages();
      if (!get().outboxIdentityVerified && (!AppState?.currentState || AppState.currentState === 'active')) void get().verifyOutboxIdentity();
      if (canRunOutbox(get) && get().socket?.readyState !== WebSocket.OPEN) void get().socketConnect();
    }
    return saved;
  },

  discardPendingMessage: async (clientId) => {
    const session = outboxSession(get);
    const message = get().pendingMessages.find((item) => item.clientId === clientId);
    if (!session.active() || !get().outboxReady || !message || message.deliveryStatus === 'sending') return false;
    discardingOutboxIds.add(clientId);
    const saved = await persistOutboxChange(set, get, session, (queue) => queue.filter((item) => item.clientId !== clientId));
    if (session.active()) {
      discardingOutboxIds.delete(clientId);
      if (saved) set({ outboxError: null });
      get().flushPendingMessages();
    }
    return saved;
  },

  messageSendImage: (connectionId, base64, filename) => {
    return !get().conversationClearing[String(connectionId)] && sendBase64OverSocket(get().socket, 'message.send_image', connectionId, base64, filename,
      get().conversationHistory[String(connectionId)]?.revision || 0);
  },

  messageSendAudio: (connectionId, base64, filename) => {
    return !get().conversationClearing[String(connectionId)] && sendBase64OverSocket(get().socket, 'message.send_audio', connectionId, base64, filename,
      get().conversationHistory[String(connectionId)]?.revision || 0);
  },

  messageSendVideo: (connectionId, base64, filename) => {
    return !get().conversationClearing[String(connectionId)] && sendBase64OverSocket(get().socket, 'message.send_video', connectionId, base64, filename,
      get().conversationHistory[String(connectionId)]?.revision || 0);
  },

  messageSendDocument: (connectionId, base64, filename) => {
    return !get().conversationClearing[String(connectionId)] && sendBase64OverSocket(get().socket, 'message.send_document', connectionId, base64, filename,
      get().conversationHistory[String(connectionId)]?.revision || 0);
  },

  messageType: (connectionId, isTyping = true, draft = null) => {
    const socket = get().socket;
    if (get().authenticated && connectionId && String(get().messagesConnectionId) === String(connectionId) &&
        typeof isTyping === 'boolean' && (!isTyping || !get().conversationClearing[String(connectionId)]) &&
        (!isTyping || !AppState.currentState || AppState.currentState === 'active') &&
        socket?.readyState === WebSocket.OPEN) {
      try { socket.send(
        JSON.stringify({
          source: 'message.type',
          connectionId,
          isTyping,
          historyRevision: get().conversationHistory[String(connectionId)]?.revision || 0,
          clientSequence: (() => {
            const next = (typingClientSequence.get(socket) || 0) + 1;
            typingClientSequence.set(socket, next);
            return next;
          })(),
          draft: isTyping && get().outboxIdentityVerified && !get().liveTypingUpdating && get().user?.liveTypingEnabled === true
            ? boundedTypingDraft(draft) : null,
          draftRevision: get().user?.liveTypingRevision || 0,
        })
      ); } catch { return false; }
      return true;
    }
    return false;
  },

  requestAccept: (username) => {
    const socket = get().socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ source: 'request.accept', username }));
    }
  },

  requestConnect: (username) => {
    const socket = get().socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ source: 'request.connect', username }));
    }
  },

  uploadMiniatura: (file) => {
    const socket = get().socket;
    if (socket?.readyState === WebSocket.OPEN) {
      const base64Data = normalizeBase64Payload(file?.base64);
      const filename = typeof file?.fileName === 'string' ? file.fileName.trim() : '';
      if (!base64Data || !filename) {
        console.warn('WARNING: Payload Base64 invalido para miniatura.');
        return false;
      }

      socket.send(
        JSON.stringify({
          source: 'miniatura',
          base64: base64Data,
          filename,
        })
      );
      return true;
    }
    return false;
  },

  markFriendAsRead: (username, connectionId = null) => markFriendAsReadFn(set, get, username, connectionId),
}));

setSessionExpiredHandler(() => { useGlobal.getState().logout(); });

export default useGlobal;
