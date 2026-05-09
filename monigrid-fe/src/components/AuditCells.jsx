/**
 * 백엔드 설정 그리드의 "수정 시각" / "편집자" 셀 렌더러.
 *
 * BE 응답: updated_at 은 UTC ISO8601 ('2026-05-09T05:23:14Z'), 또는 null.
 *          updated_by 는 string 또는 null.
 *
 * 표시 규칙:
 *   - null/missing → '—'
 *   - updated_at → 사용자 로컬 타임존으로 'YYYY-MM-DD HH:mm'
 *   - title 호버 → 원본 ISO 문자열 (정확한 초·타임존 확인용)
 */

const _DATE_FMT = new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
});

export const formatLocalDateTime = (isoUtc) => {
    if (!isoUtc) return "—";
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return String(isoUtc);
    // Intl 출력 'YYYY/MM/DD, HH:mm' 또는 'YYYY. MM. DD. HH:mm' 등 → 'YYYY-MM-DD HH:mm'
    return _DATE_FMT.format(d).replace(/[/.]/g, "-").replace(",", "").replace(/\s+/g, " ").trim();
};

const AuditCells = ({ updatedAt, updatedBy }) => (
    <>
        <span className="cfg-grid-audit-time" title={updatedAt || ""}>
            {formatLocalDateTime(updatedAt)}
        </span>
        <span className="cfg-grid-audit-user" title={updatedBy || ""}>
            {updatedBy || "—"}
        </span>
    </>
);

export default AuditCells;
