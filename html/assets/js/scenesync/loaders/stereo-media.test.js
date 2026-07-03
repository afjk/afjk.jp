// Tests for stereo-media.js
// Run: node --test html/assets/js/scenesync/loaders/stereo-media.test.js

import { test } from 'node:test';
import { strictEqual, deepEqual } from 'node:assert';
import {
  normalizeStereoMedia,
  detectStereoMediaFromName,
  resolveMediaFormat,
  stereoMediaLabel,
  eyeTextureTransform,
  perEyeAspect,
  stereoPlaneSize,
} from './stereo-media.js';

// ── normalizeStereoMedia ─────────────────────────────────────────────────────

test('normalizeStereoMedia: 省略時は flat/mono (default)', () => {
  deepEqual(normalizeStereoMedia(null), {
    projection: 'flat',
    stereoLayout: 'mono',
    isDefault: true,
  });
  deepEqual(normalizeStereoMedia({}), {
    projection: 'flat',
    stereoLayout: 'mono',
    isDefault: true,
  });
});

test('normalizeStereoMedia: 不正値は既定値に落とす', () => {
  deepEqual(normalizeStereoMedia({ projection: 'vr360', stereoLayout: 'quad' }), {
    projection: 'flat',
    stereoLayout: 'mono',
    isDefault: true,
  });
});

test('normalizeStereoMedia: vr180 / sbs を保持する', () => {
  deepEqual(normalizeStereoMedia({ projection: 'vr180', stereoLayout: 'sbs' }), {
    projection: 'vr180',
    stereoLayout: 'sbs',
    isDefault: false,
  });
});

test('normalizeStereoMedia: flat + sbs も non-default', () => {
  strictEqual(normalizeStereoMedia({ stereoLayout: 'sbs' }).isDefault, false);
});

// ── detectStereoMediaFromName ────────────────────────────────────────────────

test('detect: vr180 トークン', () => {
  deepEqual(detectStereoMediaFromName('https://example.com/clip_vr180.mp4'), {
    projection: 'vr180',
    stereoLayout: 'mono',
  });
});

test('detect: VR180 + SBS', () => {
  deepEqual(detectStereoMediaFromName('https://example.com/tour_VR180_SBS.mp4'), {
    projection: 'vr180',
    stereoLayout: 'sbs',
  });
});

test('detect: 180 単独トークン', () => {
  deepEqual(detectStereoMediaFromName('video-180.mp4'), {
    projection: 'vr180',
    stereoLayout: 'mono',
  });
});

test('detect: vr180 + 3d は SBS 扱い', () => {
  deepEqual(detectStereoMediaFromName('festival_180_3D.mp4'), {
    projection: 'vr180',
    stereoLayout: 'sbs',
  });
});

test('detect: flat SBS 画像', () => {
  deepEqual(detectStereoMediaFromName('https://example.com/photos/shrine_sbs.jpg'), {
    projection: 'flat',
    stereoLayout: 'sbs',
  });
  deepEqual(detectStereoMediaFromName('scan_LR.png'), {
    projection: 'flat',
    stereoLayout: 'sbs',
  });
});

test('detect: flat TB 動画', () => {
  deepEqual(detectStereoMediaFromName('movie_ou.mp4'), {
    projection: 'flat',
    stereoLayout: 'tb',
  });
  deepEqual(detectStereoMediaFromName('movie.topbottom.webm'), {
    projection: 'flat',
    stereoLayout: 'tb',
  });
});

test('detect: 1080p や連番は誤検出しない', () => {
  strictEqual(detectStereoMediaFromName('movie_1080p.mp4'), null);
  strictEqual(detectStereoMediaFromName('IMG_0180.jpg'), null);
  strictEqual(detectStereoMediaFromName('https://example.com/normal-video.mp4'), null);
});

test('detect: クエリ付き URL でも basename で判定', () => {
  deepEqual(detectStereoMediaFromName('https://cdn.example.com/a/b/dive_vr180.mp4?token=abc'), {
    projection: 'vr180',
    stereoLayout: 'mono',
  });
});

test('detect: 空入力は null', () => {
  strictEqual(detectStereoMediaFromName(''), null);
  strictEqual(detectStereoMediaFromName(null), null);
});

// ── resolveMediaFormat ───────────────────────────────────────────────────────

test('resolve: 明示指定が自動判定より優先', () => {
  deepEqual(
    resolveMediaFormat({ projection: 'vr180', stereoLayout: 'tb' }, 'clip_sbs.mp4'),
    { projection: 'vr180', stereoLayout: 'tb', detected: false }
  );
});

test('resolve: 明示的な 2D 指定は自動判定を抑止', () => {
  strictEqual(
    resolveMediaFormat({ projection: 'flat', stereoLayout: 'mono' }, 'clip_vr180_sbs.mp4'),
    null
  );
});

test('resolve: 指定なしなら自動判定', () => {
  deepEqual(resolveMediaFormat(null, 'clip_vr180.mp4'), {
    projection: 'vr180',
    stereoLayout: 'mono',
    detected: true,
  });
  strictEqual(resolveMediaFormat(null, 'clip.mp4'), null);
});

// ── stereoMediaLabel ─────────────────────────────────────────────────────────

test('label: 表示ラベル', () => {
  strictEqual(stereoMediaLabel({ projection: 'vr180', stereoLayout: 'sbs' }), 'VR180 3D 左右(SBS)');
  strictEqual(stereoMediaLabel({ projection: 'vr180', stereoLayout: 'mono' }), 'VR180 (2D)');
  strictEqual(stereoMediaLabel({ projection: 'flat', stereoLayout: 'tb' }), '3D 上下(TB)');
  strictEqual(stereoMediaLabel({}), '2D');
});

// ── eyeTextureTransform ──────────────────────────────────────────────────────

test('transform: sbs は左右半分ずつ（左目が左）', () => {
  deepEqual(eyeTextureTransform('sbs', 'left'), { offset: [0, 0], repeat: [0.5, 1] });
  deepEqual(eyeTextureTransform('sbs', 'right'), { offset: [0.5, 0], repeat: [0.5, 1] });
});

test('transform: tb は上下半分ずつ（左目が上）', () => {
  deepEqual(eyeTextureTransform('tb', 'left'), { offset: [0, 0.5], repeat: [1, 0.5] });
  deepEqual(eyeTextureTransform('tb', 'right'), { offset: [0, 0], repeat: [1, 0.5] });
});

test('transform: mono は全面', () => {
  deepEqual(eyeTextureTransform('mono', 'left'), { offset: [0, 0], repeat: [1, 1] });
});

// ── perEyeAspect / stereoPlaneSize ───────────────────────────────────────────

test('perEyeAspect: sbs は半分、tb は倍', () => {
  strictEqual(perEyeAspect(3840 / 1080, 'sbs'), 3840 / 1080 / 2);
  strictEqual(perEyeAspect(16 / 18, 'tb'), 16 / 9);
  strictEqual(perEyeAspect(16 / 9, 'mono'), 16 / 9);
  strictEqual(perEyeAspect(0, 'sbs'), 0.5);
});

test('stereoPlaneSize: 片目 16:9 SBS 素材は 2m x 1.125m', () => {
  const { width, height } = stereoPlaneSize(32 / 9, 'sbs');
  strictEqual(width, 2);
  strictEqual(height, 2 / (16 / 9));
});

test('stereoPlaneSize: 縦長素材は高さ基準', () => {
  const { width, height } = stereoPlaneSize(0.5, 'mono');
  strictEqual(height, 2);
  strictEqual(width, 1);
});
