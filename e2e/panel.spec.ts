import { test, expect, type Page } from '@playwright/test';

const meta = {
  map: { id: 'test-map', version: 1, bounds: { minX: -1000, maxX: 1000, minY: -1000, maxY: 1000 }, center: { x: 0, y: 0 }, directions: ['北', '东北', '东', '东南', '南', '西南', '西', '西北'], metersPerGameUnit: 1 },
  availableDates: ['2026-08-22', '2026-08-23'], earliestDate: '2026-08-22', latestDate: '2026-08-23', presetRanges: { today: { from: '2026-08-23', to: '2026-08-23' }, yesterday: { from: '2026-08-22', to: '2026-08-22' }, 'this-week': null, 'last-week': null, 'this-month': null, 'last-month': null }, timezone: 'Asia/Shanghai', schemaVersion: 'snapshot-v1', features: { realtime: true, history: true }
};
const player = { userId: 7, name: 'fixture-player', online: true, lastSeenAt: '2026-08-23T00:01:00+08:00', currentEntityId: 1, drop: 12, externalBalanceSnapshot: 1250000, quota: { day: '2026-08-23', initial: 200, value: 204, income: 4 }, income: 4, kills: 1, deaths: 0, state: { hp: 100, maxHp: 100, x: 20, y: 10, invulnerableRemainingSecs: 0, loss: 2, stamina5s: 10000, stamina1h: 3000000, stamina1d: 20000000, stamina5sLimit: 10000, stamina1hLimit: 3000000, stamina1dLimit: 20000000, currentJoinMode: 'Passive', life: 'Alive', snapshotId: 'test', observedAt: '2026-08-23T00:01:00+08:00' } };
const offlinePlayer = { ...player, userId: 8, name: 'offline-player', online: false, drop: 25, state: { ...player.state, x: 80, y: 90 } };

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

test('player and kill titles stay fixed while data panes scroll', async ({ page }) => {
  const manyPlayers = Array.from({ length: 40 }, (_, index) => ({
    ...player,
    userId: 100 + index,
    name: `player-${index}`,
    externalBalanceSnapshot: 500000 + index * 500000,
    state: { ...player.state, x: index, y: index }
  }));
  const manyKills = Array.from({ length: 40 }, (_, index) => ({
    kill_id: `scroll-kill-${index}`,
    event_at: `2026-08-23T00:${String(index % 60).padStart(2, '0')}:00+08:00`,
    killer_user_id: 7,
    victim_user_id: 100 + index,
    killer_name: 'fixture-player',
    victim_name: `victim-${index}`,
    confidence: 'confirmed',
    drop: { amount: 20 },
    victim_position: { x: index, y: index }
  }));
  await mockApi(page, manyPlayers);
  await page.route('**/api/v1/realtime/kills*', route => route.fulfill({ json: response('realtime', 'kills', { versionToken: 'v1', latest: { snapshot_id: 's1', server_day: '2026-08-23', server_tick: 10, observed_at: player.state.observedAt }, kills: manyKills }) }));

  await page.goto('/realtime/players');
  const playerPane = page.locator('.players-panel .table-shell');
  const playerTitle = page.locator('.players-panel .section-heading');
  const playerBefore = await playerTitle.boundingBox();
  const playerScroll = await playerPane.evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(playerScroll.scrollHeight).toBeGreaterThan(playerScroll.height);
  await playerPane.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const playerAfter = await playerTitle.boundingBox();
  expect(Math.abs((playerBefore?.top || 0) - (playerAfter?.top || 0))).toBeLessThanOrEqual(1);

  await page.getByRole('tab', { name: '击杀' }).click();
  await expect(page.locator('.kill-table tbody td').filter({ hasText: 'victim-0' })).toBeVisible();
  const killPane = page.locator('.kill-panel .kill-scroll');
  const killTitle = page.locator('.kill-panel .kill-heading');
  const killBefore = await killTitle.boundingBox();
  const killScroll = await killPane.evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(killScroll.scrollHeight).toBeGreaterThan(killScroll.height);
  await killPane.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const killAfter = await killTitle.boundingBox();
  expect(Math.abs((killBefore?.top || 0) - (killAfter?.top || 0))).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight === document.documentElement.clientHeight)).toBe(true);
});

test('history URL preserves range and browser back restores the previous tab', async ({ page }) => {
  await mockApi(page);
  await page.goto('/realtime/chat');
  await page.getByRole('link', { name: '历史' }).click();
  await expect(page).toHaveURL(/\/history\/chat\?from=2026-08-22&to=2026-08-22$/);
  await page.getByRole('tab', { name: '玩家' }).click();
  await expect(page).toHaveURL(/\/history\/players\?from=2026-08-22&to=2026-08-22$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/history\/chat\?from=2026-08-22&to=2026-08-22$/);
});

test('history range offers only past presets and excludes today from custom dates', async ({ page }) => {
  await mockApi(page);
  await page.goto('/history/chat?from=2026-08-23&to=2026-08-23');
  await expect(page).toHaveURL(/\/history\/chat\?from=2026-08-22&to=2026-08-22$/);
  await expect(page.getByRole('button', { name: '昨天' })).toBeVisible();
  await expect(page.getByRole('button', { name: '上周' })).toBeVisible();
  await expect(page.getByRole('button', { name: '上月' })).toBeVisible();
  await expect(page.getByRole('button', { name: '指定日期' })).toBeVisible();
  await expect(page.getByRole('button', { name: '今天' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '昨日' })).toHaveCount(0);
  await expect(page.locator('input[type="date"]')).toHaveCount(0);
  await page.getByRole('button', { name: '指定日期' }).click();
  await expect(page.locator('input[type="date"]')).toHaveCount(2);
  await expect(page.locator('input[type="date"]').first()).toHaveAttribute('max', '2026-08-22');
  await expect(page.locator('input[type="date"]').nth(1)).toHaveAttribute('max', '2026-08-22');
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
  await expect(page.locator('.map-panel .tooltip')).toHaveAttribute('data-tooltip', /Drop 达到当前阈值/);
  await expect(page.locator('.map-land')).toHaveCount(0);
  await expect(page.locator('.map-water')).toHaveCount(0);
  expect(await page.locator('.map-canvas').evaluate(element => { const rect = element.getBoundingClientRect(); return Math.abs(rect.width - rect.height); })).toBeGreaterThan(1);
  await expect(page.getByText('x=0')).toBeVisible();
  await expect(page.getByText('y=0')).toBeVisible();
  await expect(page.getByText(/视野半径/)).toBeVisible();
  await expect(page.getByRole('button', { name: /fixture-player 玩家详情/ })).toBeVisible();
  await expect(page.getByText('Drop 12')).toBeVisible();
  const initialRadius = await page.locator('.map-readout span').first().textContent();
  await page.getByRole('button', { name: /fixture-player 玩家详情/ }).hover();
  await expect(page.getByText(/Loss 2/)).toBeVisible();
  await expect(page.getByText('坐标 x 20 / y 10', { exact: true })).toBeVisible();
  await expect(page.getByText(/^无敌/)).toHaveCount(0);
  await page.getByRole('button', { name: '放大地图' }).click();
  await expect(page.locator('.map-readout span').first()).not.toHaveText(initialRadius || '');
  await expect(page.getByRole('button', { name: '缩小地图' })).toBeVisible();
});

test('dragging the map does not select map labels', async ({ page }) => {
  await mockApi(page);
  await page.goto('/realtime/map');
  const mapCanvas = page.locator('.map-canvas');
  await expect(mapCanvas).toHaveCSS('user-select', 'none');
  await page.getByRole('button', { name: '放大地图' }).click();
  const box = await mapCanvas.boundingBox();
  if (!box) throw new Error('map stage is not measurable');
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7);
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString() || '')).toBe('');
});

test('map Drop threshold uses a wheel-adjustable slider and filters players', async ({ page }) => {
  await mockApi(page);
  await page.goto('/realtime/map');
  const slider = page.getByRole('slider', { name: '地图 Drop 阈值' });
  await expect(slider).toHaveAttribute('aria-valuenow', '10');
  await expect(slider).toHaveAttribute('min', '1');
  await expect(slider).toHaveAttribute('max', '1000');
  await expect(slider).toHaveAttribute('step', '10');
  await expect(page.locator('.drop-threshold-value')).toHaveText('10');
  await slider.hover();
  await page.mouse.wheel(0, -100);
  await expect(slider).toHaveAttribute('aria-valuenow', '20');
  await expect(page.locator('.drop-threshold-value')).toHaveText('20');
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '30');
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '40');
  await expect(page.getByText('0 位玩家')).toBeVisible();
  await slider.press('Home');
  await expect(slider).toHaveAttribute('aria-valuenow', '1');
  const sliderBox = await slider.boundingBox();
  if (!sliderBox) throw new Error('map threshold slider is not measurable');
  await page.mouse.click(sliderBox.x + sliderBox.width - 1, sliderBox.y + sliderBox.height / 2);
  await expect(slider).toHaveAttribute('aria-valuenow', '1000');
  expect(await page.evaluate(() => localStorage.getItem('grasp-rat:map-drop-threshold'))).toBe('1000');
});

test('kill Drop threshold uses a wheel-adjustable slider and filters kills', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/v1/realtime/kills*', route => route.fulfill({ json: response('realtime', 'kills', { versionToken: 'v1', latest: { snapshot_id: 's1', server_day: '2026-08-23', server_tick: 10, observed_at: player.state.observedAt }, kills: [
    { kill_id: 'small-kill', event_at: '2026-08-23T00:02:00+08:00', killer_user_id: 7, victim_user_id: 8, killer_name: 'fixture-player', victim_name: 'small-victim', confidence: 'confirmed', drop: { amount: 8 }, victim_position: { x: 1, y: 2 } },
    { kill_id: 'large-kill', event_at: '2026-08-23T00:03:00+08:00', killer_user_id: 7, victim_user_id: 9, killer_name: 'fixture-player', victim_name: 'large-victim', confidence: 'confirmed', drop: { amount: 32 }, victim_position: { x: 3, y: 4 } }
  ] }) }));
  await page.goto('/realtime/kills');
  const slider = page.getByRole('slider', { name: '击杀 Drop 阈值' });
  await expect(slider).toHaveAttribute('aria-valuenow', '10');
  await expect(slider).toHaveAttribute('min', '1');
  await expect(slider).toHaveAttribute('max', '1000');
  await expect(slider).toHaveAttribute('step', '10');
  const killBody = page.locator('.kill-table tbody');
  await expect(killBody.getByText('small-victim')).toHaveCount(0);
  await expect(killBody.getByText('large-victim')).toBeVisible();
  await slider.hover();
  await page.mouse.wheel(0, -100);
  await expect(slider).toHaveAttribute('aria-valuenow', '20');
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '30');
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', '40');
  await expect(killBody.getByText('large-victim')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('grasp-rat:kill-drop-threshold'))).toBe('40');
});

test('chat filter folds adjacent kills into a visible summary', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/v1/realtime/chat*', route => route.fulfill({ json: response('realtime', 'chat', { versionToken: 'v1', latest: { snapshot_id: 's1', server_day: '2026-08-23', server_tick: 10, observed_at: player.state.observedAt }, messages: [{ message_id: 'chat', kind: 'chat', text: 'hello', event_at: player.state.observedAt }, { message_id: 'kill-1', kind: 'kill', text: 'killer killed victim one', event_at: '2026-08-23T00:02:00+08:00' }, { message_id: 'kill-2', kind: 'kill', text: 'killer killed victim two', event_at: '2026-08-23T00:03:00+08:00' }, { message_id: 'chat-2', kind: 'chat', text: 'after kills', event_at: '2026-08-23T00:04:00+08:00' }] }) }));
  await page.goto('/realtime/chat');
  await expect(page.getByText('killer killed victim one')).toBeVisible();
  await expect(page.getByText('killer killed victim two')).toBeVisible();
  await page.getByText('仅看聊天').click();
  await expect(page.getByText('2条击杀记录已折叠')).toBeVisible();
  await expect(page.getByText('killer killed victim one')).toHaveCount(0);
  await expect(page.getByText('killer killed victim two')).toHaveCount(0);
  await expect(page.getByText('hello')).toBeVisible();
  await expect(page.getByText('after kills')).toBeVisible();
});

test('chat filter persists across page entry', async ({ page }) => {
  await mockApi(page);
  await page.goto('/realtime/chat');
  const filter = page.getByRole('checkbox', { name: '仅看聊天' });
  await filter.check();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: '仅看聊天' })).toBeChecked();
  await page.getByRole('tab', { name: '玩家' }).click();
  await page.getByRole('tab', { name: '聊天' }).click();
  await expect(page.getByRole('checkbox', { name: '仅看聊天' })).toBeChecked();
});

test('player rows keep stamina and position on one line and expose selection tooltip', async ({ page }) => {
  await mockApi(page);
  await page.goto('/realtime/players');
  await expect(page.getByText('fixture-player')).toBeVisible();
  expect(await page.locator('.stamina-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length)).toBe(3);
  await expect(page.locator('.realtime-table thead th').filter({ hasText: '坐标' })).toBeVisible();
  await expect(page.locator('.realtime-table thead th').filter({ hasText: '相对中心点' })).toBeVisible();
  await expect(page.locator('.realtime-table thead th').filter({ hasText: '体力' })).toHaveCSS('text-align', 'right');
  await expect(page.locator('.realtime-table thead th')).toHaveText(['#', '名称', '状态', 'Drop', '额度', '今日收益', '今日击杀', '今日死亡', 'HP', '体力', '坐标', '相对中心点']);
  await expect(page.locator('.rank')).toHaveCSS('text-align', 'left');
  await expect(page.locator('.stamina-grid i').first()).toHaveCSS('text-align', 'right');
  await expect(page.locator('.position-cell').first()).toHaveCSS('display', 'grid');
  const tooltip = page.locator('.tooltip');
  await tooltip.hover();
  await expect(tooltip).toHaveAttribute('data-tooltip', /额度 Top50、Drop Top50、收益 Top50/);
  await expect(page.locator('.sort-header.active .sort-desc')).toHaveCount(1);
  await expect(page.locator('.sort-header:not(.active) .sort-desc')).toHaveCount(0);
  await expect(page.locator('.sort-header:not(.active)').first()).toHaveCSS('text-decoration-line', 'underline');
  await expect(page.locator('th').first()).toHaveCSS('padding-left', '12px');
  await expect(page.locator('td').first()).toHaveCSS('padding-right', '12px');
});

test('history player rows only show historical aggregate columns', async ({ page }) => {
  await mockApi(page);
  await page.goto('/history/players?from=2026-08-22&to=2026-08-22');
  const headers = page.locator('.player-table thead th');
  await expect(headers).toHaveText(['#', '名称', '收益', '击杀', '死亡']);
  await expect(page.getByRole('columnheader', { name: '状态' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Drop' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '额度' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'HP' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '体力' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '位置' })).toHaveCount(0);
});

test('realtime player list includes qualifying offline players', async ({ page }) => {
  await mockApi(page, [player, offlinePlayer]);
  await page.goto('/realtime/players');
  const row = page.locator('.player-table tbody tr').filter({ hasText: 'offline-player' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.status')).toHaveText(/\d+(天|小时|分钟|秒)前在线/);
  await expect(row.locator('td').nth(3)).toHaveText('25');
  await expect(row.locator('td').nth(8)).toHaveText('100');
  await expect(row.locator('td').nth(10)).toHaveText('--');
  await expect(row.locator('td').nth(11)).toHaveText('--');
});

test('realtime player list can show only online players', async ({ page }) => {
  await mockApi(page, [player, offlinePlayer]);
  await page.goto('/realtime/players');
  const filter = page.getByRole('checkbox', { name: '仅看在线' });
  await expect(filter).not.toBeChecked();
  await expect(page.getByText('offline-player')).toBeVisible();
  await filter.check();
  await expect(filter).toBeChecked();
  await expect(page.getByText('offline-player')).toHaveCount(0);
  await expect(page.getByText('1 位玩家')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: '仅看在线' })).toBeChecked();
});

test('realtime player quota uses external balance with three decimals', async ({ page }) => {
  await mockApi(page);
  await page.goto('/realtime/players');
  const row = page.locator('.player-table tbody tr').filter({ hasText: 'fixture-player' });
  await expect(row.locator('td').nth(4)).toHaveText('2.500');
  await expect(row.locator('.quota-integer')).toHaveText('2');
  await expect(row.locator('.quota-fraction')).toHaveText('.500');
});
