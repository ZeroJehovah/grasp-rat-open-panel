import { useSyncExternalStore } from 'react';

export type RangePreset = 'today' | 'yesterday' | 'this-week' | 'last-week' | 'this-month' | 'last-month' | 'custom';

export interface RangeState {
  preset: RangePreset;
  from: string;
  to: string;
}

const listeners = new Set<() => void>();
let state: RangeState = { preset: 'today', from: '', to: '' };

export const rangeStore = {
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set(next: RangeState) {
    state = next;
    listeners.forEach(listener => listener());
  },
};

export function useRangeStore(): RangeState {
  return useSyncExternalStore(rangeStore.subscribe, rangeStore.getSnapshot, rangeStore.getSnapshot);
}
