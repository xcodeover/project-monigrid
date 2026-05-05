import "./DirtyListSummary.css";

/**
 * Bottom summary bar for batch-save modals. Shows dirty count breakdown,
 * validation status, and an optional primary "저장 & 적용" button.
 *
 * Pass `hideSaveButton` when the save action is handled by a parent modal
 * (pattern A — shared footer button). In that case only the summary text
 * and validation badge are rendered.
 */
const DirtyListSummary = ({
    count,           // { creates, updates, deletes, total }
    isValid,
    invalidCount,
    isSaving,
    onSave,
    saveLabel = "저장 & 적용",
    hideSaveButton = false,
}) => {
    const hasChanges = count.total > 0;
    const hasInvalid = invalidCount > 0;

    let summaryText;
    if (!hasChanges) {
        summaryText = "변경 사항 없음";
    } else {
        const parts = [];
        if (count.creates > 0) parts.push(`${count.creates} 신규`);
        if (count.updates > 0) parts.push(`${count.updates} 수정`);
        if (count.deletes > 0) parts.push(`${count.deletes} 삭제`);
        summaryText = `변경 사항: ${parts.join(" / ")}`;
    }

    return (
        <div className='dirty-list-summary'>
            <span
                className={
                    "dls-summary-text" +
                    (!hasChanges ? " dls-summary-empty" : "")
                }
            >
                {summaryText}
            </span>
            {hasInvalid && (
                <span className='dls-invalid-badge'>
                    {invalidCount}개 항목에 오류
                </span>
            )}
            {!hideSaveButton && (
                <button
                    type='button'
                    className='dls-save-btn'
                    onClick={onSave}
                    disabled={!hasChanges || isSaving}
                >
                    {isSaving ? "저장 중…" : saveLabel}
                </button>
            )}
        </div>
    );
};

export default DirtyListSummary;
