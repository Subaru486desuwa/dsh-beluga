# Development and contribution

The repository is a build workspace around **a base Chat package**, `packages/plugin`, and a separately installed Office extension, `packages/office`. Use Node 24.9+ and the pnpm version declared in the root manifest.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run pack
```

The base tarball is `dist/dsh-beluga-0.1.0.tgz`; the separately installed extension is `dist/dsh-beluga-office-0.1.0.tgz`. Build generates strict Host/Client Remote codecs from authored types, compiles both faces, and bundles the public lazy-CJS browser entry. rc.3's Typert generator identifies protocol/brand/JSON declarations through a workspace inventory; the build registers the installed pinned SDK declarations through its public analyzer cache. No runtime host patch or copied SDK declaration is required.

`tests/runtime.spec.ts` intentionally imports the built host artifact. Run `build` before the suite. Fixtures contain only synthetic data; never commit personal exports, database files, API keys or authenticated preview URLs.

## Isolated browser acceptance

Create a fresh `DSH_HOME` and a web-derived profile using `dsh --profile <name> --from-default-profile web --help`. Install the tarball through `dsh plugin` with that same home. Add `packages/plugin/tests/acceptance-fixture/index.mjs` through a local patch to select the deterministic **Local acceptance** model. Bind to loopback on an unused port. This fixture sends no model traffic outside the host. Do not install it into a normal profile.

Check streaming/Stop, edit and branch switching, import preview/confirm/re-import/continuation, profile and memory review, temporary chat cleanup, Work navigation and narrow layout. Verify the actual packed install rather than a replacement demo page.

## Publishing and market contribution

The source is hosted at <https://github.com/Subaru486desuwa/dsh-beluga>. npm publication and market listing are separate actions. Do not claim an unpublished npm package can be installed by name.

Publish the built base and Office packages independently, or attach their separate tarballs to a Git release only when authorized. The root is a development workspace, not a directly installable Git plugin. For market discovery, submit the real npm package or supported Git source to the chosen index maintainer after publication. The official market supports third-party index sources; a source repository by itself is not automatic admission to a public index.

References: [plugin packaging](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md), [plugin market](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md), [index generator](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/plugin-market-generator/README.md).

Keep [the product spec](docs/IMPLEMENTATION_SPEC.md) and [architecture decision](docs/adr/0001-plugin-owned-chat.md) aligned with behavior. Run the focused suite and packed browser checks for affected contracts; report real provider/export checks separately from fixtures.

Office implementation dependencies belong only to `packages/office`. Never add Office to the base package dependencies, optionalDependencies or default patch. Test both base-only denial and explicit extension load/unload.
