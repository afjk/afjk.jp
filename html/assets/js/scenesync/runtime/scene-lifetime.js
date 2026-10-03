// Tokens belong to work started in one connection/scene generation. Never stamp
// an old async result with the generation current at its completion.
export function createSceneLifetime() {
  let generation = 0;
  let controller = new AbortController();
  return {
    capture: () => ({ generation, signal: controller.signal }),
    current: token => !!token && token.generation === generation && token.signal?.aborted === false,
    assert(token) {
      if (!this.current(token)) throw Object.assign(new Error('シーンの変更により処理を取り消しました'), { name: 'AbortError' });
    },
    invalidate() { controller.abort(); controller = new AbortController(); generation++; },
  };
}
