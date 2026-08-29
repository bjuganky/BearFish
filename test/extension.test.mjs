import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

test('manifest.json is valid Manifest V3 Firefox extension configuration', () => {
  const manifestPath = path.join(projectRoot, 'manifest.json');
  assert.strictEqual(fs.existsSync(manifestPath), true, 'manifest.json must exist');

  const content = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(content);

  assert.strictEqual(manifest.manifest_version, 3, 'manifest_version must be 3');
  assert.strictEqual(manifest.name, 'BearFish', 'extension name must be BearFish');
  assert.ok(manifest.version, 'version field must be present');
  assert.ok(manifest.action && manifest.action.default_popup, 'action.default_popup must be defined');
  assert.ok(manifest.browser_specific_settings?.gecko?.id, 'gecko extension ID must be set');
});

test('required extension HTML, CSS, and JS files exist', () => {
  const requiredFiles = [
    'popup.html',
    'popup.js',
    'popup.css',
    'details.html',
    'details.js',
    'details.css',
    'indicator.html',
    'indicator.js',
    'indicator.css'
  ];

  for (const file of requiredFiles) {
    const filePath = path.join(projectRoot, file);
    assert.strictEqual(fs.existsSync(filePath), true, `${file} should exist`);
  }
});

test('extension icons specified in manifest exist', () => {
  const manifestPath = path.join(projectRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const actionIcons = Object.values(manifest.action?.default_icon || {});
  const extensionIcons = Object.values(manifest.icons || {});
  const allIcons = [...new Set([...actionIcons, ...extensionIcons])];

  for (const iconRelativePath of allIcons) {
    const iconPath = path.join(projectRoot, iconRelativePath);
    assert.strictEqual(fs.existsSync(iconPath), true, `Icon ${iconRelativePath} should exist`);
  }
});
