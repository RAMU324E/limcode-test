import {
  LOCAL_RESOURCE_MAPPINGS_META_NAME,
  toMappedWebviewResourceUri,
  type WebviewLocalResourceMapping
} from '@shared/localFileResources';

let cachedMappings: WebviewLocalResourceMapping[] | undefined;

function getResourceMappings(): WebviewLocalResourceMapping[] {
  if (cachedMappings !== undefined) return cachedMappings;
  cachedMappings = [];
  if (typeof document === 'undefined') return cachedMappings;

  const meta = document.querySelector(`meta[name="${LOCAL_RESOURCE_MAPPINGS_META_NAME}"]`);
  const content = meta?.getAttribute('content')?.trim();
  if (!content) return cachedMappings;

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) return cachedMappings;
    cachedMappings = parsed.filter(isResourceMapping).map((mapping) => ({ ...mapping }));
  } catch (error) {
    console.warn('[LimCode] Failed to parse local resource mappings.', error);
  }
  return cachedMappings;
}

function isResourceMapping(value: unknown): value is WebviewLocalResourceMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mapping = value as Partial<WebviewLocalResourceMapping>;
  return typeof mapping.pathPrefix === 'string'
    && mapping.pathPrefix.length > 0
    && typeof mapping.resourceBase === 'string'
    && mapping.resourceBase.length > 0
    && typeof mapping.caseSensitive === 'boolean';
}

/** 非本地路径或没有对应资源映射时保持原 src。 */
export function toWebviewImageSrc(source: string): string {
  return toMappedWebviewResourceUri(source, getResourceMappings()) ?? source;
}
