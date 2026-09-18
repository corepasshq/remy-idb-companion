# remy-idb-companion

A patched build of [`facebook/idb`](https://github.com/facebook/idb)'s
`idb_companion`, published as an immutable release asset for Remy's iOS
simulator panel.

This repository holds no product code. It exists so the helper binary has a
**public, permanent, checksum-pinned URL**: Remy's `pnpm fetch:idb` downloads
`idb-companion.macos-arm64.tar.gz` (or the `-x64` asset, on an Intel host) from
a release here and verifies it against a sha256 recorded in
`desktop/scripts/idb-patched-manifest.json`. A CI artifact cannot serve that
role — it expires after two weeks, and downloading it requires credentials.

## What is patched

Two changes against upstream `v1.5.1`, both in `scripts/idb-patches/`:

1. **`0001-video-stream-single-iterator`** — grpc-swift traps when a second
   `AsyncIterator` is created over a request stream. The video-stream handler
   now reads every frame through one owned iterator.
2. **`0002-jpeg-without-low-latency-rate-control`** — the MJPEG encoder
   specification no longer asks for low-latency rate control, which the JPEG
   encoder does not support.

Nothing else differs from upstream: the build downloads the pinned `v1.5.1`
source archive, verifies its digest, applies those two patches, and builds the
`idb_companion` target alone.

## Releasing

The tag comes from `scripts/idb-patched-manifest.json` (`assets.tag`), and a
release is published **only** by a manual `workflow_dispatch` run of
`Build patched idb companion`, which builds and publishes both the arm64 and
x64 assets under that one tag. A push that edits the patches or the build
script gets a verified build of both and a 14-day workflow artifact, never a
release.

Published tags are never re-cut. Remy pins each archive's sha256, which only
means anything if those bytes are permanent — so a new patch set bumps `name`
and `assets.tag` (`…-remy.1` → `…-remy.2`) and leaves the old release in place
for the Remy versions still pinning it.

The `assets.arm64.sha256` / `assets.x64.sha256` fields in this repository's
copy of the manifest are not maintained -- nothing here reads them, and the
build cannot know its own output's digest before producing it. It is Remy's
copy that carries the real ones.

After a release, its digests go into Remy's own manifest, one per arch. Until
promoted, those fields read `REPLACE_AFTER_HELPER_CI_RELEASE`, and Remy's iOS
panel is simply view-only for that arch.

## Scope

macOS arm64 and x64 (Intel). Upstream's own `build.sh` hardcodes
`ARCHS=arm64`; `scripts/build-patched-idb-companion.mjs` patches that one line
per target and cross-compiles both from the same arm64 CI runner — there is no
x64 build machine involved. The x86_64 output does not get an implicit
linker-applied ad-hoc signature the way arm64 does, so the build script signs
it ad-hoc itself before packing.

This is a shrinking window, not a permanent commitment: Xcode already flags
`ARCHS=x86_64` as deprecated for this SDK's deployment target, and macOS 26 is
the last release supporting Intel Macs at all. When a future Xcode refuses to
build it, the x64 asset simply stops being republished for new patch sets, and
Remy falls back to the same view-only degradation it already has for any other
unsupported host.

## License

`idb` is MIT-licensed by Meta Platforms, Inc. That license is reproduced in
`LICENSE` and covers the binaries published here, which are **modified builds**
of it; the modifications are exactly the patches in `scripts/idb-patches/`.
