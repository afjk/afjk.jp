export function generateReadme() {
  return `# Scene Sync Export

This package contains an exported Scene Sync scene.

## Preview locally

1. Unzip this package.
2. Open a terminal in this folder.
3. Run:

   python3 -m http.server 8080

4. Open:

   http://localhost:8080

## Notes

- This is a read-only exported scene.
- Editing and multi-user sync are not included.
- Some browsers may require a local server instead of opening \`index.html\` directly.
- Device-specific immersive viewing may be available when supported by the browser.
- The initial export viewer may require an internet connection to load viewer dependencies.
- A future version may bundle these dependencies for offline use.
`;
}
