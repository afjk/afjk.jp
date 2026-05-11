function generateRandomPath() {
  return Math.random().toString(36).slice(2, 10);
}

export function createSceneSyncFileTransferAdapter({
  presenceState,
  sendHandoff,
  showToast,
}) {
  const fileReceivedCallbacks = [];
  const PIPING_BASE = location.hostname === 'localhost'
    ? 'http://localhost:8080'
    : 'https://pipe.afjk.jp';
  const PIPE_DISPLAY_URL = `${location.origin}/pipe`;

  async function sendFileToPeer(peerId, file) {
    if (!file || !peerId) {
      throw new Error('sendFileToPeer requires peerId and file');
    }

    const path = generateRandomPath();
    const fileInfo = {
      path,
      filename: file.name || 'file.glb',
      size: file.size,
      mime: file.type || 'application/octet-stream',
      url: `${PIPE_DISPLAY_URL}/#${path}`,
    };

    console.log('[FileTransferAdapter] Sending file to peer:', {
      peerId,
      filename: fileInfo.filename,
      size: fileInfo.size,
    });

    sendHandoff({
      targetId: peerId,
      payload: { kind: 'file', ...fileInfo },
    });

    try {
      const response = await fetch(`${PIPING_BASE}/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name || 'file')}"`,
        },
        body: file,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} uploading file`);
      }
      console.log('[FileTransferAdapter] File transfer complete:', path);
    } catch (err) {
      console.warn('[FileTransferAdapter] File transfer failed:', err);
      throw err;
    }
  }

  function onFileReceived(callback) {
    if (typeof callback === 'function') {
      fileReceivedCallbacks.push(callback);
    }
  }

  function emitFileReceived(event) {
    fileReceivedCallbacks.forEach(cb => {
      try {
        cb(event);
      } catch (err) {
        console.warn('[FileTransferAdapter] Error in onFileReceived callback:', err);
      }
    });
  }

  async function maybeHandleFileTransferHandoff({ payload, from }) {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const isFilePayload = payload.kind === 'file' && payload.path && payload.filename;
    if (!isFilePayload) {
      return false;
    }

    console.log('[FileTransferAdapter] Receiving file from peer:', {
      fromPeerId: from?.id,
      filename: payload.filename,
      size: payload.size,
    });

    try {
      const response = await fetch(`${PIPING_BASE}/${payload.path}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching file`);
      }

      const blob = await response.blob();
      const file = new File([blob], payload.filename, { type: payload.mime });

      emitFileReceived({
        file,
        fromPeerId: from?.id,
        from,
      });

      return true;
    } catch (err) {
      console.warn('[FileTransferAdapter] Failed to receive file:', err);
      return false;
    }
  }

  return {
    sendFileToPeer,
    onFileReceived,
    maybeHandleFileTransferHandoff,
  };
}
