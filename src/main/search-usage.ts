import type { SearchItem, SearchResponse } from "../shared/ipc";
import { readState, writeState } from "./database";

interface UsageEntry {
  count: number;
  lastUsed: number;
  queries: Record<string, { count: number; lastUsed: number }>;
}

type UsageState = Record<string, UsageEntry>;

const NS = "search";
const KEY = "selection-usage";
const MAX_ITEMS = 500;
const MAX_QUERIES_PER_ITEM = 24;

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

function itemKey(item: Pick<SearchItem, "type" | "payload" | "pluginId">): string {
  const identity = item.type === "plugin" && item.pluginId ? item.pluginId : item.payload;
  return `${item.type}:${identity}`.slice(0, 600);
}

function load(): UsageState {
  try {
    return readState<UsageState>(NS, KEY) ?? {};
  } catch {
    return {};
  }
}

export function recordSearchSelection(query: string, item: SearchItem): void {
  const q = normalizeQuery(query);
  if (!q || !item?.payload || !item?.type) return;
  const state = load();
  const key = itemKey(item);
  const now = Date.now();
  const entry = state[key] ?? { count: 0, lastUsed: 0, queries: {} };
  entry.count += 1;
  entry.lastUsed = now;
  const queryUsage = entry.queries[q] ?? { count: 0, lastUsed: 0 };
  queryUsage.count += 1;
  queryUsage.lastUsed = now;
  entry.queries[q] = queryUsage;
  entry.queries = Object.fromEntries(
    Object.entries(entry.queries)
      .sort((a, b) => b[1].lastUsed - a[1].lastUsed)
      .slice(0, MAX_QUERIES_PER_ITEM),
  );
  state[key] = entry;
  const trimmed = Object.fromEntries(
    Object.entries(state)
      .sort((a, b) => b[1].lastUsed - a[1].lastUsed)
      .slice(0, MAX_ITEMS),
  );
  writeState(NS, KEY, trimmed);
}

function recencyScore(lastUsed: number, max: number): number {
  const ageDays = Math.max(0, (Date.now() - lastUsed) / 86_400_000);
  return max * Math.exp(-ageDays / 30);
}

function usageScore(state: UsageState, query: string, item: SearchItem): number {
  const entry = state[itemKey(item)];
  if (!entry) return 0;
  const exact = entry.queries[query];
  const exactScore = exact
    ? Math.min(120, exact.count * 28) + recencyScore(exact.lastUsed, 42)
    : 0;
  const generalScore = Math.min(24, Math.log2(entry.count + 1) * 7) + recencyScore(entry.lastUsed, 14);
  return exactScore + generalScore;
}

function sortGroup(items: SearchItem[], state: UsageState, query: string): SearchItem[] {
  return items
    // Preserve the search provider's relevance order as the baseline. Usage
    // can move a result up gradually, but a weak historical choice does not
    // immediately outrank a much better textual match.
    .map((item, index) => ({
      item,
      index,
      score: usageScore(state, query, item) - index * 12,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

export function applyUsageRanking(response: SearchResponse, rawQuery: string): SearchResponse {
  const query = normalizeQuery(rawQuery);
  if (!query) return response;
  const state = load();
  response.apps = sortGroup(response.apps, state, query);
  response.files = sortGroup(response.files, state, query);
  response.plugins = sortGroup(response.plugins, state, query);
  response.commands = sortGroup(response.commands, state, query);
  return response;
}
