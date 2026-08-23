import { test, expect, type Page } from '@playwright/test';

const meta = {
  map: { id: 'test-map', version: 1, bounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 }, center: { x: 0, y: 0 }, directions: ['北', '东北', '东', '东南', '南', '西南', '西', '西北'], metersPerGameUnit: 1 },
  availableDates: ['2026-08-22'], earliestDate: '2026-08-22', latestDate: '2026-08-22', timezone: 'Asia/Shanghai', schemaVersion: 'snapshot-v1', features: { realtime: true, history: true },
};
const player = { userId: 7, name: 'fixture-player', online: true, lastSeenAt: '2026-08-22T00:01:00+08:00', currentEntityId: 1, drop: 12, quota: { day: '2026-08-22', initial: 200, value: 204, income: 4 }, income: 4, kills: 1, deaths: 0, state: { hp: 100, maxHp: 100, x: 20, y: 10, stamina5s: 10000, stamina1h: 3000000, stamina1d: 20000000, stamina5sLimit: 10000, stamina1hLimit: 3000000, stamina1dLimit: 20000000, currentJoinMode: 'Passive', life: 'Alive', snapshotId: 'test', observedAt: '2026-08-22T00:01:00+08:00' } };

async function mockApi(page: Page) {
  await page.route('**/api/v1/meta', route => route.fulfill({ json: meta }));
  await page.route('**/api/v1/realtime*', route => route.fulfill({ json: { versionToken: 'v1', generatedAt: player.state.observedAt, latest: { snapshot_id: 's1', server_day: '2026-08-22', server_tick: 10, observed_at: player.state.observedAt }, map: meta.map, players: [player], messages: [], kills: [] } }));
  await page.route('**/api/v1/realtime/version', route => route.fulfill({ json: { versionToken: 'v1', snapshotId: 's1', observedAt: player.state.observedAt } }));
  await page.route('**/api/v1/history*', route => route.fulfill({ json: { from: '2026-08-22', to: '2026-08-22', timezone: 'Asia/Shanghai', generatedAt: player.state.observedAt, closedThrough: null, players: [player], messages: [], kills: [], dailyQuota: [], stats: [] } }));
}

test('desktop panel keeps the three primary regions and data tabs', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Grasp Rat Open Panel' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '实时地图' })).toBeVisible();
  await page.getByRole('button', { name: '玩家列表' }).click();
  await expect(page.getByText('fixture-player')).toBeVisible();
  await page.screenshot({ path: 'test-results/panel-desktop.png', fullPage: true });
});

test('narrow panel keeps range, tabs and footer reachable', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '时间范围' })).toBeVisible();
  await page.getByRole('button', { name: '击杀明细' }).click();
  await expect(page.getByText('没有符合阈值的击杀记录')).toBeVisible();
  await expect(page.getByRole('link', { name: 'GitHub' })).toBeVisible();
  await page.screenshot({ path: 'test-results/panel-narrow.png', fullPage: true });
});
