import fs from 'node:fs';
import path from 'node:path';
import type { Compilation, Compiler, Module, StatsModule } from 'webpack';

/**
 * Writes the module list of a build to `.bundle-stats/<platform>.json` (resolved path, size,
 * output files, and which packages use it). `scripts/size-report.mjs` reads it to prove there
 * is one copy of react, react-reconciler and @tarojs/runtime, that no module only sub-packages
 * use sits in the main package, and to explain where the bytes go.
 *
 * `usedBy` names the packages whose entries reach the module through the import graph: `main`
 * for the app, the main-package pages and Taro's own templates, else the sub-package's name.
 * Taro's MiniSplitChunksPlugin moves a module no main entry reaches into each sub-package that
 * uses it, so a main-package module whose `usedBy` lacks `main` is a layout regression.
 */
const STYLE = /\.(s?css|less)$/;

export class BundleStatsPlugin {
  constructor(private readonly outFile: string) {}

  apply(compiler: Compiler): void {
    compiler.hooks.done.tap('BundleStatsPlugin', (stats) => {
      const usedBy = this.packagesByModule(stats.compilation);
      const json = stats.toJson({
        all: false,
        modules: true,
        nestedModules: true,
        chunks: true,
        ids: true,
        modulesSpace: Infinity,
        nestedModulesSpace: Infinity,
      });
      const chunkFiles = new Map<string | number, string[]>();
      for (const chunk of json.chunks ?? []) {
        if (chunk.id !== undefined) chunkFiles.set(chunk.id, [...(chunk.files ?? [])]);
      }
      // A concatenated module lists its parts under `modules`; only the outer one knows
      // its chunks, so the parts inherit them.
      const modules: { path: string; size: number; files: string[]; usedBy: string[] }[] = [];
      const walk = (list: StatsModule[] | undefined, inherited: (string | number)[]) => {
        for (const module of list ?? []) {
          const chunks = module.chunks?.length ? module.chunks : inherited;
          if (module.modules) {
            walk(module.modules, chunks);
          } else if (typeof module.nameForCondition === 'string') {
            modules.push({
              path: module.nameForCondition,
              size: module.size ?? 0,
              files: chunks.flatMap((id) => chunkFiles.get(id) ?? []),
              usedBy: [...(usedBy.get(module.nameForCondition) ?? [])].sort(),
            });
          }
        }
      };
      walk(json.modules, []);
      fs.mkdirSync(path.dirname(this.outFile), { recursive: true });
      fs.writeFileSync(this.outFile, `${JSON.stringify({ modules }, null, 1)}\n`);
    });
  }

  /** Walks the import graph from every entry; keyed by `nameForCondition` like the list. */
  private packagesByModule(compilation: Compilation): Map<string, Set<string>> {
    const { moduleGraph } = compilation;
    const subPackages = subPackagesOf(compilation);
    const result = new Map<string, Set<string>>();
    for (const [entryName, entry] of compilation.entries) {
      const pkg = subPackages.find(({ root }) => entryName.startsWith(`${root}/`))?.name ?? 'main';
      const seen = new Set<Module>();
      const queue: Module[] = [];
      for (const dependency of entry.dependencies) {
        const module = moduleGraph.getModule(dependency);
        if (module) queue.push(module);
      }
      for (let module = queue.pop(); module; module = queue.pop()) {
        if (seen.has(module)) continue;
        seen.add(module);
        const name = module.nameForCondition();
        if (name) {
          const packages = result.get(name) ?? new Set<string>();
          packages.add(pkg);
          result.set(name, packages);
        }
        // Scope hoisting moves the root's outside imports onto the concatenated module; its
        // parts keep their own.
        const parts = (module as Module & { modules?: Iterable<Module> }).modules;
        if (parts) queue.push(...parts);
        for (const connection of moduleGraph.getOutgoingConnections(module)) {
          // An import tree shaking removed does not ship the module it names. A stylesheet's
          // import looks removed (mini-css-extract leaves an empty module behind), but its
          // rules ship with its importer.
          const target = connection.module;
          if (
            target &&
            (connection.isTargetActive(undefined) || STYLE.test(target.nameForCondition() ?? ''))
          ) {
            queue.push(target);
          }
        }
      }
    }
    return result;
  }
}

/** The sub-packages the build's emitted `app.json` declares (none in an H5 build). */
function subPackagesOf(compilation: Compilation): { root: string; name: string }[] {
  const file = path.join(compilation.outputOptions.path ?? '', 'app.json');
  if (!fs.existsSync(file)) return [];
  const app = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    subPackages?: { root: string; name?: string }[];
    subpackages?: { root: string; name?: string }[];
  };
  return (app.subPackages ?? app.subpackages ?? []).map(({ root, name }) => ({
    root: root.replace(/\/+$/, ''),
    name: name ?? root,
  }));
}
