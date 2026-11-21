/**
 * Normalizes Unicode smart dashes (em dash —, en dash –, figure dash ‒, horizontal bar ―)
 * that mobile/desktop OS smart punctuation substitutes for double hyphens ("--") in CLI flags.
 *
 * Examples:
 *   "!releasecourt 1 —keep-size"       -> "!releasecourt 1 --keep-size"
 *   "!poll 8 –courts-strategy=book"    -> "!poll 8 --courts-strategy=book"
 *   "!poll 8 —courts—strategy=book"    -> "!poll 8 --courts-strategy=book"
 *   "!poll 8 —title=\"Friday — 7pm\"" -> "!poll 8 --title=\"Friday — 7pm\""
 */
function normalizeCommandDashes(text) {
  if (!text || typeof text !== 'string') return text;
  if (!/[—–\u2012\u2015]/.test(text)) return text;

  let normalized = text.replace(/(^|[\s(,\[{])-*[—–\u2012\u2015]+-*(?=[a-zA-Z])/g, '$1--');
  normalized = normalized.replace(/(^|[\s(,\[{])--[^\s=]+/g, (token) =>
    token.replace(/[—–\u2012\u2015]+/g, '-')
  );
  return normalized;
}

module.exports = {
  normalizeCommandDashes
};
