#!/usr/bin/env bash
# Everything that must hold before a version of @quirna/sdk reaches npm. Runs in
# the monorepo before tagging and again in quirna/quirna-node before
# publishing, so both sides refuse the same broken release.
#
# The in-repo typecheck resolves src/ through export conditions and can't see
# packaging mistakes (ADR-0012: `export *` dropping names only showed up in a
# bare consumer). So this packs the tarball and uses it the way a customer
# would: installed from the .tgz, imported by Node, typechecked with nodenext.
#
# Needs bun, node >= 20 and npm on PATH.
set -euo pipefail

pkg_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$pkg_dir"

version="$(node -p 'require("./package.json").version')"

# VERSION goes out in the user-agent; a stale one makes server logs lie about
# which client is calling.
if ! grep -q "export const VERSION = \"$version\";" src/index.ts; then
  echo "::error::src/index.ts VERSION does not match package.json version $version"
  exit 1
fi

bun test src
bun run build

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

npm pack --pack-destination "$work" >/dev/null
cd "$work"
npm init -y >/dev/null
npm pkg set type=module
npm install --no-audit --no-fund --silent "./quirna-sdk-$version.tgz" typescript@5.6 @types/node@20

cat >check.ts <<'EOF'
import {
  type Approval,
  fetchJwks,
  Quirna,
  QuirnaError,
  VERSION,
  verifyCallback,
  verifyExport,
} from "@quirna/sdk";

const client: Quirna = new Quirna({ apiKey: "ck_release_check" });
const status: Approval["status"] | undefined = undefined;
// If types.ts failed to resolve, Approval is `any` and this line stops being
// an error, which makes the directive itself the error.
// @ts-expect-error a number is not an approval status
const notAStatus: Approval["status"] = 42;
console.log(VERSION, typeof client.create, status, QuirnaError.name);
console.log(notAStatus, typeof fetchJwks, typeof verifyCallback, typeof verifyExport);
EOF

cat >tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2022",
    "strict": true,
    "noEmit": true,
    "types": ["node"]
  },
  "files": ["check.ts"]
}
EOF

npx tsc -p tsconfig.json
node --input-type=module -e 'import("@quirna/sdk").then((m) => { if (m.VERSION !== process.argv[1]) throw new Error(`runtime VERSION ${m.VERSION}`); console.log("import ok", m.VERSION); })' "$version"

echo "release check passed for @quirna/sdk@$version"
