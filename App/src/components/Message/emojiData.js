export const EMOJI_CATEGORIES = [
  { id: 'faces', label: 'Caras', emojis: [
    ['😀', 'Sonrisa'], ['😄', 'Alegría'], ['😂', 'Risa'], ['😍', 'Enamorado'], ['🥰', 'Cariño'], ['😎', 'Gafas de sol'],
    ['😢', 'Triste'], ['😭', 'Llanto'], ['😴', 'Sueño'], ['🤔', 'Pensando'], ['🙃', 'Cara al revés'], ['😮', 'Sorpresa'],
    ['😅', 'Sonrisa nerviosa'], ['😘', 'Beso'], ['🤗', 'Abrazo'], ['🥳', 'Celebrando'],
  ] },
  { id: 'gestures', label: 'Gestos', emojis: [
    ['👍', 'Me gusta'], ['👎', 'No me gusta'], ['👏', 'Aplausos'], ['🙌', 'Celebración'], ['🤝', 'Acuerdo'], ['👋', 'Saludo'],
    ['🙏', 'Gracias'], ['💪', 'Fuerza'], ['👌', 'Perfecto'], ['✌️', 'Paz'], ['🤞', 'Suerte'], ['🤲', 'Manos abiertas'],
    ['👍🏽', 'Me gusta, tono medio'], ['👋🏽', 'Saludo, tono medio'],
  ] },
  { id: 'hearts', label: 'Corazones', emojis: [
    ['❤️', 'Corazón rojo'], ['💙', 'Corazón azul'], ['💚', 'Corazón verde'], ['💛', 'Corazón amarillo'], ['💜', 'Corazón morado'],
    ['🧡', 'Corazón naranja'], ['🤍', 'Corazón blanco'], ['🖤', 'Corazón negro'], ['💕', 'Dos corazones'], ['💖', 'Corazón brillante'],
    ['💔', 'Corazón roto'], ['💯', 'Cien puntos'],
  ] },
  { id: 'everyday', label: 'Más', emojis: [
    ['🎉', 'Fiesta'], ['🎁', 'Regalo'], ['🎂', 'Cumpleaños'], ['☕', 'Café'], ['🍕', 'Pizza'], ['⚽', 'Fútbol'],
    ['🌞', 'Sol'], ['🌙', 'Luna'], ['🌈', 'Arcoíris'], ['🌷', 'Flor'], ['🐶', 'Perro'], ['🐱', 'Gato'],
    ['🏠', 'Casa'], ['🚗', 'Coche'], ['🚀', 'Cohete'], ['📍', 'Lugar'], ['✅', 'Listo'], ['🔥', 'Fuego'],
    ['⭐', 'Estrella'], ['🎵', 'Música'], ['🇭🇳', 'Bandera de Honduras'], ['👨‍👩‍👧‍👦', 'Familia'],
  ] },
];

function cursorPosition(value, length) {
  return Number.isFinite(value) ? Math.max(0, Math.min(length, Math.trunc(value))) : length;
}

function splitsSurrogate(text, position) {
  if (position <= 0 || position >= text.length) return false;
  const before = text.charCodeAt(position - 1), after = text.charCodeAt(position);
  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
}

function graphemeBoundaries(text) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      return [...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.index), text.length];
    } catch { /* Use the local fallback if the runtime lacks segmentation data. */ }
  }
  // Hermes versions without Segmenter still keep common emoji, modifiers and ZWJ families together.
  const boundaries = [0];
  let offset = 0, previous = -1, regionalRun = 0;
  for (const symbol of Array.from(text)) {
    const point = symbol.codePointAt(0);
    const regional = point >= 0x1F1E6 && point <= 0x1F1FF;
    const extender = (point >= 0x0300 && point <= 0x036F) || (point >= 0x1AB0 && point <= 0x1AFF) ||
      (point >= 0x1DC0 && point <= 0x1DFF) || (point >= 0x20D0 && point <= 0x20FF) ||
      (point >= 0xFE00 && point <= 0xFE0F) || (point >= 0xFE20 && point <= 0xFE2F) ||
      (point >= 0x1F3FB && point <= 0x1F3FF) || (point >= 0xE0020 && point <= 0xE007F) ||
      (point >= 0xE0100 && point <= 0xE01EF);
    const joined = extender || point === 0x200D || previous === 0x200D ||
      (regional && regionalRun % 2 === 1) || (point === 0x0A && previous === 0x0D);
    if (offset && !joined) boundaries.push(offset);
    regionalRun = regional ? regionalRun + 1 : 0;
    previous = point; offset += symbol.length;
  }
  boundaries.push(text.length);
  return boundaries;
}

// TextInput reports UTF-16 offsets. Never leave half of an existing code point behind.
export function insertEmojiAtSelection(text, emoji, selection) {
  const message = typeof text === 'string' ? text : '';
  let start = cursorPosition(selection?.start, message.length);
  let end = cursorPosition(selection?.end ?? selection?.start, message.length);
  if (start > end) [start, end] = [end, start];
  if (start === end) {
    const boundaries = graphemeBoundaries(message);
    if (!boundaries.includes(start)) start = end = boundaries.find((position) => position > start) ?? message.length;
  } else {
    if (splitsSurrogate(message, start)) start -= 1;
    if (splitsSurrogate(message, end)) end += 1;
  }
  const symbol = typeof emoji === 'string' ? emoji : '';
  const result = message.slice(0, start) + symbol + message.slice(end);
  const cursor = start + symbol.length;
  return { message: result, selection: { start: cursor, end: cursor } };
}
