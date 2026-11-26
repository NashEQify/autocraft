// Kept free of Node imports: the prompt registry and the web build read it.
export type PremergeFinding = {
  severity: "defect" | "minor";
  file: string;
  line: number;
  title: string;
  scenario: string;
  fix?: { file: string; change: string };
};

/** What the fix-up is told to change for a defect: the review's own fix, or, when it wrote none, the defect itself (title and scenario) in its file. */
export const defectFix = (d: PremergeFinding): { file: string; change: string } => d.fix ?? { file: d.file, change: `${d.title}: ${d.scenario}` };
