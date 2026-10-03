#!/usr/bin/env bash
# 撤回已发布版本（version retraction）端到端调用示例。
#
# 流程：建草稿并连发两版 → 撤回第 2 版（非空原因，只追加审计记录）
#       → 访客最新年表退到第 1 版；版本清单隐藏撤回版；指定版读取 404
#       → 引用撤回版的专题路线对访客隐藏，编辑者仍可见原文与原因
#       → 重复撤回幂等（返回首次记录，不覆盖原因）；非法原因 400、未知版本 404
#       → 以撤回版为冻结基准的预约到期转冲突（不生成新版本）
#       → 即时发布仍以最高已发布版本号为基准，编号继续递增
#       → 全部撤回 → 访客显示「尚无可读版本」
#
# 依赖：curl 与 node（本应用本身就需要 node，用于解析 JSON）。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/retract-example.sh
# 可重复运行（标题与出处带时间戳，避免与历史数据互相干扰）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
# 从标准输入的 JSON 中取字段：echo "$json" | jfield 'd.retraction.versionNo'
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
get_pub() { curl -s "$@"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# 当前最高已发布版本号（编辑者视角，含撤回版）
latest_no() { get_ed "$BASE/api/editor/versions" | jfield 'd.currentVersionNo'; }

say "0) 口令检查（错误口令应 401）"
code=$(http_code -X POST "${h_json[@]}" -H 'X-Editor-Token: wrong' \
  -d '{"reason":"x"}' "$BASE/api/editor/versions/1/retract")
[ "$code" = 401 ] && echo "OK：错误口令返回 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 建草稿：先两事件发第 1 版，再补第三事件发第 2 版"
mk_event() { post "$BASE/api/editor/events" -d '{"title":"'"$1"'"}' | jfield 'd.event.id'; }
mk_claim() { post "$BASE/api/editor/events/$1/claims" -d "$2" | jfield 'd.claim.id'; }
E1=$(mk_event "撤回示例·动员会 $TS")
E2=$(mk_event "撤回示例·通水会 $TS")
C1=$(mk_claim "$E1" '{"precision":"day","year":1958,"month":9,"day":12,"source":"李宝山口述 '"$TS"'"}')
C2=$(mk_claim "$E2" '{"precision":"month","year":1959,"month":5,"source":"王秀兰口述 '"$TS"'"}')
post "$BASE/api/editor/relations" -d '{"earlierId":'"$E1"',"laterId":'"$E2"',"source":"二人口述一致 '"$TS"'"}' >/dev/null
SEL2='[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'}]'
V0=$(latest_no)
post "$BASE/api/editor/publish" -d '{"selection":'"$SEL2"',"baseVersionNo":'"$V0"',"editor":"示例脚本","note":"撤回示例首版"}' >/dev/null
V1=$(latest_no)
[ "$V1" != "$V0" ] && echo "已发布第 $V1 版（事件 E1=$E1 E2=$E2）" || { echo "FAIL：第 1 版未发布成功"; exit 1; }
# 第 2 版：补入第三事件（发布须为草稿中每个事件选定主张，故选择含全部三个事件）
E3=$(mk_event "撤回示例·抽水机到站 $TS")
C3=$(mk_claim "$E3" '{"precision":"year","year":1962,"source":"县志水利篇 '"$TS"'"}')
post "$BASE/api/editor/relations" -d '{"earlierId":'"$E2"',"laterId":'"$E3"',"source":"社员回忆 '"$TS"'"}' >/dev/null
SEL3='[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'},{"eventId":'"$E3"',"claimId":'"$C3"'}]'
post "$BASE/api/editor/publish" -d '{"selection":'"$SEL3"',"baseVersionNo":'"$V1"',"editor":"示例脚本","note":"第二版：补抽水机"}' >/dev/null
V2=$(latest_no)
[ "$V2" != "$V1" ] && echo "已发布第 $V2 版（补事件 E3=$E3）" || { echo "FAIL：第 2 版未发布成功"; exit 1; }

say "2) 基于第 $V2 版建一条专题路线（稍后验证撤回后路线对访客隐藏）"
ROUTE=$(post "$BASE/api/editor/routes" -d '{"title":"撤回示例脉络 '"$TS"'","versionNo":'"$V2"',"anchorEventIds":['"$E1"','"$E3"'],"editor":"示例脚本"}')
ROUTE_NO=$(echo "$ROUTE" | jfield 'd.route.routeNo')
echo "已建立路线 #$ROUTE_NO（据第 $V2 版）"

say "3) 撤回第 $V2 版：只追加审计记录，快照与版本号不改"
RET=$(post "$BASE/api/editor/versions/$V2/retract" \
  -d '{"reason":"「抽水机到站」编年依据错误，受访人更正为 1963 年，待重新核定","editor":"示例脚本"}')
echo "$RET" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify(d,null,2))'
[ "$(echo "$RET" | jfield 'd.alreadyRetracted')" = "false" ] && echo "OK：首次撤回"
[ "$(echo "$RET" | jfield 'd.currentVersionNo')" = "$V2" ] && echo "OK：发布基准仍是最高已发布版本号（第 $V2 版）"
[ "$(echo "$RET" | jfield 'd.latestVisibleVersionNo')" = "$V1" ] && echo "OK：访客可读版本退到第 $V1 版"
# 历史快照原文不变（编辑者持口令仍可见）
RAW_SRC=$(get_ed "$BASE/api/editor/versions/$V2/raw" | jfield 'd.version.events.find(e=>e.title.includes("抽水机")).source')
[ "$RAW_SRC" = "县志水利篇 $TS" ] && echo "OK：撤回版快照原文未改（编辑者仍可见）" || { echo "FAIL：快照被改动"; exit 1; }

say "4) 访客视图：最新年表退到第 $V1 版；清单隐藏撤回版；指定撤回版 404"
CUR=$(get_pub "$BASE/api/public/chronicle" | jfield 'd.currentVersionNo')
[ "$CUR" = "$V1" ] && echo "OK：访客最新年表 = 第 $V1 版（编号最大的未撤回版）" || { echo "FAIL：访客最新 = $CUR"; exit 1; }
LIST=$(get_pub "$BASE/api/public/versions" | jfield 'JSON.stringify(d.versions.map(v=>v.versionNo))')
[ "$LIST" = "[$V1]" ] && echo "OK：访客版本清单只余第 $V1 版" || { echo "FAIL：清单 = $LIST"; exit 1; }
code=$(http_code "$BASE/api/public/versions/$V2")
[ "$code" = 404 ] && echo "OK：访客读撤回版 → 404（按不存在处理）" || { echo "FAIL：期望 404，实际 $code"; exit 1; }

say "5) 引用撤回版的路线：访客清单隐藏、详情 404；编辑者仍可见"
CNT=$(get_pub "$BASE/api/public/routes" | jfield 'd.routes.length')
[ "$CNT" = "0" ] && echo "OK：访客路线清单已隐藏该路线" || { echo "FAIL：访客仍见 $CNT 条路线"; exit 1; }
code=$(http_code "$BASE/api/public/routes/$ROUTE_NO")
[ "$code" = 404 ] && echo "OK：访客直接访问路线 → 404" || { echo "FAIL：期望 404，实际 $code"; exit 1; }
FLAG=$(get_ed "$BASE/api/editor/routes" | jfield 'd.routes.find(r=>r.routeNo==='"$ROUTE_NO"').versionRetracted')
[ "$FLAG" = "true" ] && echo "OK：编辑者清单仍列出（versionRetracted=true）"
get_ed "$BASE/api/editor/routes/$ROUTE_NO/raw" | jfield 'd.route.routeNo' >/dev/null && echo "OK：编辑者仍可查看路线原文"
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/routes" \
  -d '{"title":"x","versionNo":'"$V2"',"anchorEventIds":['"$E1"','"$E2"']}')
[ "$code" = 409 ] && echo "OK：基于已撤回版建新路线 → 409" || { echo "FAIL：期望 409，实际 $code"; exit 1; }

say "6) 重复撤回幂等：返回首次记录，不覆盖原因"
AGAIN=$(post "$BASE/api/editor/versions/$V2/retract" -d '{"reason":"试图改写的原因","editor":"另一个人"}')
[ "$(echo "$AGAIN" | jfield 'd.alreadyRetracted')" = "true" ] && echo "OK：alreadyRetracted=true"
echo "$AGAIN" | grep -q '编年依据错误' && echo "OK：原因仍是首次记录（未被覆盖）" || { echo "FAIL：原因被覆盖"; exit 1; }
CNT=$(get_ed "$BASE/api/editor/retractions" | jfield 'd.retractions.length')
[ "$CNT" = "1" ] && echo "OK：审计记录仍只有 1 条（只追加，不重复落库）"

say "7) 非法请求：原因空 → 400；版本不存在 → 404；均不改状态"
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/versions/$V1/retract" -d '{"reason":"   "}')
[ "$code" = 400 ] && echo "OK：空原因 → 400" || { echo "FAIL：期望 400，实际 $code"; exit 1; }
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/versions/999999/retract" -d '{"reason":"x"}')
[ "$code" = 404 ] && echo "OK：版本不存在 → 404" || { echo "FAIL：期望 404，实际 $code"; exit 1; }
CUR=$(get_pub "$BASE/api/public/chronicle" | jfield 'd.currentVersionNo')
[ "$CUR" = "$V1" ] && echo "OK：上述失败均未改状态"

say "8) 以已撤回版为冻结基准的预约：到期转冲突，不生成新版本"
AT=$(node -e 'console.log(new Date(Date.now()+3000).toISOString().replace(/\.\d{3}Z$/,"Z"))')
SCH=$(post "$BASE/api/editor/schedules" -d '{"selection":'"$SEL3"',"scheduledAt":"'"$AT"'","baseVersionNo":'"$V2"',"editor":"示例脚本","note":"基准是已撤回的第 '"$V2"' 版"}')
SCH_NO=$(echo "$SCH" | jfield 'd.schedule.scheduleNo')
echo "已建立预约 #$SCH_NO（冻结基准 = 已撤回的第 $V2 版），等待到期…"
sleep 5
ST=$(get_ed "$BASE/api/editor/schedules/$SCH_NO" | jfield 'd.schedule.status')
[ "$ST" = "conflict" ] && echo "OK：到期转冲突（基准已撤回），未生成新版本" || { echo "FAIL：状态 = $ST"; exit 1; }
get_ed "$BASE/api/editor/schedules/$SCH_NO" | jfield 'd.schedule.resultMessage'
[ "$(latest_no)" = "$V2" ] && echo "OK：最高版本号仍是 $V2（未生成新版本）"

say "9) 即时发布仍以最高已发布版本号（第 $V2 版）为基准，编号继续递增"
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/publish" \
  -d '{"selection":'"$SEL3"',"baseVersionNo":'"$V1"'}')
[ "$code" = 409 ] && echo "OK：以旧基准 $V1 发布 → 409（基准含撤回版，仍是 $V2）" || { echo "FAIL：期望 409，实际 $code"; exit 1; }
post "$BASE/api/editor/publish" -d '{"selection":'"$SEL3"',"baseVersionNo":'"$V2"',"editor":"示例脚本","note":"核定后重发"}' >/dev/null
V3=$(latest_no)
echo "已发布第 $V3 版（编号在撤回版之后继续递增）"
CUR=$(get_pub "$BASE/api/public/chronicle" | jfield 'd.currentVersionNo')
[ "$CUR" = "$V3" ] && echo "OK：新版本未撤回，访客最新年表 = 第 $V3 版"

say "10) 撤回全部版本 → 访客显示「尚无可读版本」"
post "$BASE/api/editor/versions/$V1/retract" -d '{"reason":"整批编年存疑","editor":"示例脚本"}' >/dev/null
post "$BASE/api/editor/versions/$V3/retract" -d '{"reason":"整批编年存疑","editor":"示例脚本"}' >/dev/null
MSG=$(get_pub "$BASE/api/public/chronicle" | jfield 'd.message')
echo "访客提示：$MSG"
echo "$MSG" | grep -q '尚无可读版本' && echo "OK：全部撤回后显示尚无可读版本" || { echo "FAIL：提示不符"; exit 1; }
EMPTY=$(get_pub "$BASE/api/public/versions" | jfield 'd.versions.length')
[ "$EMPTY" = "0" ] && echo "OK：访客版本清单为空"

say "全部通过。审计记录见 GET $BASE/api/editor/retractions（持口令）；编辑台 http://localhost:3000/editor 可查看撤回标记与原因。"
