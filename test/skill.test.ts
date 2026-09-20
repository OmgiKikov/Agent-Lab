import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

// Guide semantics are verified by fresh reference-application and native walkthroughs.
// This test protects the distributable resource boundary, not its prose wording.
test('packaged Pi skill configuration discovers agent-builder and its local reference links resolve', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'agent-builder-package-'));
  try {
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: join(directory, 'agent'),
      settingsManager: SettingsManager.inMemory({ packages: [], enableAnalytics: false, enableInstallTelemetry: false }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalSkillPaths: manifest.pi.skills.map((path: string) => resolve(root, path)),
    });
    await loader.reload();
    const loaded = loader.getSkills();
    assert.deepEqual(loaded.diagnostics, []);
    const skill = loaded.skills.find(s => s.name === 'agent-builder');
    assert.ok(skill, 'package.pi.skills must discover the shipped skill');
    assert.ok(skill.description.length > 0, 'Pi needs a usable frontmatter description');
    const packaged = (path: string) => manifest.files.some((entry: string) => path === entry || path.startsWith(`${entry}/`));
    assert.ok(packaged(relative(root, skill.filePath)));
    const verification = 'docs/superpowers/scenario-lab-verification.md';
    assert.ok(packaged(verification), 'README verification record must ship with the package');
    await access(join(root, verification));
    const text = await readFile(skill.filePath, 'utf8');
    const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]!);
    assert.ok(links.length > 0, 'the guide links its adapter/API references');
    for (const link of links) {
      const url = new URL(link, `file://${skill.filePath}`);
      if (url.protocol !== 'file:') continue;
      const path = fileURLToPath(url);
      await access(path);
      assert.ok(packaged(relative(root, path)), `Reference must ship in npm package: ${link}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
