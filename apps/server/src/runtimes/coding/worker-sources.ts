import { dirname, join } from 'node:path'

/** `dir` and every parent up to the file system root: where a CLI looks for per-folder instructions. */
export function ancestors(dir: string): string[] {
  const chain: string[] = []
  for (let at = dir; ; at = dirname(at)) {
    chain.push(at)
    if (dirname(at) === at) break
  }
  return chain
}

/** The same file name in every folder of the chain. */
export const inChain = (dir: string, ...parts: string[]): string[] =>
  ancestors(dir).map((folder) => join(folder, ...parts))
