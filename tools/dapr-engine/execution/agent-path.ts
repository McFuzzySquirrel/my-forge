import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Manifest agent paths point at the registered checkout. Execution happens in a
 * disposable clone or worktree, so a path inside the registered repository must
 * be rewritten into the execution workspace before the harness resolves it.
 */
export function remapAgentPath<T extends { readonly path: string }>(
  agent: T,
  repositoryPath: string,
  workspacePath: string,
): T {
  if (!agent.path) return agent;
  const relativePath = isAbsolute(agent.path)
    ? relative(repositoryPath, agent.path)
    : agent.path;
  if (!relativePath
    || isAbsolute(relativePath)
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)) return agent;
  return { ...agent, path: join(workspacePath, relativePath) } as T;
}
