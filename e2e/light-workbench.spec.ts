import { test, expect } from './fixtures';
import { createReadySession, diagnostics, loadDemo } from './oracle';

// Regression: importing a second candidate must not replace active-log details.
test('drawers preserve active details and resume the unactivated candidate', async ({ page }) => {
  await page.goto('/');
  const sid = await createReadySession(page);
  await page.getByTestId('import-log').click({ timeout: 2000 });
  await expect(page.getByTestId('import-drawer')).toBeVisible();
  await page.getByTestId('mapping-json').fill('{"timestamp":{"field":"first_time","unit":"s"}}');
  const firstReply = page.waitForResponse(r => r.request().method() === 'POST' && /\/logs$/.test(new URL(r.url()).pathname));
  await page.getByTestId('file-input').setInputFiles({name:'active.json',mimeType:'application/json',buffer:Buffer.from('{}')});
  const first = await (await firstReply).json();
  await expect(page.getByTestId('upload-result')).toContainText('等待激活');
  await page.getByTestId('activate-log').click();
  await expect.poll(async () => (await diagnostics(page)).snapshot?.log_id).toBe(first.log_id);
  await page.getByTestId('close-import').click();
  await page.getByTestId('import-log').click();
  await page.getByTestId('upload-reconfigure').click();
  await page.getByTestId('mapping-json').fill('{"timestamp":{"field":"second_time","unit":"s"}}');
  const secondReply = page.waitForResponse(r => r.request().method() === 'POST' && /\/logs$/.test(new URL(r.url()).pathname));
  await page.getByTestId('file-input').setInputFiles({name:'candidate.json',mimeType:'application/json',buffer:Buffer.from('{}')});
  const second = await (await secondReply).json();
  await expect(page.getByTestId('upload-result')).toContainText('等待激活');
  await page.getByTestId('close-import').click();
  await page.getByTestId('open-log-details').click();
  await expect(page.getByTestId('log-details-filename')).toContainText('active.json');
  await expect(page.getByTestId('log-details-mapping')).toContainText('first_time');
  await expect(page.getByTestId('log-details-mapping')).not.toContainText('second_time');
  await page.getByTestId('close-log-details').click();
  await page.getByTestId('import-log').click();
  await expect(page.getByTestId('upload-result')).toContainText('等待激活');
  await expect(page.getByTestId('mapping-snapshot-id')).toHaveText(second.mapping_snapshot_id);
  expect((await diagnostics(page)).snapshot?.log_id).toBe(first.log_id);
  await page.getByTestId('close-import').click();
  await page.getByTestId('close-session').click();
  await expect(page.getByTestId('close-confirmation')).toBeVisible();
  await page.getByTestId('cancel-close-session').click();
  expect((await diagnostics(page)).session.sid).toBe(sid);
});

test('channel cancellation preserves selection and invalid seek cannot submit by Enter', async ({ page }) => {
  await page.goto('/');
  await createReadySession(page);
  await loadDemo(page);
  await expect(page.getByTestId('open-channel-picker')).toBeEnabled();
  const original = await page.locator('.channel-chip').allTextContents();
  await page.getByTestId('open-channel-picker').click();
  await page.locator('.channel-options input:checked').first().uncheck();
  await page.getByTestId('cancel-channels').click();
  expect(await page.locator('.channel-chip').allTextContents()).toEqual(original);
  await page.getByTestId('open-seek').click();
  await page.getByTestId('seek-input').fill('');
  await expect(page.getByTestId('seek-submit')).toBeDisabled();
  const before = (await diagnostics(page)).snapshot?.control_seq;
  await page.getByTestId('seek-input').press('Enter');
  expect((await diagnostics(page)).snapshot?.control_seq).toBe(before);
  await expect(page.getByTestId('seek-input')).toBeVisible();
});

test('workbench fits desktop widths with layers closed', async ({ page }) => {
  await page.goto('/');
  await createReadySession(page);
  await loadDemo(page);
  await page.waitForTimeout(1000);
  for (const width of [1600, 1280]) {
    await page.setViewportSize({ width, height: 1100 });
    await expect(page.getByTestId('paired-canvas')).toBeVisible();
    await page.screenshot({ path: `output/light-workbench/workbench-${width}.png`, fullPage: true });
  }
});
