import { createPortal } from "react-dom";
import { MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC } from "../pages/dashboardConstants";
import MonitorTargetPicker from "./MonitorTargetPicker";
import { IconClose } from "./icons";

/**
 * ServerResource widget settings modal.
 *
 * 위젯 자체에서 호스트/자격증명을 직접 입력하는 legacy UI 는 제거되었고,
 * 백엔드 설정의 "서버/네트워크 체크" 탭에 등록된 대상 중에서만 선택한다.
 *
 * NOTE: Does not close on outside click — only the ✕ button. Prevents
 * losing in-progress edits to selection.
 */

const ServerResourceSettingsModal = ({
    title,
    onClose,
    // Title editor
    titleDraft,
    onTitleDraftChange,
    onTitleApply,
    // Size editor
    sizeDraft,
    sizeBounds,
    onSizeDraftChange,
    onSizeApply,
    // Interval editor
    intervalDraft,
    onIntervalDraftChange,
    onIntervalApply,
    // Target selection
    selectedTargetIds,
    onSelectedTargetIdsChange,
    onSave,
}) => {
    return createPortal(
        <div
            className='settings-overlay'
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
        >
            <div
                className='settings-popup srv-settings-popup'
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
            >
                <div className='settings-popup-header'>
                    <div>
                        <h5>서버 리소스 위젯 설정</h5>
                        <p>{title}</p>
                    </div>
                    <button
                        type='button'
                        className='close-settings-btn'
                        onClick={onClose}
                    >
                        <IconClose size={14} />
                    </button>
                </div>
                <div className='settings-popup-body'>
                    <div className='settings-section'>
                        <h6>위젯 정보</h6>
                        <div className='size-editor widget-meta-editor'>
                            <label>
                                Title
                                <input
                                    type='text'
                                    value={titleDraft}
                                    onChange={(e) =>
                                        onTitleDraftChange(e.target.value)
                                    }
                                />
                            </label>
                            <button
                                type='button'
                                className='size-preset-btn'
                                onClick={onTitleApply}
                            >
                                적용
                            </button>
                        </div>
                    </div>
                    <div className='settings-inline-row'>
                        <div className='settings-section'>
                            <h6>위젯 크기</h6>
                            <div className='size-editor widget-size-editor'>
                                <label>
                                    Width
                                    <input
                                        type='number'
                                        min={sizeBounds?.minW ?? 2}
                                        max={sizeBounds?.maxW ?? 12}
                                        value={sizeDraft.w}
                                        onChange={(e) =>
                                            onSizeDraftChange((p) => ({
                                                ...p,
                                                w: e.target.value,
                                            }))
                                        }
                                    />
                                </label>
                                <label>
                                    Height
                                    <input
                                        type='number'
                                        min={sizeBounds?.minH ?? 2}
                                        max={sizeBounds?.maxH ?? 24}
                                        value={sizeDraft.h}
                                        onChange={(e) =>
                                            onSizeDraftChange((p) => ({
                                                ...p,
                                                h: e.target.value,
                                            }))
                                        }
                                    />
                                </label>
                                <button
                                    type='button'
                                    className='size-preset-btn'
                                    onClick={onSizeApply}
                                >
                                    적용
                                </button>
                            </div>
                        </div>
                        <div className='settings-section refresh-interval-section'>
                            <h6>갱신 주기 (초)</h6>
                            <div className='refresh-interval-editor'>
                                <label className='refresh-interval-input-label'>
                                    <span>Interval</span>
                                    <input
                                        type='number'
                                        min={MIN_REFRESH_INTERVAL_SEC}
                                        max={MAX_REFRESH_INTERVAL_SEC}
                                        value={intervalDraft}
                                        onChange={(e) =>
                                            onIntervalDraftChange(e.target.value)
                                        }
                                    />
                                </label>
                                <button
                                    type='button'
                                    className='size-preset-btn'
                                    onClick={onIntervalApply}
                                >
                                    적용
                                </button>
                            </div>
                        </div>
                    </div>
                    <div className='settings-section srv-list-section'>
                        <div className='srv-list-header'>
                            <h6>대상 선택 ({selectedTargetIds.length}개)</h6>
                        </div>
                        <MonitorTargetPicker
                            targetType='server_resource'
                            selectedIds={selectedTargetIds}
                            onChange={onSelectedTargetIdsChange}
                        />
                    </div>
                </div>
                <div className='srv-settings-footer'>
                    <button
                        type='button'
                        className='size-preset-btn'
                        onClick={onClose}
                    >
                        취소
                    </button>
                    <button
                        type='button'
                        className='size-preset-btn srv-save-btn'
                        onClick={onSave}
                    >
                        저장 ({selectedTargetIds.length}개)
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default ServerResourceSettingsModal;
