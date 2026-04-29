import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

export function createEnvironmentManager(ctx) {
  const {
    scene,
    pmremGenerator,
    dom,
    showToast,
  } = ctx;

  let desiredEnvId = 'outdoor_day';
  let appliedEnvId = null;
  let loadSeq = 0;
  let currentEnvMap = null;

  const envSelect = dom?.envSelect || document.getElementById('env-select');
  const loader = new RGBELoader();

  function updateEnvSelector() {
    if (envSelect) {
      envSelect.value = desiredEnvId;
    }
  }

  function disposeCurrentEnvMap() {
    if (!currentEnvMap) return;

    if (scene.environment === currentEnvMap) {
      scene.environment = null;
    }

    if (scene.background === currentEnvMap) {
      scene.background = null;
    }

    currentEnvMap.dispose();
    currentEnvMap = null;
  }

  function loadEnvironmentAsset(envId) {
    const seq = ++loadSeq;
    const url = '/assets/hdri/' + envId + '.hdr';

    loader.load(
      url,
      (texture) => {
        if (seq !== loadSeq || envId !== desiredEnvId) {
          texture.dispose();
          return;
        }

        const envMap = pmremGenerator.fromEquirectangular(texture).texture;
        texture.dispose();

        if (seq !== loadSeq || envId !== desiredEnvId) {
          envMap.dispose();
          return;
        }

        disposeCurrentEnvMap();

        currentEnvMap = envMap;
        scene.environment = envMap;
        scene.background = envMap;
        appliedEnvId = envId;
      },
      undefined,
      (error) => {
        if (seq !== loadSeq || envId !== desiredEnvId) {
          return;
        }

        console.warn('[environment] failed to load HDRI:', envId, error);
        showToast?.('環境の読み込みに失敗しました: ' + envId);
      }
    );
  }

  function requestEnvironment(envId, options = {}) {
    if (!envId) return;

    const {
      source = 'local',
      broadcastChange = source === 'local',
    } = options;

    const previousEnvId = desiredEnvId;
    desiredEnvId = envId;
    updateEnvSelector();

    if (broadcastChange) {
      const operation = {
        kind: 'scene-env',
        envId,
      };

      // 履歴に追加
      if (ctx.onBeforeBroadcast) {
        ctx.onBeforeBroadcast(operation, {
          beforeEnvId: previousEnvId,
          afterEnvId: envId,
        });
      }

      ctx.broadcast?.(operation);
    }

    loadEnvironmentAsset(envId);
  }

  envSelect?.addEventListener('change', (e) => {
    requestEnvironment(e.target.value, {
      source: 'local',
      broadcastChange: true,
    });
  });

  function loadEnvironment(envId, options = {}) {
    requestEnvironment(envId, options);
  }

  function dispose() {
    loadSeq += 1;
    disposeCurrentEnvMap();
  }

  return {
    requestEnvironment,
    loadEnvironment,
    updateEnvSelector,
    getCurrentEnvId: () => desiredEnvId,
    getDesiredEnvId: () => desiredEnvId,
    getAppliedEnvId: () => appliedEnvId,
    dispose,
  };
}
