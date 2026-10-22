export const RECOVERY_REQUEST_MESSAGE = 'Si existe una cuenta activa con ese correo, recibirás instrucciones para recuperar la contraseña.';
export const INVALID_RECOVERY_LINK = 'El enlace venció o no es válido. Solicita uno nuevo.';

export function normalizeRecoveryEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function recoveryEmailError(value) {
  const email = normalizeRecoveryEmail(value);
  if (!email) return 'Ingresa tu correo electrónico.';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Ingresa un correo electrónico válido.';
  return '';
}

export function resetPasswordErrors(password, repeatedPassword) {
  return {
    password: !password ? 'Ingresa una contraseña nueva.' : password.length < 8 ? 'Usa al menos 8 caracteres.' : '',
    repeatedPassword: !repeatedPassword ? 'Repite la contraseña nueva.' : password !== repeatedPassword ? 'Las contraseñas no coinciden.' : '',
  };
}

function validCredentials(uid, token) {
  return typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid)
    && typeof token === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(token);
}

export function readPasswordResetCode(value) {
  if (typeof value !== 'string') return null;
  const match = /^([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,256})$/.exec(value.trim());
  return match && validCredentials(match[1], match[2]) ? { uid: match[1], token: match[2] } : null;
}

export function readPasswordResetLink(value, webOrigin) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  // React Native's URL only parses HTTP host/path getters; inspect our fixed custom-scheme route directly.
  const native = /^chatlocal:\/{0,3}reset-password\/?(?:[?#]|$)/.test(value);
  const web = /^https?:$/.test(url.protocol) && url.pathname.replace(/\/$/, '') === '/reset-password'
    && (!webOrigin || url.origin === webOrigin);
  if (!native && !web) return null;
  try {
    const uid = url.searchParams.get('uid');
    const token = url.searchParams.get('token');
    return validCredentials(uid, token) && url.searchParams.getAll('uid').length === 1 && url.searchParams.getAll('token').length === 1
      ? { credentials: { uid, token }, error: '' }
      : { credentials: null, error: INVALID_RECOVERY_LINK };
  } catch { return { credentials: null, error: INVALID_RECOVERY_LINK }; }
}

export function clearPasswordResetUrl(browser) {
  try {
    if (!browser?.location || !browser?.history) return false;
    const url = new URL(browser.location.href);
    if (url.pathname.replace(/\/$/, '') !== '/reset-password') return false;
    if (url.search || url.hash) browser.history.replaceState(browser.history.state, '', url.pathname);
    return true;
  } catch { return false; }
}

let nextRequest = 0;
const linkInbox = new Map();

export function rememberPasswordResetLink(link) {
  linkInbox.clear();
  const requestId = `recovery-${++nextRequest}`;
  linkInbox.set(requestId, link);
  return requestId;
}

export function takePasswordResetLink(requestId) {
  const link = linkInbox.get(requestId) || null;
  linkInbox.delete(requestId);
  return link;
}

export function clearPasswordResetLinks() { linkInbox.clear(); }

// Keep incoming secrets in memory while session/navigation initialize. Only opaque IDs reach navigation.
export function createPasswordResetLinkCoordinator({ isReady, onOpen, onCleanUrl, webOrigin }) {
  let pending = null;
  let disposed = false;
  return {
    receive(value) {
      if (disposed) return false;
      const link = readPasswordResetLink(value, webOrigin);
      if (!link) return false;
      onCleanUrl?.();
      pending = link;
      this.flush();
      return true;
    },
    flush() {
      if (disposed || !pending || !isReady()) return false;
      const link = pending;
      pending = null;
      onOpen(link);
      return true;
    },
    dispose() { disposed = true; pending = null; },
  };
}

export function recoveryExitRoute(state) {
  return !state?.initialized ? 'Splash' : state.authenticated ? 'Home' : 'SignIn';
}
