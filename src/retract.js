'use strict';

// 撤回已发布版本：编辑者发现某版编年依据错误时，按版本号 + 非空原因撤回整版。
//
// 数据层只在 version_retractions 追加审计记录（version_no UNIQUE，首次记录为准）：
//   - 不改写 versions / version_events / version_relations 快照，版本号不复用；
//   - 重复撤回幂等：返回首次记录（alreadyRetracted: true），不覆盖原因、不重复落库；
//   - 版本不存在 → 404；原因空 / 纯空白 / 非字符串 / 超长 → 400；均不改任何状态。
//
// 读出层效果（本模块提供判定函数，由各读出接口应用）：
//   - 访客最新年表指向编号最大的未撤回版；全部撤回 → 显示「尚无可读版本」；
//   - 访客版本清单、指定版读取、引用撤回版的专题路线均隐藏，直接访问按不存在处理；
//   - 编辑者持口令仍可查看撤回版原文（/raw）、撤回原因与相关路线。
//
// 发布 / 预约的基准仍是最高已发布版本号（含撤回版），编号继续递增（本模块不影响
// latestVersionNo）；以已撤回版为冻结基准的待执行预约到期转冲突（见 schedule.js
// processOne 事务内检查）。撤回与到期发布竞争时按事务提交顺序裁决：撤回先提交则
// 预约事务内 isRetracted(base) 为真而转冲突；发布先提交则新版本保留，撤回仅作用
// 于指定版（新版本号更高，不受影响）。

const { getDb } = require('./db');
const { latestVersionNo } = require('./publish');

const MAX_REASON_LEN = 1000; // 与出处文本上限一致

// 空 / 非字符串 / 超长拒绝；返回 trim 后的原因文本。
function normalizeReason(reason) {
  if (typeof reason !== 'string') {
    throw { status: 400, message: 'reason（撤回原因）必须是非空字符串' };
  }
  const text = reason.trim();
  if (text === '') {
    throw { status: 400, message: '撤回原因不能为空：请说明该版编年依据的错误' };
  }
  if (text.length > MAX_REASON_LEN) {
    throw { status: 400, message: `撤回原因长度不能超过 ${MAX_REASON_LEN}` };
  }
  return text;
}

function rowToApi(row) {
  if (!row) return null;
  return {
    versionNo: row.version_no,
    reason: row.reason,
    editor: row.editor,
    retractedAt: row.created_at,
  };
}

// 某版的撤回记录（首次记录）；未撤回返回 null。
function getRetraction(versionNo) {
  const row = getDb()
    .prepare('SELECT * FROM version_retractions WHERE version_no = ?')
    .get(Number(versionNo));
  return rowToApi(row);
}

function isRetracted(versionNo) {
  return (
    getDb()
      .prepare('SELECT 1 FROM version_retractions WHERE version_no = ?')
      .get(Number(versionNo)) !== undefined
  );
}

// 全部已撤回版本号集合（读出层批量判定用）。
function retractedVersionSet() {
  return new Set(
    getDb().prepare('SELECT version_no AS no FROM version_retractions').all().map((r) => r.no)
  );
}

// 编号最大的未撤回版；0 表示没有可读版本（从未发布或全部撤回）。
function latestVisibleVersionNo() {
  const row = getDb()
    .prepare(
      `SELECT MAX(version_no) AS no FROM versions
        WHERE version_no NOT IN (SELECT version_no FROM version_retractions)`
    )
    .get();
  return row.no || 0;
}

// ---------- 撤回：事务内追加审计记录（只追加） ----------
// 重复撤回幂等：返回首次记录（alreadyRetracted: true），不覆盖原因。
// 抛 { status, ...body } 表示 HTTP 错误；抛错时事务回滚，不改任何状态。
function retractVersion({ versionNo, reason, editor = '' }) {
  const no = Number(versionNo);
  if (!Number.isInteger(no) || no < 1) {
    throw { status: 400, message: '版本号必须是正整数' };
  }
  const reasonText = normalizeReason(reason);

  const db = getDb();
  const tx = db.transaction(() => {
    const version = db.prepare('SELECT version_no FROM versions WHERE version_no = ?').get(no);
    if (!version) {
      throw { status: 404, message: `版本 ${no} 不存在，未撤回任何版本` };
    }
    const existing = getRetraction(no);
    if (existing) {
      // 重复撤回：返回首次记录，不覆盖原因、不重复落库
      return { alreadyRetracted: true, retraction: existing };
    }
    db.prepare('INSERT INTO version_retractions (version_no, reason, editor) VALUES (?, ?, ?)').run(
      no,
      reasonText,
      String(editor || '')
    );
    return { alreadyRetracted: false, retraction: getRetraction(no) };
  });
  const out = tx();

  return {
    ok: true,
    ...out,
    // 发布基准（最高已发布版本号，含撤回版）与访客当前可读版本
    currentVersionNo: latestVersionNo(),
    latestVisibleVersionNo: latestVisibleVersionNo(),
  };
}

// 撤回审计清单（编辑者查看，含原因原文）。
function listRetractions() {
  return getDb()
    .prepare('SELECT * FROM version_retractions ORDER BY version_no DESC')
    .all()
    .map(rowToApi);
}

module.exports = {
  MAX_REASON_LEN,
  retractVersion,
  getRetraction,
  isRetracted,
  retractedVersionSet,
  latestVisibleVersionNo,
  listRetractions,
};
