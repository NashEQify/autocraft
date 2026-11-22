// Validation of the fix patches that security fixes return. Pure text checks.
import { MAX_CHANGED_LINES, editable, extractDiff, validatePatch, type BuildScripts } from "../fixup/patch.ts";
import { patchFor, patchProblem } from "../verify/plan.ts";

export { editable };

export type FixPatch = {
  /** The fix and the test file, canonical, for the head task. */
  patch: string;
  /** Only the test file, for the base task. */
  testPatch: string;
  files: string[];
  changed: number;
};
export type FixPatchCheck = ({ ok: true } & FixPatch) | { ok: false; reason: string };

/**
 * Splits the reply into edits of the `allowed` files and one new `testPath`. The test file is rebuilt from
 * its added lines so the stored patch has the canonical header; everything else goes through validatePatch.
 */
export function validateFixPatch(text: string, allowed: string[], testPath: string, crateDir: string, test: string, scripts: BuildScripts = null): FixPatchCheck {
  const diff = extractDiff(text);
  if (!diff.startsWith("diff --git ")) return { ok: false, reason: "the reply is not a unified diff" };
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.trim());
  const edits: string[] = [];
  let testChunk: string | null = null;
  for (const c of chunks) {
    const head = c.split("\n", 1)[0]!;
    if (head === `diff --git a/${testPath} b/${testPath}`) {
      if (testChunk !== null) return { ok: false, reason: "the test file appears twice" };
      testChunk = c;
    } else edits.push(c);
  }
  if (testChunk === null) return { ok: false, reason: `the diff does not add ${testPath}` };
  if (!edits.length) return { ok: false, reason: "the diff changes no source file" };
  const fix = validatePatch(edits.join(""), allowed, (p) => editable(p, scripts));
  if (!fix.ok) return fix;
  const lines = testChunk.replace(/\n$/, "").split("\n").filter((l) => !/^index [0-9a-f]+\.\.[0-9a-f]+$/.test(l));
  const canon = lines.join("\n") + "\n";
  const bad = patchProblem(canon, testPath);
  if (bad) return { ok: false, reason: `test file: ${bad}` };
  const content = lines.slice(5).map((l) => l.slice(1)).join("\n");
  const testPatch = patchFor(crateDir, test, content);
  if (testPatch !== canon) return { ok: false, reason: "test file: not a plain new file" };
  const testLines = lines.length - 5;
  const changed = fix.changed + testLines;
  if (changed > MAX_CHANGED_LINES) return { ok: false, reason: `${changed} changed lines, over the limit of ${MAX_CHANGED_LINES}` };
  return { ok: true, patch: fix.patch + testPatch, testPatch, files: fix.files, changed };
}
