/**
 * paths.ts — the security boundary: project-dir resolution refusals, docs/
 * containment (traversal + symlink escape), the extension allowlist, and the
 * .git refusal. Uses throwaway mkdtemp trees (symlinks can't live in fixtures).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  setProjectDir,
  assertArtifactPath,
  safeStaticPath,
  isValidSlug,
  contentTypeFor,
} from '../paths.ts'

const REPO_ROOT = resolve(import.meta.dir, '..', '..') // the plugin's own root

let tmp: string
let outside: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sdd-paths-'))
  outside = mkdtempSync(join(tmpdir(), 'sdd-outside-'))
  mkdirSync(join(tmp, 'docs', 'features', 'demo'), { recursive: true })
  writeFileSync(join(tmp, 'docs', 'features', 'demo', 'spec.md'), '# demo\n')
  writeFileSync(join(outside, 'secret.md'), 'leak me\n')
  setProjectDir(tmp)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('setProjectDir refusals', () => {
  it('rejects a nonexistent dir', () => {
    expect(() => setProjectDir(join(tmp, 'nope'))).toThrow(/does not exist/)
  })

  it('rejects a dir with no docs/ or .git marker', () => {
    const bare = mkdtempSync(join(tmpdir(), 'sdd-bare-'))
    try {
      expect(() => setProjectDir(bare)).toThrow(/not a project root/)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it("rejects the plugin's own root as the project", () => {
    expect(() => setProjectDir(REPO_ROOT)).toThrow(/plugin/)
  })
})

describe('assertArtifactPath containment', () => {
  it('resolves a real artifact inside the feature dir', () => {
    const abs = assertArtifactPath('demo', 'spec.md')
    expect(abs).toBe(realpathSync(join(tmp, 'docs', 'features', 'demo', 'spec.md')))
  })

  it('rejects absolute paths', () => {
    expect(() => assertArtifactPath('demo', '/etc/passwd.md')).toThrow(/must be relative/)
  })

  it('rejects .. traversal', () => {
    expect(() => assertArtifactPath('demo', '../../../etc/passwd.md')).toThrow(/traversal/)
  })

  it('rejects an invalid slug', () => {
    expect(() => assertArtifactPath('Bad Slug', 'spec.md')).toThrow(/invalid slug/)
    expect(isValidSlug('ok-slug')).toBe(true)
    expect(isValidSlug('../x')).toBe(false)
  })

  it('rejects a disallowed extension, allows the .size basename', () => {
    expect(() => assertArtifactPath('demo', 'evil.sh')).toThrow(/extension not allowed/)
    writeFileSync(join(tmp, 'docs', 'features', 'demo', '.size'), 'XS\n')
    expect(assertArtifactPath('demo', '.size')).toContain('demo')
  })

  it('refuses a missing artifact (the API is read-only — no write anchoring)', () => {
    expect(() => assertArtifactPath('demo', 'not-written-yet.md')).toThrow(/no such artifact/)
  })

  it('rejects a symlinked FILE escaping docs/', () => {
    symlinkSync(join(outside, 'secret.md'), join(tmp, 'docs', 'features', 'demo', 'leak.md'))
    expect(() => assertArtifactPath('demo', 'leak.md')).toThrow(/escapes docs/)
  })

  it('rejects a file reached through a symlinked DIR escaping docs/', () => {
    symlinkSync(outside, join(tmp, 'docs', 'features', 'demo', 'sub'))
    expect(() => assertArtifactPath('demo', 'sub/secret.md')).toThrow(/escapes docs/)
  })

  it('refuses anything under a .git dir', () => {
    mkdirSync(join(tmp, 'docs', '.git'), { recursive: true })
    writeFileSync(join(tmp, 'docs', '.git', 'config.md'), 'x\n')
    expect(() => assertArtifactPath(null, '.git/config.md')).toThrow(/\.git/)
  })

  it('resolves a docs-root file when slug is null (roadmap.md)', () => {
    writeFileSync(join(tmp, 'docs', 'roadmap.md'), '# r\n')
    expect(assertArtifactPath(null, 'roadmap.md')).toBe(
      realpathSync(join(tmp, 'docs', 'roadmap.md')),
    )
  })
})

describe('safeStaticPath', () => {
  it('serves a real file, refuses traversal / missing / directory', () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'sdd-static-'))
    try {
      writeFileSync(join(staticRoot, 'index.html'), '<html></html>')
      mkdirSync(join(staticRoot, 'sub'))
      expect(safeStaticPath(staticRoot, '/index.html')).toBe(join(staticRoot, 'index.html'))
      expect(safeStaticPath(staticRoot, '/../../etc/passwd')).toBeNull()
      expect(safeStaticPath(staticRoot, '/missing.js')).toBeNull()
      expect(safeStaticPath(staticRoot, '/sub')).toBeNull()
    } finally {
      rmSync(staticRoot, { recursive: true, force: true })
    }
  })
})

describe('contentTypeFor', () => {
  it('maps by name', () => {
    expect(contentTypeFor('/x/spec.md')).toContain('text/markdown')
    expect(contentTypeFor('/x/openapi.yaml')).toContain('application/yaml')
    expect(contentTypeFor('/x/tasks.json')).toContain('application/json')
    expect(contentTypeFor('/x/.size')).toContain('text/plain')
  })
})
