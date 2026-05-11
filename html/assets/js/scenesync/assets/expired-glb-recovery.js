import { computeAssetId } from './asset-id.js';

const RECOVERY_TIMEOUT_MS = 30000;
const PEER_RETRY_INTERVAL_MS = 4000;
const COOLDOWN_MS = 30000;
const MAX_GLB_SIZE = 50 * 1024 * 1024;
const MAX_ACTIVE_OUTGOING = 1;

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
  broadcast,
  sendHandoff,
  loadGlbBlobForObject,
  getObjectById,
  showToast,
}) {
  const pendingRecoveries = new Map();
  const responderCooldowns = new Map();
  let activeOutgoingTransfer = null;

  async function handleMissingGlb(objectId, meshPath, expectedSize, assetId) {
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
      requestedAt: Date.now(),
      fromPeerId: null,
    };

    pendingRecoveries.set(requestId, recovery);

    showToast('GLBアセットの期限切れ。近くの参加者に問い合わせています...');

    const peers = getOtherPeers(presenceState);
    if (peers.length === 0) {
      console.log('[ExpiredGlbRecovery] No other peers available');
      setTimeout(() => {
        pendingRecoveries.delete(requestId);
      }, RECOVERY_TIMEOUT_MS);
      return;
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
        console.log('[ExpiredGlbRecovery] All peers exhausted for requestId:', requestId);
        pendingRecoveries.delete(requestId);
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
        pendingRecoveries.delete(requestId);
      }
    }, RECOVERY_TIMEOUT_MS);
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

    const obj = getObjectById(objectId);
    if (!obj) {
      console.log('[ExpiredGlbRecovery] Object not found locally:', objectId);
      return;
    }

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

    if (activeOutgoingTransfer) {
      console.log('[ExpiredGlbRecovery] Already transferring, skipping');
      return;
    }

    let cachedRecord = null;
    if (assetId) {
      cachedRecord = await assetCache.getByAssetId(assetId);
    } else if (meshPath) {
      cachedRecord = await assetCache.getByMeshPath(meshPath);
    }

    if (!cachedRecord || !cachedRecord.blob) {
      console.log('[ExpiredGlbRecovery] Asset not in local cache:', cacheKey);
      return;
    }

    const blob = cachedRecord.blob;
    if (blob.size > MAX_GLB_SIZE) {
      console.warn('[ExpiredGlbRecovery] Cached GLB too large, skipping');
      return;
    }

    responderCooldowns.set(cooldownKey, Date.now());
    activeOutgoingTransfer = requestId;

    try {
      const fileName = assetId ? `${assetId}.glb` : `${objectId}.glb`;
      const file = new File([blob], fileName, { type: 'model/gltf-binary' });

      console.log('[ExpiredGlbRecovery] Sending GLB to peer:', {
        requestId,
        peerId: from.id,
        fileName,
        size: blob.size,
      });

      await fileTransfer.sendFileToPeer(from.id, file);
    } catch (err) {
      console.warn('[ExpiredGlbRecovery] Failed to send GLB:', err);
    } finally {
      activeOutgoingTransfer = null;
    }
  }

  async function handleReceivedFile({ file, fromPeerId, from }) {
    if (!file) {
      return;
    }

    console.log('[ExpiredGlbRecovery] File received from peer:', {
      fromPeerId,
      fileName: file.name,
      size: file.size,
    });

    if (file.size > MAX_GLB_SIZE) {
      console.warn('[ExpiredGlbRecovery] Received file too large, ignoring');
      return;
    }

    const isGlb = (file.type === 'model/gltf-binary' || file.name.endsWith('.glb'));
    if (!isGlb) {
      console.log('[ExpiredGlbRecovery] File is not GLB, ignoring');
      return;
    }

    let recovery = null;
    for (const [, rec] of pendingRecoveries) {
      if (!rec.requestedPeerIds.has(fromPeerId)) {
        continue;
      }
      recovery = rec;
      break;
    }

    if (!recovery) {
      console.log('[ExpiredGlbRecovery] No matching pending recovery for this file from requestedPeerIds');
      return;
    }

    console.log('[ExpiredGlbRecovery] Matching recovered file to pending recovery:', recovery.requestId);

    let computedAssetId = null;
    try {
      computedAssetId = await computeAssetId(file);
    } catch (err) {
      console.warn('[ExpiredGlbRecovery] Failed to compute asset ID:', err);
    }

    if (recovery.assetId && computedAssetId && recovery.assetId !== computedAssetId) {
      console.warn('[ExpiredGlbRecovery] Asset ID mismatch, ignoring file');
      return;
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
      await loadGlbBlobForObject(recovery.objectId, file);

      showToast('GLBアセットが別の参加者から復元されました。');
    } catch (err) {
      console.warn('[ExpiredGlbRecovery] Failed to load recovered GLB:', err);
    }
  }

  function canAcceptFileHandoff({ fromPeerId, filename, size, mime }) {
    if (!fromPeerId || !filename || !size || !mime) {
      return false;
    }

    const isGlb = (mime === 'model/gltf-binary' || filename.endsWith('.glb'));
    if (!isGlb) {
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

  return {
    handleMissingGlb,
    handleSceneAssetRequest,
    handleReceivedFile,
    canAcceptFileHandoff,
  };
}
