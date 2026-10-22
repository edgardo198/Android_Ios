const FIELD_LABELS = {
  username: 'Usuario', first_name: 'Nombre', last_name: 'Apellido', password: 'Contraseña',
  file: 'Archivo', connectionId: 'Conversación', type: 'Tipo', email: 'Correo electrónico', current_password: 'Contraseña actual',
};

const ERROR_TRANSLATIONS = new Map([
  ['Invalid credentials.', 'Usuario o contraseña incorrectos. Revisa tus datos e intenta nuevamente.'],
  ['Username and password required.', 'Ingresa tu usuario y contraseña.'],
]);

export function connectionErrorMessage(error) {
  if (error?.code === 'SERVER_UNAVAILABLE') {
    return 'El servidor está tardando en responder. Espera un momento y vuelve a intentarlo.';
  }
  return 'No se pudo conectar con el servidor. Revisa tu conexión a Internet e intenta nuevamente.';
}

export function normalizeApiError(data, fallback = 'No se pudo completar la operación.') {
  if (typeof data === 'string') {
    const message = data.trim();
    return ERROR_TRANSLATIONS.get(message) || message || fallback;
  }
  if (Array.isArray(data)) return data.map((value) => normalizeApiError(value, '')).filter(Boolean).join('\n') || fallback;
  if (data && typeof data === 'object') {
    if (data.detail) return normalizeApiError(data.detail, fallback);
    return Object.entries(data).map(([field, value]) => {
      const text = normalizeApiError(value, '');
      if (!text) return '';
      return FIELD_LABELS[field] ? `${FIELD_LABELS[field]}: ${text}` : text;
    }).filter(Boolean).join('\n') || fallback;
  }
  return fallback;
}
