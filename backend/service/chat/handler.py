"""POST /api/chat — fixed audience-safe demo answers."""

from datetime import datetime, timezone
import json


DEFAULT_SCENARIO_AT = "2026-05-20T21:00:00+08:00"


def handler(event, _context):
    try:
        request = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        request = {}
    context = request.get("context", {})
    scenario_at = context.get("scenarioAt") or DEFAULT_SCENARIO_AT
    is_public = context.get("audience") == "public"
    answer = {"messageId": "MSG_002" if is_public else "MSG_001", "text": "國父紀念館站目前人潮較多，建議預留額外時間，或改由鄰近站點進出。" if is_public else "符合捷運分流門檻，建議北捷過站不停、調度接駁專車，並引導群眾步行至鄰近站點。", "createdAt": scenario_at}
    if not is_public:
        answer.update({
            "ruleResult": {
                "rule": "checkMrtDiversion",
                "triggered": True,
                "input": {"userCount": 26000, "growthRate": 0.35},
            },
            "sopRefs": ["SOP §3"],
            "reasoningSteps": [
                {
                    "order": 1,
                    "status": "info",
                    "title": "取得情境輸入",
                    "detail": "BL17 人數 26,000 人，成長率 0.35。",
                },
                {
                    "order": 2,
                    "status": "pass",
                    "title": "檢核捷運分流門檻",
                    "detail": "User_Count 26,000 > 25,000，且 Growth_Rate 0.35 > 0.30。",
                    "sopRef": "SOP §3",
                },
                {
                    "order": 3,
                    "status": "final",
                    "title": "產出捷運分流建議",
                    "detail": "建議北捷過站不停、調度接駁專車，並引導群眾步行至 BS_MRT_BL18。",
                    "sopRef": "SOP §3",
                },
            ],
        })
    payload = {"meta": {"scenarioAt": scenario_at, "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"), "dataMode": "demo"}, "answer": answer}
    return {"statusCode": 200, "headers": {"content-type": "application/json; charset=utf-8"}, "body": json.dumps(payload, ensure_ascii=False)}
