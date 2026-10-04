import { createSceneLifetime } from './scene-lifetime.js';

// A new intent invalidates older work even when the newer load itself fails.
export function createSkyboxSwapController() {
  const lifetime = createSceneLifetime();
  return {
    begin() { lifetime.invalidate(); return lifetime.capture(); },
    cancel() { lifetime.invalidate(); },
    assert: token => lifetime.assert(token),
    async run(token, prepare, commit, discard = () => {}) {
      let candidate;
      try {
        lifetime.assert(token);
        candidate = await prepare(token.signal);
        lifetime.assert(token);
        return commit(candidate);
      } catch (error) {
        discard(candidate);
        if (token.signal.aborted) lifetime.assert(token);
        throw error;
      }
    },
  };
}

// Recognize the existing add/remove protocol, including reversed Undo batches.
// Mixed batches must retain their normal per-operation behavior.
export function skyboxReplacementInBatch(operations) {
  if (!Array.isArray(operations)) return null;
  const additions = operations.filter(op => op?.kind === 'scene-add');
  if (additions.length !== 1) return null;
  const target = additions[0];
  if (!target.objectId?.startsWith('sky-') || target.asset?.source !== 'generated-skybox'
      || !(target.asset?.meshPath || target.meshPath)) return null;
  return operations.every(op => op === target
    || (op?.kind === 'scene-remove' && op.objectId?.startsWith('sky-')))
    ? target : null;
}
