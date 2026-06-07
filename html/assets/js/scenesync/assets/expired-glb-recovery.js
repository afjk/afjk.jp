import { computeAssetId } from './asset-id.js';

function cloneJsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

const RECOVERY_TIMEOUT_MS = 30000;
const PEER_RETRY_INTERVAL_MS = 4000;
const COOLDOWN_MS = 30000;
const DEFAULT_MAX_GLB_SIZE = 500 * 1024 * 1024;
const MAX_OUTGOING_QUEUE = 8;

function getOtherPeers(presenceState) {
  let peers = presenceState.peers;
  if (peers instanceof Map) {
    peers = Array.from(peers.values());
  } else if (!Array.isArray(peers)) {
    peers = [];
  }
  return peers.filter(p => p.id !== presenceState.id);
}

export function createExpiredGlbRecovery({
  assetCache,
  fileTransfer,
  presenceState,
  sendHandoff,
  loadGlbBlobForObject,
}) {
  const pendingRecoveries = new Map();
  const responderCooldowns = new Map();
  const outgoingQueue = [];
  const recoveryFailedCallbacks = [];
  const recoverySuccessCallbacks = [];
  let outgoingProcessing = false;

  async function handleMissingGlb(objectId, meshPath, expectedSize, assetId, info = null) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    console.log('[ExpiredGlbRecovery] Missing GLB detected:', {
      objectId,
      meshPath,
      assetId,
      requestId,
    });

    const recovery = {
      requestId,
      objectId,
      assetId: assetId || null,
      meshPath: meshPath || null,
      expectedSize: expectedSize || null,
      info: info ? cloneJsonSafe(info) : null,
      requestedAt: Date.now(),
      requestedPeerIds: new Set(),
    };

    pendingRecoveries.set(requestId, recovery);

    const peers = getOtherPeers(presenceState);
    if (peers.length === 0) {
      console.log('[ExpiredGlbRecovery] No other peers available');
      pendingRecoveries.delete(requestId);
      recoveryFailedCallbacks.forEach(cb => {
        try {
          cb({ objectId, requestId, reason: 'no-peers', info: recovery.info });
        } catch (err) {
          console.warn('[ExpiredGlbRecovery] Error in recovery failed callback:', err);
        }
      });
      return { started: false, requestId, reason: 'no-peers' };
    }

    const request = {
      kind: 'scene-asset-request',
      requestId,
      objectId,
      assetId: assetId || null,
      meshPath: meshPath || null,
      expectedSize: expectedSize || null,
    };

    let peerIndex = 0;
    function tryNextPeer() {
      if (!pendingRecoveries.has(requestId)) {
        return;
      }

      if (peerIndex >= peers.length) {
        console.log('[ExpiredGlbRecovery] All peers requested for requestId:', requestId, 'waiting for file handoff or timeout');
        return;
      }

      const peer = peers[peerIndex];
      peerIndex++;

      const recovery = pendingRecoveries.get(requestId);
      if (recovery) {
        recovery.requestedPeerIds.add(peer.id);
      }

      console.log('[ExpiredGlbRecovery] Sending request to peer', peerIndex - 1, ':', peer.id);
      sendHandoff({
        targetId: peer.id,
        payload: request,
      });

      setTimeout(() => {
        if (pendingRecoveries.has(requestId)) {
          tryNextPeer();
        }
      }, PEER_RETRY_INTERVAL_MS);
    }

    tryNextPeer();

    setTimeout(() => {
      if (pendingRecoveries.has(requestId)) {
        console.log('[ExpiredGlbRecovery] Recovery timeout for requestId:', requestId);
        const recovery = pendingRecoveries.get(requestId);
        pendingRecoveries.delete(requestId);
        recoveryFailedCallbacks.forEach(cb => {
          try {
            cb({ objectId, requestId, reason: 'timeout', info: recovery?.info });
          } catch (err) {
            console.warn('[ExpiredGlbRecovery] Error in recovery failed callback:', err);
          }
        });
      }
    }, RECOVERY_TIMEOUT_MS);

    return { started: true, requestId, peerCount: peers.length };
  }

  async function handleSceneAssetRequest({ payload, from }) {
    const { requestId, objectId, assetId, meshPath, expectedSize } = payload;

    if (!requestId || !from?.id) {
      return;
    }

    console.log('[ExpiredGlbRecovery] Received asset request:', {
      requestId,
      objectId,
      assetId,
      from: from.id,
    });

    const cacheKey = assetId || meshPath;
    if (!cacheKey) {
      console.log('[ExpiredGlbRecovery] No cacheKey for matching');
      return;
    }

    const cooldownKey = `${cacheKey}-${from.id}`;
    const lastCooldown = responderCooldowns.get(cooldownKey);
    if (lastCooldown && Date.now() - lastCooldown < COOLDOWN_MS) {
      console.log('[ExpiredGlbRecovery] Cooldown active for', cacheKey);
      return;
    }

    const request = { requestId, objectId, assetId, meshPath, expectedSize, fromPeerId: from.id };

    if (outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
      console.warn('[ExpiredGlbRecovery] Outgoing queue full, dropping request', requestId);
      return;
    }

    console.log('[ExpiredGlbRecovery] Queuing request for processing');
    outgoingQueue.push(request);
    drainOutgoingQueue();
  }

  async function drainOutgoingQueue() {
    if (outgoingProcessing || outgoingQueue.length === 0) {
      return;
    }

    outgoingProcessing = true;

    while (outgoingQueue.length > 0) {
      const request = outgoingQueue.shift();
      try {
        await processOutgoingRequest(request);
      } catch (err) {
        console.warn('[ExpiredGlbRecovery] Error processing outgoing request:', err);
      }
    }

    outgoingProcessing = false;
  }

  async function processOutgoingRequest(request) {
    const { requestId, objectId, assetId, meshPath, expectedSize, fromPeerId } = request;

    let cachedRecord = null;
    try {
      if (assetId) {
        cachedRecord = await assetCache.getByAssetId(assetId);
      } else if (meshPath) {
        cachedRecord = await assetCache.getByMeshPath(meshPath);
      }
    } catch (err) {
      console.warn('[ExpiredGlbRecovery] Error looking up asset cache:', err);
      return;
    }

    if (!cachedRecord || !cachedRecord.blob) {
      console.log('[ExpiredGlbRecovery] Asset not in local cache:', assetId || meshPath);
      return;
    }

    const blob = cachedRecord.blob;
    if (blob.size > DEFAULT_MAX_GLB_SIZE) {
      console.warn('[ExpiredGlbRecovery] Cached GLB too large, skipping');
      return;
    }

    const cacheKey = assetId || meshPath;
    responderCooldowns.set(`${cacheKey}-${fromPeerId}`, Date.now());

    try {
      const fileName = assetId ? `${assetId}.glb` : `${objectId}.glb`;
      const file = new File([blob], fileName, { type: 'model/gltf-binary' });

      console.log('[ExpiredGlbRecovery] Sending GLB to peer:', {
        requestId,
        peerId: fromPeerId,
        fileName,
        size: blob.size,
      });

      await fileTransfer.sendFileToPeer(fromPeerId, file, { requestId, assetId, meshPath, objectId });
    } catch (err) {
      console.warn('[ExpiredGlbRecovery] Failed to send GLB:', err);
    }
  }

  async function handleReceivedFile({ file, fromPeerId, from, recoveryRequestId }) {
    if (!file) {
      return;
    }

    console.log('[ExpiredGlbRecovery] File received from peer:', {
      fromPeerId,
      recoveryRequestId,
      fileName: file.name,
      size: file.size,
    });

    if (file.size > DEFAULT_MAX_GLB_SIZE) {
      console.warn('[ExpiredGlbRecovery] Received file too large, ignoring');
      return;
    }

    const isGlb = (file.type === 'model/gltf-binary' || file.name.toLowerCase().endsWith('.glb'));
    if (!isGlb) {
      console.log('[ExpiredGlbRecovery] File is not GLB, ignoring');
      return;
    }

    let recovery = null;

    if (recoveryRequestId) {
      recovery = pendingRecoveries.get(recoveryRequestId);
    }

    let computedAssetId = null;
    try {
      computedAssetId = await computeAssetId(file);
    } catch (err) {
      console.warn('[ExpiredGlbRecovery] Failed to compute asset ID:', err);
    }

    if (!recovery && fromPeerId) {
      let fallback = null;
      for (const [, rec] of pendingRecoveries) {
        if (!rec.requestedPeerIds.has(fromPeerId)) {
          continue;
        }
        if (rec.expectedSize && rec.expectedSize !== file.size) {
          continue;
        }
        if (computedAssetId && rec.assetId) {
          if (rec.assetId === computedAssetId) {
            recovery = rec;
            break;
          }
          continue;
        }
        if (rec.assetId && file.name?.startsWith?.(rec.assetId)) {
          recovery = rec;
          break;
        }
        if (!fallback) fallback = rec;
      }
      recovery ||= fallback;
    }

    if (!recovery) {
      console.log('[ExpiredGlbRecovery] No matching pending recovery for this file');
      return;
    }

    console.log('[ExpiredGlbRecovery] Matching recovered file to pending recovery:', recovery.requestId);

    if (recovery.assetId) {
      if (!computedAssetId) {
        console.warn('[ExpiredGlbRecovery] Expected assetId but computation failed, ignoring file');
        return;
      }
      if (recovery.assetId !== computedAssetId) {
        console.warn('[ExpiredGlbRecovery] Asset ID mismatch, ignoring file');
        return;
      }
    }

    if (recovery.expectedSize && recovery.expectedSize !== file.size) {
      console.warn('[ExpiredGlbRecovery] Size mismatch, ignoring file');
      return;
    }

    pendingRecoveries.delete(recovery.requestId);

    try {
      await assetCache.putAsset({
        assetId: computedAssetId || recovery.assetId,
        meshPath: recovery.meshPath,
        blob: file,
        source: 'recovered',
      });

      console.log('[ExpiredGlbRecovery] Loading recovered GLB into object');
      await loadGlbBlobForObject(recovery.objectId, file, {
        info: recovery.info,
        meshPath: recovery.meshPath,
        assetId: computedAssetId || recovery.assetId,
      });

      recoverySuccessCallbacks.forEach(cb => {
        try {
          cb({ objectId: recovery.objectId, requestId: recovery.requestId });
        } catch (err) {
          console.warn('[ExpiredGlbRecovery] Error in recovery success callback:', err);
        }
      });
    } catch (err) {
      console.warn('[ExpiredGlbRecovery] Failed to load recovered GLB:', err);
      recoveryFailedCallbacks.forEach(cb => {
        try {
          cb({ objectId: recovery.objectId, requestId: recovery.requestId, reason: 'load-failed', info: recovery.info });
        } catch (cbErr) {
          console.warn('[ExpiredGlbRecovery] Error in recovery failed callback:', cbErr);
        }
      });
    }
  }

  function canAcceptFileHandoff({ fromPeerId, filename, size, mime, recoveryRequestId }) {
    if (!filename || !size || !mime) {
      return false;
    }

    const isGlb = (mime === 'model/gltf-binary' || filename.toLowerCase().endsWith('.glb'));
    if (!isGlb) {
      return false;
    }

    if (recoveryRequestId && pendingRecoveries.has(recoveryRequestId)) {
      return true;
    }

    if (!fromPeerId) {
      return false;
    }

    let recovery = null;
    for (const [, rec] of pendingRecoveries) {
      if (!rec.requestedPeerIds.has(fromPeerId)) {
        continue;
      }

      if (rec.expectedSize && rec.expectedSize !== size) {
        continue;
      }

      recovery = rec;
      break;
    }

    return recovery !== null;
  }

  function onRecoveryFailed(callback) {
    if (typeof callback === 'function') {
      recoveryFailedCallbacks.push(callback);
    }
  }

  function onRecoverySuccess(callback) {
    if (typeof callback === 'function') {
      recoverySuccessCallbacks.push(callback);
    }
  }

  return {
    handleMissingGlb,
    handleSceneAssetRequest,
    handleReceivedFile,
    canAcceptFileHandoff,
    onRecoveryFailed,
    onRecoverySuccess,
  };
}
