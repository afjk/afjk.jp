import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

export function createEnvironmentManager(ctx) {
  const {
    scene,
    pmremGenerator,
    broadcast,
    dom,
  } = ctx;

  let currentEnvId = 'outdoor_day';
  const envSelect = dom?.envSelect || document.getElementById('env-select');

  function updateEnvSelector() {
    if (envSelect) {
      envSelect.value = currentEnvId;
    }
  }

  function loadEnvironment(envId, options = {}) {
    const { broadcastChange = false } = options;
    const url = '/assets/hdri/' + envId + '.hdr';

    new RGBELoader().load(url, (texture) => {
      const envMap = pmremGenerator.fromEquirectangular(texture).texture;
      scene.environment = envMap;
      scene.background = envMap;
      texture.dispose();

      currentEnvId = envId;
      updateEnvSelector();

      if (broadcastChange) {
        broadcast?.({
          kind: 'scene-env',
          envId,
        });
      }
    });
  }

  envSelect?.addEventListener('change', (e) => {
    const envId = e.target.value;
    loadEnvironment(envId, { broadcastChange: true });
  });

  return {
    loadEnvironment,
    updateEnvSelector,
    getCurrentEnvId: () => currentEnvId,
    setCurrentEnvId: (envId) => {
      currentEnvId = envId;
      updateEnvSelector();
    },
  };
}
