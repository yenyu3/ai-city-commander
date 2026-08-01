"""Builds the "交控中心建議書" (traffic control center recommendation report)
required by the competition brief's 必做 "自動化指令產出" task, and writes it
(both JSON and PDF) to S3 -- the exact keys report/handler.py polls for
(data/api.md §3).

Called only from decision_routing.run_incident_flow -- the incident API
entry (POST /api/incidents -> worker, `mode="incident"`), once ALL of an
event's SOP checks have finished (not per-check -- see run_incident_flow's
docstring for why a per-check write was wrong: an incident tripping more
than one SOP article, e.g. §2 accident + §5 signal_failure both firing,
clobbered its own report on the second write, since both used the same
key). The decision API's city sweep (run_worker_phases) never calls this --
decision-vs-incident is decided by which API invoked the worker (see
decision_routing.py).

2026-08-01: content is now `government`/`citizen`/`decisions` -- the SAME
serialized shape decision_item_json()/summary_json() produce for
GET /api/decisions (per the user's direction that this incident's report/
notice should look exactly like what the decisions API would return if this
incident were the only thing in the sweep), not a hand-rolled thinner shape
with just `classification`/`reasoning`. This also means the report now
carries reasoningSteps/recommendedActions/estimatedRecovery/reroute/
signalCoordination/crossSystemCoordination per triggered SOP article, not
just a raw Decision.result dump.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

import s3_common
from rules.types import LiveIncident


def build_and_save_report(
    *,
    incident: LiveIncident,
    scenario_at: datetime,
    government: dict[str, Any],
    citizen: dict[str, Any],
    decisions: list[dict[str, Any]],
) -> None:
    date = incident.timestamp.split("T")[0].split(" ")[0]
    report: dict[str, Any] = {
        "eventId": incident.event_id,
        "generatedAt": scenario_at.isoformat(),
        "incident": {
            "type": incident.type,
            "location": incident.location,
            "affectedSegment": incident.affected_segment,
            "status": incident.status,
            "severity": incident.severity,
            "description": incident.description,
        },
        "focus": {"locationId": incident.affected_segment},
        "government": government,
        "citizen": citizen,
        "decisions": decisions,
    }
    key_base = f"emergency-reports/{date}/{incident.event_id}/report-v1"
    s3_common.client().put_object(
        Bucket=s3_common.internal_bucket(),
        Key=f"{key_base}.json",
        Body=json.dumps(report, ensure_ascii=False, indent=2).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
    )
    s3_common.client().put_object(
        Bucket=s3_common.internal_bucket(),
        Key=f"{key_base}.pdf",
        Body=_render_pdf(incident, report),
        ContentType="application/pdf",
    )


def _render_pdf(incident: LiveIncident, report: dict[str, Any]) -> bytes:
    """Renders the same government-facing content as the JSON report (one
    section per triggered SOP article, full reasoning/actions/coordination)
    into a PDF -- report/handler.py's `format=pdf` used to stay perpetually
    "processing" because nothing ever wrote this key. reportlab is
    pure-Python (no system-level binary dependency like wkhtmltopdf), which
    matters since every per-service Lambda installs from the same shared
    requirements.txt. Uses reportlab's built-in STSong-Light CID font (no
    external .ttf/.ttc font FILE needed, so nothing to bundle into the
    Lambda image) -- the default Helvetica base font has no CJK glyphs at
    all and silently renders every Chinese character as a blank box
    (caught live: a real generated PDF was legible for the English/numeric
    parts but every 中文 character was an unreadable ■).

    2026-08-01: layout pass -- the first version was one undifferentiated
    font size top to bottom, no color, no section separation; every SOP
    article's block ran straight into the next with no visual break, and
    key numbers (ETE, SOP references) didn't stand out from prose. Now uses
    a colored title band, an info card for incident metadata, a horizontal
    rule + colored SOP-tag per section, a real bullet list for actions
    (not a semicolon-joined run-on sentence), and page numbers."""
    import io

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import (
        HRFlowable,
        ListFlowable,
        ListItem,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    font_name = "STSong-Light"
    if font_name not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(UnicodeCIDFont(font_name))

    navy = colors.HexColor("#1a2b4a")
    accent = colors.HexColor("#c0392b")
    slate = colors.HexColor("#4a5568")
    pale = colors.HexColor("#f4f6f8")

    styles = {
        "title": ParagraphStyle("title", fontName=font_name, fontSize=20, leading=26, textColor=colors.white),
        "titleSub": ParagraphStyle("titleSub", fontName=font_name, fontSize=10, leading=14, textColor=colors.white),
        "meta": ParagraphStyle("meta", fontName=font_name, fontSize=9, leading=14, textColor=slate),
        "sectionLabel": ParagraphStyle(
            "sectionLabel", fontName=font_name, fontSize=12, leading=16, textColor=colors.white,
        ),
        "sopTag": ParagraphStyle(
            "sopTag", fontName=font_name, fontSize=10, leading=14, textColor=colors.white,
        ),
        "itemTitle": ParagraphStyle("itemTitle", fontName=font_name, fontSize=13, leading=18, textColor=navy),
        "body": ParagraphStyle("body", fontName=font_name, fontSize=10, leading=15, textColor=colors.HexColor("#1f2937")),
        "label": ParagraphStyle("label", fontName=font_name, fontSize=9, leading=13, textColor=slate),
        "stat": ParagraphStyle("stat", fontName=font_name, fontSize=14, leading=18, textColor=accent),
        "bullet": ParagraphStyle("bullet", fontName=font_name, fontSize=10, leading=15, textColor=colors.HexColor("#1f2937")),
    }

    import re

    # STSong-Light is a GB2312-derived CID font: it covers CJK, ASCII, and
    # common math/arrow symbols (≥ ≤ → etc. all render fine), but has no
    # glyphs for Dingbats/emoji (✓ ✔ ☑ ❌ and friends) or their variation
    # selectors -- those silently render as tofu boxes. Caught live: LLM
    # narrative text sprinkles ✔️-style checkmarks into SOP condition
    # checklists, each showing up as a pair of boxes (the emoji + its
    # variation selector) right before the "通過" text that already states
    # the same thing in words, so dropping them loses no information.
    _UNSUPPORTED_SYMBOLS = re.compile(
        "[\U0001F000-\U0001FFFF☀-➿︀-️⬀-⯿]"
    )
    # LLM output also uses a plain "•" (U+2022) as an inline list marker
    # between items (e.g. "\n• RD_TPE_004..."); that's General Punctuation,
    # outside the range above, and STSong-Light doesn't have it either --
    # swap it for a plain hyphen instead of dropping it, since here it's
    # doing real list-marker work, not decoration.
    _BULLET = re.compile("[•‣◦▪▫]")

    def esc(text: Any) -> str:
        cleaned = _UNSUPPORTED_SYMBOLS.sub("", str(text))
        cleaned = _BULLET.sub("-", cleaned)
        return cleaned.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def hr(color=colors.HexColor("#d1d5db"), thickness=0.75) -> HRFlowable:
        return HRFlowable(width="100%", thickness=thickness, color=color, spaceBefore=4, spaceAfter=8)

    flow: list[Any] = []

    # --- Title band -----------------------------------------------------
    title_table = Table(
        [[Paragraph(f"交控中心建議書 <font size=11>Traffic Control Recommendation</font>", styles["title"])],
         [Paragraph(f"事件編號 {esc(incident.event_id)}", styles["titleSub"])]],
        colWidths=[17 * cm],
    )
    title_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), navy),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (0, 0), 12),
        ("BOTTOMPADDING", (1, 0), (1, 0), 12),
        ("TOPPADDING", (1, 0), (1, 0), 0),
    ]))
    flow.append(title_table)
    flow.append(Spacer(1, 0.5 * cm))

    # --- Incident info card ----------------------------------------------
    info_rows = [
        [Paragraph("事件地點", styles["label"]), Paragraph(esc(incident.location), styles["body"])],
        [Paragraph("事件類型", styles["label"]), Paragraph(esc(incident.type), styles["body"])],
        [Paragraph("嚴重等級", styles["label"]), Paragraph(esc(incident.severity), styles["body"])],
        [Paragraph("受影響路段/站點", styles["label"]), Paragraph(esc(incident.affected_segment), styles["body"])],
        [Paragraph("報告產生時間", styles["label"]), Paragraph(esc(report["generatedAt"]), styles["body"])],
    ]
    info_table = Table(info_rows, colWidths=[3.5 * cm, 13.5 * cm])
    info_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), pale),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    flow.append(info_table)
    flow.append(Spacer(1, 0.6 * cm))

    # --- Overall assessment ----------------------------------------------
    flow.append(Paragraph("整體研判", styles["itemTitle"]))
    flow.append(hr(navy, 1.5))
    flow.append(Paragraph(f"<b>{esc(report['government']['headline'])}</b>", styles["body"]))
    flow.append(Spacer(1, 0.15 * cm))
    flow.append(Paragraph(esc(report["government"]["text"]), styles["body"]))
    flow.append(Spacer(1, 0.6 * cm))

    # --- Per-SOP-article sections -----------------------------------------
    for item in report["decisions"]:
        sop_band = Table(
            [[Paragraph(esc(item["title"]), styles["sectionLabel"]),
              Paragraph(f"SOP §{esc(item['sopSectionId'])}", styles["sopTag"])]],
            colWidths=[13.5 * cm, 3.5 * cm],
        )
        sop_band.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), slate),
            ("BACKGROUND", (1, 0), (1, 0), accent),
            ("LEFTPADDING", (0, 0), (0, 0), 10),
            ("ALIGN", (1, 0), (1, 0), "CENTER"),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
        flow.append(sop_band)
        flow.append(Spacer(1, 0.25 * cm))
        flow.append(Paragraph(esc(item["summary"]["aiText"]), styles["body"]))
        flow.append(Spacer(1, 0.2 * cm))

        if item["recommendedActions"]:
            flow.append(Paragraph("建議行動", styles["label"]))
            flow.append(ListFlowable(
                [ListItem(Paragraph(esc(a), styles["bullet"]), bulletColor=accent) for a in item["recommendedActions"]],
                bulletType="bullet", start="•", leftIndent=14,
            ))
            flow.append(Spacer(1, 0.15 * cm))

        stat_cells = []
        if item["estimatedRecovery"]:
            stat_cells.append(Paragraph(f"預計恢復時間<br/><b>{esc(item['estimatedRecovery']['ete'])} 分鐘</b>", styles["stat"]))
        if item["reroute"] and item["reroute"].get("mainRoute"):
            stat_cells.append(Paragraph(f"主疏散路徑<br/><b>{esc(item['reroute']['mainRoute'])}</b>", styles["stat"]))
        if stat_cells:
            stat_table = Table([stat_cells], colWidths=[17 / max(len(stat_cells), 1) * cm] * len(stat_cells))
            stat_table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), pale),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]))
            flow.append(stat_table)

        flow.append(Spacer(1, 0.5 * cm))

    def _footer(canvas, doc_) -> None:
        canvas.saveState()
        canvas.setFont(font_name, 8)
        canvas.setFillColor(slate)
        canvas.drawString(2 * cm, 1.2 * cm, f"eventId: {incident.event_id}")
        canvas.drawRightString(A4[0] - 2 * cm, 1.2 * cm, f"第 {doc_.page} 頁")
        canvas.restoreState()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, topMargin=1.5 * cm, bottomMargin=2 * cm, leftMargin=2 * cm, rightMargin=2 * cm,
    )
    doc.build(flow, onFirstPage=_footer, onLaterPages=_footer)
    return buf.getvalue()
