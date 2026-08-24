import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type UIEvent } from 'react';
import { Activity, CalendarDays, CircleAlert, CircleHelp, Github, Map as MapIcon, Moon, RefreshCw, Rows3, Search, Swords, Sun, Users, X, ZoomIn, ZoomOut } from 'lucide-react';
import { getCachedResource, getMeta, getResource, getVersion } from './api';
import { navigate, routePath, tabPath, useRoute, type PanelRoute, type RouteTab } from './route';
import type { Kill, MapMetadata, MapPlayer, Message, MetaResponse, Player, PlayerState, ResourceResponse } from './types';

const THEME_KEY = 'grasp-rat:theme';
const MAP_THRESHOLD_KEY = 'grasp-rat:map-drop-threshold';
const PLAYER_SORT_KEY = 'grasp-rat:player-sort';
const KILL_THRESHOLD_KEY = 'grasp-rat:kill-drop-threshold';

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

function formatAgo(value: string | null): string {
  if (!value) return '--前在线';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}秒前在线`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前在线`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前在线`;
  return `${Math.floor(hours / 24)}天前在线`;
}

function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${Math.max(0, Math.round(value))}秒`;
}

function storageNumber(key: string, fallback: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
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
}

function useResourceQuery(route: PanelRoute): ResourceQueryState {
  const [state, setState] = useState<ResourceQueryState>({ resource: null, loading: true, error: null, versionError: null, updatedAt: null });
  const key = resourceKey(route);

  useEffect(() => {
    if (route.scope === 'history' && (!route.from || !route.to)) {
      setState(current => ({ ...current, loading: true }));
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    const cached = getCachedResource(route.scope, route.tab, route.scope === 'history' ? `${route.from}:${route.to}` : 'latest');
    let currentToken = cached?.versionToken || null;
    setState({ resource: cached, loading: !cached, error: null, versionError: null, updatedAt: cached?.generatedAt || null });

    const loadRealtime = async () => {
      let version;
      try {
        version = await getVersion(controller.signal);
        if (disposed) return;
        setState(current => ({ ...current, versionError: null }));
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
        setState({ resource: next.unchanged ? cached : next, loading: false, error: null, versionError: null, updatedAt: next.unchanged ? cached?.generatedAt || null : new Date().toISOString() });
      } catch (error) {
        if (!disposed && (error as Error).name !== 'AbortError') setState(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
      }
    };

    const loadHistory = async () => {
      try {
        const next = await getResource('history', route.tab as 'chat' | 'players' | 'kills', { from: route.from!, to: route.to! }, controller.signal);
        if (!disposed) setState({ resource: next, loading: false, error: null, versionError: null, updatedAt: next.generatedAt });
      } catch (error) {
        if (!disposed && (error as Error).name !== 'AbortError') setState(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
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
  }, [key, route.scope, route.tab, route.from, route.to]);

  return state;
}

function NavLink({ route, children, className, active }: { route: PanelRoute; children: ReactNode; className?: string; active?: boolean }) {
  const href = routePath(route);
  return <a className={className} href={href} aria-current={active ? 'page' : undefined} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(route); }}>{children}</a>;
}

function Banner({ theme, onTheme, route }: { theme: 'light' | 'dark'; onTheme: () => void; route: PanelRoute }) {
  return <header className="banner">
    <div className="brand-lockup"><span className="brand-mark"><Activity size={17} strokeWidth={2.5} /></span><div><p className="eyebrow">OPEN OBSERVATORY / UTC+8</p><h1>Grasp Rat <em>Open Panel</em></h1></div></div>
    <nav className="scope-nav" aria-label="数据范围">
      <NavLink route={{ scope: 'realtime', tab: 'chat', from: null, to: null }} active={route.scope === 'realtime'}>实时</NavLink>
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
  const setPreset = (preset: HistoryPreset) => {
    if (preset === 'custom') return;
    const next = meta.presetRanges?.[preset as keyof MetaResponse['presetRanges']];
    if (!next) return;
    navigate({ ...route, scope: 'history', tab: route.tab === 'map' ? 'chat' : route.tab, from: next.from, to: next.to });
  };
  const updateDate = (field: 'from' | 'to', value: string) => {
    if (value && !availableHistoryDates.includes(value)) return;
    const next = { ...range, [field]: value };
    if (next.from && next.to && next.from > next.to) return;
    navigate({ ...route, scope: 'history', from: next.from || null, to: next.to || null });
  };
  return <section className="history-range panel-block" aria-label="历史时间范围">
    <div className="range-heading"><div><p className="eyebrow">TIME WINDOW</p><h2>历史范围</h2></div><CalendarDays size={16} /></div>
    <div className="preset-grid">{HISTORY_PRESETS.map(value => {
      const available = value === 'custom' || Boolean(meta.presetRanges?.[value]);
      const active = value === 'custom' ? !Object.entries(meta.presetRanges || {}).some(([, item]) => item?.from === range.from && item?.to === range.to) : meta.presetRanges?.[value]?.from === range.from && meta.presetRanges?.[value]?.to === range.to;
      return <button key={value} className={active ? 'preset active' : 'preset'} onClick={() => setPreset(value)} disabled={!available} title={available ? undefined : '当前没有覆盖该范围的历史数据'}>{RANGE_LABELS[value]}</button>;
    })}</div>
    <div className="date-fields"><label>起始日<input type="date" list="available-history-dates" min={meta.earliestDate || undefined} max={latestHistory || undefined} value={range.from} onChange={event => updateDate('from', event.target.value)} /></label><span>→</span><label>结束日<input type="date" list="available-history-dates" min={meta.earliestDate || undefined} max={latestHistory || undefined} value={range.to} onChange={event => updateDate('to', event.target.value)} /></label><datalist id="available-history-dates">{availableHistoryDates.map(date => <option key={date} value={date} />)}</datalist></div>
    <p className="micro-note">可用历史数据：{meta.earliestDate || '--'} 至 {latestHistory || '--'} · 不包含今天 · {meta.timezone}</p>
  </section>;
}

const REALTIME_TABS: { tab: RouteTab; label: string; icon: typeof MapIcon }[] = [
  { tab: 'chat', label: '聊天', icon: Rows3 },
  { tab: 'map', label: '地图', icon: MapIcon },
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

function StatusBar({ meta, query, route }: { meta: MetaResponse; query: ResourceQueryState; route: PanelRoute }) {
  const resourceLabel = route.tab === 'chat' ? '聊天' : route.tab === 'map' ? '地图' : route.tab === 'players' ? '玩家' : '击杀';
  return <div className="global-status" role="status">{query.versionError ? <><CircleAlert size={14} />实时版本检查失败：{query.versionError}</> : query.error ? <><CircleAlert size={14} />{resourceLabel}数据暂不可用：{query.error}</> : query.loading && !query.resource ? <><RefreshCw size={14} className="spin" />正在加载{resourceLabel}…</> : <><span className="status-dot" />{route.scope === 'history' ? `历史 ${route.from}—${route.to}` : `服务运行中 · ${meta.timezone}`}{query.updatedAt ? ` · ${formatTime(query.updatedAt)}` : ''}</>}</div>;
}

function useAutoBottom(ref: RefObject<HTMLElement>, contentKey: string, resetKey: number): (event: UIEvent<HTMLElement>) => void {
  const atBottom = useRef(true);
  const lastReset = useRef(-1);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const forced = lastReset.current !== resetKey;
    lastReset.current = resetKey;
    if (forced || atBottom.current) element.scrollTop = element.scrollHeight;
  }, [contentKey, ref, resetKey]);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const bottom = element.scrollHeight - (element.scrollTop + element.clientHeight) <= 12;
      if (bottom) { atBottom.current = true; element.scrollTop = element.scrollHeight; }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return event => {
    const element = event.currentTarget;
    atBottom.current = element.scrollHeight - (element.scrollTop + element.clientHeight) <= 12;
  };
}

function ChatPanel({ messages }: { messages: Message[] }) {
  const [onlyChat, setOnlyChat] = useState(false);
  const [filterVersion, setFilterVersion] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const sorted = messages.slice().sort((a, b) => String(a.event_at || a.eventAt || '').localeCompare(String(b.event_at || b.eventAt || '')));
    if (!onlyChat) return sorted.map((message, index) => ({ kind: 'message' as const, message, key: `${message.message_id || message.messageId || index}` }));
    const folded: ({ kind: 'message'; message: Message; key: string } | { kind: 'kill-summary'; count: number; key: string })[] = [];
    let killCount = 0;
    let killStart = '';
    const flushKills = () => {
      if (killCount > 0) folded.push({ kind: 'kill-summary', count: killCount, key: `kill-summary:${killStart}:${killCount}` });
      killCount = 0;
      killStart = '';
    };
    sorted.forEach((message, index) => {
      if (message.kind.toLowerCase() === 'kill') {
        if (!killStart) killStart = `${message.message_id || message.messageId || index}`;
        killCount += 1;
        return;
      }
      flushKills();
      folded.push({ kind: 'message', message, key: `${message.message_id || message.messageId || index}` });
    });
    flushKills();
    return folded;
  }, [messages, onlyChat]);
  const contentKey = rows.map(row => row.kind === 'kill-summary' ? row.key : `${row.key}:${row.message.text}`).join('|');
  const onScroll = useAutoBottom(scrollRef, contentKey, filterVersion);
  return <section className="chat-page panel-block">
    <div className="section-heading"><div><p className="eyebrow">{onlyChat ? 'CHAT ONLY' : 'EVENT FEED'}</p><h2>聊天记录</h2></div><label className="switch-label"><input type="checkbox" checked={onlyChat} onChange={event => { setOnlyChat(event.target.checked); setFilterVersion(value => value + 1); }} /><span className="switch" />仅看聊天</label></div>
    <div className="chat-list" ref={scrollRef} onScroll={onScroll} aria-label="聊天记录滚动区">{rows.length === 0 ? <EmptyState text="这个范围还没有消息" /> : rows.map(row => {
      if (row.kind === 'kill-summary') return <div className="chat-row kill-summary" key={row.key}><span>{row.count}条击杀记录已折叠</span></div>;
      const isKill = row.message.kind.toLowerCase() === 'kill';
      return <div className={isKill ? 'chat-row kill' : 'chat-row'} key={row.key}><time>{formatTime(row.message.event_at || row.message.eventAt)}</time><p>{!isKill && row.message.user_name && <strong>{row.message.user_name}</strong>}<span>{row.message.text}</span></p></div>;
    })}</div>
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

function PositionCell({ x, y, map }: { x: number | null; y: number | null; map: MapMetadata }) {
  const position = positionForCoordinates(x, y, map);
  return <span className={`position-cell ${position.color}`}><span>x {displayCoordinate(x)} / y {displayCoordinate(y)}</span><span>{position.direction} · {position.distance === null ? '--' : `${displayNumber(position.distance)}米`}</span></span>;
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
  if (!state) return <span className="muted">--</span>;
  const values: [string, number | null, number | null, string][] = [
    ['5秒', state.stamina5s, state.stamina5sLimit, state.stamina5sLimit === 0 ? 'bad' : state.stamina5s !== null && state.stamina5sLimit !== null && state.stamina5s >= state.stamina5sLimit ? 'good' : 'warn'],
    ['1小时', state.stamina1h, state.stamina1hLimit, state.stamina1h === 0 ? 'bad' : state.stamina1h !== null && state.stamina1h >= 1_000_000 ? 'good' : 'warn'],
    ['1天', state.stamina1d, state.stamina1dLimit, state.stamina1d === 0 ? 'bad' : state.stamina1d !== null && state.stamina1d >= 1_000_000 ? 'good' : 'warn']
  ];
  return <span className="stamina-grid">{values.map(([label, value, limit, color]) => <span className="stamina-item" key={label}><b>{label}</b><span className="stamina-values"><i className={color}>{displayNumber(value === null ? null : Math.round(value / 1000))}</i><em>/</em><i>{displayNumber(limit === null ? null : Math.round(limit / 1000))}</i></span></span>)}</span>;
}

type PlayerSort = 'drop' | 'quota' | 'income' | 'kills' | 'deaths';

function initialPlayerSort(): PlayerSort {
  const value = localStorage.getItem(PLAYER_SORT_KEY)?.split(':')[0];
  return value === 'drop' || value === 'quota' || value === 'income' || value === 'kills' || value === 'deaths' ? value : 'quota';
}

const PLAYER_SELECTION_TOOLTIP = '玩家列表显示额度 Top50、Drop Top50、收益 Top50 的并集；实时页仅显示当前在线玩家，历史页按所选日期范围聚合。';

function PlayersTable({ players, map, rangeLabel }: { players: Player[]; map: MapMetadata; rangeLabel: string }) {
  const [sort, setSort] = useState<PlayerSort>(initialPlayerSort);
  const setSortKey = (key: PlayerSort) => { setSort(key); localStorage.setItem(PLAYER_SORT_KEY, `${key}:desc`); };
  const sorted = useMemo(() => players.slice().sort((a, b) => {
    const value = (player: Player): number | null => ({ drop: player.drop, quota: player.quota?.value ?? null, income: player.income, kills: player.kills, deaths: player.deaths }[sort] ?? null);
    const av = value(a); const bv = value(b);
    if (av === null && bv === null) return a.name.localeCompare(b.name) || a.userId - b.userId;
    if (av === null) return 1;
    if (bv === null) return -1;
    return Number(bv) - Number(av) || a.name.localeCompare(b.name) || a.userId - b.userId;
  }), [players, sort]);
  const header = (key: PlayerSort, text: string) => <button className={sort === key ? 'sort-header active' : 'sort-header'} onClick={() => setSortKey(key)} title={`按${text}从大到小排序`}>{text}<span className="sort-desc">↓</span></button>;
  return <div className="table-shell" aria-label="玩家表格滚动区"><table className="player-table"><colgroup><col className="col-rank" /><col className="col-name" /><col className="col-status" /><col className="col-number" /><col className="col-number" /><col className="col-number" /><col className="col-hp" /><col className="col-stamina" /><col className="col-position" /><col className="col-number" /><col className="col-number" /></colgroup><thead><tr><th>#</th><th>名称</th><th>状态</th><th className="numeric-head">{header('drop', 'Drop')}</th><th className="numeric-head">{header('quota', '额度')}</th><th className="numeric-head">{header('income', rangeLabel)}</th><th className="numeric-head">HP</th><th>体力</th><th>位置</th><th className="numeric-head">{header('kills', `${rangeLabel}击杀`)}</th><th className="numeric-head">{header('deaths', `${rangeLabel}死亡`)}</th></tr></thead><tbody>{sorted.length === 0 ? <tr><td colSpan={11}><EmptyState text="这个范围还没有玩家数据" /></td></tr> : sorted.map((player, index) => {
    const hp = player.state?.hp ?? null;
    return <tr key={player.userId}><td className="rank numeric">{index + 1}</td><td className="name-cell" title={player.name}>{player.name || '未命名'}</td><td><span className={player.online ? 'status online' : 'status'}>{player.online ? '在线' : formatAgo(player.lastSeenAt)}</span></td><td className="numeric">{displayNumber(player.drop)}</td><td className="numeric">{displayNumber(player.quota?.value)}</td><td className={`numeric ${player.income !== null && player.income > 0 ? 'negative' : player.income !== null && player.income < 0 ? 'positive' : ''}`}>{player.income === null ? '--' : player.income > 0 ? `+${displayNumber(player.income)}` : displayNumber(player.income)}</td><td className={`numeric ${valueColor(hp, [[80, 'good'], [50, 'warn'], [20, 'orange'], [0, 'bad']])}`}>{displayNumber(hp)}</td><td><StaminaCell player={player} /></td><td><PositionCell x={player.state?.x ?? null} y={player.state?.y ?? null} map={map} /></td><td className="numeric">{displayNumber(player.kills)}</td><td className="numeric">{displayNumber(player.deaths)}</td></tr>;
  })}</tbody></table></div>;
}

interface Camera { zoom: number; center: { x: number; y: number } }
interface MapSize { width: number; height: number }

function MapView({ players, map }: { players: MapPlayer[]; map: MapMetadata }) {
  const [threshold, setThreshold] = useState(() => storageNumber(MAP_THRESHOLD_KEY, 10));
  const [size, setSize] = useState<MapSize>({ width: 1, height: 1 });
  const [camera, setCamera] = useState<Camera>({ zoom: 1, center: map.center });
  const [mouseWorld, setMouseWorld] = useState<{ x: number; y: number } | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
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
    return { x: size.width / 2 + (x - current.center.x) * fitScale * zoom, y: size.height / 2 - (y - current.center.y) * fitScale * zoom };
  };
  const screenToWorld = (x: number, y: number, current = camera) => {
    const zoom = Math.min(current.zoom, maxZoom);
    return { x: current.center.x + (x - size.width / 2) / (fitScale * zoom), y: current.center.y - (y - size.height / 2) / (fitScale * zoom) };
  };
  const pointerPosition = (event: { clientX: number; clientY: number }) => { const rect = stageRef.current?.getBoundingClientRect(); if (!rect) return null; return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const setZoomAt = (nextZoom: number, anchor?: { x: number; y: number }) => setCamera(current => {
    const zoom = Math.min(maxZoom, Math.max(1, nextZoom));
    if (!anchor) return { zoom, center: clampCenter(current.center, zoom) };
    const world = screenToWorld(anchor.x, anchor.y, current);
    const nextScale = fitScale * zoom;
    const center = { x: world.x - (anchor.x - size.width / 2) / nextScale, y: world.y + (anchor.y - size.height / 2) / nextScale };
    return { zoom, center: clampCenter(center, zoom) };
  });
  const filtered = players.filter(player => {
    const dropMatch = player.drop !== null && player.drop >= threshold;
    const tired = player.state?.stamina1d !== null && player.state?.stamina1dLimit !== null && Boolean(player.state && player.state.stamina1d < player.state.stamina1dLimit);
    return dropMatch || tired;
  });
  const hovered = players.find(player => player.userId === (selectedId ?? hoveredId)) || null;
  const worldRadius = 1000 / Math.max(0.000001, map.metersPerGameUnit);
  const viewRadius = Math.round((Math.min(size.width, size.height) / (2 * scale)) * map.metersPerGameUnit);
  const updateThreshold = (value: string) => { const next = Number(value); if (Number.isInteger(next) && next > 0) { setThreshold(next); localStorage.setItem(MAP_THRESHOLD_KEY, String(next)); } };
  const zoomIn = () => setZoomAt(camera.zoom * 1.35);
  const zoomOut = () => setZoomAt(camera.zoom / 1.35);

  return <section className="map-panel panel-block"><div className="section-heading"><div><p className="eyebrow">STEADY SNAPSHOT / MAP V{map.version}</p><h2>实时地图</h2></div><div className="map-controls"><label>Drop ≥ <input type="number" min="1" step="1" value={threshold} onChange={event => updateThreshold(event.target.value)} /></label></div></div><div className="map-stage"><div className="map-square" ref={stageRef} onWheel={event => { event.preventDefault(); const point = pointerPosition(event); setZoomAt(camera.zoom * (event.deltaY > 0 ? 0.9 : 1.1), point || undefined); }} onPointerDown={event => { const point = pointerPosition(event); if (!point) return; dragRef.current = { pointerId: event.pointerId, x: point.x, y: point.y }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { const point = pointerPosition(event); if (!point) return; setMouseWorld(screenToWorld(point.x, point.y)); if (dragRef.current?.pointerId === event.pointerId && camera.zoom > 1) { const dx = point.x - dragRef.current.x; const dy = point.y - dragRef.current.y; setCamera(current => ({ ...current, center: clampCenter({ x: current.center.x - dx / scale, y: current.center.y + dy / scale }) })); dragRef.current = { pointerId: event.pointerId, x: point.x, y: point.y }; } }} onPointerUp={event => { dragRef.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragRef.current = null; }} onPointerLeave={() => { setMouseWorld(null); setHoveredId(null); }} onTouchStart={event => { if (event.touches.length === 2) pinchRef.current = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY); }} onTouchMove={event => { if (event.touches.length !== 2 || pinchRef.current === null) return; event.preventDefault(); const distance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY); setZoomAt(camera.zoom * distance / pinchRef.current); pinchRef.current = distance; }} onTouchEnd={() => { pinchRef.current = null; }}>
    <svg viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label="实时玩家地图"><rect x="0" y="0" width={size.width} height={size.height} className="map-water" />
      {(() => { const topLeft = worldToScreen(map.bounds.minX, map.bounds.maxY); return <rect x={topLeft.x} y={topLeft.y} width={worldWidth * scale} height={worldHeight * scale} className="map-land" />; })()}
      {(() => { const x0Top = worldToScreen(0, map.bounds.maxY); const x0Bottom = worldToScreen(0, map.bounds.minY); const y0Left = worldToScreen(map.bounds.minX, 0); const y0Right = worldToScreen(map.bounds.maxX, 0); const center = worldToScreen(map.center.x, map.center.y); return <><path d={`M${x0Top.x} ${x0Top.y} L${x0Bottom.x} ${x0Bottom.y} M${y0Left.x} ${y0Left.y} L${y0Right.x} ${y0Right.y}`} className="map-axis" /><circle cx={center.x} cy={center.y} r={worldRadius * scale} className="map-center-ring" /><text x={x0Bottom.x + 7} y={x0Bottom.y - 7} className="map-detail">x=0</text><text x={y0Right.x - 28} y={y0Right.y - 8} className="map-detail">y=0</text></>; })()}
      {filtered.map(player => { const state = player.state; if (!state || state.x === null || state.y === null) return null; const point = worldToScreen(state.x, state.y); const color = stateColor(player); const active = player.userId === (selectedId ?? hoveredId); return <Fragment key={player.userId}><g className="map-player" role="button" tabIndex={0} aria-label={`${player.name || player.userId} 玩家详情`} onPointerEnter={() => setHoveredId(player.userId)} onPointerLeave={() => setHoveredId(null)} onClick={event => { event.stopPropagation(); setSelectedId(current => current === player.userId ? null : player.userId); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(current => current === player.userId ? null : current); } }}><circle cx={point.x} cy={point.y} r={active ? 9 : 6} className={`player-dot ${color}`} /><circle cx={point.x} cy={point.y} r={active ? 17 : 12} className={`player-ring ${color}`} /><circle cx={point.x} cy={point.y} r="24" className="player-hit" /><title>{player.name || player.userId}</title></g><text x={point.x + 13} y={point.y - 12} className="map-label" pointerEvents="none"><tspan x={point.x + 13} className="map-name">{player.name || player.userId}</tspan><tspan x={point.x + 13} dy="14" className="map-drop">Drop {displayNumber(player.drop)}</tspan></text></Fragment>; })}
    </svg>
    <div className="map-zoom-buttons"><button className="small-button" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); zoomIn(); }} aria-label="放大地图" title="放大地图"><ZoomIn size={14} /></button><button className="small-button" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); zoomOut(); }} aria-label="缩小地图" title="缩小地图"><ZoomOut size={14} /></button></div>
    <div className="map-readout"><span>视野半径 {displayNumber(viewRadius)}m</span><span>鼠标坐标 {mouseWorld ? `x ${displayCoordinate(mouseWorld.x)} / y ${displayCoordinate(mouseWorld.y)}` : '--'}</span></div>
    {hovered && <div className="map-player-detail"><strong>{hovered.name || hovered.userId}</strong>{hovered.state?.invulnerableRemainingSecs !== null && hovered.state?.invulnerableRemainingSecs !== undefined && hovered.state.invulnerableRemainingSecs > 0 && <span>无敌 {formatSeconds(hovered.state.invulnerableRemainingSecs)}</span>}<span>HP {displayNumber(hovered.state?.hp)}</span><span>体力 {displayNumber(hovered.state?.stamina5s === null || hovered.state?.stamina5s === undefined ? null : hovered.state.stamina5s / 1000)} / {displayNumber(hovered.state?.stamina1h === null || hovered.state?.stamina1h === undefined ? null : hovered.state.stamina1h / 1000)} / {displayNumber(hovered.state?.stamina1d === null || hovered.state?.stamina1d === undefined ? null : hovered.state.stamina1d / 1000)}</span><span>Drop {displayNumber(hovered.drop)}</span><span>Loss {displayNumber(hovered.state?.loss)}</span><span>坐标 x {displayCoordinate(hovered.state?.x)} / y {displayCoordinate(hovered.state?.y)}</span></div>}
    <div className="map-legend"><span><i className="dot good" />1d 满</span><span><i className="dot light" />1d 不满 / 5s 满</span><span><i className="dot bad" />5s 不满</span><span className="map-count">{filtered.length} 位玩家</span></div>
  </div></div></section>;
}

function killPosition(kill: Kill): { x: number | null; y: number | null } {
  const evidence = [kill.victim_position, kill.killer_position].find(position => position && position.x !== null && position.x !== undefined && position.y !== null && position.y !== undefined);
  return evidence ? { x: evidence.x, y: evidence.y } : { x: null, y: null };
}

function KillTable({ kills, map }: { kills: Kill[]; map: MapMetadata }) {
  const [threshold, setThreshold] = useState(() => storageNumber(KILL_THRESHOLD_KEY, 10));
  const [selected, setSelected] = useState<number[]>([]);
  const [filterVersion, setFilterVersion] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const names = useMemo(() => Array.from(new Map(kills.flatMap(kill => [[kill.killer_user_id, kill.killer_name], [kill.victim_user_id, kill.victim_name]]).filter(([id]) => id !== null && id !== undefined) as [number, string | null][]).entries()).sort((a, b) => String(a[1] || '').localeCompare(String(b[1] || ''), 'zh-Hans-u-co-pinyin')), [kills]);
  const filtered = useMemo(() => kills.slice().filter(kill => { const amount = kill.drop?.amount; if (amount === null || amount === undefined || amount < threshold) return false; if (selected.length === 0) return true; return selected.includes(Number(kill.killer_user_id)) || selected.includes(Number(kill.victim_user_id)); }).sort((a, b) => String(a.event_at || a.eventAt || '').localeCompare(String(b.event_at || b.eventAt || ''))), [kills, selected, threshold]);
  const onScroll = useAutoBottom(scrollRef, filtered.map(kill => `${kill.kill_id || kill.killId}:${kill.event_at || kill.eventAt}`).join('|'), filterVersion);
  const updateThreshold = (value: string) => { const next = Number(value); if (Number.isInteger(next) && next > 0) { setThreshold(next); localStorage.setItem(KILL_THRESHOLD_KEY, String(next)); setFilterVersion(current => current + 1); } };
  return <section className="kill-page"><div className="filter-bar"><label>Drop ≥ <input type="number" min="1" step="1" value={threshold} onChange={event => updateThreshold(event.target.value)} /></label><details><summary><Users size={14} /> 玩家筛选{selected.length ? ` · ${selected.length}` : ''}</summary><div className="player-options">{names.map(([id, name]) => <label key={id}><input type="checkbox" checked={selected.includes(Number(id))} onChange={event => { setSelected(current => event.target.checked ? [...current, Number(id)] : current.filter(value => value !== Number(id))); setFilterVersion(current => current + 1); }} />{name || id}</label>)}</div></details>{selected.length > 0 && <button className="clear-filter" onClick={() => { setSelected([]); setFilterVersion(current => current + 1); }}><X size={13} />清除</button>}</div><div className="table-shell kill-scroll" ref={scrollRef} onScroll={onScroll} aria-label="击杀表格滚动区"><table className="kill-table"><thead><tr><th>时间</th><th>凶手</th><th>受害者</th><th>类型</th><th>置信度</th><th>位置</th><th className="numeric-head">掉落</th></tr></thead><tbody>{filtered.length === 0 ? <tr><td colSpan={7}><EmptyState text="没有符合阈值的击杀记录" /></td></tr> : filtered.map((kill, index) => { const hasStaminaEvidence = kill.victim_stamina_5s !== null && kill.victim_stamina_5s !== undefined && kill.victim_stamina_5s_limit !== null && kill.victim_stamina_5s_limit !== undefined; const type = hasStaminaEvidence ? (Number(kill.victim_stamina_5s) === Number(kill.victim_stamina_5s_limit) ? '挂机' : '活跃') : '未知'; const position = killPosition(kill); return <tr key={kill.kill_id || kill.killId || index}><td><time>{formatTime(kill.event_at || kill.eventAt)}</time></td><td>{kill.killer_name || '未知'}</td><td>{kill.victim_name || '未知'}</td><td><span className={`kill-type ${type === '活跃' ? 'active' : type === '挂机' ? 'idle' : 'unknown'}`}>{type}</span></td><td><span className={`confidence ${kill.confidence}`}>{kill.confidence || 'unknown'}</span></td><td><PositionCell x={position.x} y={position.y} map={map} /></td><td className="numeric">{kill.drop?.amount === null || kill.drop?.amount === undefined ? '未知' : displayNumber(kill.drop.amount)}</td></tr>; })}</tbody></table></div></section>;
}

function rangeLabel(route: PanelRoute): string {
  if (route.scope !== 'history') return '今日';
  return `${route.from || '--'}—${route.to || '--'}`;
}

function ResourceContent({ route, meta, resource }: { route: PanelRoute; meta: MetaResponse; resource: ResourceResponse }) {
  if (route.tab === 'chat') return <ChatPanel messages={resource.messages || []} />;
  if (route.tab === 'map') return <MapView players={(resource.players || []) as MapPlayer[]} map={resource.map || meta.map} />;
  if (route.tab === 'players') return <section className="players-panel panel-block"><div className="section-heading"><div><p className="eyebrow">{route.scope === 'realtime' ? 'CURRENT STATE' : 'RANGE AGGREGATE'}</p><div className="title-with-tooltip"><h2>玩家列表</h2><span className="tooltip" tabIndex={0} role="img" aria-label="玩家列表显示条件" data-tooltip={PLAYER_SELECTION_TOOLTIP}><CircleHelp size={14} /></span></div></div><span className="result-count">{resource.players?.length || 0} 位玩家</span></div><PlayersTable players={(resource.players || []) as Player[]} map={meta.map} rangeLabel={rangeLabel(route)} /></section>;
  return <section className="kill-panel panel-block"><div className="section-heading kill-heading"><div><p className="eyebrow">{route.scope === 'realtime' ? 'TODAY EVENTS' : 'RANGE EVENTS'}</p><h2>击杀明细</h2></div><span className="result-count">{resource.kills?.length || 0} 条记录</span></div><KillTable kills={resource.kills || []} map={meta.map} /></section>;
}

function Footer() {
  return <footer className="footer"><span>GRASP RAT / OBSERVATION SURFACE</span><div><a href="https://github.com/ZeroJehovah/grasp-rat-open-panel" target="_blank" rel="noopener noreferrer"><Github size={14} />GitHub</a><a href="https://grasp-rat-game.h-e.top/" target="_blank" rel="noopener noreferrer"><Activity size={14} />游戏主页</a><a href="https://linux.do/t/topic/2290514" target="_blank" rel="noopener noreferrer"><Search size={14} />讨论帖</a></div></footer>;
}

function MainPanel({ route, meta, query }: { route: PanelRoute; meta: MetaResponse; query: ResourceQueryState }) {
  return <main className="main-grid"><TabMenu route={route} /><section className="data-viewport"><StatusBar meta={meta} query={query} route={route} />{query.resource ? <ResourceContent route={route} meta={meta} resource={query.resource} /> : query.loading ? <main className="resource-state"><RefreshCw className="spin" size={20} /><span>正在连接观测数据…</span></main> : <main className="resource-state"><CircleAlert size={20} /><span>当前标签暂无可显示的数据</span></main>}</section></main>;
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => { const saved = localStorage.getItem(THEME_KEY); if (saved === 'light' || saved === 'dark') return saved; return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; });
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem(THEME_KEY, theme); }, [theme]);
  useEffect(() => { const controller = new AbortController(); getMeta(controller.signal).then(setMeta).catch(error => { if (error.name !== 'AbortError') setMetaError(error.message); }); return () => controller.abort(); }, []);
  const route = useRoute(meta ? defaultHistoryRange(meta) : null);
  const query = useResourceQuery(route);
  useEffect(() => {
    const scope = route.scope === 'realtime' ? '实时' : '历史';
    const tab = route.tab === 'chat' ? '聊天' : route.tab === 'map' ? '地图' : route.tab === 'players' ? '玩家' : '击杀';
    document.title = `${scope}${tab} · Grasp Rat Open Panel`;
  }, [route.scope, route.tab]);
  if (metaError && !meta) return <div className="app-shell"><Banner route={route} theme={theme} onTheme={() => setTheme(value => value === 'light' ? 'dark' : 'light')} /><main className="resource-state"><CircleAlert size={20} /><span>元数据加载失败：{metaError}</span></main><Footer /></div>;
  return <div className={route.scope === 'history' ? 'app-shell has-history' : 'app-shell'}><Banner route={route} theme={theme} onTheme={() => setTheme(value => value === 'light' ? 'dark' : 'light')} />{meta && route.scope === 'history' && <HistoryRangeControls meta={meta} route={route} />}{meta ? <MainPanel route={route} meta={meta} query={query} /> : <main className="resource-state"><RefreshCw className="spin" size={20} /><span>正在连接观测数据…</span></main>}<Footer /></div>;
}
