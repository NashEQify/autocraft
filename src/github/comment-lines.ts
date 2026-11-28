// The lines of a GitHub comment a reader sees as the commenter's own words. Quoted lines (`> ...`), fenced and indented code and
// HTML comments come back as empty strings, so quoting or hiding a command runs nothing and line positions stay as written.

/**
 * Each line of `body`, trimmed, or "" when it is hidden: inside an HTML comment, a fenced code block or indented code, or a quote.
 * A fence closes as CommonMark closes it: the opening character, at least as many of it, and nothing after but spaces.
 */
export function commentLines(body: string): string[] {
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  let comment = false;
  for (const raw of body.split(/\r?\n/)) {
    let text = raw;
    if (!fence) {
      if (comment) {
        const end = text.indexOf("-->");
        if (end < 0) { out.push(""); continue; }
        comment = false;
        text = text.slice(end + 3);
      }
      text = text.replace(/<!--[\s\S]*?-->/g, "");
      const open = text.indexOf("<!--");
      if (open >= 0) { comment = true; text = text.slice(0, open); }
    }
    const line = text.trim();
    const f = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence.ch && f.length >= fence.len && line.slice(f.length).trim() === "") fence = null;
      out.push("");
      continue;
    }
    if (f) { fence = { ch: f[0]!, len: f.length }; out.push(""); continue; }
    // Indented code: four columns of leading space, a tab counting up to the next multiple of four.
    if (/^(?: {4}| {0,3}\t)/.test(text) || line.startsWith(">")) { out.push(""); continue; }
    out.push(line);
  }
  return out;
}
