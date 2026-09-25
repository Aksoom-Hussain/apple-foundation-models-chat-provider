#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
	printf '%s\n' 'The Apple Foundation Models helper must be built on Apple Silicon macOS.' >&2
	exit 1
fi

mkdir -p dist/bin
swiftc -O -parse-as-library -target arm64-apple-macosx26.0 -framework FoundationModels \
	swift/main.swift -o dist/bin/on-device-model-cli