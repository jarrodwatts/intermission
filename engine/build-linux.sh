#!/bin/sh
# Builds the engine for Linux into dist/, where the mod looks for it. There is
# no prebuilt Linux release yet. Needs cmake, ninja, a C++ compiler, git, curl,
# unzip and the SDL2 and SDL2_mixer development packages (libsdl2-dev
# libsdl2-mixer-dev on Debian and Ubuntu).
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git clone -q https://github.com/odamex/odamex.git "$work/odamex"
git -C "$work/odamex" checkout -q "$(cat "$root/engine/odamex-commit")"
git -C "$work/odamex" submodule update -q --init --recursive --depth 1
git -C "$work/odamex" apply "$root/engine/odamex.patch"
cmake -S "$work/odamex" -B "$work/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_CLIENT=1 -DBUILD_SERVER=0 -DBUILD_LAUNCHER=0 -DBUILD_TESTS=0 -DODAMEX_NO_GITVER=1 \
  -DUSE_INTERNAL_PNG=1 -DUSE_INTERNAL_ZSTD=1
cmake --build "$work/build"
mkdir -p "$root/dist"
cp "$work/build/client/odamex" "$work/build/client/odamex.wad" "$root/dist/"
curl -fsSL -o "$work/freedoom.zip" https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
unzip -q -j -o "$work/freedoom.zip" '*/freedoom2.wad' -d "$root/dist"
# The same freedoom2.wad the server runs, or players can't join
echo "a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b  $root/dist/freedoom2.wad" | sha256sum -c
