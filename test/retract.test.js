'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

// 每个测试文件独立内存库
const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');
const { runDueSchedules } = require('../src/schedule');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM version_retractions;
    DELETE FROM publish_schedules;
    DELETE FROM route_segments;
    DELETE FROM route_anchors;
    DELETE FROM routes;
    DELETE FROM source_redactions;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title) {
  const r = await call('POST', '/api/editor/events', { body: { title } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}

async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}

async function makeRel(earlierId, laterId, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

async function publish(selection, baseVersionNo, extra = {}) {
  const r = await call('POST', '/api/editor/publish', { body: { selection, baseVersionNo, ...extra } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.versionNo;
}

// 建两版草稿：v1（e1→e2），v2（再加 e3）。返回各 id 与选择。
async function setupTwoVersions() {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
  await makeRel(e1, e2, '二人口述一致');
  const sel12 = [
    { eventId: e1, claimId: c1 },
    { eventId: e2, claimId: c2 },
  ];
  await publish(sel12, 0);

  const e3 = await makeEvent('抽水机到站');
  const c3 = await makeClaim(e3, { precision: 'year', year: 1962, source: '县志水利篇' });
  await makeRel(e2, e3, '社员回忆');
  const sel123 = [...sel12, { eventId: e3, claimId: c3 }];
  await publish(sel123, 1);
  return { e1, e2, e3, c1, c2, c3, sel12, sel123 };
}

function secondsFromNow(deltaSec) {
  return new Date(Date.now() + deltaSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

test('撤回接口需要编辑口令', async () => {
  await setupTwoVersions();
  const r = await call('POST', '/api/editor/versions/2/retract', { token: null, body: { reason: 'x' } });
  assert.strictEqual(r.status, 401);
  const r2 = await call('GET', '/api/editor/retractions', { token: null });
  assert.strictEqual(r2.status, 401);
});

test('撤回成功：201 + 审计记录；历史快照与版本号不改，编辑者仍可见原文与原因', async () => {
  await setupTwoVersions();
  const r = await call('POST', '/api/editor/versions/2/retract', {
    body: { reason: '  「抽水机到站」编年依据错误，待重新核定 ', editor: '小王' },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.alreadyRetracted, false);
  assert.strictEqual(r.json.retraction.versionNo, 2);
  assert.strictEqual(r.json.retraction.reason, '「抽水机到站」编年依据错误，待重新核定'); // trim 后入库
  assert.strictEqual(r.json.retraction.editor, '小王');
  assert.ok(r.json.retraction.retractedAt);
  assert.strictEqual(r.json.currentVersionNo, 2); // 发布基准仍是最高已发布版本号
  assert.strictEqual(r.json.latestVisibleVersionNo, 1); // 访客可见退到第 1 版

  // 快照原文与版本号不变（编辑者原文视图）
  const raw = await call('GET', '/api/editor/versions/2/raw');
  assert.strictEqual(raw.status, 200);
  assert.strictEqual(raw.json.version.versionNo, 2);
  assert.strictEqual(raw.json.version.events.length, 3);
  assert.strictEqual(raw.json.version.events.find((e) => e.title === '抽水机到站').source, '县志水利篇');

  // 编辑者版本清单：撤回标记与原因
  const list = await call('GET', '/api/editor/versions');
  assert.strictEqual(list.json.currentVersionNo, 2);
  assert.strictEqual(list.json.latestVisibleVersionNo, 1);
  const v2 = list.json.versions.find((v) => v.versionNo === 2);
  assert.strictEqual(v2.retracted, true);
  assert.strictEqual(v2.retraction.reason, '「抽水机到站」编年依据错误，待重新核定');
  const v1 = list.json.versions.find((v) => v.versionNo === 1);
  assert.strictEqual(v1.retracted, false);
  assert.strictEqual(v1.retraction, null);

  // 审计清单
  const audit = await call('GET', '/api/editor/retractions');
  assert.strictEqual(audit.json.retractions.length, 1);
  assert.strictEqual(audit.json.retractions[0].versionNo, 2);
});

test('重复撤回：200 返回首次记录，不覆盖原因、不重复落库', async () => {
  await setupTwoVersions();
  const first = await call('POST', '/api/editor/versions/2/retract', {
    body: { reason: '首次原因', editor: '甲' },
  });
  assert.strictEqual(first.status, 201);

  const again = await call('POST', '/api/editor/versions/2/retract', {
    body: { reason: '试图改写的原因', editor: '乙' },
  });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.alreadyRetracted, true);
  assert.strictEqual(again.json.retraction.reason, '首次原因'); // 不覆盖
  assert.strictEqual(again.json.retraction.editor, '甲');
  assert.strictEqual(again.json.retraction.retractedAt, first.json.retraction.retractedAt);

  const n = mem.prepare('SELECT COUNT(*) AS n FROM version_retractions WHERE version_no = 2').get().n;
  assert.strictEqual(n, 1);
});

test('版本不存在 → 404；原因非法 → 400；均不改状态', async () => {
  await setupTwoVersions();
  const notFound = await call('POST', '/api/editor/versions/999/retract', { body: { reason: 'x' } });
  assert.strictEqual(notFound.status, 404);

  for (const reason of ['', '   ', 123, null, undefined]) {
    const r = await call('POST', '/api/editor/versions/2/retract', { body: { reason } });
    assert.strictEqual(r.status, 400, `原因 ${JSON.stringify(reason)} 应 400`);
  }
  const badNo = await call('POST', '/api/editor/versions/abc/retract', { body: { reason: 'x' } });
  assert.strictEqual(badNo.status, 400);

  // 无任何审计记录，访客视图不变
  const audit = await call('GET', '/api/editor/retractions');
  assert.strictEqual(audit.json.retractions.length, 0);
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 2);
});

test('访客最新年表指向编号最大的未撤回版；全部撤回显示尚无可读版本', async () => {
  await setupTwoVersions();

  // 撤回第 2 版 → 访客指向第 1 版
  await call('POST', '/api/editor/versions/2/retract', { body: { reason: '依据错误' } });
  let view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, true);
  assert.strictEqual(view.json.currentVersionNo, 1);
  assert.strictEqual(view.json.version.events.length, 2);

  // 再撤回第 1 版 → 尚无可读版本
  await call('POST', '/api/editor/versions/1/retract', { body: { reason: '整批存疑' } });
  view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, false);
  assert.match(view.json.message, /尚无可读版本/);
});

test('撤回后即时发布仍以最高已发布版本号为基准，编号继续递增', async () => {
  const { sel123 } = await setupTwoVersions();
  await call('POST', '/api/editor/versions/2/retract', { body: { reason: '依据错误' } });

  // 以旧基准（1）发布 → 409；以最高已发布版本号（2，已撤回）发布 → 成功得第 3 版
  const stale = await call('POST', '/api/editor/publish', { body: { selection: sel123, baseVersionNo: 1 } });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.json.currentVersionNo, 2);

  const ok = await call('POST', '/api/editor/publish', {
    body: { selection: sel123, baseVersionNo: 2, note: '核定后重发' },
  });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.json.versionNo, 3);
  assert.strictEqual(ok.json.version.parentNo, 2);

  // 新版本未撤回：访客指向第 3 版
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 3);
});

test('访客版本清单隐藏撤回版；指定撤回版读取按不存在处理', async () => {
  await setupTwoVersions();
  await call('POST', '/api/editor/versions/2/retract', { body: { reason: '依据错误' } });

  const list = await call('GET', '/api/public/versions', { token: null });
  assert.strictEqual(list.json.currentVersionNo, 1);
  assert.deepStrictEqual(list.json.versions.map((v) => v.versionNo), [1]);

  const gone = await call('GET', '/api/public/versions/2', { token: null });
  assert.strictEqual(gone.status, 404);
  assert.match(gone.json.message, /不存在/);

  // 未撤回版仍正常读取，结构不变
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.status, 200);
  assert.strictEqual(v1.json.version.versionNo, 1);
  assert.ok(Array.isArray(v1.json.version.events));

  // 全部撤回后清单为空
  await call('POST', '/api/editor/versions/1/retract', { body: { reason: '整批存疑' } });
  const empty = await call('GET', '/api/public/versions', { token: null });
  assert.strictEqual(empty.json.currentVersionNo, 0);
  assert.deepStrictEqual(empty.json.versions, []);
});

test('引用撤回版的专题路线对访客隐藏；编辑者仍可见；基于撤回版建路线被拒', async () => {
  const { e1, e2, e3 } = await setupTwoVersions();
  // 基于第 2 版建路线 e1 → e3（经 e2）
  const route = await call('POST', '/api/editor/routes', {
    body: { title: '建设脉络', versionNo: 2, anchorEventIds: [e1, e3] },
  });
  assert.strictEqual(route.status, 201, JSON.stringify(route.json));
  const routeNo = route.json.route.routeNo;

  // 撤回前访客可见
  let pub = await call('GET', `/api/public/routes/${routeNo}`, { token: null });
  assert.strictEqual(pub.status, 200);

  // 撤回第 2 版 → 路线对访客隐藏（清单与详情），按不存在处理
  await call('POST', '/api/editor/versions/2/retract', { body: { reason: '依据错误' } });
  const pubList = await call('GET', '/api/public/routes', { token: null });
  assert.strictEqual(pubList.json.routes.length, 0);
  pub = await call('GET', `/api/public/routes/${routeNo}`, { token: null });
  assert.strictEqual(pub.status, 404);

  // 编辑者清单仍列出（带撤回标记），原文详情仍可查看
  const edList = await call('GET', '/api/editor/routes');
  assert.strictEqual(edList.json.routes.length, 1);
  assert.strictEqual(edList.json.routes[0].versionRetracted, true);
  const raw = await call('GET', `/api/editor/routes/${routeNo}/raw`);
  assert.strictEqual(raw.status, 200);
  assert.strictEqual(raw.json.route.events.length > 0, true);

  // 不能基于已撤回版建立新路线
  const denied = await call('POST', '/api/editor/routes', {
    body: { title: '再建一条', versionNo: 2, anchorEventIds: [e1, e2] },
  });
  assert.strictEqual(denied.status, 409);
  assert.strictEqual(denied.json.code, 'VERSION_RETRACTED');
  void e3;
});

test('以已撤回版为冻结基准的待执行预约到期转冲突，不生成新版本', async () => {
  const { sel123 } = await setupTwoVersions(); // 最新 = 2
  const sch = await call('POST', '/api/editor/schedules', {
    body: { selection: sel123, scheduledAt: secondsFromNow(60), baseVersionNo: 2 },
  });
  assert.strictEqual(sch.status, 201);
  const no = sch.json.schedule.scheduleNo;

  // 撤回先提交：撤回第 2 版后预约到期 → 转冲突
  await call('POST', '/api/editor/versions/2/retract', { body: { reason: '依据错误' } });
  const out = runDueSchedules(Date.now() + 120 * 1000);
  assert.strictEqual(out.published.length, 0);
  assert.strictEqual(out.conflicts.length, 1);
  assert.strictEqual(out.conflicts[0].scheduleNo, no);
  assert.strictEqual(out.conflicts[0].cause, 'base_retracted');

  const detail = await call('GET', `/api/editor/schedules/${no}`);
  assert.strictEqual(detail.json.schedule.status, 'conflict');
  assert.strictEqual(detail.json.schedule.resultVersionNo, null);
  assert.match(detail.json.schedule.resultMessage, /撤回/);
  assert.strictEqual(detail.json.schedule.frozen.events.length, 3); // 冻结内容保留

  // 没有生成新版本：最高版本号仍是 2，访客仍只见第 1 版
  const edVersions = await call('GET', '/api/editor/versions');
  assert.strictEqual(edVersions.json.currentVersionNo, 2);
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
});

test('并发裁决：发布先提交则新版本保留，撤回仅作用指定版', async () => {
  const { sel123 } = await setupTwoVersions(); // 最新 = 2
  const sch = await call('POST', '/api/editor/schedules', {
    body: { selection: sel123, scheduledAt: secondsFromNow(60), baseVersionNo: 2 },
  });
  const no = sch.json.schedule.scheduleNo;

  // 发布先提交：预约到期先生成第 3 版
  const out = runDueSchedules(Date.now() + 120 * 1000);
  assert.strictEqual(out.published.length, 1);
  assert.strictEqual(out.published[0].versionNo, 3);

  // 之后撤回第 2 版：仅作用指定版，新版本保留且未撤回
  const ret = await call('POST', '/api/editor/versions/2/retract', { body: { reason: '旧版依据错误' } });
  assert.strictEqual(ret.status, 201);
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 3); // 访客指向新版本
  const v3 = await call('GET', '/api/public/versions/3', { token: null });
  assert.strictEqual(v3.status, 200);
  const gone = await call('GET', '/api/public/versions/2', { token: null });
  assert.strictEqual(gone.status, 404);

  const detail = await call('GET', `/api/editor/schedules/${no}`);
  assert.strictEqual(detail.json.schedule.status, 'published');
  assert.strictEqual(detail.json.schedule.resultVersionNo, 3);
});

test('撤回与出处遮盖兼容：未撤回版公开接口结构与遮盖不变', async () => {
  const { e1, e2, c1, c2 } = await (async () => {
    const e1 = await makeEvent('动员会');
    const e2 = await makeEvent('通水会');
    const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
    const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
    await makeRel(e1, e2, '二人口述一致');
    return { e1, e2, c1, c2 };
  })();
  const sel = [
    { eventId: e1, claimId: c1 },
    { eventId: e2, claimId: c2 },
  ];
  await publish(sel, 0);
  await publish(sel, 1); // 第 2 版（同内容）

  // 遮盖出处 + 撤回第 2 版
  await call('POST', '/api/editor/redaction', { body: { source: '李宝山口述', currentVersionNo: 2 } });
  await call('POST', '/api/editor/versions/2/retract', { body: { reason: '依据错误' } });

  // 未撤回的公开版本：结构不变，遮盖仍生效
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.status, 200);
  assert.strictEqual(v1.json.version.events.find((e) => e.title === '动员会').source, '出处已遮盖');
  assert.strictEqual(v1.json.version.events.find((e) => e.title === '通水会').source, '王秀兰口述');

  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
  assert.strictEqual(view.json.version.events.find((e) => e.title === '动员会').source, '出处已遮盖');
});

test('从未发布时访客提示保持原文（兼容）', async () => {
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, false);
  assert.strictEqual(view.json.message, '年表尚未发布任何版本');
});
