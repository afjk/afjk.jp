// Pairing codes remain in memory only. Closing the dialog does not abort and
// reissue an initiation that the server may already have processed.
export function createPairingRequestController({ getSession, request, render, isLinked = () => false, now = Date.now }) {
  const attempts = new Map();
  let generation = 0, opened = false, binding = null;
  const keyOf = session => session ? JSON.stringify([session.roomId, session.userId, session.peerId || null]) : null;
  const current = (version, key) => opened && generation === version
    && binding === key && keyOf(getSession()) === key && !isLinked();

  async function open() {
    if (isLinked()) return;
    const session = getSession();
    const key = keyOf(session);
    const version = ++generation;
    opened = true; binding = key;
    if (!session?.roomId || !session.userId) {
      render({ status: 'error', error: 'ルームに接続してからリンクしてください。' });
      return;
    }
    for (const [id, attempt] of attempts) {
      if (!attempt.promise && attempt.data?.expiresAt <= now()) attempts.delete(id);
    }
    let attempt = attempts.get(key);
    if (attempt?.data?.expiresAt > now()) {
      render({ status: 'code', ...attempt.data });
      return;
    }
    render({ status: 'loading' });
    if (!attempt?.promise) {
      attempt = {};
      attempts.set(key, attempt);
      attempt.promise = Promise.resolve().then(() => request(session)).then(data => {
        if (typeof data?.code !== 'string' || !/^\d{6}$/.test(data.code) || !Number.isFinite(data.expiresAt) || data.expiresAt <= now()) {
          throw new Error('有効なリンクコードを取得できませんでした。');
        }
        attempt.data = { code: data.code, expiresAt: data.expiresAt };
        return attempt.data;
      }).catch(error => {
        if (attempts.get(key) === attempt) attempts.delete(key);
        throw error;
      }).finally(() => { attempt.promise = null; });
    }
    try {
      const data = await attempt.promise;
      if (current(version, key)) render({ status: 'code', ...data });
    } catch (error) {
      if (current(version, key)) render({ status: 'error', error: error?.message || 'リンクコードを取得できませんでした。' });
    }
  }

  function close() {
    ++generation; opened = false; binding = null;
    render({ status: 'closed' });
  }
  function complete() {
    ++generation; opened = false; binding = null;
    attempts.clear();
  }
  function reset() { complete(); render({ status: 'closed' }); }
  function sessionChanged() {
    if (opened && binding !== null && binding !== keyOf(getSession())) close();
  }
  return { open, close, complete, reset, sessionChanged };
}
