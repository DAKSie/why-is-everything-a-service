/** Map Anki tags like " Module-6 " → module number, or null if out of scope. */
export function moduleFromAnkiTags(tags: string): number | null {
  const matches = [...tags.matchAll(/\bModule-(\d+)\b/gi)];
  if (matches.length === 0) return null;
  const modules = [...new Set(matches.map((m) => Number(m[1])))];
  const inScope = modules.filter((m) => m >= 6 && m <= 10);
  if (inScope.length === 1) return inScope[0]!;
  if (inScope.length === 0) return null;
  // Ambiguous multi-module tags in scope — treat as unmappable.
  return null;
}

export function isModulesSixToTen(tags: string): boolean {
  return moduleFromAnkiTags(tags) !== null;
}
