import { useEffect, useState } from 'react';

export type RouteScope = 'realtime' | 'history';
export type RouteTab = 'chat' | 'map' | 'players' | 'kills';

export interface PanelRoute {
  scope: RouteScope;
  tab: RouteTab;
  from: string | null;
  to: string | null;
}

const REALTIME_TABS: RouteTab[] = ['chat', 'map', 'players', 'kills'];
const HISTORY_TABS: RouteTab[] = ['chat', 'players', 'kills'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string | null): value is string {
  return Boolean(value && DATE_PATTERN.test(value));
}

export function parseRoute(location: Pick<Location, 'pathname' | 'search'> = window.location): PanelRoute {
  const match = /^\/(realtime|history)\/([a-z]+)$/.exec(location.pathname);
  if (!match) return { scope: 'realtime', tab: 'chat', from: null, to: null };
  const scope = match[1] as RouteScope;
  const tab = match[2] as RouteTab;
  const allowed = scope === 'realtime' ? REALTIME_TABS : HISTORY_TABS;
  if (!allowed.includes(tab)) return { scope: 'realtime', tab: 'chat', from: null, to: null };
  const query = new URLSearchParams(location.search);
  if (scope === 'realtime') return { scope, tab, from: null, to: null };
  const from = validDate(query.get('from')) ? query.get('from') : null;
  const to = validDate(query.get('to')) ? query.get('to') : null;
  return { scope, tab, from, to };
}

export function routePath(route: PanelRoute): string {
  const path = `/${route.scope}/${route.tab}`;
  if (route.scope !== 'history') return path;
  const query = new URLSearchParams();
  if (route.from) query.set('from', route.from);
  if (route.to) query.set('to', route.to);
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

function sameRoute(left: PanelRoute, right: PanelRoute): boolean {
  return left.scope === right.scope && left.tab === right.tab && left.from === right.from && left.to === right.to;
}

export function navigate(route: PanelRoute, replace = false): void {
  const path = routePath(route);
  if (`${window.location.pathname}${window.location.search}` !== path) {
    window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(todayRange?: { from: string; to: string } | null): PanelRoute {
  const [route, setRoute] = useState<PanelRoute>(() => parseRoute());

  useEffect(() => {
    const canonical = routePath(route);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== canonical) window.history.replaceState({}, '', canonical);
  }, [route]);

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (route.scope !== 'history' || !todayRange) return;
    if (route.from && route.to && route.from <= todayRange.to && route.to <= todayRange.to) return;
    const from = route.from && route.from <= todayRange.to ? route.from : todayRange.from;
    const to = route.to && route.to <= todayRange.to ? route.to : todayRange.to;
    const next = { ...route, from: from <= to ? from : todayRange.from, to: from <= to ? to : todayRange.to };
    if (!sameRoute(route, next)) navigate(next, true);
  }, [route, todayRange]);

  return route;
}

export function tabPath(scope: RouteScope, tab: RouteTab, route: PanelRoute): string {
  return routePath({ scope, tab, from: scope === 'history' ? route.from : null, to: scope === 'history' ? route.to : null });
}
