export function parseCallDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatCallDuration(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  const seconds = Math.floor(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = String(seconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${remaining}`
    : `${String(minutes).padStart(2, '0')}:${remaining}`;
}

export function formatCallDate(value) {
  const timestamp = parseCallDate(value);
  if (timestamp === null) return null;
  return new Date(timestamp).toLocaleString('es', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function callResultLabel(reason, direction, result) {
  const labels = {
    ended: 'Completada', rejected: 'Rechazada', cancelled: 'Cancelada',
    missed: direction === 'incoming' ? 'Perdida' : 'Sin respuesta',
    timeout: 'Sin respuesta', no_answer: 'Sin respuesta',
    connection_timeout: 'No se pudo conectar', disconnected: 'Conexión interrumpida',
    unavailable: 'No disponible', busy: 'Contacto ocupado',
  };
  const results = { answered: 'Completada', missed: direction === 'incoming' ? 'Perdida' : 'Sin respuesta',
    rejected: 'Rechazada', cancelled: 'Cancelada', failed: 'Fallida' };
  return labels[reason] || results[result] || 'Finalizada';
}
