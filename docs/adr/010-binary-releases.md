# ADR-010: Binary releases with GoReleaser's Bun builder and a Nix package

## Status

Accepted

## Context

The CLI and `drop serve` are one Bun program built into a single binary (`pnpm build:cli`, ADR-008).
Until now the only way to get it was to clone the repository, install pnpm and Bun, and build it on
the machine that runs it. That is a high bar for trying drop, and it does not fit machines whose
tools are managed declaratively (the author's are managed with Nix), where a binary built by hand
exists on one machine only.

`bun build --compile --target=...` cross-compiles, so one job can build the binaries for every
platform. What is missing is the rest of a release: archives, checksums, a GitHub Release, and the
package definitions that install from it.

## Decision

### GoReleaser with `builder: bun`

A `v*` tag runs `.github/workflows/release.yaml`, which runs GoReleaser (`.goreleaser.yaml`). It
builds darwin-arm64, darwin-x64, linux-x64 and linux-arm64, archives them as tar.gz with checksums,
and creates the GitHub Release. GoReleaser is what the author's other tools release with, so the
archive names and the downstream packages follow the same shape.

`scripts/build-cli.ts` is split in two steps for this. `--entry <version>` only writes the entry
point that embeds the admin SPA build, the migrations and the release version (printed by
`drop version`); GoReleaser's before hooks run it after `pnpm build`, and its Bun builder compiles
that entry point once per target. Without `--entry`, the script still does both steps, so
`pnpm build:cli` is unchanged. GoReleaser's output goes to `dist/release/`, apart from the entry
point and the local binary in `dist/`.

The job runs on macOS, so the darwin binaries are built by the toolchain that runs them and keep
the ad hoc signature Apple Silicon requires. The linux binaries are cross-compiled.

### A Nix package in babarot/nur-packages

GoReleaser's `nix` publisher writes `pkgs/drop/default.nix` to babarot/nur-packages on each
release: a fetchurl of the archive per platform, with `autoPatchelfHook` on Linux because Bun's
linux binaries link glibc dynamically. The binary is a Bun runtime with the program appended, so it
must not be stripped; the generated derivation does not strip it (checked by building it and running
`drop serve` from the store path). The publisher needs `NUR_GITHUB_TOKEN`; without it (a fork) the
release still publishes the binaries and skips the package.

## Consequences

- A release is a tag push. The workflow does not run the tests itself, so the tag must be on a
  commit of `main` that passed the App workflow.
- Each binary carries the Bun runtime: about 90 MB unpacked, 40 to 55 MB per archive.
- No Windows build. The CLI's credentials, notifications and paths are written for macOS and Linux.
- Homebrew and Scoop are not published. Adding one is a section in `.goreleaser.yaml` and a token,
  when someone needs it.
- The release version is the binary's version, printed by `drop version`. It is unrelated to a
  Site's Version.
