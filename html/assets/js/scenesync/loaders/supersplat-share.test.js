import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyUrl, URL_KIND } from './url-classifier.js';
import {
  isAllowedSuperSplatAssetUrl,
  parseSuperSplatSceneUrl,
} from './supersplat-share.js';

test('SuperSplat scene and viewer links normalize to one public scene URL', () => {
  for (const input of [
    'https://superspl.at/scene/56155c3f',
    'https://superspl.at/scene/56155c3f/?utm_source=test',
    'https://superspl.at/s?id=56155c3f&foo=bar',
  ]) {
    assert.deepEqual(parseSuperSplatSceneUrl(input), {
      sceneId: '56155c3f',
      sceneUrl: 'https://superspl.at/scene/56155c3f',
    });
    assert.equal(classifyUrl(input).kind, URL_KIND.SUPERSPLAT);
    assert.equal(classifyUrl(input).url, 'https://superspl.at/scene/56155c3f');
  }
});

test('SuperSplat classification rejects lookalike hosts and malformed IDs', () => {
  for (const input of [
    'https://superspl.at.evil.example/scene/56155c3f',
    'https://www.superspl.at/scene/56155c3f',
    'http://superspl.at/scene/56155c3f',
    'https://superspl.at/scene/a%2Fb',
    'https://superspl.at/scene/../admin',
    'https://superspl.at/s?id=../../admin',
  ]) {
    assert.equal(parseSuperSplatSceneUrl(input), null, input);
    assert.notEqual(classifyUrl(input).kind, URL_KIND.SUPERSPLAT, input);
  }
});

test('only expected HTTPS CDN hosts are accepted for resolved assets', () => {
  for (const good of [
    'https://d28zzqy0iyovbz.cloudfront.net/scene/v1/meta.json',
    'https://cdn.playcanvas.com/scene.sog',
    'https://superspl.at/assets/scene.sog',
  ]) {
    assert.equal(isAllowedSuperSplatAssetUrl(good), true, good);
  }

  for (const bad of [
    'https://cloudfront.net.evil.example/meta.json',
    'https://evil.example/meta.json',
    'http://d28zzqy0iyovbz.cloudfront.net/meta.json',
    'https://user@d28zzqy0iyovbz.cloudfront.net/meta.json',
    'https://127.0.0.1/meta.json',
  ]) {
    assert.equal(isAllowedSuperSplatAssetUrl(bad), false, bad);
  }
});
