const assert = require('node:assert/strict');
const test = require('node:test');
const MarkdownIt = require('markdown-it');

const {
  LOCAL_FILE_LINK_DATA_ATTRIBUTE,
  LOCAL_RESOURCE_MAPPINGS_META_NAME,
  normalizeLocalFileSource,
  toMappedWebviewResourceUri
} = require('../dist/extension/shared/localFileResources.js');

test('本地资源协议常量保持统一', () => {
  assert.equal(LOCAL_RESOURCE_MAPPINGS_META_NAME, 'limcode-local-resource-mappings');
  assert.equal(LOCAL_FILE_LINK_DATA_ATTRIBUTE, 'data-limcode-local-file');
});

test('Windows、UNC、POSIX 与 file URL 都能规范化', () => {
  assert.equal(normalizeLocalFileSource('F:%5Ca%5Cb.png'), 'F:/a/b.png');
  assert.equal(normalizeLocalFileSource('file:///F:/Shots/a%20b.png'), 'F:/Shots/a b.png');
  assert.equal(normalizeLocalFileSource('%5Cserver%5Cshare%5Ca.png'), '//server/share/a.png');
  assert.equal(normalizeLocalFileSource('/tmp/a%20b.png'), '/tmp/a b.png');
  assert.equal(normalizeLocalFileSource('https://example.com/a.png'), undefined);
  assert.equal(normalizeLocalFileSource('images/a.png'), undefined);
});

test('实际 markdown-it 编码后的 Windows 与 UNC 路径仍可识别', () => {
  const parser = new MarkdownIt();
  const tokenSource = (markdown, type, attribute) => parser.parse(markdown, {})
    .flatMap((token) => token.children || [])
    .find((token) => token.type === type)
    ?.attrs?.find(([name]) => name === attribute)?.[1];
  const windowsImage = tokenSource(String.raw`![](F:\a\b.png)`, 'image', 'src');
  const uncImage = tokenSource(String.raw`![](\\server\share\a.png)`, 'image', 'src');
  assert.equal(normalizeLocalFileSource(windowsImage), 'F:/a/b.png');
  assert.equal(normalizeLocalFileSource(uncImage), '//server/share/a.png');
});

test('资源映射按最长前缀、路径边界和大小写规则生成 URI', () => {
  const mappings = [
    { pathPrefix: 'F:/', resourceBase: 'https://resource.test/f%3A/', caseSensitive: false },
    { pathPrefix: '/home', resourceBase: 'https://remote.test/home/', caseSensitive: true }
  ];
  assert.equal(
    toMappedWebviewResourceUri('f:\\Shots\\a b.png', mappings),
    'https://resource.test/f%3A/Shots/a%20b.png'
  );
  assert.equal(
    toMappedWebviewResourceUri('/home/user/a#b.png', mappings),
    'https://remote.test/home/user/a%23b.png'
  );
  assert.equal(toMappedWebviewResourceUri('/homepage/a.png', mappings), undefined);
});
