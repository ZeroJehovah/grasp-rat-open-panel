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

test('historical range excludes realtime events from a later day', async ({ page }) => {
  const rangeMeta = { ...meta, availableDates: ['2026-08-22', '2026-08-23'], earliestDate: '2026-08-22', latestDate: '2026-08-23' };
  const oldMessage = { message_id: 'old-message', server_day: '2026-08-22', event_at: '2026-08-22T01:00:00+08:00', kind: 'chat', text: 'old-chat', user_name: 'old-user' };
  const todayMessage = { message_id: 'today-message', server_day: '2026-08-23', event_at: '2026-08-23T01:00:00+08:00', kind: 'chat', text: 'today-chat', user_name: 'today-user' };
  const oldKill = { kill_id: 'old-kill', local_date: '2026-08-22', event_at: '2026-08-22T02:00:00+08:00', killer_user_id: 7, victim_user_id: 8, killer_name: 'old-killer', victim_name: 'old-victim', confidence: 'confirmed', drop: { amount: 12 }, victim_stamina_5s: 10000, victim_stamina_5s_limit: 10000 };
  const todayKill = { kill_id: 'today-kill', local_date: '2026-08-23', event_at: '2026-08-23T02:00:00+08:00', killer_user_id: 7, victim_user_id: 8, killer_name: 'today-killer', victim_name: 'today-victim', confidence: 'confirmed', drop: { amount: 12 }, victim_stamina_5s: 10000, victim_stamina_5s_limit: 10000 };
  await page.route('**/api/v1/meta', route => route.fulfill({ json: rangeMeta }));
  await page.route('**/api/v1/realtime/version', route => route.fulfill({ json: { versionToken: 'v-range', snapshotId: 's-range', observedAt: '2026-08-23T02:00:00+08:00' } }));
  await page.route('**/api/v1/realtime*', route => route.fulfill({ json: { versionToken: 'v-range', generatedAt: '2026-08-23T02:00:00+08:00', latest: { snapshot_id: 's-range', server_day: '2026-08-23', server_tick: 10, observed_at: '2026-08-23T02:00:00+08:00' }, map: rangeMeta.map, players: [player], messages: [todayMessage], kills: [todayKill] } }));
  await page.route('**/api/v1/history*', route => {
    const url = new URL(route.request().url());
    const isYesterday = url.searchParams.get('from') === '2026-08-22';
    return route.fulfill({ json: { from: isYesterday ? '2026-08-22' : '2026-08-23', to: isYesterday ? '2026-08-22' : '2026-08-23', timezone: 'Asia/Shanghai', generatedAt: '2026-08-23T02:00:00+08:00', closedThrough: null, players: [player], messages: isYesterday ? [oldMessage] : [todayMessage], kills: isYesterday ? [oldKill] : [todayKill], dailyQuota: [], stats: [] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '昨日' }).click();
  await expect(page.getByText('old-chat')).toBeVisible();
  await expect(page.getByText('today-chat')).not.toBeVisible();
  await page.getByRole('button', { name: '击杀明细' }).click();
  await expect(page.getByRole('cell', { name: 'old-killer' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'today-killer' })).not.toBeVisible();
});
