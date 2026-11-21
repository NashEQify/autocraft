import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "ts5";
import { fnName } from "../scripts/codemod-async.ts";

// A promise in an expression statement runs unobserved: its rejection is unhandled and the code after it does not wait for it.
// Deliberate fire-and-forget sites are written `void p` or listed in test/floating-promises.allow (file :: function :: statement).
const root = resolve(new URL("..", import.meta.url).pathname);
const ALLOW = resolve(root, "test/floating-promises.allow");

export function floatingPromises(): string[] {
  const cfg = ts.getParsedCommandLineOfConfigFile(resolve(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!cfg) throw new Error("cannot read tsconfig.json");
  const program = ts.createProgram(cfg.fileNames, cfg.options);
  const checker = program.getTypeChecker();
  // node:test's test() and describe() return promises that the runner itself tracks.
  const fromNodeTest = (e: ts.Expression) => ts.isCallExpression(e) && !!checker.getResolvedSignature(e)?.getDeclaration()?.getSourceFile().fileName.endsWith("/@types/node/test.d.ts");
  const thenable = (t: ts.Type): boolean => !(t.flags & ts.TypeFlags.Any) && (t.isUnion() ? t.types : [t]).some((x) => !!x.getProperty("then"));
  const found: string[] = [];
  for (const sf of program.getSourceFiles()) {
    const rel = relative(root, sf.fileName);
    if (sf.isDeclarationFile || rel.startsWith("..") || rel.includes("node_modules")) continue;
    const visit = (n: ts.Node) => {
      if (ts.isExpressionStatement(n)) {
        let e = n.expression;
        while (ts.isParenthesizedExpression(e)) e = e.expression;
        const assign = ts.isBinaryExpression(e) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken].includes(e.operatorToken.kind);
        if (!ts.isAwaitExpression(e) && !ts.isVoidExpression(e) && !assign && !fromNodeTest(e) && thenable(checker.getTypeAtLocation(e))) {
          found.push(`${rel} :: ${fnName(n)} :: ${n.getText(sf).replace(/\s+/g, " ").slice(0, 100).trim()}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return found.sort();
}

test("no promise floats unawaited outside the allowlist", () => {
  const allowed = readFileSync(ALLOW, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const left = [...allowed];
  const unexpected: string[] = [];
  for (const f of floatingPromises()) {
    const i = left.indexOf(f);
    if (i >= 0) left.splice(i, 1);
    else unexpected.push(f);
  }
  assert.deepEqual({ unexpected, stale: left }, { unexpected: [], stale: [] }, "await these, write `void` for deliberate fire-and-forget, or list them in test/floating-promises.allow; drop stale entries");
});
