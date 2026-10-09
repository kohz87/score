import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Dev and e2e only: each fake agent gets a small temp-dir workspace, created on first use and removed when the
// process exits. Neutral example content only; `.env` is there to show the blocked list hides it.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==',
  'base64',
)

export class FakeWorkspaces {
  private base: string | undefined
  private readonly cwds = new Map<string, string>()
  private readonly exitHook = () => this.dispose()

  /** Agents with a remote terminal backend, to exercise the unavailable state. */
  backendOf(agentId: string): string {
    return agentId === 'designer' ? 'docker' : 'local'
  }

  cwdOf(agentId: string): string | null {
    const set = this.cwds.get(agentId)
    if (set !== undefined) return set
    if (this.backendOf(agentId) !== 'local') return '/workspace'
    if (!this.base) {
      this.base = fs.mkdtempSync(path.join(os.tmpdir(), 'score-fake-ws-'))
      process.once('exit', this.exitHook)
    }
    const dir = path.join(this.base, agentId)
    if (!fs.existsSync(dir)) this.seed(dir, agentId)
    this.cwds.set(agentId, dir)
    return dir
  }

  set(agentId: string, cwd: string): void {
    this.cwds.set(agentId, cwd)
  }

  private seed(dir: string, agentId: string): void {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'notes'))
    fs.mkdirSync(path.join(dir, '.git'))
    fs.writeFileSync(
      path.join(dir, 'README.md'),
      `# ${agentId} workspace\n\nExample project files.\n`,
    )
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), "export const hello = 'world'\n")
    fs.writeFileSync(
      path.join(dir, 'notes', 'todo.md'),
      '- [ ] write the report\n- [ ] review the plan\n',
    )
    fs.writeFileSync(path.join(dir, 'logo.png'), PNG_1X1)
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n')
    fs.writeFileSync(path.join(dir, '.env'), 'EXAMPLE_TOKEN=not-a-real-secret\n')
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  }

  dispose(): void {
    process.removeListener('exit', this.exitHook)
    if (this.base) fs.rmSync(this.base, { recursive: true, force: true })
    this.base = undefined
    this.cwds.clear()
  }
}
