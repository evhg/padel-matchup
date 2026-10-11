/**
 * What each page's client components translate in the browser, read from the source.
 *
 * The browser gets only the messages a page hands its provider (`withClientMessages` in
 * src/i18n/withClientMessages.tsx). A key the browser does not hold renders as its own path ("me.title")
 * and logs MISSING_MESSAGE, which is the notification-that-showed-its-own-key lesson in the ship skill.
 * This walk is how tests/client-messages.test.ts knows, before anything runs, what each page needs:
 *
 *   1. From each route file (page, layout, not-found, error) it follows the server's imports to the
 *      first "use client" modules, then every module those import for the browser. A "use server"
 *      module stops both walks: the browser holds only a reference to an action. A local import it
 *      cannot resolve, and an `import()` of a path built at run time, are errors: the module behind
 *      either would reach the browser unread. So is a JavaScript module in the browser's set.
 *   2. In every module the browser loads, it finds each translator (`useTranslations(ns)` bound to a
 *      const) and each place the translator goes. The hook is known by what it resolves to, so one
 *      passed on by a file of our own, under any name, is still the hook. A call `t(key)` is a key. A
 *      translator handed to a function as an argument is followed into that function's parameter
 *      (levelText's helpers). Any other road out (a JSX prop, an object, a return, `t.rich`, `t.raw`,
 *      `t.has`) is an error, because a key used past it cannot be seen.
 *   3. A key is a string literal, a conditional of keys, or a cast of one. Anything else is a dynamic
 *      key, and must be named in the guard's table with what it can be. Where the type checker can
 *      list what a dynamic key may be (a union of string literals), every member must match the table.
 *      Where a template or its type fixes how the key starts or ends, every entry must fit that.
 *
 * tests/fixtures/client-messages holds one page for each way a translator once got past this walk.
 *
 * It counts imports, not what renders, so a list can be a little wider than a page needs. It never
 * comes out narrower.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

/** What a dynamic key can be, relative to its translator: "a.b" one key, "a.b.*" or "a.b_*" every key that starts so. */
export type DynamicTable = Record<string, Record<string, readonly string[]>>;

export type Need = { kind: "key" | "prefix"; path: string; at: string };
export type Problem = { at: string; message: string };
export type Entry = {
  file: string;
  /** The list given to `withClientMessages`, or null when the default export is not wrapped. */
  declared: string[] | null;
  clientRoots: string[];
  needs: Need[];
};

// ---- the module graph ------------------------------------------------------------------------------

const EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];
/** What the translator analysis reads. A JavaScript module in the browser's closure is a problem instead. */
const TS_FILE = /\.(tsx?|mts)$/;
function walkDir(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(p, out);
    else if (EXTS.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

const kindOf = (f: string) => (f.endsWith(".tsx") ? ts.ScriptKind.TSX : f.endsWith(".jsx") ? ts.ScriptKind.JSX : /\.m?js$/.test(f) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const parsed = new Map<string, ts.SourceFile>();
function parse(f: string): ts.SourceFile {
  let s = parsed.get(f);
  if (!s) {
    s = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, kindOf(f));
    parsed.set(f, s);
  }
  return s;
}

export function directive(f: string): string | null {
  const first = parse(f).statements[0];
  return first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) ? first.expression.text : null;
}

/** One walk's view of the source: where `@/` points, and what each file it read imports. */
type Graph = { src: string; imports: Map<string, { files: string[]; problems: Problem[] }> };

/** The module a local specifier names, "asset" for a file that is not code (CSS, JSON), or null. */
function resolveSpec(g: Graph, from: string, spec: string): string | "asset" | null {
  const base = spec.startsWith("@/") ? path.join(g.src, spec.slice(2)) : path.resolve(path.dirname(from), spec);
  for (const c of [base, ...EXTS.map((x) => base + x), ...EXTS.map((x) => path.join(base, "index" + x))]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile() && EXTS.some((x) => c.endsWith(x))) return c;
  }
  return fs.existsSync(base) && fs.statSync(base).isFile() ? "asset" : null;
}

/**
 * The modules a file loads at run time: type-only imports are skipped, `import()` counts. A local
 * specifier the walk cannot resolve, and an `import()` of a path built at run time, are problems: the
 * module behind either would load in the browser with nobody reading its keys.
 */
function imports(g: Graph, f: string): string[] {
  const cached = g.imports.get(f);
  if (cached) return cached.files;
  const files: string[] = [];
  const problems: Problem[] = [];
  const add = (spec: string, at: ts.Node) => {
    if (!spec.startsWith("@/") && !spec.startsWith(".")) return; // a package
    const r = resolveSpec(g, f, spec);
    if (r === null) problems.push({ at: lineOf(at), message: `an import the guard cannot resolve: "${spec}"` });
    else if (r !== "asset") files.push(r);
  };
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n)) {
      const ic = n.importClause;
      const typeOnly =
        ic && (ic.isTypeOnly || (!ic.name && ic.namedBindings && ts.isNamedImports(ic.namedBindings) && ic.namedBindings.elements.length > 0 && ic.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier.text, n);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && !n.isTypeOnly && ts.isStringLiteral(n.moduleSpecifier)) {
      add(n.moduleSpecifier.text, n);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) add(arg.text, n);
      // `import(`../../messages/${locale}.json`)` loads data, not code (src/i18n/config.ts).
      else if (!(arg && ts.isTemplateExpression(arg) && /\.json$/.test(arg.templateSpans.at(-1)!.literal.text)))
        problems.push({ at: lineOf(n), message: "an import() of a path built at run time, which the guard cannot follow; import each module by a string literal" });
    }
    ts.forEachChild(n, visit);
  };
  visit(parse(f));
  g.imports.set(f, { files, problems });
  return files;
}

/** The "use client" modules a route file reaches through the server's imports. */
function clientRootsOf(g: Graph, entry: string): Set<string> {
  const seen = new Set<string>();
  const roots = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const d = directive(f);
    if (d === "use client") {
      roots.add(f);
      continue;
    }
    if (d === "use server" && f !== entry) continue;
    stack.push(...imports(g, f));
  }
  return roots;
}

/** Every module the browser loads for those roots. */
function closureOf(g: Graph, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const r of imports(g, f)) if (directive(r) !== "use server") stack.push(r);
  }
  return seen;
}

/** Route files whose output the browser can see: pages, layouts and the boundaries Next renders in them. */
export function routeFiles(src = SRC): string[] {
  return walkDir(path.join(src, "app"))
    .filter((f) => /\/(page|layout|not-found|error|global-error|loading|template|default)\.tsx$/.test(f))
    .sort();
}

// ---- translators and keys --------------------------------------------------------------------------

const HOOKS_WITH_DEPS = new Set(["useMemo", "useCallback", "useEffect", "useLayoutEffect", "useInsertionEffect", "useImperativeHandle"]);
const FORBIDDEN_IMPORTS = new Set(["useMessages", "useExtracted", "getMessages", "createTranslator", "IntlProvider", "NextIntlClientProvider"]);

type Analysis = { needs: Need[]; problems: Problem[]; dynamicSeen: Set<string> };

function lineOf(node: ts.Node): string {
  const sf = node.getSourceFile();
  return `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
}
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const join = (ns: string, key: string) => (ns ? `${ns}.${key}` : key);

function strip(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

/** The string literals a type stands for, or null when it is not a finite set of them. */
function literalsOf(checker: ts.TypeChecker, e: ts.Expression): string[] | null {
  const t = checker.getTypeAtLocation(e);
  const members = t.isUnion() ? t.types : [t];
  const out: string[] = [];
  for (const m of members) {
    if (!m.isStringLiteral()) return null;
    out.push(m.value);
  }
  return out;
}

export function matchesPattern(value: string, pattern: string): boolean {
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

/** One value a dynamic key can take: a known string, or a template's fixed start and end (`errors.${code}`: "errors." and ""). */
type Shape = { value: string } | { head: string; tail: string };

/** What every value of a dynamic key looks like, from its template or its type; null when neither says. */
function shapesOf(checker: ts.TypeChecker, e: ts.Expression): Shape[] | null {
  if (ts.isTemplateExpression(e)) return [{ head: e.head.text, tail: e.templateSpans.at(-1)!.literal.text }];
  const t = checker.getTypeAtLocation(e);
  const members = t.isUnion() ? t.types : [t];
  if (!members.some((m) => m.flags & ts.TypeFlags.TemplateLiteral)) return null;
  const out: Shape[] = [];
  for (const m of members) {
    if (m.isStringLiteral()) out.push({ value: m.value });
    else if (m.flags & ts.TypeFlags.TemplateLiteral) {
      const texts = (m as ts.TemplateLiteralType).texts;
      out.push({ head: texts[0], tail: texts[texts.length - 1] });
    } else return null;
  }
  return out;
}

/** Whether a DYNAMIC pattern names keys a value of that shape can be at all. */
function patternFits(pattern: string, s: Shape): boolean {
  if ("value" in s) return matchesPattern(s.value, pattern);
  if (!pattern.endsWith("*")) return pattern.length >= s.head.length + s.tail.length && pattern.startsWith(s.head) && pattern.endsWith(s.tail);
  const start = pattern.slice(0, -1);
  return start.startsWith(s.head) || s.head.startsWith(start);
}

class Analyzer {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  private readonly fileCache = new Map<string, Analysis>();

  constructor(
    files: string[],
    private readonly table: DynamicTable,
    src: string,
  ) {
    const cfg = ts.parseJsonConfigFileContent(JSON.parse(fs.readFileSync(path.join(ROOT, "tsconfig.json"), "utf8")), ts.sys, ROOT);
    const paths = { ...cfg.options.paths, "@/*": [path.join(src, "*")] };
    this.program = ts.createProgram([...files, path.join(ROOT, "global.d.ts")], { ...cfg.options, paths, noEmit: true, incremental: false, skipLibCheck: true });
    this.checker = this.program.getTypeChecker();
  }

  /**
   * The name next-intl or use-intl gives the thing a binding stands for, whatever the module it was
   * imported from: `export { useTranslations } from "next-intl"` in a file of our own is still the hook.
   */
  private intlName(symbol: ts.Symbol | undefined): string | undefined {
    const s = symbol && symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
    for (const d of s?.declarations ?? []) {
      if (!/[\\/]node_modules[\\/](next-intl|use-intl)[\\/]/.test(d.getSourceFile().fileName)) continue;
      const n = ts.getNameOfDeclaration(d);
      return n && ts.isIdentifier(n) ? n.text : s!.name;
    }
    return undefined;
  }

  private symbolOf(node: ts.Node): ts.Symbol | undefined {
    const s = this.checker.getSymbolAtLocation(node);
    return s && s.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(s) : s;
  }

  /** Every reference to `symbol` inside `scope`. */
  private refs(scope: ts.Node, symbol: ts.Symbol, declName: ts.Node): ts.Identifier[] {
    const out: ts.Identifier[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && n !== declName && n.text === symbol.name) {
        // `{ t }` names the property; the value it carries is the translator.
        const s = ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n ? this.checker.getShorthandAssignmentValueSymbol(n.parent) : this.checker.getSymbolAtLocation(n);
        if (s === symbol) out.push(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return out;
  }

  /** The keys one expression handed to a translator can be. */
  private keysOf(arg: ts.Expression | undefined, ns: string, a: Analysis, at: ts.Node): void {
    if (!arg) {
      a.problems.push({ at: lineOf(at), message: "a translator called with no key" });
      return;
    }
    const e = strip(arg);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      a.needs.push({ kind: "key", path: join(ns, e.text), at: lineOf(e) });
      return;
    }
    if (ts.isConditionalExpression(e)) {
      this.keysOf(e.whenTrue, ns, a, at);
      this.keysOf(e.whenFalse, ns, a, at);
      return;
    }
    const file = rel(e.getSourceFile().fileName);
    const text = squash(e.getText());
    const listed = this.table[file]?.[text];
    a.dynamicSeen.add(`${file}\u0000${text}`);
    if (!listed) {
      a.problems.push({ at: lineOf(e), message: `a dynamic key the guard does not know: ${text} — add it to DYNAMIC in tests/client-messages.test.ts with what it can be and where that comes from` });
      return;
    }
    // An entry is trusted for what the expression can be, but never for keys its own text rules out:
    // `errors.${code}` listed as "feedback.*" would send feedback and leave every errors.* key behind.
    const shapes = shapesOf(this.checker, e);
    if (shapes) for (const p of listed) if (!shapes.some((s) => patternFits(p, s))) a.problems.push({ at: lineOf(e), message: `${text} can never be "${p}", which its DYNAMIC entry lists` });
    const lits = literalsOf(this.checker, e);
    if (lits) {
      for (const v of lits) if (!listed.some((p) => matchesPattern(v, p))) a.problems.push({ at: lineOf(e), message: `${text} can be "${v}", which its DYNAMIC entry does not cover` });
    }
    for (const p of listed) a.needs.push({ kind: p.endsWith("*") ? "prefix" : "key", path: join(ns, p.endsWith("*") ? p.slice(0, -1) : p), at: lineOf(e) });
  }

  /** Follows a translator wherever its references go. */
  private follow(symbol: ts.Symbol, scope: ts.Node, declName: ts.Node, ns: string, a: Analysis, stack: Set<ts.Node>): void {
    for (const id of this.refs(scope, symbol, declName)) {
      const p = id.parent;
      if (ts.isTypeQueryNode(p)) continue;
      if (ts.isCallExpression(p) && p.expression === id) {
        this.keysOf(p.arguments[0], ns, a, p);
        continue;
      }
      if (ts.isPropertyAccessExpression(p) && p.expression === id) {
        a.problems.push({ at: lineOf(p), message: `t.${p.name.text} reads messages the guard cannot see; use t(key)` });
        continue;
      }
      if (ts.isCallExpression(p) && p.arguments.some((x) => x === id)) {
        const i = p.arguments.findIndex((x) => x === id);
        const fn = this.functionOf(p.expression);
        const param = fn?.parameters[i];
        if (!fn || !param || !ts.isIdentifier(param.name) || !fn.body) {
          a.problems.push({ at: lineOf(p), message: `a translator handed to ${squash(p.expression.getText())}, which the guard cannot follow` });
          continue;
        }
        if (stack.has(param)) continue;
        const psym = this.checker.getSymbolAtLocation(param.name);
        if (!psym) {
          a.problems.push({ at: lineOf(param), message: "a translator's parameter the type checker cannot name" });
          continue;
        }
        stack.add(param);
        this.follow(psym, fn.body, param.name, ns, a, stack);
        stack.delete(param);
        continue;
      }
      // A hook's dependency list holds the translator and calls nothing.
      if (ts.isArrayLiteralExpression(p) && ts.isCallExpression(p.parent) && ts.isIdentifier(p.parent.expression) && HOOKS_WITH_DEPS.has(p.parent.expression.text) && p.parent.arguments.at(-1) === p) continue;
      a.problems.push({ at: lineOf(id), message: `a translator leaves by a ${ts.SyntaxKind[p.kind]}; only t(key) and a helper's parameter can be followed` });
    }
  }

  private functionOf(callee: ts.Expression): ts.FunctionLikeDeclaration | undefined {
    const s = this.symbolOf(callee);
    const d = s?.valueDeclaration ?? s?.declarations?.[0];
    if (!d) return undefined;
    if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) return d;
    if (ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer;
    return undefined;
  }

  /** Every key one module translates in the browser, and every road out the guard cannot follow. */
  analyse(file: string): Analysis {
    const cached = this.fileCache.get(file);
    if (cached) return cached;
    const a: Analysis = { needs: [], problems: [], dynamicSeen: new Set() };
    this.fileCache.set(file, a);
    const sf = this.program.getSourceFile(file);
    if (!sf) {
      a.problems.push({ at: rel(file), message: "not in the program" });
      return a;
    }
    const hooks = new Set<ts.Symbol>();
    const hookNames = new Set<string>();
    const reads = (n: string | undefined) => n === "useTranslations" || (n !== undefined && FORBIDDEN_IMPORTS.has(n));
    for (const st of sf.statements) {
      // Every import, not only next-intl's: a file of our own can pass the hook on under any name.
      if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.isTypeOnly) continue;
      const ic = st.importClause;
      const nb = ic.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) {
        const mod = this.checker.getSymbolAtLocation(st.moduleSpecifier);
        if (mod && this.checker.getExportsOfModule(mod).some((x) => reads(this.intlName(x))))
          a.problems.push({ at: lineOf(st), message: `a namespace import of ${st.moduleSpecifier.getText()}, which holds next-intl's readers; import useTranslations by name` });
      }
      const bindings = [...(ic.name ? [ic.name] : []), ...(nb && ts.isNamedImports(nb) ? nb.elements.filter((el) => !el.isTypeOnly).map((el) => el.name) : [])];
      for (const b of bindings) {
        const s = this.checker.getSymbolAtLocation(b);
        const imported = this.intlName(s);
        if (imported && FORBIDDEN_IMPORTS.has(imported)) a.problems.push({ at: lineOf(b), message: `${imported} in code the browser runs hands it messages the guard cannot see` });
        if (imported === "useTranslations" && s) {
          hooks.add(s);
          hookNames.add(b.text);
        }
      }
    }
    if (!hooks.size) return a;
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && hookNames.has(n.text) && !ts.isImportSpecifier(n.parent) && !ts.isImportClause(n.parent)) {
        const s = this.checker.getSymbolAtLocation(n);
        if (s && hooks.has(s)) {
          const call = n.parent;
          if (!ts.isCallExpression(call) || call.expression !== n) {
            a.problems.push({ at: lineOf(n), message: "useTranslations used other than as a call" });
          } else {
            const arg = call.arguments[0] && strip(call.arguments[0]);
            const ns = !arg ? "" : ts.isStringLiteralLike(arg) ? arg.text : null;
            const decl = call.parent;
            if (ns === null) a.problems.push({ at: lineOf(call), message: "useTranslations with a namespace that is not a string literal" });
            else if (!ts.isVariableDeclaration(decl) || decl.initializer !== call || !ts.isIdentifier(decl.name)) a.problems.push({ at: lineOf(call), message: "useTranslations not bound to a const" });
            else {
              const sym = this.checker.getSymbolAtLocation(decl.name);
              if (sym) this.follow(sym, sf, decl.name, ns, a, new Set());
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return a;
  }
}

/** The default export's wrapper, if any: `export default withClientMessages([...], Page)`. */
function declaredList(file: string): { list: string[] | null; problem?: string } {
  const sf = parse(file);
  for (const st of sf.statements) {
    if (!ts.isExportAssignment(st)) continue;
    const e = st.expression;
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== "withClientMessages") return { list: null };
    const arr = e.arguments[0];
    if (!arr || !ts.isArrayLiteralExpression(arr) || !arr.elements.every((x) => ts.isStringLiteral(x))) return { list: null, problem: "withClientMessages takes an array of string literals" };
    return { list: arr.elements.map((x) => (x as ts.StringLiteral).text) };
  }
  return { list: null };
}

export type Report = { entries: Entry[]; problems: Problem[]; staleDynamic: string[]; clientFiles: string[] };

/** `src`: the tree to walk, for the guard's own tests (tests/fixtures/client-messages); `@/` points into it. */
export function analyseClientMessages(table: DynamicTable, src = SRC): Report {
  const g: Graph = { src, imports: new Map() };
  const entries = routeFiles(src);
  const rootsByEntry = new Map(entries.map((e) => [e, clientRootsOf(g, e)]));
  const all = new Set<string>();
  for (const roots of rootsByEntry.values()) for (const f of closureOf(g, roots)) all.add(f);
  const analyzer = new Analyzer([...all].filter((f) => TS_FILE.test(f)), table, src);
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const out: Entry[] = [];
  const reported = new Set<string>();
  const report = (p: Problem) => {
    const k = `${p.at}\u0000${p.message}`;
    if (!reported.has(k)) {
      reported.add(k);
      problems.push(p);
    }
  };
  // Every file either walk read, on the server's side or the browser's.
  for (const { problems: ps } of g.imports.values()) ps.forEach(report);
  for (const e of entries) {
    const roots = rootsByEntry.get(e)!;
    const needs: Need[] = [];
    for (const f of closureOf(g, roots)) {
      if (!TS_FILE.test(f)) {
        report({ at: rel(f), message: "a JavaScript module the browser runs; the guard reads translators in TypeScript only, so make it .ts or .tsx" });
        continue;
      }
      const a = analyzer.analyse(f);
      needs.push(...a.needs);
      for (const d of a.dynamicSeen) seen.add(d);
      a.problems.forEach(report);
    }
    const { list, problem } = declaredList(e);
    if (problem) problems.push({ at: rel(e), message: problem });
    out.push({ file: rel(e), declared: list, clientRoots: [...roots].map(rel).sort(), needs });
  }
  const staleDynamic: string[] = [];
  for (const [file, exprs] of Object.entries(table)) for (const expr of Object.keys(exprs)) if (!seen.has(`${file}\u0000${expr}`)) staleDynamic.push(`${file}: ${expr}`);
  return { entries: out, problems, staleDynamic, clientFiles: [...all].map(rel).sort() };
}

// ---- messages --------------------------------------------------------------------------------------

export function leavesOf(messages: Record<string, unknown>, prefix = "", out: string[] = []): string[] {
  for (const [k, v] of Object.entries(messages)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") leavesOf(v as Record<string, unknown>, p, out);
    else out.push(p);
  }
  return out;
}

/** The leaf keys one need stands for. */
export function leavesFor(need: Pick<Need, "kind" | "path">, leaves: readonly string[]): string[] {
  return need.kind === "key" ? leaves.filter((l) => l === need.path || l.startsWith(need.path + ".")) : leaves.filter((l) => l.startsWith(need.path));
}

export const covers = (paths: readonly string[], leaf: string) => paths.some((p) => leaf === p || leaf.startsWith(p + "."));

/**
 * The list a page should give: each top-level namespace it needs, except the ones in `split`, which
 * are given one level down ("coach.page"), because `coach` alone is a sixth of the catalogue.
 */
export function listFor(leaves: Iterable<string>, split: readonly string[], skip: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const l of leaves) {
    if (covers(skip, l)) continue;
    const parts = l.split(".");
    out.add(split.includes(parts[0]) && parts.length > 2 ? parts.slice(0, 2).join(".") : split.includes(parts[0]) ? l : parts[0]);
  }
  return [...out].sort();
}
