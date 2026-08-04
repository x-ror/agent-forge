/**
 * Prompt templating over the flow context (§7.1): `{{task.title}}`,
 * `{{steps.implement.diff_summary}}`. Missing paths render as ''.
 * Shared by the engine (server) and canvas preview (frontend).
 */
export function renderTemplate(template: string, context: unknown): string {
  return template.replace(/\{\{\s*([\w.$-]+(?:\.[\w.$-]+)*)\s*\}\}/g, (_match, path: string) => {
    const value = path.split('.').reduce<unknown>((acc, key) => (acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), context);
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/** Referenced `{{…}}` paths — used by the canvas for validation hints. */
export function templatePaths(template: string): string[] {
  const paths: string[] = [];
  for (const match of template.matchAll(/\{\{\s*([\w.$-]+(?:\.[\w.$-]+)*)\s*\}\}/g)) {
    paths.push(match[1]!);
  }
  return paths;
}
