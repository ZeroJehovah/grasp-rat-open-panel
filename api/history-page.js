'use strict';

// 历史分页只开放这三档页大小。页大小进响应缓存键，放开成任意整数等于让同一份数据
// 按用户输入无限增殖缓存条目。
const HISTORY_PAGE_SIZES = Object.freeze([100, 500, 1000]);
// 分页请求不再受 HISTORY_ROW_LIMITS 约束——那个上限是为了别把整区间塞进一个响应，
// 而分页响应本来就只有一页。但仍要有个上界兜住"整年区间"这类请求：击杀每天约 900 行，
// 一个月约 27,000 行，20 万行留了足够余量。
const HISTORY_PAGE_ROW_CAP = 200_000;
const HISTORY_USER_FILTER_MAX = 64;
const PAGINATED_RESOURCES = Object.freeze(['chat', 'kills']);
const FILTERABLE_RESOURCES = Object.freeze(['kills']);
const RESOURCE_ROWS = Object.freeze({ chat: 'messages', kills: 'kills' });

function invalidPagination(message) {
  const error = new Error(message);
  error.code = 'invalid_pagination';
  return error;
}

// query 里同名参数出现多次时 fastify 给的是数组；取第一个而不是让 Number(['1','2']) 变 NaN。
function firstValue(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function parseUserIds(raw) {
  const users = [];
  for (const part of raw.split(',')) {
    const text = part.trim();
    if (!text) continue;
    if (!/^\d+$/.test(text)) throw invalidPagination('users must be a comma separated list of user ids');
    const id = Number(text);
    if (!Number.isSafeInteger(id)) throw invalidPagination('users must be a comma separated list of user ids');
    if (!users.includes(id)) users.push(id);
  }
  if (users.length > HISTORY_USER_FILTER_MAX) throw invalidPagination(`users accepts at most ${HISTORY_USER_FILTER_MAX} ids`);
  // 规范化排序：缓存键必须与调用方给的顺序无关，否则 1,2 和 2,1 会各占一条缓存。
  users.sort((left, right) => left - right);
  return users.length === 0 ? null : users;
}

function parseFilters(resource, query) {
  const minDropRaw = firstValue(query.minDrop);
  const usersRaw = firstValue(query.users);
  if (minDropRaw === null && usersRaw === null) return null;
  if (!FILTERABLE_RESOURCES.includes(resource)) throw invalidPagination(`history ${resource} does not accept minDrop or users`);
  let minDrop = null;
  if (minDropRaw !== null) {
    minDrop = Number(minDropRaw);
    if (!Number.isFinite(minDrop) || minDrop < 0) throw invalidPagination('minDrop must be a non-negative number');
  }
  return { minDrop, users: usersRaw === null ? null : parseUserIds(usersRaw) };
}

// 返回 null 表示这次请求不分页也不过滤，走原来的整区间行为（413 上限照旧生效）。
function parseHistoryPageQuery(resource, query = {}) {
  const pageSizeRaw = firstValue(query.pageSize);
  const pageRaw = firstValue(query.page);
  const filters = parseFilters(resource, query);
  if (pageSizeRaw === null) {
    if (pageRaw !== null) throw invalidPagination('page requires pageSize');
    return filters ? { pageSize: null, page: 1, filters, rowCap: null } : null;
  }
  if (!PAGINATED_RESOURCES.includes(resource)) throw invalidPagination(`history ${resource} does not support pagination`);
  const pageSize = Number(pageSizeRaw);
  if (!HISTORY_PAGE_SIZES.includes(pageSize)) throw invalidPagination(`pageSize must be one of ${HISTORY_PAGE_SIZES.join(', ')}`);
  let page = 1;
  if (pageRaw !== null) {
    if (pageRaw === 'last') page = 'last';
    else {
      page = Number(pageRaw);
      if (!Number.isSafeInteger(page) || page < 1) throw invalidPagination('page must be a positive integer or "last"');
    }
  }
  return { pageSize, page, filters, rowCap: HISTORY_PAGE_ROW_CAP };
}

// 缓存键片段。已勾选的用户 id 已在解析时排好序，所以同一组过滤条件只会有一条缓存。
function historyPageCacheKey(request) {
  if (!request) return '';
  const parts = [`p${request.page}`, `s${request.pageSize ?? 'all'}`];
  if (request.filters?.minDrop !== null && request.filters?.minDrop !== undefined) parts.push(`d${request.filters.minDrop}`);
  if (request.filters?.users) parts.push(`u${request.filters.users.join('.')}`);
  return `:${parts.join(':')}`;
}

function killDropAmount(row) {
  const amount = row?.drop?.amount;
  if (amount === null || amount === undefined) return null;
  const value = Number(amount);
  return Number.isFinite(value) ? value : null;
}

function participantIds(row) {
  const ids = [];
  for (const raw of [row?.killer_user_id, row?.victim_user_id]) {
    if (raw === null || raw === undefined) continue;
    const id = Number(raw);
    if (Number.isFinite(id)) ids.push(id);
  }
  return ids;
}

// 玩家候选表给的是"阈值过滤之后出现过的人"，加上当前已勾选的 id——即使他们在新阈值下
// 没有击杀，复选框也要留着，否则用户没法取消自己刚勾的人。名字从未过滤的全集里查，
// 这和前端原来从所有击杀里建 namesById 的行为一致。
function buildPlayerOptions(allRows, thresholdRows, users) {
  const names = new Map();
  for (const row of allRows) {
    if (row?.killer_user_id !== null && row?.killer_user_id !== undefined) names.set(Number(row.killer_user_id), row.killer_name ?? null);
    if (row?.victim_user_id !== null && row?.victim_user_id !== undefined) names.set(Number(row.victim_user_id), row.victim_name ?? null);
  }
  const ids = new Set(users || []);
  for (const row of thresholdRows) for (const id of participantIds(row)) ids.add(id);
  return Array.from(ids, id => ({ userId: id, name: names.get(id) ?? null }))
    .sort((left, right) => String(left.name || left.userId).localeCompare(String(right.name || right.userId), 'zh-Hans-u-co-pinyin') || left.userId - right.userId);
}

function applyMinDrop(rows, minDrop) {
  if (minDrop === null || minDrop === undefined) return rows;
  // 掉落金额未知的击杀在有阈值时一律排除，和前端原来的 `amount !== null && amount >= threshold` 一致。
  return rows.filter(row => {
    const amount = killDropAmount(row);
    return amount !== null && amount >= minDrop;
  });
}

function applyUsers(rows, users) {
  if (!users) return rows;
  const wanted = new Set(users);
  return rows.filter(row => participantIds(row).some(id => wanted.has(id)));
}

// 过滤和裁剪都在这里做：store 仍然返回整个区间的行（并按天缓存），路由只把需要的一页
// 序列化出去。这样 store 的分片等价性不受分页影响，两条历史查询路径也不用各写一遍。
function sliceHistoryPage(resource, payload, request) {
  if (!request) return payload;
  const key = RESOURCE_ROWS[resource];
  if (!key) return payload;
  const rows = Array.isArray(payload[key]) ? payload[key] : [];
  const thresholdRows = resource === 'kills' ? applyMinDrop(rows, request.filters?.minDrop) : rows;
  const filtered = resource === 'kills' ? applyUsers(thresholdRows, request.filters?.users) : thresholdRows;
  if (request.pageSize === null) return { ...payload, [key]: filtered };
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / request.pageSize));
  // 越界的页号一律夹到有效范围而不是报错：调高阈值会让总页数变少，此时用户手上的页号
  // 必然过期，报错只会把页面打回错误态。响应里回的是实际用的页号。
  const page = request.page === 'last' ? totalPages : Math.min(request.page, totalPages);
  const start = (page - 1) * request.pageSize;
  const result = {
    ...payload,
    [key]: filtered.slice(start, start + request.pageSize),
    pagination: { page, pageSize: request.pageSize, total, totalPages, hasPrev: page > 1, hasNext: page < totalPages }
  };
  if (resource === 'kills') result.filterOptions = { players: buildPlayerOptions(rows, thresholdRows, request.filters?.users) };
  return result;
}

module.exports = {
  HISTORY_PAGE_SIZES,
  HISTORY_PAGE_ROW_CAP,
  HISTORY_USER_FILTER_MAX,
  parseHistoryPageQuery,
  historyPageCacheKey,
  sliceHistoryPage
};
