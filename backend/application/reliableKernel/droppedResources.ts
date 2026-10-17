import * as vscode from 'vscode';

/** DataTransfer values are paths, URI lists, or VS Code resource/editor JSON, not just file paths. */
export function resolveDroppedResources(rawValues: readonly string[]): vscode.Uri[] {
  const resources = new Map<string, vscode.Uri>();
  const add = (value: unknown): void => {
    let uri: vscode.Uri | undefined;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text || text.startsWith('#')) return;
      if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(text)) uri = vscode.Uri.file(text.replace(/\\/g, '/'));
      else if (text.startsWith('/')) uri = vscode.Uri.file(text);
      else if (/^(?:file|vscode-remote|vscode-vfs):/i.test(text)) uri = vscode.Uri.parse(text, true);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.scheme === 'string' && typeof record.path === 'string') {
        uri = vscode.Uri.from({
          scheme: record.scheme, path: record.path,
          ...(typeof record.authority === 'string' ? { authority: record.authority } : {}),
          ...(typeof record.query === 'string' ? { query: record.query } : {})
        });
      }
    }
    if (!uri || !['file', 'vscode-remote', 'vscode-vfs'].includes(uri.scheme)) return;
    // Editor selections use URI fragments; they do not identify a different file.
    uri = uri.with({ fragment: '' });
    resources.set(uri.toString(), uri);
  };

  for (const raw of rawValues) {
    const text = raw.trim();
    if (!text) continue;
    try {
      if (/^[\[{"]/.test(text)) {
        const parsed: unknown = JSON.parse(text);
        for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
          // CodeEditors wraps a URI in resource; ResourceURLs/CodeFiles are arrays of strings.
          const value = entry && typeof entry === 'object' && 'resource' in entry ? entry.resource : entry;
          add(value);
        }
      } else {
        for (const line of text.split(/\r?\n/)) add(line);
      }
    } catch {
      // An unrelated or malformed drag format must not hide the other valid representations.
    }
  }
  return [...resources.values()];
}
