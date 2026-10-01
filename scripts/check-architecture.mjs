import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// This source check covers static ES module edges. Dynamic imports intentionally
// used for platform selection are not startup dependencies.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(path));
    else if (/\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}
const files = [...await sources(resolve(root, 'apps')), ...await sources(resolve(root, 'packages'))];
const known = new Set(files);
const graph = new Map();
const failures = [];
const name = path => relative(root, path).replaceAll('\\', '/');
for (const file of files) {
  const source = await readFile(file, 'utf8');
  const edges = [];
  function addImport(specifier, runtime) {
    if (!specifier.startsWith('.')) return;
    const base = resolve(dirname(file), specifier);
    const bare = /\.[cm]?js$/.test(base) ? base.slice(0, -extname(base).length) : base;
    const target = [base, bare + '.ts', bare + '.tsx', resolve(base, 'index.ts')].find(candidate => known.has(candidate));
    if (!target) return;
    if (runtime) edges.push(target);
    if (name(file).startsWith('packages/') && name(target).startsWith('apps/')) failures.push(`${name(file)} -> ${name(target)}: packages must not import application implementations`);
    if (name(file).startsWith('apps/runner/') && name(target).startsWith('apps/controller/')) failures.push(`${name(file)} -> ${name(target)}: runner must not import controller implementations`);
  }
  const imports = /(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(imports)) {
    const clause = match[3].trim();
    const namedTypes = clause.startsWith('{') && clause.endsWith('}') && clause.slice(1, -1).split(',').every(part => !part.trim() || /^type\s/.test(part.trim()));
    addImport(match[4], !match[2] && !namedTypes);
  }
  for (const match of source.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)) addImport(match[1], true);
  graph.set(file, edges);
}
const visiting = new Set();
const visited = new Set();
function visit(file, path) {
  if (visiting.has(file)) {
    failures.push('Static runtime cycle: ' + [...path.slice(path.indexOf(file)), file].map(name).join(' -> '));
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const dependency of graph.get(file) ?? []) visit(dependency, [...path, file]);
  visiting.delete(file); visited.add(file);
}
for (const file of files) visit(file, []);
if (failures.length) { for (const failure of failures) console.error(failure); process.exitCode = 1; }
else console.log(`Architecture boundaries and static runtime cycles: ${files.length} source files checked.`);
