// tsc copies relative specifiers into .d.ts verbatim, so `from "./types"`
// ships as-is. Under `moduleResolution: node16/nodenext` a consumer can't
// resolve an extensionless relative import: tsc errors, or with skipLibCheck
// every type from types.ts silently becomes `any`.
//
// The fix can't live in src/: writing "./types.js" there would break Metro,
// which reads src/ through the `react-native` condition and doesn't map .js to
// .ts. So the published declarations are rewritten after emit instead.
import { readdir } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);

for (const name of await readdir(dist)) {
  if (!name.endsWith(".d.ts")) continue;
  const file = Bun.file(new URL(name, dist));
  const source = await file.text();
  const fixed = source.replace(
    /(from\s+["'])(\.\.?\/[^"']+?)(["'])/g,
    (match, open, path, close) =>
      /\.(js|mjs|cjs|json)$/.test(path) ? match : `${open}${path}.js${close}`,
  );
  if (fixed !== source) await Bun.write(file, fixed);
}
