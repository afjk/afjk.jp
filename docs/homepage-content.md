# Homepage content

The homepage is static HTML (`html/index.html`), with bilingual Works cards in
`html/assets/js/worksData.js`. Keep descriptions short and link to project docs
for requirements and limitations. Preserve Japanese and English together.

## Public project selection (2026-10-08)

Reviewed the public repositories of [afjk](https://github.com/afjk). The seven
additional cards cover distinct, documented tools rather than listing every
repository, dependency fork, empty experiment, or test project:

- **Insta360 SOG XR Viewer:** a browser/WebXR entry point for Gaussian Splat viewing
- **Splat Spots:** a complementary community directory, not a capture hosting service
- **Rapier for Unity:** reusable physics tooling; describe it as unofficial and early-stage
- **MR Godot Samples:** MR examples extending the existing Unity-template coverage
- **OWON Scope:** desktop hardware tooling; retain the tested-platform and uncalibrated-axis caveats
- **KotoPatch:** a browser translation tool; note the desktop Chrome requirement
- **Local Device Finder:** a focused Unity/C# networking utility with usage documentation

Scene Sync now links to its Unity and Godot XR clients. Loomlet explicitly states
its experimental status. MazeMaker's static star count was removed, and its
summary now describes the documented shape-based 3D maze generation rather than
an unverified claim about multiple algorithms. Pipe's copy acknowledges relay
support rather than claiming no cloud infrastructure.

The existing physical-product cards remain first. Current scene/viewer projects
follow, then templates and utility tools. No new star counts, release-version
claims, production-readiness claims, private project information, or device
performance guarantees were added.

### Sources

Public visibility was checked through GitHub repository metadata. Descriptions
were checked against the following README contents. The hashes below identify
README blobs, not repository commits.

| Repository | Source | README blob SHA |
| --- | --- | --- |
| loomlet | [README](https://github.com/afjk/loomlet/blob/main/README.md) | `434e5b307f8d9bfd1604e80cc44807e9017945af` |
| MR-Godot-Template | [README](https://github.com/afjk/MR-Godot-Template/blob/main/README.md) | `3d083f7cba31951b0620ae43b2fa196c16eec843` |
| splat-spots | [README](https://github.com/afjk/splat-spots/blob/main/README.md) | `b55c8d738d7b96fbed64fdeb0e3e45aa88e8a97b` |
| insta360-sog-xr-viewer | [README](https://github.com/afjk/insta360-sog-xr-viewer/blob/main/README.md) | `8abfd1efebd8594b39b11f1ef4353a23575585de` |
| rapier-unity | [README](https://github.com/afjk/rapier-unity/blob/main/README.md) | `af5ffec9c2c22e4c14af8b06b2f9f12f2847b2f5` |
| owon_hds25s | [README](https://github.com/afjk/owon_hds25s/blob/main/README.md) | `781b171feaee5dbdb61510232adc087dcbbab54c` |
| koto-patch | [README](https://github.com/afjk/koto-patch/blob/main/README.md) | `4e41bb40feb179aff17364ac994be720d8517471` |
| LocalDeviceFinder | [README](https://github.com/afjk/LocalDeviceFinder/blob/main/README.md) | `11a5ebb3e5db1c0898926aa66555b787dd55b320` |
| Scene-Sync-Unity | [README](https://github.com/afjk/Scene-Sync-Unity/blob/main/README.md) | `07493b89fb07d00cd9132ef39e9bda376afc57f6` |
| Scene-Sync-Godot | [README](https://github.com/afjk/Scene-Sync-Godot/blob/main/README.md) | `9fd2ef4fb9f00aba8ab21b0904b94c078dee36aa` |
| MazeMaker | [README](https://github.com/afjk/MazeMaker/blob/master/README.md) | `46a31c56ac9c505d302bbe1f8196b55faa511447` |

Scene Sync and Pipe descriptions also use this repository's [README](../README.md)
at base commit `96ff46795f2e396bd51d8f20e80a93d079d560d4`.

## X timeline

Posts uses X's official profile timeline for `@afjk01` rather than four fixed
status IDs. The existing `platform.twitter.com/widgets.js` script is loaded once.
No paid API, account credentials, cookie-based scraper, new service, or polling
backend is introduced. The embed retains `data-dnt="true"`.

The container is full-width up to 700px and bounded to 640px high. The profile
link below it is independent of the widget and stays available if JavaScript,
tracking protection, or X availability prevents the embed from loading. Both
languages explain that content availability and update timing depend on X;
this is not a guarantee of immediate or chronological updates.

Official guidance: [How to embed a timeline](https://help.x.com/en/using-x/embed-x-feed).
It supports public profile timelines and notes that embedded timelines are
subject to X's Developer Agreement and Policy. The site already used X widgets;
this change does not create an account or accept an explicit new agreement.

## Verification

Run the dependency-free homepage checks:

```sh
node --test html/assets/js/worksData.test.js
node --check html/assets/js/worksData.js
git diff --check
```

The tests cover bilingual data, unique identifiers, link shapes and local
routes, repeated rendering in both languages, required caveats, removal of fixed
post IDs, single widget loading, responsive container rules, and the independent
fallback link. They do not verify live X rendering or pixel layout. This static
homepage does not have a build step.

Before publication, visually check the page at mobile and desktop widths in
both languages and with the X widget blocked. Verify that the timeline renders
when X permits it, that scrolling is usable, and that the fallback remains
visible. Verify demo availability separately from repository-link validity.
