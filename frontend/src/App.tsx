import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CalendarDays, ChevronDown, CircleAlert, Github, Map as MapIcon, Moon, RefreshCw, Rows3, Search, Sun, Swords, Users, X, ZoomIn, ZoomOut } from 'lucide-react';
import { getHistory, getMeta, getRealtime, getVersion, mergeById } from './api';
import { rangeStore, useRangeStore, type RangePreset } from './rangeStore';
import type { HistoryResponse, Kill, MapMetadata, Message, MetaResponse, Player, RealtimeResponse } from './types';

const THEME_KEY = 'grasp-rat:theme';
const MAP_THRESHOLD_KEY = 'grasp-rat:map-drop-threshold';
const PLAYER_SORT_KEY = 'grasp-rat:player-sort';
const KILL_THRESHOLD_KEY = 'grasp-rat:kill-drop-threshold';

function localDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rangeForPreset(preset: RangePreset, today: string): { from: string; to: string } {
  const date = new Date(`${today}T00:00:00+08:00`);
  const day = (date.getUTCDay() + 6) % 7;
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'yesterday') return { from: shiftDate(today, -1), to: shiftDate(today, -1) };
  if (preset === 'this-week') return { from: shiftDate(today, -day), to: today };
  if (preset === 'last-week') { const end = shiftDate(today, -day - 1); return { from: shiftDate(end, -6), to: end }; }
  const monthStart = `${today.slice(0, 7)}-01`;
  if (preset === 'this-month') return { from: monthStart, to: today };
  if (preset === 'last-month') { const end = shiftDate(monthStart, -1); return { from: `${end.slice(0, 7)}-01`, to: end }; }
  return { from: today, to: today };
}

function formatTime(value?: string | null): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function eventDay(event: { event_at?: string; eventAt?: string; local_date?: string; server_day?: string }): string | null {
  const explicit = event.local_date || event.server_day;
  if (explicit) return explicit.slice(0, 10);
  const timestamp = Date.parse(event.event_at || event.eventAt || '');
  return Number.isNaN(timestamp) ? null : localDate(new Date(timestamp));
}

function eventInRange(event: { event_at?: string; eventAt?: string; local_date?: string; server_day?: string }, range: { from: string; to: string }): boolean {
  const day = eventDay(event);
  return Boolean(day && day >= range.from && day <= range.to);
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

function displayNumber(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? '--' : Math.round(value).toLocaleString('zh-CN');
}

function storageNumber(key: string, fallback: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function usePanelData(meta: MetaResponse | null, range: { from: string; to: string }) {
  const [realtime, setRealtime] = useState<RealtimeResponse | null>(null);
  const [realtimeUpdatedAt, setRealtimeUpdatedAt] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    if (!meta || !range.from || !range.to) return;
    const controller = new AbortController();
    setLoadingHistory(true);
    setHistoryError(null);
    setHistory(null);
    getHistory(range.from, range.to, controller.signal)
      .then(setHistory)
      .catch(error => { if (error.name !== 'AbortError') setHistoryError(error.message); })
      .finally(() => setLoadingHistory(false));
    return () => controller.abort();
  }, [meta, range.from, range.to]);

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const version = await getVersion();
        if (disposed) return;
        setVersionError(null);
        if (!realtime || version.versionToken !== realtime.versionToken) {
          const next = await getRealtime(realtime?.versionToken || null);
          if (!disposed && !next.unchanged) {
            setRealtime(next);
            setRealtimeUpdatedAt(new Date().toISOString());
          }
        }
      } catch (error) {
        if (!disposed) setVersionError(error instanceof Error ? error.message : String(error));
      }
    };
    poll();
    const pollMs = Number(import.meta.env.VITE_REALTIME_POLL_MS || 10_000);
    const interval = window.setInterval(poll, Number.isFinite(pollMs) && pollMs >= 1_000 ? pollMs : 10_000);
    return () => { disposed = true; window.clearInterval(interval); };
  }, [realtime]);

  return { realtime, realtimeUpdatedAt, history, versionError, historyError, loadingHistory };
}

function Banner({ theme, onTheme }: { theme: 'light' | 'dark'; onTheme: () => void }) {
  return <header className="banner">
    <div className="brand-lockup"><span className="brand-mark"><Activity size={17} strokeWidth={2.5} /></span><div><p className="eyebrow">OPEN OBSERVATORY / UTC+8</p><h1>Grasp Rat <em>Open Panel</em></h1></div></div>
    <button className="icon-button" onClick={onTheme} aria-label={theme === 'light' ? '切换暗色模式' : '切换亮色模式'} title={theme === 'light' ? '暗色模式' : '亮色模式'}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button>
  </header>;
}

function RangeControls({ meta }: { meta: MetaResponse | null }) {
  const range = useRangeStore();
  const today = meta?.latestDate || localDate();
  const setPreset = (preset: RangePreset) => {
    const next = rangeForPreset(preset, today);
    const available = meta?.availableDates || [];
    const clamp = (value: string) => available.length ? (available.includes(value) ? value : (value < available[0] ? available[0] : available[available.length - 1])) : value;
    rangeStore.set({ preset, from: clamp(next.from), to: clamp(next.to) });
  };
  const updateDate = (field: 'from' | 'to', value: string) => {
    const next = { ...range, preset: 'custom' as const, [field]: value };
    if (next.from && next.to && next.from > next.to) return;
    rangeStore.set(next);
  };
  return <section className="range-control panel-block">
    <div className="section-heading"><div><p className="eyebrow">TIME WINDOW</p><h2>时间范围</h2></div><CalendarDays size={17} /></div>
    <div className="preset-grid">
      {([['today', '今日'], ['yesterday', '昨日'], ['this-week', '本周'], ['last-week', '上周'], ['this-month', '本月'], ['last-month', '上月'], ['custom', '指定日期']] as [RangePreset, string][]).map(([value, label]) => <button key={value} className={range.preset === value ? 'preset active' : 'preset'} onClick={() => setPreset(value)}>{label}</button>)}
    </div>
    <div className="date-fields"><label>起始日<input type="date" min={meta?.earliestDate || undefined} max={meta?.latestDate || undefined} value={range.from} onChange={event => updateDate('from', event.target.value)} /></label><span>→</span><label>结束日<input type="date" min={meta?.earliestDate || undefined} max={meta?.latestDate || undefined} value={range.to} onChange={event => updateDate('to', event.target.value)} /></label></div>
    <p className="micro-note">可用数据：{meta?.earliestDate || '--'} 至 {meta?.latestDate || '--'} · {meta?.timezone || 'Asia/Shanghai'}</p>
  </section>;
}

function ChatPanel({ messages }: { messages: Message[] }) {
  const [killsOnly, setKillsOnly] = useState(false);
  const rows = useMemo(() => {
    const sorted = messages.slice().sort((a, b) => String(a.event_at || a.eventAt || '').localeCompare(String(b.event_at || b.eventAt || '')));
    const result: ({ type: 'message'; message: Message } | { type: 'fold'; count: number; at: string })[] = [];
    let index = 0;
    while (index < sorted.length) {
      const current = sorted[index];
      const isKill = current.kind.toLowerCase() === 'kill';
      if (killsOnly && isKill) {
        let end = index + 1;
        while (end < sorted.length && sorted[end].kind.toLowerCase() === 'kill') end += 1;
        result.push({ type: 'fold', count: end - index, at: String(current.event_at || current.eventAt || '') });
        index = end;
      } else {
        result.push({ type: 'message', message: current });
        index += 1;
      }
    }
    return result;
  }, [messages, killsOnly]);
  return <section className="chat panel-block">
    <div className="section-heading"><div><p className="eyebrow">LIVE FEED</p><h2>聊天记录</h2></div><label className="switch-label"><input type="checkbox" checked={killsOnly} onChange={event => setKillsOnly(event.target.checked)} /><span className="switch" />仅看击杀</label></div>
    <div className="chat-list">{rows.length === 0 ? <EmptyState text="这个范围还没有消息" /> : rows.map((row, index) => row.type === 'fold' ? <div className="chat-fold" key={`fold-${index}`}><span>{row.count}条击杀记录已折叠</span></div> : <div className={row.message.kind.toLowerCase() === 'kill' ? 'chat-row kill' : 'chat-row'} key={`${row.message.message_id || row.message.messageId || index}`}><time>{formatTime(row.message.event_at || row.message.eventAt)}</time><p>{row.message.user_name && <strong>{row.message.user_name}</strong>}<span>{row.message.text}</span></p></div>)}</div>
  </section>;
}

function EmptyState({ text }: { text: string }) { return <div className="empty-state"><Rows3 size={18} /><span>{text}</span></div>; }

function valueColor(value: number | null, thresholds: [number, string][], fallback = 'muted'): string {
  if (value === null || value === undefined) return fallback;
  for (const [threshold, color] of thresholds) if (value >= threshold) return color;
  return thresholds.at(-1)?.[1] || fallback;
}

function playerPosition(player: Player, map: MapMetadata): { text: string; color: string } {
  const state = player.state;
  if (!state || state.x === null || state.y === null) return { text: '未知', color: 'muted' };
  const dx = state.x - map.center.x;
  const dy = state.y - map.center.y;
  const distance = Math.round(Math.hypot(dx, dy) * map.metersPerGameUnit);
  const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
  const index = Math.round(angle / (Math.PI / 4)) % 8;
  return { text: `${map.directions[index] || '未知'}${distance}米`, color: distance <= 1000 ? 'good' : 'warn' };
}

function stateColor(player: Player): string {
  const state = player.state;
  if (!state) return 'muted';
  if (state.stamina5s !== null && state.stamina5sLimit !== null && state.stamina5s < state.stamina5sLimit) return 'bad';
  if (state.stamina1d !== null && state.stamina1dLimit !== null && state.stamina1d < state.stamina1dLimit) return 'light';
  return 'good';
}

function StaminaCell({ player }: { player: Player }) {
  const state = player.state;
  if (!state) return <span className="muted">--</span>;
  const classes = [
    state.stamina5sLimit === 0 ? 'bad' : (state.stamina5s !== null && state.stamina5sLimit !== null && state.stamina5s >= state.stamina5sLimit ? 'good' : state.stamina5s !== null && state.stamina5s >= 5000 ? 'warn' : 'bad'),
    state.stamina1h === 0 ? 'bad' : state.stamina1h !== null && state.stamina1h >= 1000_000 ? 'good' : 'warn',
    state.stamina1d === 0 ? 'bad' : state.stamina1d !== null && state.stamina1d >= 1000_000 ? 'good' : 'warn'
  ];
  return <span className="stamina"><i className={classes[0]}>{displayNumber(state.stamina5s === null ? null : Math.round(state.stamina5s / 1000))}</i><b>/</b><i className={classes[1]}>{displayNumber(state.stamina1h === null ? null : Math.round(state.stamina1h / 1000))}</i><b>/</b><i className={classes[2]}>{displayNumber(state.stamina1d === null ? null : Math.round(state.stamina1d / 1000))}</i></span>;
}

type PlayerSort = 'quota' | 'drop' | 'income' | 'hp' | 'kills' | 'deaths';

function PlayersTable({ players, map, rangeLabel }: { players: Player[]; map: MapMetadata; rangeLabel: string }) {
  const saved = localStorage.getItem(PLAYER_SORT_KEY)?.split(':') as [PlayerSort, 'asc' | 'desc'] | null;
  const [sort, setSort] = useState<{ key: PlayerSort; direction: 'asc' | 'desc' }>({ key: saved?.[0] || 'quota', direction: saved?.[1] || 'desc' });
  const setSortKey = (key: PlayerSort) => setSort(current => { const next = { key, direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc' } as const; localStorage.setItem(PLAYER_SORT_KEY, `${next.key}:${next.direction}`); return next; });
  const sorted = useMemo(() => players.slice().sort((a, b) => {
    const value = (player: Player) => ({ quota: player.quota?.value, drop: player.drop, income: player.income, hp: player.state?.hp, kills: player.kills, deaths: player.deaths }[sort.key] ?? null);
    const av = value(a); const bv = value(b);
    if (av === null && bv === null) return a.name.localeCompare(b.name) || a.userId - b.userId;
    if (av === null) return 1; if (bv === null) return -1;
    return (Number(bv) - Number(av)) * (sort.direction === 'desc' ? 1 : -1) || a.name.localeCompare(b.name) || a.userId - b.userId;
  }), [players, sort]);
  const header = (key: PlayerSort, text: string) => <button className={sort.key === key ? 'sort-header active' : 'sort-header'} onClick={() => setSortKey(key)} title={`按${text}排序`}>{text}{sort.key === key && <ChevronDown size={12} className={sort.direction === 'asc' ? 'asc' : ''} />}</button>;
  return <div className="table-shell"><table className="player-table"><thead><tr><th>#</th><th>名称</th><th>状态</th><th>{header('drop', 'Drop')}</th><th>{header('quota', '额度')}</th><th>{header('income', rangeLabel)}</th><th>{header('hp', '血量')}</th><th>体力</th><th>位置</th><th>{header('kills', `${rangeLabel}击杀数`)}</th><th>{header('deaths', `${rangeLabel}死亡数`)}</th></tr></thead><tbody>{sorted.length === 0 ? <tr><td colSpan={11}><EmptyState text="这个范围还没有玩家数据" /></td></tr> : sorted.map((player, index) => { const hp = player.state?.hp ?? null; const position = playerPosition(player, map); return <tr key={player.userId}><td className="rank">{index + 1}</td><td className="name-cell" title={player.name}>{player.name || '未命名'}</td><td><span className={player.online ? 'status online' : 'status'}>{player.online ? '在线' : formatAgo(player.lastSeenAt)}</span></td><td className="numeric">{displayNumber(player.drop)}</td><td className="numeric">{displayNumber(player.quota?.value)} </td><td className={`numeric ${player.income !== null && player.income > 0 ? 'negative' : player.income !== null && player.income < 0 ? 'positive' : ''}`}>{player.income === null ? '--' : player.income > 0 ? `+${displayNumber(player.income)}` : displayNumber(player.income)}</td><td className={`numeric ${valueColor(hp, [[80, 'good'], [50, 'warn'], [20, 'orange'], [0, 'bad']])}`}>{displayNumber(hp)}</td><td><StaminaCell player={player} /></td><td className={position.color}>{position.text}</td><td className="numeric">{displayNumber(player.kills)}</td><td className="numeric">{displayNumber(player.deaths)}</td></tr>; })}</tbody></table></div>;
}

function playerCandidates(players: Player[]): Player[] {
  const selected = new Set<number>();
  const top = (value: (player: Player) => number | null | undefined) => players.filter(player => {
    const current = value(player);
    return current !== null && current !== undefined && Number.isFinite(Number(current));
  }).sort((a, b) => {
    const av = Number(value(a)); const bv = Number(value(b));
    return bv - av || a.name.localeCompare(b.name) || a.userId - b.userId;
  }).slice(0, 50);
  for (const player of top(player => player.quota?.value)) selected.add(player.userId);
  for (const player of top(player => player.drop)) selected.add(player.userId);
  for (const player of top(player => player.quota?.income)) selected.add(player.userId);
  return players.filter(player => selected.has(player.userId));
}

function MapView({ players, map }: { players: Player[]; map: MapMetadata }) {
  const [threshold, setThreshold] = useState(() => storageNumber(MAP_THRESHOLD_KEY, 10));
  const [zoom, setZoom] = useState(1);
  const pinchDistance = useRef<number | null>(null);
  const filtered = players.filter(player => { const dropMatch = player.drop !== null && player.drop >= threshold; const tired = player.state?.stamina1d !== null && player.state?.stamina1dLimit !== null && Boolean(player.state && player.state.stamina1d < player.state.stamina1dLimit); return dropMatch || tired; });
  const point = (player: Player) => { const state = player.state; if (!state || state.x === null || state.y === null) return null; return { x: ((state.x - map.bounds.minX) / (map.bounds.maxX - map.bounds.minX)) * 1000, y: 700 - ((state.y - map.bounds.minY) / (map.bounds.maxY - map.bounds.minY)) * 700 }; };
  const updateThreshold = (value: string) => { const next = Number(value); if (Number.isInteger(next) && next > 0) { setThreshold(next); localStorage.setItem(MAP_THRESHOLD_KEY, String(next)); } };
  return <section className="map-panel panel-block"><div className="section-heading"><div><p className="eyebrow">STEADY SNAPSHOT / MAP V{map.version}</p><h2>实时地图</h2></div><div className="map-controls"><label>Drop ≥ <input type="number" min="1" step="1" value={threshold} onChange={event => updateThreshold(event.target.value)} /></label><button className="small-button" onClick={() => setZoom(value => Math.min(2.4, value + 0.2))} aria-label="放大地图" title="放大地图"><ZoomIn size={14} /></button><button className="small-button" onClick={() => setZoom(value => Math.max(0.7, value - 0.2))} aria-label="缩小地图" title="缩小地图"><ZoomOut size={14} /></button></div></div><div className="map-stage" onWheel={event => { event.preventDefault(); setZoom(value => Math.max(0.7, Math.min(2.4, value + (event.deltaY > 0 ? -0.1 : 0.1)))); }} onTouchStart={event => { if (event.touches.length === 2) pinchDistance.current = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY); }} onTouchMove={event => { if (event.touches.length !== 2 || pinchDistance.current === null) return; event.preventDefault(); const next = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY); setZoom(value => Math.max(0.7, Math.min(2.4, value * (next / pinchDistance.current!)))); pinchDistance.current = next; }} onTouchEnd={() => { pinchDistance.current = null; }}><svg viewBox="0 0 1000 700" role="img" aria-label="实时玩家地图" style={{ transform: `scale(${zoom})` }}><rect x="0" y="0" width="1000" height="700" className="map-water" /><ellipse cx="500" cy="350" rx="500" ry="350" className="map-land" /><path d="M0 350 H1000 M500 0 V700" className="map-grid" /><ellipse cx="500" cy="350" rx="325" ry="228" className="map-grid" />{filtered.map(player => { const p = point(player); if (!p) return null; return <g key={player.userId} transform={`translate(${p.x} ${p.y})`} className="map-player"><circle r="7" className={`player-dot ${stateColor(player)}`} /><circle r="13" className={`player-ring ${stateColor(player)}`} /><text x="12" y="-11" className="map-name">{player.name || player.userId}</text><text x="12" y="4" className="map-detail">HP {displayNumber(player.state?.hp)} · Drop {displayNumber(player.drop)}</text></g>; })}</svg><div className="map-legend"><span><i className="dot good" />1d 满</span><span><i className="dot light" />1d 不满 / 5s 满</span><span><i className="dot bad" />5s 不满</span><span className="map-count">{filtered.length} 位玩家</span></div></div></section>;
}

function killPosition(kill: Kill, players: Player[], map: MapMetadata): { text: string; color: string } {
  const evidence = kill.victim_position || kill.killer_position;
  if (evidence && evidence.x !== null && evidence.y !== null) {
    const synthetic: Player = { userId: -1, name: '', online: false, lastSeenAt: null, currentEntityId: null, drop: null, quota: null, income: null, kills: 0, deaths: 0, state: { hp: null, maxHp: null, x: evidence.x, y: evidence.y, stamina5s: null, stamina1h: null, stamina1d: null, stamina5sLimit: null, stamina1hLimit: null, stamina1dLimit: null, currentJoinMode: null, life: null, snapshotId: '', observedAt: '' } };
    return playerPosition(synthetic, map);
  }
  const victim = players.find(player => player.userId === kill.victim_user_id);
  const killer = players.find(player => player.userId === kill.killer_user_id);
  const source = victim?.state?.x !== null && victim?.state?.x !== undefined ? victim : killer;
  if (!source) return { text: '未知', color: 'muted' };
  return playerPosition(source, map);
}

function KillTable({ kills, players, map }: { kills: Kill[]; players: Player[]; map: MapMetadata }) {
  const [threshold, setThreshold] = useState(() => storageNumber(KILL_THRESHOLD_KEY, 10));
  const [selected, setSelected] = useState<number[]>([]);
  const names = useMemo(() => Array.from(new Map(kills.flatMap(kill => [[kill.killer_user_id, kill.killer_name], [kill.victim_user_id, kill.victim_name]]).filter(([id]) => id !== null && id !== undefined) as [number, string | null][]).entries()).sort((a, b) => String(a[1] || '').localeCompare(String(b[1] || ''), 'zh-Hans-u-co-pinyin')), [kills]);
  const filtered = kills.filter(kill => { const amount = kill.drop?.amount; if (amount === null || amount === undefined || amount < threshold) return false; if (selected.length === 0) return true; return selected.includes(Number(kill.killer_user_id)) || selected.includes(Number(kill.victim_user_id)); }).sort((a, b) => String(a.event_at || a.eventAt || '').localeCompare(String(b.event_at || b.eventAt || '')));
  const updateThreshold = (value: string) => { const next = Number(value); if (Number.isInteger(next) && next > 0) { setThreshold(next); localStorage.setItem(KILL_THRESHOLD_KEY, String(next)); } };
  return <section className="kill-panel"><div className="filter-bar"><label>Drop ≥ <input type="number" min="1" step="1" value={threshold} onChange={event => updateThreshold(event.target.value)} /></label><details><summary><Users size={14} /> 玩家筛选{selected.length ? ` · ${selected.length}` : ''}</summary><div className="player-options">{names.map(([id, name]) => <label key={id}><input type="checkbox" checked={selected.includes(Number(id))} onChange={event => setSelected(current => event.target.checked ? [...current, Number(id)] : current.filter(value => value !== Number(id)))} />{name || id}</label>)}</div></details>{selected.length > 0 && <button className="clear-filter" onClick={() => setSelected([])}><X size={13} />清除</button>}</div><div className="table-shell"><table className="kill-table"><thead><tr><th>时间</th><th>凶手</th><th>受害者</th><th>类型</th><th>位置</th><th>掉落</th></tr></thead><tbody>{filtered.length === 0 ? <tr><td colSpan={6}><EmptyState text="没有符合阈值的击杀记录" /></td></tr> : filtered.map((kill, index) => { const type = kill.victim_stamina_5s !== null && kill.victim_stamina_5s !== undefined && kill.victim_stamina_5s_limit !== null && kill.victim_stamina_5s_limit !== undefined ? (kill.victim_stamina_5s === kill.victim_stamina_5s_limit ? '挂机' : '活跃') : (players.find(player => player.userId === kill.victim_user_id)?.state ? '活跃' : '未知'); const position = killPosition(kill, players, map); return <tr key={kill.kill_id || kill.killId || index}><td>{formatTime(kill.event_at || kill.eventAt)}</td><td>{kill.killer_name || '未知'}</td><td>{kill.victim_name || '未知'}</td><td><span className={`confidence ${kill.confidence}`}>{type}</span></td><td className={position.color}>{position.text}</td><td className="numeric">{displayNumber(kill.drop?.amount ?? null)}</td></tr>; })}</tbody></table></div></section>;
}

function MainPanel({ realtime, history, meta, range, loading }: { realtime: RealtimeResponse | null; history: HistoryResponse | null; meta: MetaResponse; range: { from: string; to: string }; loading: boolean }) {
  const [tab, setTab] = useState<'map' | 'players' | 'kills'>('map');
  const latest = realtime?.latest?.server_day || meta.latestDate || localDate();
  const realtimePlayers = realtime?.players || [];
  const historyPlayers = history?.players || [];
  const playerMap = new Map<number, Player>();
  historyPlayers.forEach(player => playerMap.set(player.userId, player));
  realtimePlayers.forEach(player => { const old = playerMap.get(player.userId); playerMap.set(player.userId, old ? { ...old, ...player, income: old.income, kills: old.kills, deaths: old.deaths } : player); });
  const players = playerCandidates([...playerMap.values()]);
  const messages = mergeById<Message>(history?.messages || [], realtime?.messages || [], 'message_id').filter(message => eventInRange(message, range));
  const kills = mergeById<Kill>(history?.kills || [], realtime?.kills || [], 'kill_id').filter(kill => eventInRange(kill, range));
  const rangeLabel = range.from === range.to ? (range.to === latest ? '今日' : range.to) : `${range.from}—${range.to}`;
  return <main className="main-grid"><aside className="left-rail"><RangeControls meta={meta} /><ChatPanel messages={messages} /></aside><section className="right-field"><nav className="tabs" aria-label="面板视图"><button className={tab === 'map' ? 'tab active' : 'tab'} onClick={() => setTab('map')}><MapIcon size={15} />实时地图</button><button className={tab === 'players' ? 'tab active' : 'tab'} onClick={() => setTab('players')}><Users size={15} />玩家列表</button><button className={tab === 'kills' ? 'tab active' : 'tab'} onClick={() => setTab('kills')}><Swords size={15} />击杀明细</button><span className="tab-status">{loading ? <><RefreshCw size={13} className="spin" />同步历史</> : <><span className="status-dot" />{realtime ? `v${realtime.latest?.server_tick ?? '--'}` : '等待快照'}</>}</span></nav>{tab === 'map' && <MapView players={realtimePlayers.length ? realtimePlayers : players.filter(player => player.online)} map={realtime?.map || meta.map} />}{tab === 'players' && <section className="players-panel panel-block"><div className="section-heading"><div><p className="eyebrow">RANKED CURRENT STATE</p><h2>玩家列表</h2></div><span className="result-count">{players.length} 位玩家</span></div><PlayersTable players={players} map={meta.map} rangeLabel={rangeLabel} /></section>}{tab === 'kills' && <KillTable kills={kills} players={players} map={meta.map} />}</section></main>;
}

function Footer() {
  return <footer className="footer"><span>GRASP RAT / OBSERVATION SURFACE</span><div><a href="https://github.com/ZeroJehovah/grasp-rat-open-panel" target="_blank" rel="noopener noreferrer"><Github size={14} />GitHub</a><a href="https://grasp-rat-game.h-e.top/" target="_blank" rel="noopener noreferrer"><Activity size={14} />游戏主页</a><a href="https://linux.do/t/topic/2290514" target="_blank" rel="noopener noreferrer"><Search size={14} />讨论帖</a></div></footer>;
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => { const saved = localStorage.getItem(THEME_KEY); if (saved === 'light' || saved === 'dark') return saved; return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; });
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem(THEME_KEY, theme); }, [theme]);
  useEffect(() => { const controller = new AbortController(); getMeta(controller.signal).then(value => { setMeta(value); if (!rangeStore.getSnapshot().from && value.latestDate) rangeStore.set({ preset: 'today', ...rangeForPreset('today', value.latestDate) }); }).catch(error => { if (error.name !== 'AbortError') setMetaError(error.message); }); return () => controller.abort(); }, []);
  const range = useRangeStore();
  const data = usePanelData(meta, range);
  const realtimeAge = data.realtimeUpdatedAt ? ` · 最近更新 ${formatTime(data.realtimeUpdatedAt)}` : '';
  return <div className="app-shell"><Banner theme={theme} onTheme={() => setTheme(value => value === 'light' ? 'dark' : 'light')} /><div className="global-status">{metaError ? <><CircleAlert size={14} />元数据加载失败：{metaError}</> : data.versionError ? <><CircleAlert size={14} />实时版本检查失败，显示旧缓存{realtimeAge}</> : data.historyError ? <><CircleAlert size={14} />历史数据暂不可用，实时视图仍可用{realtimeAge}</> : <><span className="status-dot" />服务运行中 · {meta?.timezone || 'Asia/Shanghai'}{realtimeAge}</>}</div>{meta ? <MainPanel realtime={data.realtime} history={data.history} meta={meta} range={range} loading={data.loadingHistory} /> : <main className="loading-screen"><RefreshCw className="spin" size={20} /><span>正在连接观测数据…</span></main>}<Footer /></div>;
}
