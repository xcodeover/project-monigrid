import React from "react";
import { getDefaultColumnWidth } from "./apiCardHelpers";
import {
    MAX_REFRESH_INTERVAL_SEC,
    MAX_WIDGET_FONT_SIZE,
    MAX_WIDGET_H,
    MAX_WIDGET_W,
    MIN_REFRESH_INTERVAL_SEC,
    MIN_WIDGET_FONT_SIZE,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
    SIZE_STEP,
} from "../pages/dashboardConstants";
import { toGridSize, toUserSize } from "./widgetUtils.js";
import WidgetSettingsModal from "./WidgetSettingsModal.jsx";
import EndpointSelect from "./EndpointSelect.jsx";

/**
 * Widget settings popup extracted from ApiCard (SRP).
 *
 * Receives every piece of state and every handler as props — owns no
 * state of its own. This makes the parent ApiCard the single source of
 * truth and lets us test the settings UI in isolation. Each section has
 * its own apply button so the shared WidgetSettingsModal wrapper is used
 * without `onApply` (footer is suppressed).
 */
const ApiCardSettingsModal = ({
    open,
    title,
    onClose,
    // Widget meta editor
    titleDraft,
    endpointDraft,
    onTitleDraftChange,
    onEndpointDraftChange,
    onWidgetMetaApply,
    // Widget size editor
    sizeDraft,
    sizeBounds,
    onSizeDraftChange,
    onSizeApply,
    // Refresh interval editor
    intervalDraft,
    onIntervalDraftChange,
    onIntervalApply,
    // Data area font size editor
    fontSizeDraft,
    onFontSizeDraftChange,
    onFontSizeApply,
    // Column visibility / width / drag
    orderedColumns,
    visibleColumns,
    localColumnWidths,
    draggingColumn,
    dragOverColumn,
    onColumnToggle,
    onColumnWidthChange,
    onColumnDragStart,
    onColumnDragEnd,
    onColumnDragOver,
    onColumnDropEvent,
    // Criteria editor
    availableColumns,
    criteriaMap,
    onCriteriaChange,
}) => {
    return (
        <WidgetSettingsModal
            open={open}
            onClose={onClose}
            title='위젯 설정'
            subtitle={title}
        >
                    <div className='settings-section'>
                        <h6>위젯 정보</h6>
                        <div className='size-editor widget-meta-editor'>
                            <label>
                                Title
                                <input
                                    type='text'
                                    value={titleDraft}
                                    onChange={(event) =>
                                        onTitleDraftChange(event.target.value)
                                    }
                                />
                            </label>
                            <label>
                                Endpoint
                                <EndpointSelect
                                    value={endpointDraft}
                                    onChange={onEndpointDraftChange}
                                />
                            </label>
                            <button
                                type='button'
                                className='size-preset-btn'
                                onClick={onWidgetMetaApply}
                            >
                                적용
                            </button>
                        </div>
                    </div>

                    <div className='settings-section'>
                        <h6>위젯 동작</h6>
                        <div className='widget-action-row'>
                            <div className='widget-action-cell'>
                                <label>크기 (W × H)</label>
                                <div className='widget-action-size'>
                                    <input
                                        type='number'
                                        min={toUserSize(sizeBounds?.minW ?? MIN_WIDGET_W)}
                                        max={toUserSize(sizeBounds?.maxW ?? MAX_WIDGET_W)}
                                        step={SIZE_STEP}
                                        value={toUserSize(sizeDraft.w)}
                                        onChange={(event) =>
                                            onSizeDraftChange((previousDraft) => ({
                                                ...previousDraft,
                                                w: toGridSize(event.target.value),
                                            }))
                                        }
                                    />
                                    <span className='widget-action-size-sep'>×</span>
                                    <input
                                        type='number'
                                        min={sizeBounds?.minH ?? MIN_WIDGET_H}
                                        max={sizeBounds?.maxH ?? MAX_WIDGET_H}
                                        value={sizeDraft.h}
                                        onChange={(event) =>
                                            onSizeDraftChange((previousDraft) => ({
                                                ...previousDraft,
                                                h: event.target.value,
                                            }))
                                        }
                                    />
                                </div>
                            </div>
                            <div className='widget-action-cell'>
                                <label>리프레시 주기 (초)</label>
                                <input
                                    type='number'
                                    min={MIN_REFRESH_INTERVAL_SEC}
                                    max={MAX_REFRESH_INTERVAL_SEC}
                                    value={intervalDraft}
                                    onChange={(event) =>
                                        onIntervalDraftChange(event.target.value)
                                    }
                                />
                            </div>
                            <div className='widget-action-cell'>
                                <label>폰트 크기 (px)</label>
                                <input
                                    type='number'
                                    min={MIN_WIDGET_FONT_SIZE}
                                    max={MAX_WIDGET_FONT_SIZE}
                                    value={fontSizeDraft}
                                    onChange={(event) =>
                                        onFontSizeDraftChange(event.target.value)
                                    }
                                />
                            </div>
                            <button
                                type='button'
                                className='size-preset-btn'
                                onClick={() => {
                                    onSizeApply();
                                    onIntervalApply();
                                    onFontSizeApply();
                                }}
                            >
                                적용
                            </button>
                        </div>
                    </div>

                    <div className='settings-section'>
                        <h6>컬럼 표시 및 너비</h6>
                        <div className='column-settings-list'>
                            {orderedColumns.map((column) => (
                                <div
                                    key={column}
                                    className={`column-setting-row ${draggingColumn === column ? "dragging" : ""} ${dragOverColumn === column ? "drag-over" : ""}`}
                                    onDragOver={(event) =>
                                        onColumnDragOver(event, column)
                                    }
                                    onDrop={(event) =>
                                        onColumnDropEvent(event, column)
                                    }
                                >
                                    <button
                                        type='button'
                                        className='column-drag-handle'
                                        aria-label={`${column} 순서 이동`}
                                        title='드래그해서 표시 순서 변경'
                                        draggable
                                        onDragStart={(event) =>
                                            onColumnDragStart(event, column)
                                        }
                                        onDragEnd={onColumnDragEnd}
                                    >
                                        ⋮⋮
                                    </button>
                                    <label className='column-toggle'>
                                        <input
                                            type='checkbox'
                                            checked={visibleColumns.includes(
                                                column,
                                            )}
                                            onChange={() =>
                                                onColumnToggle(column)
                                            }
                                        />
                                        <span>{column}</span>
                                    </label>

                                    <div className='column-width-controls'>
                                        <input
                                            type='range'
                                            min='80'
                                            max='420'
                                            step='10'
                                            value={
                                                localColumnWidths[column] ??
                                                getDefaultColumnWidth(column)
                                            }
                                            onChange={(event) =>
                                                onColumnWidthChange(
                                                    column,
                                                    event.target.value,
                                                )
                                            }
                                        />
                                        <input
                                            type='number'
                                            min='80'
                                            max='420'
                                            step='10'
                                            value={
                                                localColumnWidths[column] ??
                                                getDefaultColumnWidth(column)
                                            }
                                            onChange={(event) =>
                                                onColumnWidthChange(
                                                    column,
                                                    event.target.value,
                                                )
                                            }
                                        />
                                        <span>px</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Phase 2: criteria(임계치)는 BE 위젯 설정으로 이전됨.
                        모달은 컬럼 표시 / 너비 / 순서 등 개인 레이아웃 항목만
                        편집 가능하다. */}
                    <div className='settings-section'>
                        <h6>이상 감지 Criteria</h6>
                        <div className='criteria-settings-empty'>
                            임계치는 백엔드 설정 → <strong>위젯별 설정</strong> 탭에서
                            (data API, 표) 단위로 중앙 관리됩니다. 알람 발생 여부는 BE 가
                            평가하여 모든 사용자에게 동일하게 반영됩니다.
                        </div>
                    </div>
        </WidgetSettingsModal>
    );
};

export default ApiCardSettingsModal;
