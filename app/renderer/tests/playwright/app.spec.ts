import { expect, test } from '@playwright/test';

test.describe('renderer shell', () => {
  test('shows preload bridge status', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Embodied Assistant MVP' })).toBeVisible();
    await expect(page.getByText(/Preload bridge status/i)).toBeVisible();
  });
});
