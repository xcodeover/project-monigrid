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
    const parts = Object.fromEntries(
        _DATE_FMT.formatToParts(d).map((p) => [p.type, p.value])
    );
    // hour는 24h 모드에서 '24'를 돌려주는 브라우저가 있어 정규화
    const hh = parts.hour === "24" ? "00" : (parts.hour || "00");
    return `${parts.year}-${parts.month}-${parts.day} ${hh}:${parts.minute || "00"}`;
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
