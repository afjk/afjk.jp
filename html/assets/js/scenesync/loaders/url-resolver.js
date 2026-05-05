export function resolveDroppedUrl(inputUrl) {
  const originalUrl = typeof inputUrl === 'string' ? inputUrl.trim() : '';

  if (!originalUrl) {
    return {
      originalUrl,
      resolvedUrl: originalUrl,
      source: 'invalid',
      warnings: [],
      notes: [],
    };
  }

  let parsed;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return {
      originalUrl,
      resolvedUrl: originalUrl,
      source: 'invalid',
      warnings: [],
      notes: [],
    };
  }

  if (parsed.hostname === 'github.com') {
    const parts = parsed.pathname.split('/').filter(Boolean);

    // /owner/repo/blob/branch/path/to/file
    if (parts.length >= 5 && parts[2] === 'blob') {
      const [owner, repo, , branch, ...pathParts] = parts;
      return {
        originalUrl,
        resolvedUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pathParts.join('/')}`,
        source: 'github-blob',
        warnings: [],
        notes: ['GitHub blob URLをraw URLに変換しました'],
      };
    }
  }

  if (parsed.hostname === 'raw.githubusercontent.com') {
    return {
      originalUrl,
      resolvedUrl: originalUrl,
      source: 'github-raw',
      warnings: [],
      notes: [],
    };
  }

  return {
    originalUrl,
    resolvedUrl: originalUrl,
    source: 'direct',
    warnings: [],
    notes: [],
  };
}
