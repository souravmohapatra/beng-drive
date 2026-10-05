import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createServer } from 'vite';

test('the production client excludes the synthetic design gallery', async () => {
  const assets = join('dist', 'client', 'assets');
  const names = await readdir(assets);
  const output = (await Promise.all([
    readFile(join('dist', 'client', 'index.html'), 'utf8'),
    ...names.map((name) => readFile(join(assets, name), 'utf8')),
  ])).join('\n');
  for (const marker of ['BD_T07_SAMPLE_DATA', 'Design preview · sample data', 'SAMPLE-KEY-NOT-VALID', 'owner-detail']) {
    assert.equal(output.includes(marker), false, `${marker} leaked into production output`);
  }
  assert.match(output, /Your files, together in one place/);
});

test('the gallery names the required guest and owner fixture states', async () => {
  const source = await readFile(join('src', 'client', 'preview.tsx'), 'utf8');
  for (const state of ['welcome', 'unlock', 'unlock-error', 'queue', 'receipt', 'error-storage', 'error-quota', 'error-expired', 'error-revoked', 'error-invalid', 'owner-list', 'owner-empty', 'owner-create', 'owner-edit', 'owner-detail', 'owner-key']) {
    assert.match(source, new RegExp(`['\"]${state}['\"]`));
  }
});

test('rendered pre-unlock screens hide collection details while the queue shows them', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { Preview } = await vite.ssrLoadModule('/src/client/preview.tsx');
    const render = (screen) => {
      globalThis.location = { href: `http://127.0.0.1/design-preview?screen=${screen}`, search: `?screen=${screen}` };
      return renderToStaticMarkup(createElement(Preview));
    };
    for (const screen of ['welcome', 'unlock', 'unlock-error']) {
      const html = render(screen);
      for (const detail of ['Weekend moments', 'Photos and notes for the weekend', '8.4 GB', '30 Sep']) {
        assert.equal(html.includes(detail), false, `${screen} showed ${detail} before unlock`);
      }
    }
    const queue = render('queue');
    assert.match(queue, /Weekend moments/);
    assert.match(queue, /8\.4 GB/);
    assert.match(queue, /30 Sep/);
    assert.match(queue, /598 MB of 1,751 MB transmitted/);
    assert.match(queue, /aria-valuenow="598"/);
    assert.match(queue, /aria-valuemax="1751"/);
    assert.match(queue, /1 of 7/);
    assert.match(queue, /6 MB confirmed saved/);
    assert.match(queue, /Finalizing is still saving/);
    assert.match(queue, /Cancelled draft\.txt is excluded/);
  } finally {
    delete globalThis.location;
    await vite.close();
  }
});

test('normal field boundaries meet non-text contrast against both adjacent colors', async () => {
  const css = await readFile(join('src', 'client', 'style.css'), 'utf8');
  const fieldRule = css.match(/\.field input,\.field textarea\{([^}]+)\}/)?.[1];
  assert.ok(fieldRule);
  const border = fieldRule.match(/border:1px solid #(\w{6})/)?.[1];
  const fill = fieldRule.match(/background:#(\w{6})/)?.[1];
  const form = css.match(/\.form-card,\.surface\{background:#(\w{3,6})/)?.[1];
  assert.ok(border && fill && form);
  const luminance = (value) => {
    const hex = value.length === 3 ? [...value].map((part) => part + part).join('') : value;
    const channels = hex.match(/../g).map((part) => parseInt(part, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const contrast = (a, b) => {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };
  assert.ok(contrast(border, fill) >= 3, `field boundary/fill ${contrast(border, fill).toFixed(2)}:1`);
  assert.ok(contrast(border, form) >= 3, `field boundary/form ${contrast(border, form).toFixed(2)}:1`);
});
