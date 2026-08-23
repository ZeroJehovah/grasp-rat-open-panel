import { test, expect, type Page } from '@playwright/test';

const meta = {
  map: { id: 'test-map', version: 1, bounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 }, center: { x: 0, y: 0 }, directions: ['北', '东北', '东', '东南', '南', '西南', '西', '西北'], metersPerGameUnit: 1 },
  availableDates: ['2026-08-22', '2026-08-23'], earliestDate: '2026-08-22', latestDate: '2026-08-23', presetRanges: { today: { from: '2026-08-23', to: '2026-08-23' }, yesterday: { from: '2026-08-22', to: '2026-08-22' }, 'this-week': null, 'last-week': null, 'this-month': null, 'last-month': null }, timezone: 'Asia/Shanghai', schemaVersion: 'snapshot-v1', features: { realtime: true, history: true }
};
const player = { userId: 7, name: 'fixture-player', online: true, lastSeenAt: '2026-08-23T00:01:00+08:00', currentEntityId: 1, drop: 12, quota: { day: '2026-08-23', initial: 200, value: 204, income: 4 }, income: 4, kills: 1, deaths: 0, state: { hp: 100, maxHp: 100, x: 20, y: 10, invulnerableRemainingSecs: 0, loss: 2, stamina5s: 10000, stamina1h: 3000000, stamina1d: 20000000, stamina5sLimit: 10000, stamina1hLimit: 3000000, stamina1dLimit: 20000000, currentJoinMode: 'Passive', life: 'Alive', snapshotId: 'test', observedAt: '2026-08-23T00:01:00+08:00' } };

function response(scope: 'realtime' | 'history', resource: string, payload: Record<string, unknown> = {}) {
  return { scope, resource, generatedAt: player.state.observedAt, timezone: 'Asia/Shanghai', schemaVersion: 'snapshot-v1', ...payload };
}

async function mockApi(page: Page, realtimePlayers = [player]) {
  await page.route('**/api/v1/meta', route => route.fulfill({ json: meta }));
  await page.route('**/api/v1/realtime/version', route => route.fulfill({ json: { versionToken: 'v1', snapshotId: 's1', observedAt: player.state.observedAt } }));
  await page.route('**/api/v1/realtime/*', route => {
    const resource = new URL(route.request().url()).pathname.split('/').at(-1);
    const payload = resource === 'chat' ? { versionToken: 'v1', messages: [] } : resource === 'map' ? { versionToken: 'v1', map: meta.map, players: realtimePlayers } : resource === 'players' ? { versionToken: 'v1', serverDay: '2026-08-23', players: realtimePlayers } : { versionToken: 'v1', kills: [] };
    return route.fulfill({ json: response('realtime', resource || 'chat', { latest: { snapshot_id: 's1', server_day: '2026-08-23', server_tick: 10, observed_at: player.state.observedAt }, ...payload }) });
  });
  await page.route('**/api/v1/history/*', route => {
    const resource = new URL(route.request().url()).pathname.split('/').at(-1) || 'chat';
    const payload = resource === 'chat' ? { messages: [] } : resource === 'players' ? { players: [player] } : { kills: [] };
    return route.fulfill({ json: response('history', resource, { from: '2026-08-22', to: '2026-08-22', closedThrough: '2026-08-22', ...payload }) });
  });
}

function screenshotPath(testInfo: { project: { name: string }; title: string }): string {
  const safeTitle = testInfo.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `test-results/panel-${testInfo.project.name}-${safeTitle}.png`;
}

test('desktop fixed shell starts at realtime chat and keeps the footer visible', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/realtime\/chat$/);
  await expect(page.getByRole('heading', { name: '聊天记录' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '地图' })).toBeVisible();
  await page.getByRole('tab', { name: '玩家' }).click();
  await expect(page).toHaveURL(/\/realtime\/players$/);
  await expect(page.getByText('fixture-player')).toBeVisible();
  expect(await page.evaluate(() => Math.abs(document.documentElement.scrollHeight - document.documentElement.clientHeight) <= 2)).toBe(true);
  await page.screenshot({ path: screenshotPath(testInfo), fullPage: true });
});

test('history URL preserves range and browser back restores the previous tab', async ({ page }) => {
  await mockApi(page);
  await page.goto('/realtime/chat');
  await page.getByRole('link', { name: '历史' }).click();
  await expect(page).toHaveURL(/\/history\/chat\?from=2026-08-23&to=2026-08-23$/);
  await page.getByRole('tab', { name: '玩家' }).click();
  await expect(page).toHaveURL(/\/history\/players\?from=2026-08-23&to=2026-08-23$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/history\/chat\?from=2026-08-23&to=2026-08-23$/);
});

test('switching tabs requests only the selected resource', async ({ page }) => {
  const requested: string[] = [];
  await mockApi(page);
  page.on('request', request => { if (request.url().includes('/api/v1/realtime/')) requested.push(new URL(request.url()).pathname); });
  await page.goto('/realtime/chat');
  await expect(page.getByRole('heading', { name: '聊天记录' })).toBeVisible();
  expect(requested.some(path => path.endsWith('/realtime/chat'))).toBe(true);
  expect(requested.some(path => path.endsWith('/realtime/players'))).toBe(false);
  await page.getByRole('tab', { name: '玩家' }).click();
  await expect(page.getByText('fixture-player')).toBeVisible();
  expect(requested.some(path => path.endsWith('/realtime/players'))).toBe(true);
});

test('narrow layout has no document overflow and map does not fall back to historical players', async ({ page }) => {
  await mockApi(page, []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/realtime/map');
  await expect(page.getByText('0 位玩家')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('link', { name: 'GitHub' })).toBeVisible();
});

test('map camera exposes axes, viewport readout and player details', async ({ page }) => {
  await mockApi(page);
  await page.goto('/realtime/map');
  await expect(page.getByText('x=0')).toBeVisible();
  await expect(page.getByText('y=0')).toBeVisible();
  await expect(page.getByText(/视野半径/)).toBeVisible();
  await expect(page.getByRole('button', { name: /fixture-player 玩家详情/ })).toBeVisible();
  await page.getByRole('button', { name: /fixture-player 玩家详情/ }).hover();
  await expect(page.getByText(/Loss 2/)).toBeVisible();
  await page.getByRole('button', { name: '放大地图' }).click();
  await expect(page.getByRole('button', { name: '缩小地图' })).toBeVisible();
});

test('chat filter uses the explicit chat-only wording', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/v1/realtime/chat*', route => route.fulfill({ json: response('realtime', 'chat', { versionToken: 'v1', latest: { snapshot_id: 's1', server_day: '2026-08-23', server_tick: 10, observed_at: player.state.observedAt }, messages: [{ message_id: 'chat', kind: 'chat', text: 'hello', event_at: player.state.observedAt }, { message_id: 'kill', kind: 'kill', text: 'killer killed victim', event_at: '2026-08-23T00:02:00+08:00' }] }) }));
  await page.goto('/realtime/chat');
  await expect(page.getByText('killer killed victim')).toBeVisible();
  await page.getByText('仅看聊天').click();
  await expect(page.getByText('killer killed victim')).not.toBeVisible();
});
