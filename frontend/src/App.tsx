import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject, type UIEvent, type WheelEvent } from 'react';
import { Activity, ArrowDown, CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CircleAlert, CircleHelp, Github, Map as MapIcon, Moon, RefreshCw, Rows3, Search, Swords, Sun, Users, X, ZoomIn, ZoomOut } from 'lucide-react';
import { getCachedResource, getMeta, getResource, getVersion, type HistoryPageQuery } from './api';
import { navigate, routePath, tabPath, useRoute, type PanelRoute, type RouteTab } from './route';
import type { HistoryFilterOptions, HistoryPagination, Kill, MapMetadata, MapPlayer, Message, MetaResponse, Player, PlayerState, ResourceResponse } from './types';

const THEME_KEY = 'grasp-rat:theme';
const MAP_THRESHOLD_KEY = 'grasp-rat:map-drop-threshold';
const PLAYER_SORT_KEY = 'grasp-rat:player-sort';
const KILL_THRESHOLD_KEY = 'grasp-rat:kill-drop-threshold';
const ONLY_CHAT_KEY = 'grasp-rat:only-chat';
const ONLY_ONLINE_PLAYERS_KEY = 'grasp-rat:only-online-players';
const HISTORY_PAGE_SIZE_KEY = 'grasp-rat:history-page-size';

// 后端只接受这三档；页大小进缓存键，任意值等于让同一份数据按用户输入无限增殖缓存条目。
const HISTORY_PAGE_SIZES = [100, 500, 1000] as const;
const DEFAULT_HISTORY_PAGE_SIZE = 500;
// 阈值滑块每动一格都重算一次：历史页是一个新的分页请求，实时页是几百行表格重排。
// 两边都等停手之后再生效。
const DROP_THRESHOLD_COMMIT_MS = 400;

function storageHistoryPageSize(): number {
  const saved = Number(localStorage.getItem(HISTORY_PAGE_SIZE_KEY));
  return HISTORY_PAGE_SIZES.includes(saved as typeof HISTORY_PAGE_SIZES[number]) ? saved : DEFAULT_HISTORY_PAGE_SIZE;
}

function storageOnlyChat(): boolean {
  return localStorage.getItem(ONLY_CHAT_KEY) === 'true';
}

const RANGE_LABELS: Record<string, string> = {
  yesterday: '昨天',
  'last-week': '上周',
  'last-month': '上月',
  custom: '指定日期'
};

const HISTORY_PRESETS = ['yesterday', 'last-week', 'last-month', 'custom'] as const;
type HistoryPreset = typeof HISTORY_PRESETS[number];

function formatTime(value?: string | null): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function displayNumber(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? '--' : Math.round(value).toLocaleString('zh-CN');
}

const EXTERNAL_BALANCE_PER_QUOTA = 500_000;

function quotaFromExternalBalance(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value / EXTERNAL_BALANCE_PER_QUOTA;
}

function quotaParts(value: number | null | undefined): { integer: string; fraction: string } | null {
  const quota = quotaFromExternalBalance(value);
  if (quota === null) return null;
  const formatted = quota.toLocaleString('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const decimalIndex = formatted.lastIndexOf('.');
  return { integer: formatted.slice(0, decimalIndex), fraction: formatted.slice(decimalIndex) };
}

function QuotaValue({ value }: { value: number | null | undefined }) {
  const parts = quotaParts(value);
  if (!parts) return <span className="muted">--</span>;
  return <span className="quota-value"><span className="quota-integer">{parts.integer}</span><span className="quota-fraction">{parts.fraction}</span></span>;
}

function displayCoordinate(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '--' : Math.round(value).toLocaleString('zh-CN');
}

function addDateDays(value: string | null | undefined, amount: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3])) return null;
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function historyTodayDate(meta: MetaResponse): string | null {
  return meta.presetRanges?.today?.to || meta.latestDate || null;
}

function latestHistoryDate(meta: MetaResponse): string | null {
  return addDateDays(historyTodayDate(meta), -1) || meta.latestDate || null;
}

function defaultHistoryRange(meta: MetaResponse): { from: string; to: string } | null {
  return meta.presetRanges?.yesterday || meta.presetRanges?.['last-week'] || meta.presetRanges?.['last-month'] || null;
}

function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${Math.max(0, Math.round(value))}秒`;
}

function formatOfflineStatus(value: string | null): string {
  if (!value) return '离线';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '离线';
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const units: [number, string][] = [[86_400_000, '天'], [3_600_000, '小时'], [60_000, '分钟'], [1_000, '秒']];
  const unit = units.find(([duration]) => elapsedMs >= duration) || units.at(-1)!;
  return `${Math.max(1, Math.floor(elapsedMs / unit[0]))}${unit[1]}前在线`;
}

const DROP_THRESHOLD_MIN = 1;
const DROP_THRESHOLD_MAX = 1000;
const DROP_THRESHOLD_STEP = 10;

function normalizeDropThreshold(value: number, fallback = 10): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  if (value <= DROP_THRESHOLD_MIN) return DROP_THRESHOLD_MIN;
  return Math.min(DROP_THRESHOLD_MAX, Math.max(DROP_THRESHOLD_STEP, Math.round(value / DROP_THRESHOLD_STEP) * DROP_THRESHOLD_STEP));
}

function storageDropThreshold(key: string): number {
  return normalizeDropThreshold(Number(localStorage.getItem(key)));
}

function nextDropThreshold(value: number, direction: -1 | 1): number {
  if (direction < 0) return value <= DROP_THRESHOLD_STEP ? DROP_THRESHOLD_MIN : value - DROP_THRESHOLD_STEP;
  return value === DROP_THRESHOLD_MIN ? DROP_THRESHOLD_STEP : Math.min(DROP_THRESHOLD_MAX, value + DROP_THRESHOLD_STEP);
}

function dropSliderValue(threshold: number): number {
  return threshold <= DROP_THRESHOLD_MIN ? DROP_THRESHOLD_MIN : Math.min(DROP_THRESHOLD_MAX, threshold + 1);
}

function dropThresholdFromSliderValue(value: number): number {
  if (value <= DROP_THRESHOLD_MIN) return DROP_THRESHOLD_MIN;
  if (value >= DROP_THRESHOLD_MAX) return DROP_THRESHOLD_MAX;
  return normalizeDropThreshold(value - 1);
}

// commitDelayMs > 0 时滑块自己维护草稿值，停手 delay 之后才把结果交出去：历史页避免
// 每动一格打一个新的分页请求，实时页避免每动一格重排整张表。
function DropThresholdSlider({ value, ariaLabel, onChange, commitDelayMs = 0 }: { value: number; ariaLabel: string; onChange: (value: number) => void; commitDelayMs?: number }) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | null>(null);
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const commit = (next: number) => {
    setDraft(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (commitDelayMs <= 0) { onChange(next); return; }
    timer.current = window.setTimeout(() => { timer.current = null; onChange(next); }, commitDelayMs);
  };
  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    commit(nextDropThreshold(draft, event.deltaY < 0 ? 1 : -1));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      commit(nextDropThreshold(draft, -1));
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      commit(nextDropThreshold(draft, 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      commit(DROP_THRESHOLD_MIN);
    } else if (event.key === 'End') {
      event.preventDefault();
      commit(DROP_THRESHOLD_MAX);
    }
  };
  const handlePointerEnd = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX >= rect.right - 4 || Number(event.currentTarget.getAttribute('value')) >= DROP_THRESHOLD_MAX - DROP_THRESHOLD_STEP + DROP_THRESHOLD_MIN) commit(DROP_THRESHOLD_MAX);
  };
  return <label className="drop-threshold-control" title="拖动滑块或悬停后滚动鼠标滚轮调整 Drop 阈值"><span>Drop ≥</span><input className="drop-threshold-slider" type="range" min={DROP_THRESHOLD_MIN} max={DROP_THRESHOLD_MAX} step={DROP_THRESHOLD_STEP} value={dropSliderValue(draft)} aria-label={ariaLabel} aria-valuemin={DROP_THRESHOLD_MIN} aria-valuemax={DROP_THRESHOLD_MAX} aria-valuenow={draft} aria-valuetext={displayNumber(draft)} onChange={event => commit(dropThresholdFromSliderValue(Number(event.currentTarget.value)))} onKeyDown={handleKeyDown} onClick={handlePointerEnd} onWheel={handleWheel} /><output className="drop-threshold-value">{displayNumber(draft)}</output></label>;
}

interface HistoryPageState {
  pageSize: number;
  page: number | 'last';
  minDrop: number;
  users: number[];
  onlyChat: boolean;
}

// 只有历史聊天和历史击杀走后端分页；玩家页返回的是排名候选，本来就只有几十行。
function historyPageQuery(scope: PanelRoute['scope'], tab: RouteTab, state: HistoryPageState): HistoryPageQuery | null {
  if (scope !== 'history') return null;
  if (tab === 'chat') return { pageSize: state.pageSize, page: state.page, onlyChat: state.onlyChat };
  if (tab === 'kills') return { pageSize: state.pageSize, page: state.page, minDrop: state.minDrop, users: state.users };
  return null;
}

interface PageControl {
  state: HistoryPageState;
  pagination: HistoryPagination | null;
  update: (patch: Partial<HistoryPageState>) => void;
}

function Pager({ control }: { control: PageControl }) {
  // 本地页号是明确的意图，直接显示，翻页按钮才不会等一趟网络才变。只有 'last' 要等
  // 服务端解析（总页数是它算的），过滤条件变化时页号一律回到第一页，所以本地值不会越界。
  const page = typeof control.state.page === 'number' ? control.state.page : control.pagination?.page ?? 1;
  const totalPages = control.pagination?.totalPages ?? 1;
  const total = control.pagination?.total ?? null;
  return <div className="pager">
    <label className="pager-size">每页<select value={control.state.pageSize} onChange={event => control.update({ pageSize: Number(event.currentTarget.value), page: 1 })} aria-label="每页条数">{HISTORY_PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}</select></label>
    <span className="pager-total">{total === null ? '--' : `共 ${displayNumber(total)} 条`}</span>
    <div className="pager-buttons">
      <button type="button" className="pager-button" disabled={page <= 1} onClick={() => control.update({ page: 1 })} aria-label="第一页" title="第一页"><ChevronsLeft size={13} /></button>
      <button type="button" className="pager-button" disabled={page <= 1} onClick={() => control.update({ page: page - 1 })} aria-label="上一页" title="上一页"><ChevronLeft size={13} /></button>
      <span className="pager-position">{displayNumber(page)} / {displayNumber(totalPages)}</span>
      <button type="button" className="pager-button" disabled={page >= totalPages} onClick={() => control.update({ page: page + 1 })} aria-label="下一页" title="下一页"><ChevronRight size={13} /></button>
      <button type="button" className="pager-button" disabled={page >= totalPages} onClick={() => control.update({ page: 'last' })} aria-label="最后一页" title="最后一页"><ChevronsRight size={13} /></button>
    </div>
  </div>;
}

function resourceKey(route: PanelRoute): string {
  return route.scope === 'history'
    ? `${route.tab}:${route.from || ''}:${route.to || ''}`
    : `${route.tab}:latest`;
}

interface ResourceQueryState {
  resource: ResourceResponse | null;
  loading: boolean;
  error: string | null;
  versionError: string | null;
  updatedAt: string | null;
  // 世界重启后实体集合要几分钟才长回来。实时页跟的就是这段时间的最新版本，所以要说清楚
  // 人少是因为世界在恢复，而不是数据停在了昨天。
  warmingUp: boolean;
}

function useResourceQuery(route: PanelRoute, page: HistoryPageQuery | null): ResourceQueryState {
  const [state, setState] = useState<ResourceQueryState>({ resource: null, loading: true, error: null, versionError: null, updatedAt: null, warmingUp: false });
  const key = resourceKey(route);
  // 翻页和调过滤条件只换分页参数，不换标签：这时保留面板本身（分页器要留在原地，否则
  // 鼠标底下的按钮会消失），但 loading 会让面板把数据部分清空——留着上一页的行会让人
  // 分不清看到的是新结果还是旧结果。换标签或换区间则整块清空，否则击杀表会先拿到聊天
  // 资源渲染一帧空表。
  const pageKey = JSON.stringify(page);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (route.scope === 'history' && (!route.from || !route.to)) {
      setState(current => ({ ...current, loading: true }));
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    const cached = getCachedResource(route.scope, route.tab, route.scope === 'history' ? `${route.from}:${route.to}` : 'latest', page);
    const sameRoute = lastKey.current === key;
    lastKey.current = key;
    let currentToken = cached?.versionToken || null;
    setState(current => ({ resource: cached || (sameRoute ? current.resource : null), loading: !cached, error: null, versionError: null, updatedAt: cached?.generatedAt || (sameRoute ? current.updatedAt : null), warmingUp: sameRoute ? current.warmingUp : false }));

    const loadRealtime = async () => {
      let version: Awaited<ReturnType<typeof getVersion>>;
      try {
        version = await getVersion(controller.signal);
        if (disposed) return;
        setState(current => ({ ...current, versionError: null, warmingUp: Boolean(version.warmingUp) }));
      } catch (error) {
        if (!disposed && (error as Error).name !== 'AbortError') setState(current => ({ ...current, loading: false, versionError: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (currentToken && currentToken === version.versionToken) {
        if (!disposed) setState(current => ({ ...current, loading: false }));
        return;
      }
      try {
        const next = await getResource('realtime', route.tab, currentToken, controller.signal);
        if (disposed) return;
        if (!next.unchanged) currentToken = next.versionToken || version.versionToken;
        setState({ resource: next.unchanged ? cached : next, loading: false, error: null, versionError: null, updatedAt: next.unchanged ? cached?.generatedAt || null : new Date().toISOString(), warmingUp: Boolean(version.warmingUp) });
      } catch (error) {
        if (!disposed && (error as Error).name !== 'AbortError') setState(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
      }
    };

    const loadHistory = async () => {
      try {
        const next = await getResource('history', route.tab as 'chat' | 'players' | 'kills', { from: route.from!, to: route.to!, page }, controller.signal);
        if (!disposed) setState({ resource: next, loading: false, error: null, versionError: null, updatedAt: next.generatedAt, warmingUp: false });
      } catch (error) {
        // 历史查询失败就把上一份结果一起丢掉：它属于另一组参数，留在屏幕上只会误导。
        // 实时是轮询，一次失败不该清屏，所以只有这条路径这么做。
        if (!disposed && (error as Error).name !== 'AbortError') setState({ resource: null, loading: false, error: error instanceof Error ? error.message : String(error), versionError: null, updatedAt: null, warmingUp: false });
      }
    };

    if (route.scope === 'realtime') {
      void loadRealtime();
      const pollMs = Number(import.meta.env.VITE_REALTIME_POLL_MS || 10_000);
      const interval = window.setInterval(() => { void loadRealtime(); }, Number.isFinite(pollMs) && pollMs >= 1_000 ? pollMs : 10_000);
      return () => { disposed = true; window.clearInterval(interval); controller.abort(); };
    }
    void loadHistory();
    return () => { disposed = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pageKey, route.scope, route.tab, route.from, route.to]);

  return state;
}

function NavLink({ route, children, className, active }: { route: PanelRoute; children: ReactNode; className?: string; active?: boolean }) {
  const href = routePath(route);
  return <a className={className} href={href} aria-current={active ? 'page' : undefined} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(route); }}>{children}</a>;
}

function Banner({ theme, onTheme, route }: { theme: 'light' | 'dark'; onTheme: () => void; route: PanelRoute }) {
  return <header className="banner">
    <div className="brand-lockup"><span className="brand-mark"><Activity size={16} strokeWidth={2.5} /></span><h1>Grasp Rat <em>Open Panel</em></h1></div>
    <nav className="scope-nav" aria-label="数据范围">
      <NavLink route={{ scope: 'realtime', tab: 'map', from: null, to: null }} active={route.scope === 'realtime'}>实时</NavLink>
      <NavLink route={{ scope: 'history', tab: 'chat', from: route.from, to: route.to }} active={route.scope === 'history'}>历史</NavLink>
    </nav>
    <button className="icon-button" onClick={onTheme} aria-label={theme === 'light' ? '切换暗色模式' : '切换亮色模式'} title={theme === 'light' ? '暗色模式' : '亮色模式'}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button>
  </header>;
}

function HistoryRangeControls({ meta, route }: { meta: MetaResponse; route: PanelRoute }) {
  const range = { from: route.from || '', to: route.to || '' };
  const today = historyTodayDate(meta);
  const latestHistory = latestHistoryDate(meta);
  const availableHistoryDates = (meta.availableDates || []).filter(date => !today || date < today);
  const customRange = Boolean((range.from || range.to) && !Object.values(meta.presetRanges || {}).some(item => item?.from === range.from && item?.to === range.to));
  const [customSelected, setCustomSelected] = useState(customRange);
  const rangeKey = `${range.from}:${range.to}`;
  const previousRangeKey = useRef(rangeKey);
  useEffect(() => {
    if (previousRangeKey.current === rangeKey) return;
    previousRangeKey.current = rangeKey;
    setCustomSelected(customRange);
  }, [customRange, rangeKey]);
  const setPreset = (preset: HistoryPreset) => {
    if (preset === 'custom') {
      setCustomSelected(true);
      return;
    }
    const next = meta.presetRanges?.[preset as keyof MetaResponse['presetRanges']];
    if (!next) return;
    setCustomSelected(false);
    navigate({ ...route, scope: 'history', tab: route.tab === 'map' ? 'chat' : route.tab, from: next.from, to: next.to });
  };
  const updateDate = (field: 'from' | 'to', value: string) => {
    if (value && !availableHistoryDates.includes(value)) return;
    const next = { ...range, [field]: value };
    if (next.from && next.to && next.from > next.to) return;
    navigate({ ...route, scope: 'history', from: next.from || null, to: next.to || null });
  };
  return <section className="history-range panel-block" aria-label="历史时间范围">
    <div className="range-heading"><h2>历史范围</h2><CalendarDays size={16} /></div>
    <div className="range-content"><div className="range-selection"><div className="preset-grid">{HISTORY_PRESETS.map(value => {
      const available = value === 'custom' || Boolean(meta.presetRanges?.[value]);
      const active = value === 'custom' ? customSelected : meta.presetRanges?.[value]?.from === range.from && meta.presetRanges?.[value]?.to === range.to;
      return <button key={value} className={active ? 'preset active' : 'preset'} onClick={() => setPreset(value)} disabled={!available} title={available ? undefined : '当前没有覆盖该范围的历史数据'}>{RANGE_LABELS[value]}</button>;
    })}</div>{customSelected && <div className="date-fields"><label><input type="date" aria-label="起始日" list="available-history-dates" min={meta.earliestDate || undefined} max={latestHistory || undefined} value={range.from} onChange={event => updateDate('from', event.target.value)} /></label><span>→</span><label><input type="date" aria-label="结束日" list="available-history-dates" min={meta.earliestDate || undefined} max={latestHistory || undefined} value={range.to} onChange={event => updateDate('to', event.target.value)} /></label><datalist id="available-history-dates">{availableHistoryDates.map(date => <option key={date} value={date} />)}</datalist></div>}</div><p className="micro-note">可用历史数据：{meta.earliestDate || '--'} 至 {latestHistory || '--'} · 不包含今天 · {meta.timezone}</p></div>
  </section>;
}

const REALTIME_TABS: { tab: RouteTab; label: string; icon: typeof MapIcon }[] = [
  { tab: 'map', label: '地图', icon: MapIcon },
  { tab: 'chat', label: '聊天', icon: Rows3 },
  { tab: 'players', label: '玩家', icon: Users },
  { tab: 'kills', label: '击杀', icon: Swords }
];
const HISTORY_TABS: { tab: RouteTab; label: string; icon: typeof MapIcon }[] = [
  { tab: 'chat', label: '聊天', icon: Rows3 },
  { tab: 'players', label: '玩家', icon: Users },
  { tab: 'kills', label: '击杀', icon: Swords }
];

function TabMenu({ route }: { route: PanelRoute }) {
  const tabs = route.scope === 'realtime' ? REALTIME_TABS : HISTORY_TABS;
  return <nav className="tab-menu" role="tablist" aria-label={route.scope === 'realtime' ? '实时标签' : '历史标签'}>{tabs.map(({ tab, label, icon: Icon }) => {
    const target = { ...route, tab };
    return <a key={tab} href={tabPath(route.scope, tab, route)} className={route.tab === tab ? 'tab active' : 'tab'} role="tab" aria-selected={route.tab === tab} aria-current={route.tab === tab ? 'page' : undefined} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(target); }}><Icon size={15} />{label}</a>;
  })}</nav>;
}

function EmptyState({ text }: { text: string }) { return <div className="empty-state"><Rows3 size={18} /><span>{text}</span></div>; }

// 历史页换查询参数时数据部分先清空：留着上一页的行会让人分不清看到的是新结果还是旧结果。
function LoadingState() { return <div className="empty-state"><RefreshCw size={16} className="spin" /><span>正在加载…</span></div>; }

function PanelHead({ title, subtitle, tooltip, actions }: { title: string; subtitle?: ReactNode; tooltip?: string; actions?: ReactNode }) {
  return <div className="panel-head">
    <div className="panel-title"><h2>{title}</h2>{subtitle !== undefined && <span className="result-count">{subtitle}</span>}{tooltip && <span className="tooltip" tabIndex={0} role="img" aria-label={`${title}显示条件`} data-tooltip={tooltip}><CircleHelp size={14} /></span>}</div>
    {actions && <div className="panel-actions">{actions}</div>}
  </div>;
}

// 历史页平时不显示状态行：查的是哪个区间上面的范围选择器已经写着，加载状态由数据区自己
// 显示，而静态历史数据的"更新于"只是这次请求发生的时刻，没有信息量。出错还是要说。
function StatusBar({ meta, query, route }: { meta: MetaResponse; query: ResourceQueryState; route: PanelRoute }) {
  const resourceLabel = route.tab === 'chat' ? '聊天' : route.tab === 'map' ? '地图' : route.tab === 'players' ? '玩家' : '击杀';
  const alert = query.versionError ? <><CircleAlert size={14} />实时版本检查失败：{query.versionError}</> : query.error ? <><CircleAlert size={14} />{resourceLabel}数据暂不可用：{query.error}</> : null;
  if (route.scope === 'history') return alert ? <div className="global-status" role="status">{alert}</div> : null;
  return <div className="global-status" role="status">{alert || (query.loading ? <><RefreshCw size={14} className="spin" />正在加载{resourceLabel}…</> : <><span className="status-dot" />服务运行中{query.warmingUp ? ' · 世界刚重启，实体仍在恢复' : ''} · {meta.timezone}{query.updatedAt ? ` · ${formatTime(query.updatedAt)}` : ''}</>)}</div>;
}

// 实时页的列表是"最新在下"，所以要黏在底部；历史页分页之后每页都是一个独立的片段，
// 翻到哪页都从头看，所以回到顶部。
function useListScroll(ref: RefObject<HTMLElement>, contentKey: string, resetKey: number, anchor: 'bottom' | 'top'): (event: UIEvent<HTMLElement>) => void {
  const atBottom = useRef(true);
  const lastReset = useRef(-1);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const forced = lastReset.current !== resetKey;
    lastReset.current = resetKey;
    if (anchor === 'top') { element.scrollTop = 0; return; }
    if (forced || atBottom.current) element.scrollTop = element.scrollHeight;
  }, [anchor, contentKey, ref, resetKey]);
  useEffect(() => {
    const element = ref.current;
    if (anchor !== 'bottom' || !element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const bottom = element.scrollHeight - (element.scrollTop + element.clientHeight) <= 12;
      if (bottom) { atBottom.current = true; element.scrollTop = element.scrollHeight; }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor, ref]);
  return event => {
    const element = event.currentTarget;
    atBottom.current = element.scrollHeight - (element.scrollTop + element.clientHeight) <= 12;
  };
}

type ChatRow = { kind: 'message'; message: Message; key: string } | { kind: 'kill-summary'; count: number; key: string };

// 历史页的"仅看聊天"是分页接口的入参：行由后端过滤，本页 100 条就是 100 条聊天。
// 折叠摘要还在，只是数字换了来源——后端在留下的每条消息上写 folded_before，末页再带一个
// foldedAfter，前端照着画就行，不必为了数个数把被折掉的几百条击杀也传过来。
// 实时页只有当前快照那一份数据，继续在本地折叠。
function chatRows(messages: Message[], onlyChat: boolean, serverFiltered: boolean, foldedAfter: number): ChatRow[] {
  const sorted = messages.slice().sort((a, b) => String(a.event_at || a.eventAt || '').localeCompare(String(b.event_at || b.eventAt || '')));
  const keyOf = (message: Message, index: number) => `${message.message_id || message.messageId || index}`;
  if (!onlyChat) return sorted.map((message, index) => ({ kind: 'message', message, key: keyOf(message, index) }));
  const rows: ChatRow[] = [];
  const fold = (count: number, at: string) => { if (count > 0) rows.push({ kind: 'kill-summary', count, key: `kill-summary:${at}:${count}` }); };
  if (serverFiltered) {
    sorted.forEach((message, index) => {
      const key = keyOf(message, index);
      fold(message.folded_before || 0, `before:${key}`);
      rows.push({ kind: 'message', message, key });
    });
    fold(foldedAfter, 'tail');
    return rows;
  }
  let pending = 0;
  let start = '';
  sorted.forEach((message, index) => {
    const key = keyOf(message, index);
    if (String(message.kind || '').toLowerCase() === 'kill') {
      if (!start) start = key;
      pending += 1;
      return;
    }
    fold(pending, start);
    pending = 0;
    start = '';
    rows.push({ kind: 'message', message, key });
  });
  fold(pending, start);
  return rows;
}

function ChatPanel({ messages, page, loading, foldedAfter }: { messages: Message[]; page: PageControl | null; loading: boolean; foldedAfter: number }) {
  const [localOnlyChat, setLocalOnlyChat] = useState(storageOnlyChat);
  const [filterVersion, setFilterVersion] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onlyChat = page ? page.state.onlyChat : localOnlyChat;
  const rows = useMemo(() => chatRows(messages, onlyChat, Boolean(page), foldedAfter), [foldedAfter, messages, onlyChat, page]);
  const contentKey = rows.map(row => row.kind === 'kill-summary' ? row.key : `${row.key}:${row.message.text}`).join('|');
  const onScroll = useListScroll(scrollRef, contentKey, filterVersion, page ? 'top' : 'bottom');
  // 本地状态始终跟着写：切到另一个范围时 App 会重新读这个偏好，两边不能各记一份。
  const setOnlyChatValue = (next: boolean) => {
    localStorage.setItem(ONLY_CHAT_KEY, String(next));
    setLocalOnlyChat(next);
    setFilterVersion(value => value + 1);
    if (page) page.update({ onlyChat: next, page: 1 });
  };
  return <section className="chat-page tab-panel panel-block">
    <PanelHead title="聊天记录" actions={<><label className="switch-label"><input type="checkbox" checked={onlyChat} onChange={event => setOnlyChatValue(event.target.checked)} /><span className="switch" />仅看聊天</label>{page && <Pager control={page} />}</>} />
    <div className="panel-body"><div className="chat-list" ref={scrollRef} onScroll={onScroll} aria-label="聊天记录滚动区">{loading ? <LoadingState /> : rows.length === 0 ? <EmptyState text="这个范围还没有消息" /> : rows.map(row => {
      if (row.kind === 'kill-summary') return <div className="chat-row kill-summary" key={row.key}><span>{row.count}条击杀记录已折叠</span></div>;
      const isKill = String(row.message.kind || '').toLowerCase() === 'kill';
      return <div className={isKill ? 'chat-row kill' : 'chat-row'} key={row.key}><time>{formatTime(row.message.event_at || row.message.eventAt)}</time><p>{!isKill && row.message.user_name && <strong>{row.message.user_name}</strong>}<span>{row.message.text}</span></p></div>;
    })}</div></div>
  </section>;
}

function valueColor(value: number | null, thresholds: [number, string][], fallback = 'muted'): string {
  if (value === null || value === undefined) return fallback;
  for (const [threshold, color] of thresholds) if (value >= threshold) return color;
  return thresholds.at(-1)?.[1] || fallback;
}

function positionForCoordinates(x: number | null, y: number | null, map: MapMetadata): { distance: number | null; direction: string; color: string } {
  if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return { distance: null, direction: '未知', color: 'muted' };
  const dx = x - map.center.x;
  const dy = y - map.center.y;
  const distance = Math.round(Math.hypot(dx, dy) * map.metersPerGameUnit);
  const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
  const index = Math.round(angle / (Math.PI / 4)) % 8;
  return { distance, direction: map.directions[index] || '未知', color: distance <= 1000 ? 'good' : 'warn' };
}

function PositionCells({ x, y, map, empty = false }: { x: number | null; y: number | null; map: MapMetadata; empty?: boolean }) {
  const position = positionForCoordinates(x, y, map);
  if (empty) return <><td><span className="position-cell coordinate-cell muted">--</span></td><td><span className="position-cell direction-cell muted">--</span></td></>;
  return <><td><span className="position-cell coordinate-cell"><span>x {displayCoordinate(x)} / y {displayCoordinate(y)}</span></span></td><td><span className={`position-cell direction-cell ${position.color}`}><span>{position.direction} · {position.distance === null ? '--' : `${displayNumber(position.distance)}米`}</span></span></td></>;
}

type StaminaState = Pick<PlayerState, 'stamina5s' | 'stamina5sLimit' | 'stamina1d' | 'stamina1dLimit'>;

function stateColor(player: { state: StaminaState | null }): string {
  const state = player.state;
  if (!state) return 'muted';
  if (state.stamina5s !== null && state.stamina5sLimit !== null && state.stamina5s < state.stamina5sLimit) return 'bad';
  if (state.stamina1d !== null && state.stamina1dLimit !== null && state.stamina1d < state.stamina1dLimit) return 'light';
  return 'good';
}

function StaminaCell({ player }: { player: Player }) {
  const state = player.state;
  if (!state) return <span className="stamina-grid"><i className="muted" style={{ gridColumn: 3 }}>--</i></span>;
  const values: [number | null, string][] = [
    [state.stamina5s, state.stamina5sLimit === 0 ? 'bad' : state.stamina5s !== null && state.stamina5sLimit !== null && state.stamina5s >= state.stamina5sLimit ? 'good' : 'warn'],
    [state.stamina1h, state.stamina1h === 0 ? 'bad' : state.stamina1h !== null && state.stamina1h >= 1_000_000 ? 'good' : 'warn'],
    [state.stamina1d, state.stamina1d === 0 ? 'bad' : state.stamina1d !== null && state.stamina1d >= 1_000_000 ? 'good' : 'warn']
  ];
  return <span className="stamina-grid">{values.map(([value, color], index) => <i className={color} key={index}>{displayNumber(value === null ? null : Math.round(value / 1000))}</i>)}</span>;
}

type PlayerSort = 'drop' | 'quota' | 'income' | 'kills' | 'deaths';

function initialPlayerSort(scope: 'realtime' | 'history' = 'realtime'): PlayerSort {
  const value = localStorage.getItem(PLAYER_SORT_KEY)?.split(':')[0];
  if (scope === 'history') return value === 'income' || value === 'kills' || value === 'deaths' ? value : 'income';
  return value === 'drop' || value === 'quota' || value === 'income' || value === 'kills' || value === 'deaths' ? value : 'quota';
}

const PLAYER_SELECTION_TOOLTIP = '玩家列表显示额度 Top50、Drop Top50、收益 Top50 的并集；实时页包含在线、离线和今天从未上线的玩家，历史页按所选日期范围聚合。';
const MAP_PLAYER_SELECTION_TOOLTIP = '地图显示 Drop 达到当前阈值或 1d 体力未满的玩家；只有拥有有效坐标的玩家会显示在地图上。';

function PlayersTable({ players, map, scope }: { players: Player[]; map: MapMetadata; scope: 'realtime' | 'history' }) {
  const isRealtime = scope === 'realtime';
  const [sort, setSort] = useState<PlayerSort>(() => initialPlayerSort(scope));
  useEffect(() => {
    if (!isRealtime && (sort === 'drop' || sort === 'quota')) setSort('income');
  }, [isRealtime, sort]);
  const setSortKey = (key: PlayerSort) => { setSort(key); localStorage.setItem(PLAYER_SORT_KEY, `${key}:desc`); };
  const sorted = useMemo(() => players.slice().sort((a, b) => {
    const value = (player: Player): number | null => ({ drop: player.drop, quota: quotaFromExternalBalance(player.externalBalanceSnapshot), income: player.income, kills: player.kills, deaths: player.deaths }[sort] ?? null);
    const av = value(a); const bv = value(b);
    if (av === null && bv === null) return a.name.localeCompare(b.name) || a.userId - b.userId;
    if (av === null) return 1;
    if (bv === null) return -1;
    return Number(bv) - Number(av) || a.name.localeCompare(b.name) || a.userId - b.userId;
  }), [players, sort]);
  const header = (key: PlayerSort, text: string) => <button className={sort === key ? 'sort-header active' : 'sort-header'} onClick={() => setSortKey(key)} title={`按${text}从大到小排序`}><span>{text}</span>{sort === key && <ArrowDown className="sort-desc" size={12} strokeWidth={2.5} aria-hidden="true" />}</button>;
  const incomeLabel = isRealtime ? '今日收益' : '收益';
  const killsLabel = isRealtime ? '今日击杀' : '击杀';
  const deathsLabel = isRealtime ? '今日死亡' : '死亡';
  return (
    <div className="table-shell" aria-label="玩家表格滚动区">
      <table className={isRealtime ? 'player-table realtime-table' : 'player-table history-table'}>
        <colgroup>
          <col className="col-rank" />
          <col className="col-name" />
          {isRealtime && <><col className="col-status" /><col className="col-number" /><col className="col-number" /></>}
          <col className="col-number" />
          {isRealtime ? <><col className="col-number" /><col className="col-number" /><col className="col-hp" /><col className="col-stamina" /><col className="col-position-coordinate" /><col className="col-position-direction" /></> : <><col className="col-number" /><col className="col-number" /></>}
        </colgroup>
        <thead>
          <tr>
            <th>#</th>
            <th>名称</th>
            {isRealtime && <><th>状态</th><th className="numeric-head">{header('drop', 'Drop')}</th><th className="numeric-head">{header('quota', '额度')}</th></>}
            <th className="numeric-head">{header('income', incomeLabel)}</th>
            {isRealtime ? <><th className="numeric-head">{header('kills', killsLabel)}</th><th className="numeric-head">{header('deaths', deathsLabel)}</th><th className="numeric-head">HP</th><th className="numeric-head">体力</th><th>坐标</th><th>相对中心点</th></> : <><th className="numeric-head">{header('kills', killsLabel)}</th><th className="numeric-head">{header('deaths', deathsLabel)}</th></>}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? <tr><td colSpan={isRealtime ? 12 : 5}><EmptyState text="这个范围还没有玩家数据" /></td></tr> : sorted.map((player, index) => {
            const hp = player.state?.hp ?? null;
            const positionX = isRealtime && !player.online ? null : player.state?.x ?? null;
            const positionY = isRealtime && !player.online ? null : player.state?.y ?? null;
            const incomeClass = player.income !== null && player.income > 0 ? 'negative' : player.income !== null && player.income < 0 ? 'positive' : '';
            return <tr key={player.userId}>
              <td className="rank">{index + 1}</td>
              <td className="name-cell" title={player.name}>{player.name || '未命名'}</td>
              {isRealtime && <><td><span className={player.online ? 'status online' : 'status'}>{player.online ? '在线' : formatOfflineStatus(player.lastSeenAt)}</span></td><td className="numeric">{displayNumber(player.drop)}</td><td className="numeric"><QuotaValue value={player.externalBalanceSnapshot} /></td></>}
              <td className={`numeric ${incomeClass}`}>{player.income === null ? '--' : player.income > 0 ? `+${displayNumber(player.income)}` : displayNumber(player.income)}</td>
              {isRealtime ? <><td className="numeric">{displayNumber(player.kills)}</td><td className="numeric">{displayNumber(player.deaths)}</td><td className={`numeric ${valueColor(hp, [[80, 'good'], [50, 'warn'], [20, 'orange'], [0, 'bad']])}`}>{displayNumber(hp)}</td><td><StaminaCell player={player} /></td><PositionCells x={positionX} y={positionY} map={map} empty={!player.online} /></> : <><td className="numeric">{displayNumber(player.kills)}</td><td className="numeric">{displayNumber(player.deaths)}</td></>}
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Camera { zoom: number; center: { x: number; y: number } }
interface MapSize { width: number; height: number }

function MapView({ players, map }: { players: MapPlayer[]; map: MapMetadata }) {
  const [threshold, setThreshold] = useState(() => storageDropThreshold(MAP_THRESHOLD_KEY));
  const [size, setSize] = useState<MapSize>({ width: 1, height: 1 });
  const [camera, setCamera] = useState<Camera>({ zoom: 1, center: map.center });
  const [mouseWorld, setMouseWorld] = useState<{ x: number; y: number } | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const pinchRef = useRef<number | null>(null);

  const mapCenterX = map.center.x;
  const mapCenterY = map.center.y;
  useEffect(() => { setCamera({ zoom: 1, center: { x: mapCenterX, y: mapCenterY } }); setHoveredId(null); setSelectedId(null); }, [map.id, map.version, mapCenterX, mapCenterY]);
  useEffect(() => {
    const element = stageRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const update = () => setSize({ width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const worldWidth = Math.max(1, map.bounds.maxX - map.bounds.minX);
  const worldHeight = Math.max(1, map.bounds.maxY - map.bounds.minY);
  const fitScale = Math.max(0.000001, Math.min((size.width - 10) / worldWidth, (size.height - 10) / worldHeight));
  const minimumViewRadius = (Math.min(size.width, size.height) / (2 * fitScale)) * map.metersPerGameUnit;
  const maxZoom = Math.max(1, minimumViewRadius / 150);
  const scale = fitScale * Math.min(camera.zoom, maxZoom);
  const clampCenter = (center: { x: number; y: number }, zoom = Math.min(camera.zoom, maxZoom)): { x: number; y: number } => {
    const nextScale = fitScale * Math.min(zoom, maxZoom);
    const halfWidth = size.width / (2 * nextScale);
    const halfHeight = size.height / (2 * nextScale);
    const clamp = (value: number, min: number, max: number) => min > max ? (min + max) / 2 : Math.min(max, Math.max(min, value));
    return { x: clamp(center.x, map.bounds.minX + halfWidth, map.bounds.maxX - halfWidth), y: clamp(center.y, map.bounds.minY + halfHeight, map.bounds.maxY - halfHeight) };
  };
  const worldToScreen = (x: number, y: number, current = camera) => {
    const zoom = Math.min(current.zoom, maxZoom);
    return { x: size.width / 2 + (x - current.center.x) * fitScale * zoom, y: size.height / 2 + (y - current.center.y) * fitScale * zoom };
  };
  const screenToWorld = (x: number, y: number, current = camera) => {
    const zoom = Math.min(current.zoom, maxZoom);
    return { x: current.center.x + (x - size.width / 2) / (fitScale * zoom), y: current.center.y + (y - size.height / 2) / (fitScale * zoom) };
  };
  const pointerPosition = (event: { clientX: number; clientY: number }) => { const rect = stageRef.current?.getBoundingClientRect(); if (!rect) return null; return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const setZoomAt = (nextZoom: number, anchor?: { x: number; y: number }) => setCamera(current => {
    const zoom = Math.min(maxZoom, Math.max(1, nextZoom));
    if (!anchor) return { zoom, center: clampCenter(current.center, zoom) };
    const world = screenToWorld(anchor.x, anchor.y, current);
    const nextScale = fitScale * zoom;
    const center = { x: world.x - (anchor.x - size.width / 2) / nextScale, y: world.y - (anchor.y - size.height / 2) / nextScale };
    return { zoom, center: clampCenter(center, zoom) };
  });
  const zoomHandlerRef = useRef<(next: number, anchor?: { x: number; y: number }) => void>(() => {});
  zoomHandlerRef.current = (next, anchor) => setZoomAt(next, anchor);
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const point = pointerPosition(event);
      zoomHandlerRef.current(cameraRef.current.zoom * (event.deltaY > 0 ? 0.9 : 1.1), point || undefined);
    };
    const onTouchMove = (event: globalThis.TouchEvent) => {
      if (event.touches.length !== 2 || pinchRef.current === null) return;
      event.preventDefault();
      const distance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
      const next = cameraRef.current.zoom * (distance / pinchRef.current);
      pinchRef.current = distance;
      zoomHandlerRef.current(next);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => { element.removeEventListener('wheel', onWheel); element.removeEventListener('touchmove', onTouchMove); };
  }, []);
  const filtered = players.filter(player => {
    const dropMatch = player.drop !== null && player.drop >= threshold;
    const tired = player.state?.stamina1d !== null && player.state?.stamina1dLimit !== null && Boolean(player.state && player.state.stamina1d < player.state.stamina1dLimit);
    const hasPosition = player.state?.x !== null && player.state?.x !== undefined && player.state?.y !== null && player.state?.y !== undefined;
    return hasPosition && (dropMatch || tired);
  });
  const hovered = players.find(player => player.userId === (selectedId ?? hoveredId)) || null;
  const worldRadius = 1000 / Math.max(0.000001, map.metersPerGameUnit);
  const viewRadius = Math.round((Math.min(size.width, size.height) / (2 * scale)) * map.metersPerGameUnit);
  const updateThreshold = (next: number) => { setThreshold(next); localStorage.setItem(MAP_THRESHOLD_KEY, String(next)); };
  const zoomIn = () => setZoomAt(camera.zoom * 1.35);
  const zoomOut = () => setZoomAt(camera.zoom / 1.35);

  return <section className="map-panel tab-panel panel-block"><PanelHead title="实时地图" tooltip={MAP_PLAYER_SELECTION_TOOLTIP} actions={<DropThresholdSlider value={threshold} ariaLabel="地图 Drop 阈值" onChange={updateThreshold} commitDelayMs={DROP_THRESHOLD_COMMIT_MS} />} /><div className="panel-body"><div className="map-stage"><div className="map-canvas" ref={stageRef} onPointerDown={event => { const point = pointerPosition(event); if (!point) return; dragRef.current = { pointerId: event.pointerId, x: point.x, y: point.y }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { const point = pointerPosition(event); if (!point) return; setMouseWorld(screenToWorld(point.x, point.y)); if (dragRef.current?.pointerId === event.pointerId && camera.zoom > 1) { const dx = point.x - dragRef.current.x; const dy = point.y - dragRef.current.y; setCamera(current => ({ ...current, center: clampCenter({ x: current.center.x - dx / scale, y: current.center.y - dy / scale }) })); dragRef.current = { pointerId: event.pointerId, x: point.x, y: point.y }; } }} onPointerUp={event => { dragRef.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragRef.current = null; }} onPointerLeave={() => { setMouseWorld(null); setHoveredId(null); }} onTouchStart={event => { if (event.touches.length === 2) pinchRef.current = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY); }} onTouchEnd={() => { pinchRef.current = null; }}>
    <svg viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label="实时玩家地图">
      {(() => { const x0Top = worldToScreen(0, map.bounds.minY); const x0Bottom = worldToScreen(0, map.bounds.maxY); const y0Left = worldToScreen(map.bounds.minX, 0); const y0Right = worldToScreen(map.bounds.maxX, 0); const center = worldToScreen(map.center.x, map.center.y); return <><path d={`M${x0Top.x} ${x0Top.y} L${x0Bottom.x} ${x0Bottom.y} M${y0Left.x} ${y0Left.y} L${y0Right.x} ${y0Right.y}`} className="map-axis" /><circle cx={center.x} cy={center.y} r={worldRadius * scale} className="map-center-ring" /><text x={x0Bottom.x + 7} y={x0Bottom.y - 7} className="map-detail">x=0</text><text x={y0Right.x - 28} y={y0Right.y - 8} className="map-detail">y=0</text></>; })()}
      {filtered.map(player => { const state = player.state; if (!state || state.x === null || state.y === null) return null; const point = worldToScreen(state.x, state.y); const color = stateColor(player); const active = player.userId === (selectedId ?? hoveredId); return <Fragment key={player.userId}><g className="map-player" role="button" tabIndex={0} aria-label={`${player.name || player.userId} 玩家详情`} onPointerEnter={() => setHoveredId(player.userId)} onPointerLeave={() => setHoveredId(null)} onClick={event => { event.stopPropagation(); setSelectedId(current => current === player.userId ? null : player.userId); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(current => current === player.userId ? null : current); } }}><circle cx={point.x} cy={point.y} r={active ? 9 : 6} className={`player-dot ${color}`} /><circle cx={point.x} cy={point.y} r={active ? 17 : 12} className={`player-ring ${color}`} /><circle cx={point.x} cy={point.y} r="24" className="player-hit" /><title>{player.name || player.userId}</title></g><text x={point.x + 13} y={point.y - 12} className="map-label" pointerEvents="none"><tspan x={point.x + 13} className="map-name">{player.name || player.userId}</tspan><tspan x={point.x + 13} dy="14" className="map-drop">Drop {displayNumber(player.drop)}</tspan></text></Fragment>; })}
    </svg>
    <div className="map-zoom-buttons"><button className="small-button" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); zoomIn(); }} aria-label="放大地图" title="放大地图"><ZoomIn size={14} /></button><button className="small-button" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); zoomOut(); }} aria-label="缩小地图" title="缩小地图"><ZoomOut size={14} /></button></div>
    <div className="map-readout"><span>视野半径 {displayNumber(viewRadius)}m</span><span>鼠标坐标 {mouseWorld ? `x ${displayCoordinate(mouseWorld.x)} / y ${displayCoordinate(mouseWorld.y)}` : '--'}</span></div>
    {hovered && <div className="map-player-detail"><strong>{hovered.name || hovered.userId}</strong>{hovered.state?.invulnerableRemainingSecs !== null && hovered.state?.invulnerableRemainingSecs !== undefined && hovered.state.invulnerableRemainingSecs > 0 && <span>无敌 {formatSeconds(hovered.state.invulnerableRemainingSecs)}</span>}<span>HP {displayNumber(hovered.state?.hp)}</span><span>体力 {displayNumber(hovered.state?.stamina5s === null || hovered.state?.stamina5s === undefined ? null : hovered.state.stamina5s / 1000)} / {displayNumber(hovered.state?.stamina1h === null || hovered.state?.stamina1h === undefined ? null : hovered.state.stamina1h / 1000)} / {displayNumber(hovered.state?.stamina1d === null || hovered.state?.stamina1d === undefined ? null : hovered.state.stamina1d / 1000)}</span><span>Drop {displayNumber(hovered.drop)}</span><span>Loss {displayNumber(hovered.state?.loss)}</span><span>坐标 x {displayCoordinate(hovered.state?.x)} / y {displayCoordinate(hovered.state?.y)}</span></div>}
    <div className="map-legend"><span><i className="dot good" />1d 满</span><span><i className="dot light" />1d 不满 / 5s 满</span><span><i className="dot bad" />5s 不满</span><span className="map-count">{filtered.length} 位玩家</span></div>
  </div></div></div></section>;
}

function killPosition(kill: Kill): { x: number | null; y: number | null } {
  const evidence = [kill.victim_position, kill.killer_position].find(position => position && position.x !== null && position.x !== undefined && position.y !== null && position.y !== undefined);
  return evidence ? { x: evidence.x, y: evidence.y } : { x: null, y: null };
}

// 历史页的阈值和玩家筛选是分页接口的入参，行由后端裁剪；实时页的数据本来就只有当前
// 快照那一份，继续在本地过滤，不必为了统一而多跑一趟网络。
function KillTable({ kills, map, page, filterOptions, loading }: { kills: Kill[]; map: MapMetadata; page: PageControl | null; filterOptions: HistoryFilterOptions | null; loading: boolean }) {
  const [localThreshold, setLocalThreshold] = useState(() => storageDropThreshold(KILL_THRESHOLD_KEY));
  const [localSelected, setLocalSelected] = useState<number[]>([]);
  const [filterVersion, setFilterVersion] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const playerFilterRef = useRef<HTMLDetailsElement>(null);
  const threshold = page ? page.state.minDrop : localThreshold;
  const selected = page ? page.state.users : localSelected;
  const overThreshold = useMemo(() => page ? kills : kills.filter(kill => { const amount = kill.drop?.amount; return amount !== null && amount !== undefined && amount >= threshold; }), [kills, page, threshold]);
  // 后端把 killer_user_id / victim_user_id 当 bigint 序列化成了字符串，而下方 options 用
  // Number(id) 去查名字。这里键必须同样归一成 number，否则查名永远 miss、面板回退显示 ID。
  const namesById = useMemo(() => new Map(kills.flatMap(kill => [[kill.killer_user_id, kill.killer_name], [kill.victim_user_id, kill.victim_name]]).filter(([id]) => id !== null && id !== undefined).map(([id, name]) => [Number(id), name] as [number, string | null])), [kills]);
  const options = useMemo(() => {
    // 分页模式下候选表必须由后端给：本页之外的玩家在本地根本看不到。
    if (page) return (filterOptions?.players || []).map(player => [player.userId, player.name] as [number, string | null]);
    const ids = new Set<number>(selected);
    overThreshold.forEach(kill => [kill.killer_user_id, kill.victim_user_id].forEach(id => { if (id !== null && id !== undefined) ids.add(Number(id)); }));
    return Array.from(ids, id => [id, namesById.get(id) || null] as [number, string | null]).sort((a, b) => String(a[1] || a[0]).localeCompare(String(b[1] || b[0]), 'zh-Hans-u-co-pinyin'));
  }, [filterOptions, namesById, overThreshold, page, selected]);
  const filtered = useMemo(() => overThreshold.slice().filter(kill => page || selected.length === 0 || selected.includes(Number(kill.killer_user_id)) || selected.includes(Number(kill.victim_user_id))).sort((a, b) => String(a.event_at || a.eventAt || '').localeCompare(String(b.event_at || b.eventAt || ''))), [overThreshold, page, selected]);
  // 标题旁显示"当前筛选出来的条目数"：分页模式里 filtered 只有当前页，总数得看后端分页；
  // 实时模式没有分页，filtered 就是全部命中行。
  const filteredTotal = page && page.pagination ? page.pagination.total : filtered.length;
  const onScroll = useListScroll(scrollRef, filtered.map(kill => `${kill.kill_id || kill.killId}:${kill.event_at || kill.eventAt}`).join('|'), filterVersion, page ? 'top' : 'bottom');
  const updateThreshold = (next: number) => {
    localStorage.setItem(KILL_THRESHOLD_KEY, String(next));
    setFilterVersion(current => current + 1);
    // 本地状态始终跟着写：切到另一个范围时 App 会重新读这个偏好，两边不能各记一份。
    setLocalThreshold(next);
    // 阈值变了总行数也变了，页号必须回到第一页，否则会停在一个已经不存在的页上。
    if (page) page.update({ minDrop: next, page: 1 });
  };
  const toggleSelected = (id: number) => {
    setFilterVersion(current => current + 1);
    if (page) return page.update({ users: page.state.users.includes(id) ? page.state.users.filter(value => value !== id) : [...page.state.users, id], page: 1 });
    setLocalSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  };
  const clearSelected = () => {
    setFilterVersion(current => current + 1);
    if (page) return page.update({ users: [], page: 1 });
    setLocalSelected([]);
  };
  // 点击玩家筛选弹框之外的区域时关闭它。<details> 原生的 summary 只负责开关，不处理
  // 外点收起，这里用一次 document 级监听补齐。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const details = playerFilterRef.current;
      if (!details || !details.open) return;
      if (event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);
  const nameCell = (id: number | null | undefined, name: string | null | undefined) => {
    const numeric = id === null || id === undefined ? null : Number(id);
    if (numeric === null || !Number.isFinite(numeric)) return <td>{name || '未知'}</td>;
    const active = selected.includes(numeric);
    const label = name || String(numeric);
    return <td><button type="button" className={active ? 'player-filter-link active' : 'player-filter-link'} onClick={() => toggleSelected(numeric)} title={active ? `取消筛选 ${label}` : `只看 ${label}`}>{label}</button></td>;
  };
  return <section className="kill-panel tab-panel panel-block">
    <PanelHead title="击杀明细" subtitle={`${loading ? '--' : displayNumber(filteredTotal)} 条`} actions={<><DropThresholdSlider value={threshold} ariaLabel="击杀 Drop 阈值" onChange={updateThreshold} commitDelayMs={DROP_THRESHOLD_COMMIT_MS} /><details className="player-filter" ref={playerFilterRef}><summary><Users size={14} /> 玩家筛选{selected.length ? ` · ${selected.length}` : ''}</summary><div className="player-options">{options.length === 0 ? <p className="player-options-empty">没有符合阈值的玩家</p> : options.map(([id, name]) => <label key={id}><input type="checkbox" checked={selected.includes(id)} onChange={() => toggleSelected(id)} />{name || id}</label>)}</div></details>{selected.length > 0 && <button className="clear-filter" onClick={clearSelected}><X size={13} />清除</button>}{page && <Pager control={page} />}</>} />
    <div className="panel-body"><div className="table-shell kill-scroll" ref={scrollRef} onScroll={onScroll} aria-label="击杀表格滚动区"><table className="kill-table"><thead><tr><th>时间</th><th>凶手</th><th>受害者</th><th>类型</th><th>置信度</th><th>坐标</th><th>相对中心点</th><th className="numeric-head">掉落</th></tr></thead><tbody>{loading ? <tr><td colSpan={8}><LoadingState /></td></tr> : filtered.length === 0 ? <tr><td colSpan={8}><EmptyState text="没有符合阈值的击杀记录" /></td></tr> : filtered.map((kill, index) => { const hasStaminaEvidence = kill.victim_stamina_5s !== null && kill.victim_stamina_5s !== undefined && kill.victim_stamina_5s_limit !== null && kill.victim_stamina_5s_limit !== undefined; const type = hasStaminaEvidence ? (Number(kill.victim_stamina_5s) === Number(kill.victim_stamina_5s_limit) ? '挂机' : '活跃') : '未知'; const position = killPosition(kill); return <tr key={kill.kill_id || kill.killId || index}><td><time>{formatTime(kill.event_at || kill.eventAt)}</time></td>{nameCell(kill.killer_user_id, kill.killer_name)}{nameCell(kill.victim_user_id, kill.victim_name)}<td><span className={`kill-type ${type === '活跃' ? 'active' : type === '挂机' ? 'idle' : 'unknown'}`}>{type}</span></td><td><span className={`confidence ${kill.confidence}`}>{kill.confidence || 'unknown'}</span></td><PositionCells x={position.x} y={position.y} map={map} /><td className="numeric">{kill.drop?.amount === null || kill.drop?.amount === undefined ? '未知' : displayNumber(kill.drop.amount)}</td></tr>; })}</tbody></table></div></div>
  </section>;
}

function PlayersPanel({ players, map, scope }: { players: Player[]; map: MapMetadata; scope: 'realtime' | 'history' }) {
  const isRealtime = scope === 'realtime';
  const [onlyOnline, setOnlyOnline] = useState(() => localStorage.getItem(ONLY_ONLINE_PLAYERS_KEY) === 'true');
  const visiblePlayers = useMemo(() => isRealtime && onlyOnline ? players.filter(player => player.online) : players, [isRealtime, onlyOnline, players]);
  const setOnlyOnlineValue = (value: boolean) => {
    setOnlyOnline(value);
    localStorage.setItem(ONLY_ONLINE_PLAYERS_KEY, String(value));
  };
  return <section className="players-panel tab-panel panel-block">
    <PanelHead title="玩家列表" tooltip={PLAYER_SELECTION_TOOLTIP} actions={<>{isRealtime && <label className="switch-label"><input type="checkbox" aria-label="仅看在线" checked={onlyOnline} onChange={event => setOnlyOnlineValue(event.target.checked)} /><span className="switch" />仅看在线</label>}<span className="result-count">{visiblePlayers.length} 位玩家</span></>} />
    <div className="panel-body"><PlayersTable players={visiblePlayers} map={map} scope={scope} /></div>
  </section>;
}

function ResourceContent({ route, meta, resource, page, loading }: { route: PanelRoute; meta: MetaResponse; resource: ResourceResponse; page: PageControl | null; loading: boolean }) {
  if (route.tab === 'chat') return <ChatPanel messages={resource.messages || []} page={page} loading={loading} foldedAfter={resource.foldedAfter || 0} />;
  if (route.tab === 'map') return <MapView players={(resource.players || []) as MapPlayer[]} map={resource.map || meta.map} />;
  if (route.tab === 'players') return <PlayersPanel players={(resource.players || []) as Player[]} map={meta.map} scope={route.scope} />;
  return <KillTable kills={resource.kills || []} map={meta.map} page={page} filterOptions={resource.filterOptions || null} loading={loading} />;
}

function Footer() {
  return <footer className="footer"><span>GRASP RAT / OBSERVATION SURFACE</span><div><a href="https://github.com/ZeroJehovah/grasp-rat-open-panel" target="_blank" rel="noopener noreferrer"><Github size={14} />GitHub</a><a href="https://grasp-rat-game.h-e.top/" target="_blank" rel="noopener noreferrer"><Activity size={14} />游戏主页</a><a href="https://linux.do/t/topic/2290514" target="_blank" rel="noopener noreferrer"><Search size={14} />讨论帖</a></div></footer>;
}

function MainPanel({ route, meta, query, page }: { route: PanelRoute; meta: MetaResponse; query: ResourceQueryState; page: PageControl | null }) {
  return <main className="main-grid"><TabMenu route={route} /><section className="data-viewport"><StatusBar meta={meta} query={query} route={route} />{query.resource ? <ResourceContent route={route} meta={meta} resource={query.resource} page={page} loading={query.loading} /> : query.loading ? <main className="resource-state"><RefreshCw className="spin" size={20} /><span>正在连接观测数据…</span></main> : <main className="resource-state"><CircleAlert size={20} /><span>当前标签暂无可显示的数据</span></main>}</section></main>;
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => { const saved = localStorage.getItem(THEME_KEY); if (saved === 'light' || saved === 'dark') return saved; return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; });
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem(THEME_KEY, theme); }, [theme]);
  useEffect(() => { const controller = new AbortController(); getMeta(controller.signal).then(setMeta).catch(error => { if (error.name !== 'AbortError') setMetaError(error.message); }); return () => controller.abort(); }, []);
  const route = useRoute(meta ? defaultHistoryRange(meta) : null);
  // 分页状态放在 App 里：它要同时喂给取数的 hook 和渲染表格的组件，放在表格里就没法参与请求。
  const [pageState, setPageState] = useState<HistoryPageState>(() => ({ pageSize: storageHistoryPageSize(), page: 1, minDrop: storageDropThreshold(KILL_THRESHOLD_KEY), users: [], onlyChat: storageOnlyChat() }));
  const rangeKey = `${route.scope}:${route.tab}:${route.from || ''}:${route.to || ''}`;
  // 换标签或换区间之后页号和已勾选的人都失效了。阈值和"仅看聊天"是偏好，但实时页的面板
  // 改的是自己的本地状态，所以这里重新读一次 localStorage，免得两边各记一份。
  useEffect(() => {
    setPageState(current => ({ ...current, page: 1, users: [], minDrop: storageDropThreshold(KILL_THRESHOLD_KEY), onlyChat: storageOnlyChat() }));
  }, [rangeKey]);
  const pageQuery = useMemo(() => historyPageQuery(route.scope, route.tab, pageState), [route.scope, route.tab, pageState]);
  const query = useResourceQuery(route, pageQuery);
  const pageControl = useMemo<PageControl | null>(() => pageQuery === null ? null : {
    state: pageState,
    pagination: query.resource?.pagination || null,
    update: patch => setPageState(current => {
      const next = { ...current, ...patch };
      if (patch.pageSize !== undefined) localStorage.setItem(HISTORY_PAGE_SIZE_KEY, String(patch.pageSize));
      return next;
    })
  }, [pageQuery, pageState, query.resource]);
  useEffect(() => {
    const scope = route.scope === 'realtime' ? '实时' : '历史';
    const tab = route.tab === 'chat' ? '聊天' : route.tab === 'map' ? '地图' : route.tab === 'players' ? '玩家' : '击杀';
    document.title = `${scope}${tab} · Grasp Rat Open Panel`;
  }, [route.scope, route.tab]);
  if (metaError && !meta) return <div className="app-shell"><Banner route={route} theme={theme} onTheme={() => setTheme(value => value === 'light' ? 'dark' : 'light')} /><main className="resource-state"><CircleAlert size={20} /><span>元数据加载失败：{metaError}</span></main><Footer /></div>;
  return <div className={route.scope === 'history' ? 'app-shell has-history' : 'app-shell'}><Banner route={route} theme={theme} onTheme={() => setTheme(value => value === 'light' ? 'dark' : 'light')} />{meta && route.scope === 'history' && <HistoryRangeControls meta={meta} route={route} />}{meta ? <MainPanel route={route} meta={meta} query={query} page={pageControl} /> : <main className="resource-state"><RefreshCw className="spin" size={20} /><span>正在连接观测数据…</span></main>}<Footer /></div>;
}
