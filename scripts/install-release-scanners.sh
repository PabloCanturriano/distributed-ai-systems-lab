#!/usr/bin/env bash
set -euo pipefail
destination=${1:?Expected a tools directory}
mkdir -p "$destination"
case "$(uname -m)" in
  x86_64) trivy_arch=64bit; leaks_arch=x64; trivy_hash=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf; leaks_hash=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  aarch64|arm64) trivy_arch=ARM64; leaks_arch=arm64; trivy_hash=ab9d51f86e6a5fb936f605faff6b593ac51bc378fff4d3e8b9d58358b9c367c3; leaks_hash=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  *) exit 1 ;;
esac
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
curl --fail --silent --show-error --location "https://github.com/aquasecurity/trivy/releases/download/v0.76.2/trivy_0.76.2_Linux-${trivy_arch}.tar.gz" --output "$temporary/trivy.tar.gz"
curl --fail --silent --show-error --location "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_${leaks_arch}.tar.gz" --output "$temporary/gitleaks.tar.gz"
printf '%s  %s\n' "$trivy_hash" "$temporary/trivy.tar.gz" "$leaks_hash" "$temporary/gitleaks.tar.gz" | shasum -a 256 --check
tar -xzf "$temporary/trivy.tar.gz" -C "$destination" trivy
tar -xzf "$temporary/gitleaks.tar.gz" -C "$destination" gitleaks
