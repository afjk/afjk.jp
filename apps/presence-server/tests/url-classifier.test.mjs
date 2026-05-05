import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  URL_KIND, classifyUrl, parseUriList, extractUrlFromText,
} from '../../../html/assets/js/scenesync/loaders/url-classifier.js';

test('classifyUrl', async (t) => {
  await t.test('mp4 video URL', () => {
    const r = classifyUrl('https://example.com/clip.mp4');
    assert.equal(r.kind, URL_KIND.VIDEO);
    assert.equal(r.ext, 'mp4');
  });

  await t.test('webm video URL', () => {
    assert.equal(classifyUrl('https://example.com/v.webm').kind, URL_KIND.VIDEO);
  });

  await t.test('mov video URL', () => {
    assert.equal(classifyUrl('https://example.com/v.mov').kind, URL_KIND.VIDEO);
  });

  await t.test('m4v video URL', () => {
    assert.equal(classifyUrl('https://example.com/v.m4v').kind, URL_KIND.VIDEO);
  });

  await t.test('m3u8 HLS', () => {
    assert.equal(classifyUrl('https://example.com/master.m3u8').kind, URL_KIND.VIDEO_HLS);
  });

  await t.test('png image URL', () => {
    assert.equal(classifyUrl('https://example.com/cat.png').kind, URL_KIND.IMAGE);
  });

  await t.test('jpg image URL', () => {
    assert.equal(classifyUrl('https://example.com/photo.jpg').kind, URL_KIND.IMAGE);
  });

  await t.test('jpeg image URL', () => {
    assert.equal(classifyUrl('https://example.com/photo.jpeg').kind, URL_KIND.IMAGE);
  });

  await t.test('webp image URL', () => {
    assert.equal(classifyUrl('https://example.com/image.webp').kind, URL_KIND.IMAGE);
  });

  await t.test('gif image URL', () => {
    assert.equal(classifyUrl('https://example.com/animation.gif').kind, URL_KIND.IMAGE);
  });

  await t.test('avif image URL', () => {
    assert.equal(classifyUrl('https://example.com/image.avif').kind, URL_KIND.IMAGE);
  });

  await t.test('bmp image URL', () => {
    assert.equal(classifyUrl('https://example.com/bitmap.bmp').kind, URL_KIND.IMAGE);
  });

  await t.test('svg image URL is unsupported', () => {
    assert.equal(classifyUrl('https://example.com/graphic.svg').kind, URL_KIND.UNSUPPORTED);
  });

  await t.test('glb model URL', () => {
    assert.equal(classifyUrl('https://example.com/model.glb').kind, URL_KIND.GLB);
  });

  await t.test('gltf model URL', () => {
    assert.equal(classifyUrl('https://example.com/model.gltf').kind, URL_KIND.GLB);
  });

  await t.test('webpage URL', () => {
    assert.equal(classifyUrl('https://example.com/').kind, URL_KIND.WEBPAGE);
  });

  await t.test('webpage with path', () => {
    assert.equal(classifyUrl('https://example.com/path/to/page').kind, URL_KIND.WEBPAGE);
  });

  await t.test('uppercase extension is normalized', () => {
    assert.equal(classifyUrl('https://example.com/A.MP4').kind, URL_KIND.VIDEO);
  });

  await t.test('mixed case extension', () => {
    assert.equal(classifyUrl('https://example.com/video.Mp4').kind, URL_KIND.VIDEO);
  });

  await t.test('ftp protocol is invalid', () => {
    assert.equal(classifyUrl('ftp://example.com/clip.mp4').kind, URL_KIND.INVALID);
  });

  await t.test('javascript protocol is invalid', () => {
    assert.equal(classifyUrl('javascript:alert(1)').kind, URL_KIND.INVALID);
  });

  await t.test('no protocol is invalid', () => {
    assert.equal(classifyUrl('example.com/clip.mp4').kind, URL_KIND.INVALID);
  });

  await t.test('empty string is invalid', () => {
    assert.equal(classifyUrl('').kind, URL_KIND.INVALID);
  });

  await t.test('null is invalid', () => {
    assert.equal(classifyUrl(null).kind, URL_KIND.INVALID);
  });

  await t.test('undefined is invalid', () => {
    assert.equal(classifyUrl(undefined).kind, URL_KIND.INVALID);
  });

  await t.test('number is invalid', () => {
    assert.equal(classifyUrl(123).kind, URL_KIND.INVALID);
  });

  await t.test('URL with query string', () => {
    const r = classifyUrl('https://example.com/v.mp4?token=abc&start=0');
    assert.equal(r.kind, URL_KIND.VIDEO);
    assert.equal(r.ext, 'mp4');
  });

  await t.test('URL with fragment', () => {
    const r = classifyUrl('https://example.com/v.mp4#start=10');
    assert.equal(r.kind, URL_KIND.VIDEO);
  });

  await t.test('URL with port', () => {
    const r = classifyUrl('https://example.com:8443/v.mp4');
    assert.equal(r.kind, URL_KIND.VIDEO);
  });

  await t.test('returns host correctly', () => {
    const r = classifyUrl('https://cdn.example.com/v.mp4');
    assert.equal(r.host, 'cdn.example.com');
  });

  await t.test('http (non-https) URL is valid', () => {
    assert.equal(classifyUrl('http://example.com/v.mp4').kind, URL_KIND.VIDEO);
  });
});

test('parseUriList', async (t) => {
  await t.test('single URI', () => {
    const r = parseUriList('https://example.com/');
    assert.deepEqual(r, ['https://example.com/']);
  });

  await t.test('multiple URIs', () => {
    const r = parseUriList('https://a/\nhttps://b/');
    assert.deepEqual(r, ['https://a/', 'https://b/']);
  });

  await t.test('URIs with trailing whitespace', () => {
    const r = parseUriList('  https://a/  \n  https://b/  ');
    assert.deepEqual(r, ['https://a/', 'https://b/']);
  });

  await t.test('comments are skipped', () => {
    const r = parseUriList('# comment\nhttps://a/\n# another\nhttps://b/');
    assert.deepEqual(r, ['https://a/', 'https://b/']);
  });

  await t.test('CRLF line endings', () => {
    const r = parseUriList('https://a/\r\nhttps://b/\r\n');
    assert.deepEqual(r, ['https://a/', 'https://b/']);
  });

  await t.test('mixed line endings', () => {
    const r = parseUriList('https://a/\nhttps://b/\r\nhttps://c/');
    assert.deepEqual(r, ['https://a/', 'https://b/', 'https://c/']);
  });

  await t.test('empty input returns empty array', () => {
    assert.deepEqual(parseUriList(''), []);
  });

  await t.test('null input returns empty array', () => {
    assert.deepEqual(parseUriList(null), []);
  });

  await t.test('whitespace only input', () => {
    assert.deepEqual(parseUriList('   \n  \n  '), []);
  });

  await t.test('comments only input', () => {
    assert.deepEqual(parseUriList('# comment 1\n# comment 2'), []);
  });
});

test('extractUrlFromText', async (t) => {
  await t.test('extracts http URL', () => {
    const result = extractUrlFromText('see https://example.com/v.mp4 here');
    assert.equal(result, 'https://example.com/v.mp4');
  });

  await t.test('extracts http (non-https) URL', () => {
    const result = extractUrlFromText('check http://example.com/v.mp4 out');
    assert.equal(result, 'http://example.com/v.mp4');
  });

  await t.test('returns first URL only', () => {
    const result = extractUrlFromText('https://first.com https://second.com');
    assert.equal(result, 'https://first.com');
  });

  await t.test('returns null when no URL', () => {
    assert.equal(extractUrlFromText('hello world'), null);
  });

  await t.test('returns null for empty string', () => {
    assert.equal(extractUrlFromText(''), null);
  });

  await t.test('returns null for null input', () => {
    assert.equal(extractUrlFromText(null), null);
  });

  await t.test('returns null for undefined', () => {
    assert.equal(extractUrlFromText(undefined), null);
  });

  await t.test('extracts URL with query string', () => {
    const result = extractUrlFromText('try https://example.com/v.mp4?token=abc');
    assert.equal(result, 'https://example.com/v.mp4?token=abc');
  });

  await t.test('extracts URL at start of text', () => {
    const result = extractUrlFromText('https://example.com/v.mp4 is great');
    assert.equal(result, 'https://example.com/v.mp4');
  });

  await t.test('extracts URL at end of text', () => {
    const result = extractUrlFromText('check out https://example.com/v.mp4');
    assert.equal(result, 'https://example.com/v.mp4');
  });

  await t.test('does not extract non-http URLs', () => {
    const result = extractUrlFromText('ftp://example.com is not extracted');
    assert.equal(result, null);
  });
});
