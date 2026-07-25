export function sortableName(id: string, label = id): string {
  return `${timestampForFileName()}-${slugify(label)}-${shortHash(id)}`;
}

export function sortableNameWithReadableSuffix(id: string, label = id): string {
  return `${timestampForFileName()}-${slugify(label)}-${readableIdSuffix(id)}`;
}

export function sortableNameWithExactIdSuffix(id: string): string {
  return `${timestampForFileName()}-${fileSafeId(id)}`;
}

/** conversation runtime、timeline 与 compression 领域共享的稳定分片目录名。 */
export function conversationShardName(id: string): string {
  const slug = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'conversation';
  return `${slug}-${shortHash(id)}`;
}

/** conversation settings 使用的稳定文件名片段。 */
export function conversationSettingsFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function timestampForFileName(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '').replace('.', '-');
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'item';
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function readableIdSuffix(id: string): string {
  const normalized = id.startsWith('conversation-') ? id.slice('conversation-'.length) : id;
  const suffix = slugify(normalized).slice(0, 64);
  if (suffix) return suffix;
  return shortHash(id);
}

function fileSafeId(id: string): string {
  const safe = id
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return safe || shortHash(id);
}
