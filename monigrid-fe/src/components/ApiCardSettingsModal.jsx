import React from "react";
import { createPortal } from "react-dom";
import { getDefaultColumnWidth } from "./apiCardHelpers";
import { MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC } from "../pages/dashboardConstants";

/**
 * Widget settings popup extracted from ApiCard (SRP).
 *
 * Receives every piece of state and every handler as props — owns no
 * state of its own. This makes the parent ApiCard the single source of
 * truth and lets us test the settings UI in isolation.
 */
const ApiCardSettingsModal = ({
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
    return createPortal(
        <div className='settings-overlay'>
            <div
                className='settings-popup'
                onClick={(event) => event.stopPropagation()}
            >
                <div className='settings-popup-header'>
                    <div>
                        <h5>위젯 설정</h5>
                        <p>{title}</p>
                    </div>
                    <button
                        type='button'
                        className='close-settings-btn'
                        onClick={onClose}
                    >
                        ✕
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
                                    onChange={(event) =>
                                        onTitleDraftChange(event.target.value)
                                    }
                                />
                            </label>
                            <label>
                                Endpoint
                                <input
                                    type='text'
                                    value={endpointDraft}
                                    onChange={(event) =>
                                        onEndpointDraftChange(event.target.value)
                                    }
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
                                        onChange={(event) =>
                                            onSizeDraftChange((previousDraft) => ({
                                                ...previousDraft,
                                                w: event.target.value,
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
                                        onChange={(event) =>
                                            onSizeDraftChange((previousDraft) => ({
                                                ...previousDraft,
                                                h: event.target.value,
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
                            <h6>API 리프레시 주기 (초)</h6>
                            <div className='refresh-interval-editor'>
                                <label className='refresh-interval-input-label'>
                                    <span>Interval</span>
                                    <input
                                        type='number'
                                        min={MIN_REFRESH_INTERVAL_SEC}
                                        max={MAX_REFRESH_INTERVAL_SEC}
                                        value={intervalDraft}
                                        onChange={(event) =>
                                            onIntervalDraftChange(event.target.value)
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

                    <div className='settings-section'>
                        <h6>이상 감지 Criteria (컬럼별)</h6>
                        <div className='criteria-settings-list'>
                            {availableColumns.map((column) => {
                                const criteria = criteriaMap[column] ?? {
                                    enabled: false,
                                    operator: ">=",
                                    value: "",
                                };

                                return (
                                    <div
                                        key={`${column}-criteria`}
                                        className='criteria-setting-row'
                                    >
                                        <label className='criteria-column-label'>
                                            <input
                                                type='checkbox'
                                                checked={!!criteria.enabled}
                                                onChange={(event) =>
                                                    onCriteriaChange(column, {
                                                        enabled:
                                                            event.target
                                                                .checked,
                                                    })
                                                }
                                            />
                                            <span>{column}</span>
                                        </label>

                                        <select
                                            value={criteria.operator ?? ">="}
                                            onChange={(event) =>
                                                onCriteriaChange(column, {
                                                    operator:
                                                        event.target.value,
                                                })
                                            }
                                        >
                                            <option value='>'>&gt;</option>
                                            <option value='>='>&gt;=</option>
                                            <option value='<'>&lt;</option>
                                            <option value='<='>&lt;=</option>
                                            <option value='=='>==</option>
                                            <option value='!='>!=</option>
                                            <option value='contains'>
                                                contains
                                            </option>
                                            <option value='not_contains'>
                                                not_contains
                                            </option>
                                        </select>

                                        <input
                                            type='text'
                                            value={criteria.value ?? ""}
                                            onChange={(event) =>
                                                onCriteriaChange(column, {
                                                    value: event.target.value,
                                                })
                                            }
                                            placeholder='임계값'
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default ApiCardSettingsModal;
