import type Database from 'better-sqlite3';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectManager } from '../../src/projects/manager.js';
import { ProjectManagerError } from '../../src/projects/types.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';

let tempDir = '';
let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('project manager', () => {
  it('ensures one default project inside the managed OpenCreator directory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-default-project-'));
    const managedProjectRoot = join(tempDir, 'Documents', 'OpenCreator');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    let nextId = 0;
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => `project_default_${++nextId}`
    });

    const first = manager.ensureDefaultProject();
    const repeated = manager.ensureDefaultProject();

    expect(first).toMatchObject({
      id: 'project_default_1',
      name: 'Default project',
      cwd: join(managedProjectRoot, 'Default Project'),
      directoryState: 'available'
    });
    expect(repeated).toEqual(first);
    expect(existsSync(join(managedProjectRoot, 'Default Project'))).toBe(true);
    expect(manager.listProjects('all')).toEqual([first]);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM projects').get()
    ).toEqual({ count: 1 });
  });

  it('creates named projects with generated directories inside the managed OpenCreator directory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-managed-project-'));
    const managedProjectRoot = join(tempDir, 'Documents', 'OpenCreator');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => 'project_managed'
    });

    const created = manager.createManagedProject({ name: ' 产品官网 ' });

    expect(created).toMatchObject({
      id: 'project_managed',
      name: '产品官网',
      cwd: expect.stringMatching(new RegExp(join(managedProjectRoot, 'project-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
      directoryState: 'available'
    });
    expect(existsSync(created.cwd)).toBe(true);
  });

  it('uses the latest configured root for newly managed projects', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-managed-project-root-'));
    const firstRoot = join(tempDir, 'first');
    const secondRoot = join(tempDir, 'second');
    let currentRoot = firstRoot;
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    let id = 0;
    const manager = createProjectManager({
      db,
      resolveManagedProjectRoot: () => currentRoot,
      idFactory: () => `project_dynamic_${++id}`
    });

    const first = manager.createManagedProject({ name: 'First' });
    currentRoot = secondRoot;
    const second = manager.createManagedProject({ name: 'Second' });

    expect(first.cwd.startsWith(firstRoot)).toBe(true);
    expect(second.cwd.startsWith(secondRoot)).toBe(true);
  });

  it('removes a newly created empty directory when registration fails', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-managed-project-'));
    const managedProjectRoot = join(tempDir, 'Documents', 'OpenCreator');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => ''
    });

    expect(() => manager.createManagedProject({ name: '未注册项目' }))
      .toThrow('Unable to allocate a unique project id');
    expect(readdirSync(managedProjectRoot)).toEqual([]);
  });

  it('rejects invalid managed project names and generates unique directories for duplicates', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-managed-project-'));
    const managedProjectRoot = join(tempDir, 'Documents', 'OpenCreator');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({ db, managedProjectRoot });

    for (const name of ['', '   ', '.', '..', 'nested/project', 'nested\\project']) {
      expect(() => manager.createManagedProject({ name })).toThrowError(
        expect.objectContaining({ code: 'PROJECT_NAME_INVALID' })
      );
    }

    const first = manager.createManagedProject({ name: '重复项目' });
    const second = manager.createManagedProject({ name: '重复项目' });

    expect(first.name).toBe('重复项目');
    expect(second.name).toBe('重复项目');
    expect(first.cwd).not.toBe(second.cwd);
    expect(existsSync(first.cwd)).toBe(true);
    expect(existsSync(second.cwd)).toBe(true);
  });

  it('persists projects and preserves a missing migrated directory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-project-'));
    const projectDir = join(tempDir, 'workspace');
    mkdirSync(projectDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => 'project_generated'
    });

    const created = manager.createProject({
      cwd: projectDir,
      name: 'Workspace'
    });
    const missing = manager.createMigratedProject({
      preferredId: 'legacy_missing',
      cwd: join(tempDir, 'missing'),
      name: 'Missing'
    });

    expect(created).toMatchObject({
      id: 'project_generated',
      cwd: projectDir,
      canonicalCwd: realpathSync(projectDir),
      directoryState: 'available',
      profile: 'default',
      sandbox: 'follow-global',
      status: 'active'
    });
    expect(missing).toMatchObject({
      id: 'legacy_missing',
      canonicalCwd: null,
      directoryState: 'missing'
    });

    db.close();
    db = undefined;
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const reopened = createProjectManager({ db, homeDir: tempDir });
    expect(reopened.getProject(created.id)).toMatchObject({
      id: created.id,
      name: 'Workspace',
      directoryState: 'available'
    });
    expect(reopened.getProject(missing.id)).toMatchObject({
      id: missing.id,
      directoryState: 'missing'
    });
  });

  it('rejects duplicate active canonical directories and detects a removed directory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-project-'));
    const projectDir = join(tempDir, 'workspace');
    mkdirSync(projectDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    let nextId = 0;
    const manager = createProjectManager({
      db,
      idFactory: () => `project_${++nextId}`
    });

    const created = manager.createProject({ cwd: projectDir });
    let duplicateError: unknown;
    try {
      manager.createProject({ cwd: projectDir });
    } catch (error) {
      duplicateError = error;
    }
    expect(duplicateError).toBeInstanceOf(ProjectManagerError);
    expect((duplicateError as ProjectManagerError).code).toBe('PROJECT_DIRECTORY_CONFLICT');

    rmSync(projectDir, { recursive: true });
    expect(manager.getProject(created.id)?.directoryState).toBe('missing');
  });

  it('returns SQLite UTC timestamps as timezone-qualified ISO values', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-project-timestamp-'));
    const projectDir = join(tempDir, 'workspace');
    mkdirSync(projectDir);
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      idFactory: () => 'project_timestamp'
    });
    const project = manager.createProject({ cwd: projectDir });

    db.prepare(`
      UPDATE projects
      SET created_at = ?, updated_at = ?, archived_at = ?
      WHERE id = ?
    `).run(
      '2026-07-21 07:00:00',
      '2026-07-21 07:00:30',
      '2026-07-21 07:01:00',
      project.id
    );

    expect(manager.getProject(project.id)).toMatchObject({
      createdAt: '2026-07-21T07:00:00.000Z',
      updatedAt: '2026-07-21T07:00:30.000Z',
      archivedAt: '2026-07-21T07:01:00.000Z'
    });
  });

  it('renames the managed project directory on disk when the name changes', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-project-rename-'));
    const managedProjectRoot = join(tempDir, 'Documents', 'OpenCreator');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => 'project_rename'
    });

    const created = manager.createManagedProject({ name: 'Tên Cũ' });
    const oldCwd = created.cwd;
    const updated = manager.updateProject(created.id, { name: 'Tên Mới' });

    expect(updated).toMatchObject({
      id: created.id,
      name: 'Tên Mới',
      cwd: join(managedProjectRoot, 'Tên Mới'),
      directoryState: 'available'
    });
    expect(existsSync(oldCwd)).toBe(false);
    expect(existsSync(join(managedProjectRoot, 'Tên Mới'))).toBe(true);
    expect(manager.getProject(created.id)).toMatchObject({ cwd: updated.cwd });
  });

  it('sanitizes Windows-forbidden names when renaming and guards device names', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-project-rename-sanitize-'));
    const managedProjectRoot = join(tempDir, 'Documents', 'OpenCreator');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => 'project_rename_sanitize'
    });

    const created = manager.createManagedProject({ name: 'Bộ Phim' });
    const renamed = manager.updateProject(created.id, { name: 'Phim<Kiểm:1?>' });
    expect(renamed.cwd).toBe(join(managedProjectRoot, 'Phim-Kiểm-1'));

    const device = manager.updateProject(created.id, { name: 'CON' });
    expect(device.cwd).toBe(join(managedProjectRoot, 'CON-movie'));
    expect(existsSync(join(managedProjectRoot, 'Phim-Kiểm-1'))).toBe(false);
    expect(existsSync(join(managedProjectRoot, 'CON-movie'))).toBe(true);
  });

  it('adds a numeric suffix when the renamed directory already exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-project-rename-collision-'));
    const managedProjectRoot = join(tempDir, 'Documents', 'OpenCreator');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    let collisionId = 0;
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => `project_rename_collision_${++collisionId}`
    });

    const first = manager.ensureProjectByName('Phim Hay');
    const second = manager.createManagedProject({ name: 'Khác' });
    mkdirSync(join(managedProjectRoot, 'Phim Hay (2)'));

    const updated = manager.updateProject(second.id, { name: 'Phim Hay' });

    expect(updated.cwd).toBe(join(managedProjectRoot, 'Phim Hay (3)'));
    expect(existsSync(first.folder)).toBe(true);
    expect(existsSync(join(managedProjectRoot, 'Phim Hay (2)'))).toBe(true);
    expect(existsSync(updated.cwd)).toBe(true);
  });

  it('does not touch the directory of projects outside the managed root', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-project-rename-external-'));
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({ db, homeDir: tempDir });

    const externalDir = join(tempDir, 'user-workspace');
    mkdirSync(externalDir);
    const created = manager.createProject({ cwd: externalDir, name: 'User Workspace' });
    const updated = manager.updateProject(created.id, { name: 'New Name' });

    expect(updated.name).toBe('New Name');
    expect(updated.cwd).toBe(externalDir);
    expect(existsSync(externalDir)).toBe(true);
    expect(existsSync(join(tempDir, 'New Name'))).toBe(false);
  });

  it('keeps the old name and reports a conflict when the directory is locked', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-project-rename-locked-'));
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => 'project_locked'
    });

    const created = manager.createManagedProject({ name: 'Phim Khoa' });
    writeFileSync(join(created.cwd, 'output.mp4'), 'video');
    const lock = openSync(join(created.cwd, 'output.mp4'), 'r');
    try {
      let failure: unknown;
      try {
        manager.updateProject(created.id, { name: 'Phim Khác' });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ProjectManagerError);
      expect((failure as ProjectManagerError).code).toBe('PROJECT_DIRECTORY_CONFLICT');
      expect(manager.getProject(created.id)).toMatchObject({
        name: 'Phim Khoa',
        cwd: created.cwd
      });
    } finally {
      closeSync(lock);
    }
  });

  it('rejects invalid names when renaming', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-project-rename-invalid-'));
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => 'project_invalid_rename'
    });
    const created = manager.createManagedProject({ name: 'Original' });

    for (const name of ['', '   ', '.', '..', 'nested/project', 'nested\\project']) {
      expect(() => manager.updateProject(created.id, { name }))
        .toThrowError(expect.objectContaining({ code: 'PROJECT_NAME_INVALID' }));
    }
    expect(manager.getProject(created.id)).toMatchObject({ name: 'Original' });
  });

  it('finds projects by movie name case-insensitively before creating one', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-project-by-name-'));
    const managedProjectRoot = join(tempDir, 'Documents', 'OpenCreator');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => `project_by_name_${++byNameId}`
    });

    const first = manager.ensureProjectByName('Phim Hay');
    expect(first).toMatchObject({
      id: 'project_by_name_1',
      name: 'Phim Hay',
      folder: join(managedProjectRoot, 'Phim Hay')
    });
    expect(existsSync(first.folder)).toBe(true);

    const repeated = manager.ensureProjectByName('phim hay');
    expect(repeated.id).toBe(first.id);
    expect(repeated.folder).toBe(first.folder);
    expect(manager.listProjects('all')).toHaveLength(1);
  });

  it('creates movie-named directories with sanitized names and collision suffixes', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-project-by-name-sanitize-'));
    const managedProjectRoot = join(tempDir, 'Documents', 'OpenCreator');
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({
      db,
      homeDir: tempDir,
      idFactory: () => `project_by_name_${++byNameId}`
    });

    const unicode = manager.ensureProjectByName('Phim<Tập:1>?');
    expect(unicode.name).toBe('Phim<Tập:1>?');
    expect(unicode.folder).toBe(join(managedProjectRoot, 'Phim-Tập-1'));
    expect(manager.getProject(unicode.id)).toMatchObject({ directoryState: 'available' });

    const device = manager.ensureProjectByName('CON');
    expect(device.folder).toBe(join(managedProjectRoot, 'CON-movie'));

    // Tên khác nhưng sanitize ra cùng thư mục → hậu tố " (2)".
    const collision = manager.ensureProjectByName('Phim-Tập-1');
    expect(collision.id).not.toBe(unicode.id);
    expect(collision.folder).toBe(join(managedProjectRoot, 'Phim-Tập-1 (2)'));
  });

  it('rejects invalid movie names in ensureProjectByName', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencreator-project-by-name-invalid-'));
    db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
    const manager = createProjectManager({ db, homeDir: tempDir });

    for (const name of ['', '   ', '.', '..', 'nested/project', 'nested\\project']) {
      expect(() => manager.ensureProjectByName(name))
        .toThrowError(expect.objectContaining({ code: 'PROJECT_NAME_INVALID' }));
    }
    expect(manager.listProjects('all')).toEqual([]);
  });
});

let byNameId = 0;
