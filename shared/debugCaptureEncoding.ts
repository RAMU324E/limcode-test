/** 两端共用的编码预检：越界即退出，不先拼完整字符串或创建字节副本。 */
export function boundedJsonBytes(value: unknown, limit: number): number {
  let size = 0;
  const parents = new Set<object>();
  const add = (n: number) => { size += n; if (size > limit) throw new RangeError('记录超过剩余预算。'); };
  const string = (text: string) => {
    if (text.length + size > limit) throw new RangeError('记录超过剩余预算。');
    add(2);
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2);
      else if (code < 32) add(6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(4); i += 1; }
      else if (code >= 0xd800 && code <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (depth > 128) throw new TypeError('记录嵌套过深。');
    if (item === null || item === undefined) { add(4); return; }
    if (typeof item === 'string') { string(item); return; }
    if (typeof item === 'boolean') { add(item ? 4 : 5); return; }
    if (typeof item === 'number') { add(JSON.stringify(item).length); return; }
    if (typeof item !== 'object' || parents.has(item)) throw new TypeError('记录不是独立的普通数据。');
    parents.add(item);
    add(2);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i += 1) { if (i) add(1); visit(item[i], depth + 1); }
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('记录包含非普通对象。');
      let count = 0;
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        const entry = (item as Record<string, unknown>)[key];
        if (entry === undefined) continue;
        if (count++) add(1);
        string(key); add(1); visit(entry, depth + 1);
      }
    }
    parents.delete(item);
  };
  visit(value, 0);
  return size;
}
