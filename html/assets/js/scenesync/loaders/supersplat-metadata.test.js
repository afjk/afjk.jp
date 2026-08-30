import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSuperSplatGlbAssetMetadata,
  createSuperSplatSourceMetadata,
  normalizeSuperSplatAttribution,
  readEmbeddedSuperSplatSourceMetadata,
} from './supersplat-metadata.js';

const SCENE_URL = 'https://superspl.at/scene/56155c3f';
const ATTRIBUTION_TEXT = '"Lion" by Renaud (https://superspl.at/user/rohls)\n'
  + `Source: ${SCENE_URL}\n`
  + 'Licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)';

function resolution() {
  return {
    provider: 'supersplat',
    sceneId: '56155c3f',
    pageUrl: SCENE_URL,
    title: 'Lion',
    author: '',
    license: {
      code: 'CC-BY-4.0',
      label: 'CC BY 4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/',
    },
    attribution: {
      status: 'complete',
      text: ATTRIBUTION_TEXT,
      sourceUrl: SCENE_URL,
      creators: [{ name: 'Renaud', url: 'https://superspl.at/user/rohls' }],
      publisher: { name: 'rohls', url: 'https://superspl.at/user/rohls' },
    },
    asset: { format: 'sog-meta', revision: 'v1' },
  };
}

test('creates bounded SuperSplat source metadata without resolver asset URLs', () => {
  const metadata = createSuperSplatSourceMetadata(resolution(), {
    sourceFormat: 'sog',
    splatCount: 195099,
    shDegree: 2,
  });

  assert.equal(metadata.pageUrl, SCENE_URL);
  assert.equal(metadata.license.url, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(metadata.attribution.text, ATTRIBUTION_TEXT);
  assert.equal(metadata.sourceAssetFormat, 'sog-meta');
  assert.equal(metadata.sourceFormat, 'sog');
  assert.equal(metadata.splatCount, 195099);
  assert.equal(metadata.asset, undefined);
});

test('creates glTF asset copyright and namespaced extras', () => {
  const metadata = createSuperSplatGlbAssetMetadata(resolution());

  assert.equal(metadata.copyright, ATTRIBUTION_TEXT);
  assert.equal(
    metadata.extras.scenesync.gaussianSplatSource.attribution.creators[0].name,
    'Renaud',
  );
  assert.equal(
    metadata.extras.scenesync.gaussianSplatSource.license.url,
    'https://creativecommons.org/licenses/by/4.0/',
  );
});

test('embedded metadata round-trips through strict normalization', () => {
  const source = createSuperSplatSourceMetadata(resolution());
  const recovered = readEmbeddedSuperSplatSourceMetadata({
    asset: { extras: { scenesync: { gaussianSplatSource: source } } },
  });

  assert.deepEqual(recovered, source);
});

test('embedded metadata for a mismatched scene is rejected', () => {
  const source = createSuperSplatSourceMetadata(resolution());
  source.attribution.sourceUrl = 'https://superspl.at/scene/another';

  assert.equal(readEmbeddedSuperSplatSourceMetadata({
    asset: { extras: { scenesync: { gaussianSplatSource: source } } },
  }), null);
});

test('attribution normalization rejects unsafe creator URLs', () => {
  assert.equal(normalizeSuperSplatAttribution({
    ...resolution().attribution,
    creators: [{ name: 'Renaud', url: 'javascript:alert(1)' }],
  }, SCENE_URL), null);
});
