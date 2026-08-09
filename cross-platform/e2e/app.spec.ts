import { expect, test } from '@playwright/test';

test('loads the library and provides a keyboard-accessible queue dialog', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '音乐库' })).toBeVisible();
  const launcher = page.getByRole('button', { name: /下载队列/ });
  await launcher.click();
  const dialog = page.getByRole('dialog', { name: '下载队列' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: '关闭下载队列' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(launcher).toBeFocused();
});

test('filters songs in real time and keeps Enter positioning available', async ({ page }) => {
  await page.goto('/');
  const search = page.getByRole('searchbox', { name: '搜索歌曲、专辑或艺术家' });
  await search.fill('OST');
  await expect(page.locator('.search-count')).toBeVisible();
  await search.press('Enter');
  await expect(page.getByRole('button', { name: '定位' })).toBeVisible();
});
