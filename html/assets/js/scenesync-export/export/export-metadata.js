const TAG_SEPARATOR_RE = /[,\n、]+/u;

function normalizeSingleLineText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeMultilineText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim();
}

export function normalizeExportTags(value) {
  const rawTags = Array.isArray(value)
    ? value
    : String(value ?? '').split(TAG_SEPARATOR_RE);
  const seen = new Set();
  const tags = [];

  for (const rawTag of rawTags) {
    const tag = normalizeSingleLineText(rawTag);
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }

  return tags;
}

export function normalizeExportMetadata(value = {}) {
  const metadata = {};
  const title = normalizeSingleLineText(value?.title);
  const description = normalizeMultilineText(value?.description);
  const tags = normalizeExportTags(value?.tags);
  const author = normalizeSingleLineText(value?.author ?? value?.credit ?? value?.credits);

  if (title) metadata.title = title;
  if (description) metadata.description = description;
  if (tags.length > 0) metadata.tags = tags;
  if (author) metadata.author = author;

  return metadata;
}

export function applyExportMetadata(target, metadataInput = {}) {
  const metadata = normalizeExportMetadata(metadataInput);
  for (const [key, value] of Object.entries(metadata)) {
    target[key] = value;
  }
  return target;
}
