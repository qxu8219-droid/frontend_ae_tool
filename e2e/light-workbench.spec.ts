import { test, expect } from './fixtures';
import { createReadySession, diagnostics, loadDemo, waitPair } from './oracle';

// Regression: importing a second candidate must not replace active-log details.
test('drawers preserve active details and resume the unactivated candidate', async ({ page }) => {
  await page.goto('/');
  const sid = await createReadySession(page);
  await page.getByTestId('import-log').click({ timeout: 2000 });
  await expect(page.getByTestId('import-drawer')).toBeVisible();
  await expect(page.getByTestId('file-input')).toHaveAttribute('tabindex', '-1');
  expect(await page.getByTestId('file-input').evaluate(el => getComputedStyle(el).clipPath)).toBe('inset(50%)');
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
  expect(await page.locator('.group-overlay').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-testid')))).toEqual(['group-left', 'group-right', 'group-torso', 'group-base']);
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


test('numeric seek validates seconds and whole frames without page errors', async ({ page }) => {
  await page.goto('/'); await createReadySession(page); await loadDemo(page);
  await page.getByTestId('open-seek').click();
  await page.getByTestId('seek-input').fill('5');
  await expect(page.getByTestId('seek-submit')).toBeEnabled();
  await page.getByTestId('seek-input').press('Enter');
  await waitPair(page, p => p.snapshot.log_time_s === 5);
  await page.getByTestId('open-seek').click();
  await page.getByText('按原采样帧定位').click();
  for (const invalid of ['1.5', '-1']) {
    await page.getByTestId('frame-input').fill(invalid);
    await expect(page.getByTestId('frame-submit')).toBeDisabled();
    const seq = (await diagnostics(page)).snapshot?.control_seq;
    await page.getByTestId('frame-input').press('Enter');
    expect((await diagnostics(page)).snapshot?.control_seq).toBe(seq);
  }
  await page.getByTestId('frame-input').fill('180');
  await expect(page.getByTestId('frame-submit')).toBeEnabled();
  await page.getByTestId('frame-submit').click();
  await waitPair(page, p => p.snapshot.source_sample_index === 180);
});

test('accessible presented data holds the paired snapshot during delayed seek', async ({ page }) => {
  await page.goto('/'); await createReadySession(page); await loadDemo(page);
  await page.getByTestId('presented-data-toggle').click();
  await expect(page.getByTestId('presented-joint-row')).toHaveCount(28);
  const before = await diagnostics(page);
  const initialTime = await page.getByTestId('presented-data-time').innerText();
  const initialRows = await page.getByTestId('presented-joint-row').allTextContents();
  expect(initialTime).toContain(before.snapshot!.log_time_s.toFixed(3));
  expect(initialRows[0]).toContain('steer_motor_joint1');
  expect(initialRows[0]).toContain(before.snapshot!.joints[0].toFixed(3));
  expect(initialRows[0]).toContain('rad');
  expect(initialRows[0]).toContain('推算');
  expect(initialRows[0]).toContain('未评估');
  await expect(page.getByTestId('presented-chassis')).toContainText('yaw');
  await expect(page.getByTestId('presented-chassis')).toContainText(before.snapshot!.chassis!.x.toFixed(3));
  await expect(page.getByTestId('presented-chassis')).toContainText(before.snapshot!.chassis!.yaw.toFixed(3));
  await page.getByTestId('scenario-select').selectOption('video-delay');
  await page.getByTestId('open-seek').click();
  await page.getByTestId('seek-input').fill('5');
  await page.getByTestId('seek-submit').click();
  await page.waitForTimeout(100);
  expect(await page.getByTestId('presented-data-time').innerText()).toBe(initialTime);
  expect(await page.getByTestId('presented-joint-row').allTextContents()).toEqual(initialRows);
  const target = await waitPair(page, p => p.snapshot.log_time_s === 5);
  await expect(page.getByTestId('presented-data-time')).toContainText('5.000');
  await expect(page.getByTestId('presented-joint-row').first()).toContainText(target.snapshot.joints[0].toFixed(3));
  expect(await page.getByTestId('presented-joint-row').allTextContents()).not.toEqual(initialRows);
});
