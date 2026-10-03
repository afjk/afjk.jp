// For local development checks. Use the execution platform's formal approval
// mechanism when its ordinary command sandbox cannot host Chromium's sandbox.
// This helper never installs certificates or changes the user's trust store.
export function localChromiumOptions() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const proxy = proxyUrl ? new URL(proxyUrl) : null;
  return {
    executablePath: process.env.AFJK_CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
    ...(proxy ? { proxy: {
      server: proxy.origin,
      bypass: 'localhost,127.0.0.1,[::1]',
      ...(proxy.username ? {
        username: decodeURIComponent(proxy.username),
        password: decodeURIComponent(proxy.password),
      } : {}),
    } } : {}),
  };
}
