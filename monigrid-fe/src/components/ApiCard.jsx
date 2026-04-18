import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import {
    countRowsMatchingCriteria,
    getEnabledCriteriaColumns,
} from "../utils/helpers";
import DynamicTable from "./DynamicTable";
import {
    clamp,
    formatInterval,
    formatLocalTime,
    getAllColumns,
    getDefaultColumnWidth,
    normalizeData,
    reorderItems,
} from "./apiCardHelpers";
import { MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC } from "../pages/dashboardConstants";
import ApiCardRowDetailModal from "./ApiCardRowDetailModal";
import ApiCardSettingsModal from "./ApiCardSettingsModal";
import "./ApiCard.css";

const ApiCard = ({
    title,
    endpoint,
    data,
    loading,
    error,
    apiStatus,
    onRemove,
    onRefresh,
    currentSize,
    sizeBounds,
    onSizeChange,
    refreshIntervalSec,
    onRefreshIntervalChange,
    onWidgetMetaChange,
    widgetFontSize,
    tableSettings,
    onTableSettingsChange,
}) => {
    const [showSettings, setShowSettings] = useState(false);
    const [sizeDraft, setSizeDraft] = useState({ w: 4, h: 4 });
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? 5);
    const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
    const [selectedRow, setSelectedRow] = useState(null);
    const [clipboardRow, setClipboardRow] = useState(null);
    const [showAlertsOnly, setShowAlertsOnly] = useState(false);
    const [draggingColumn, setDraggingColumn] = useState(null);
    const [dragOverColumn, setDragOverColumn] = useState(null);
    const [titleDraft, setTitleDraft] = useState(title);
    const [endpointDraft, setEndpointDraft] = useState(endpoint);

    const dataRows = useMemo(() => normalizeData(data), [data]);
    const detectedColumns = useMemo(() => getAllColumns(data), [data]);
    const savedVisibleColumns = tableSettings?.visibleColumns ?? [];
    const availableColumns = useMemo(() => {
        const mergedColumns = new Set([
            ...savedVisibleColumns,
            ...detectedColumns,
        ]);
        return Array.from(mergedColumns);
    }, [detectedColumns, savedVisibleColumns]);

    const orderedColumns = useMemo(() => {
        const visibleSet = new Set(savedVisibleColumns);
        const visibleOrdered = savedVisibleColumns.filter((column) =>
            availableColumns.includes(column),
        );
        const hiddenColumns = availableColumns.filter(
            (column) => !visibleSet.has(column),
        );

        return [...visibleOrdered, ...hiddenColumns];
    }, [availableColumns, savedVisibleColumns]);

    useEffect(() => {
        if (detectedColumns.length === 0) return;

        const saved = tableSettings?.visibleColumns ?? [];

        // 초기 상태: 저장된 컬럼 없음 → detectedColumns 그대로 저장
        if (saved.length === 0) {
            onTableSettingsChange({ visibleColumns: detectedColumns });
            return;
        }

        // 백엔드 데이터셋에서 사라진 컬럼이 있으면 자동 갱신
        const hasDisappearedColumns = saved.some(
            (col) => !detectedColumns.includes(col),
        );
        if (hasDisappearedColumns) {
            // 살아남은 컬럼은 기존 순서 유지, 신규 컬럼은 뒤에 추가
            const surviving = saved.filter((col) =>
                detectedColumns.includes(col),
            );
            const newCols = detectedColumns.filter(
                (col) => !saved.includes(col),
            );
            onTableSettingsChange({
                visibleColumns: [...surviving, ...newCols],
            });
        }
    }, [detectedColumns, onTableSettingsChange, tableSettings?.visibleColumns]);

    const visibleColumns =
        tableSettings?.visibleColumns && tableSettings.visibleColumns.length > 0
            ? tableSettings.visibleColumns.filter((column) =>
                  availableColumns.includes(column),
              )
            : availableColumns;

    useEffect(() => {
        setSizeDraft({
            w: currentSize?.w ?? 4,
            h: currentSize?.h ?? 4,
        });
    }, [currentSize?.w, currentSize?.h]);

    useEffect(() => {
        setIntervalDraft(refreshIntervalSec ?? 5);
    }, [refreshIntervalSec]);

    useEffect(() => {
        if (data != null) {
            setLastUpdatedAt(new Date());
        }
    }, [data]);

    useEffect(() => {
        setTitleDraft(title);
    }, [title]);

    useEffect(() => {
        setEndpointDraft(endpoint);
    }, [endpoint]);

    const columnWidths = tableSettings?.columnWidths ?? {};
    const [localColumnWidths, setLocalColumnWidths] = useState(columnWidths);
    const columnWidthTimerRef = useRef(null);

    // Sync local widths when external tableSettings change (e.g., from store load)
    useEffect(() => {
        setLocalColumnWidths(tableSettings?.columnWidths ?? {});
    }, [tableSettings?.columnWidths]);

    const criteriaMap = tableSettings?.criteria ?? {};
    const rowCount = dataRows.length;
    const enabledCriteriaColumns = useMemo(
        () => getEnabledCriteriaColumns(criteriaMap),
        [criteriaMap],
    );

    const alertCount = useMemo(() => {
        if (enabledCriteriaColumns.length === 0 || dataRows.length === 0) {
            return 0;
        }

        return countRowsMatchingCriteria(dataRows, criteriaMap);
    }, [criteriaMap, dataRows, enabledCriteriaColumns.length]);

    useEffect(() => {
        if (alertCount === 0) {
            setShowAlertsOnly(false);
        }
    }, [alertCount]);

    useEffect(() => {
        if (enabledCriteriaColumns.length === 0) {
            setShowAlertsOnly(false);
        }
    }, [enabledCriteriaColumns.length]);

    const statusLabel = loading
        ? "loading"
        : apiStatus === "dead"
          ? "dead"
          : apiStatus === "slow-live"
            ? "slow-live"
            : "live";

    const statusText = statusLabel === "slow-live" ? "live" : statusLabel;

    const handleColumnToggle = (column) => {
        const nextVisibleColumns = visibleColumns.includes(column)
            ? visibleColumns.filter((item) => item !== column)
            : [...visibleColumns, column];

        onTableSettingsChange({ visibleColumns: nextVisibleColumns });
    };

    const handleColumnDragStart = (event, column) => {
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", column);
        }
        setDraggingColumn(column);
        setDragOverColumn(column);
    };

    const handleColumnDrop = (targetColumn) => {
        if (!draggingColumn || draggingColumn === targetColumn) {
            setDraggingColumn(null);
            setDragOverColumn(null);
            return;
        }

        const fromIndex = orderedColumns.indexOf(draggingColumn);
        const toIndex = orderedColumns.indexOf(targetColumn);
        const reorderedColumns = reorderItems(
            orderedColumns,
            fromIndex,
            toIndex,
        );
        const nextVisibleColumns = reorderedColumns.filter((column) =>
            visibleColumns.includes(column),
        );

        onTableSettingsChange({ visibleColumns: nextVisibleColumns });
        setDraggingColumn(null);
        setDragOverColumn(null);
    };

    const handleColumnDragEnd = () => {
        setDraggingColumn(null);
        setDragOverColumn(null);
    };

    const handleColumnDragOver = (event, column) => {
        event.preventDefault();

        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
        }

        if (dragOverColumn !== column) {
            setDragOverColumn(column);
        }
    };

    const handleColumnDropEvent = (event, column) => {
        event.preventDefault();
        handleColumnDrop(column);
    };

    const handleColumnWidthChange = useCallback((column, width) => {
        const nextWidth = Number(width);
        const resolvedWidth = Number.isNaN(nextWidth)
            ? getDefaultColumnWidth(column)
            : nextWidth;

        // Update local state immediately for responsive UI
        setLocalColumnWidths((prev) => ({ ...prev, [column]: resolvedWidth }));

        // Debounce the store update to avoid flooding API calls
        if (columnWidthTimerRef.current) {
            clearTimeout(columnWidthTimerRef.current);
        }
        columnWidthTimerRef.current = setTimeout(() => {
            onTableSettingsChange({
                columnWidths: {
                    ...columnWidths,
                    [column]: resolvedWidth,
                },
            });
            columnWidthTimerRef.current = null;
        }, 300);
    }, [columnWidths, onTableSettingsChange]);

    useEffect(() => {
        if (availableColumns.length === 0) {
            return;
        }

        const nextWidths = { ...columnWidths };
        let changed = false;

        availableColumns.forEach((column) => {
            if (!Number.isFinite(Number(nextWidths[column]))) {
                nextWidths[column] = getDefaultColumnWidth(column);
                changed = true;
            }
        });

        if (changed) {
            setLocalColumnWidths(nextWidths);
            onTableSettingsChange({ columnWidths: nextWidths });
        }
    }, [availableColumns]); // only run when columns change, not on every width update

    const criteriaTimerRef = useRef(null);

    // 디바운스 setTimeout — 위젯이 디바운스 윈도우 안에서 언마운트되면
    // 콜백이 살아남아 unmounted 컴포넌트에 setState를 호출하므로 정리한다.
    useEffect(() => {
        return () => {
            if (columnWidthTimerRef.current) {
                clearTimeout(columnWidthTimerRef.current);
                columnWidthTimerRef.current = null;
            }
            if (criteriaTimerRef.current) {
                clearTimeout(criteriaTimerRef.current);
                criteriaTimerRef.current = null;
            }
        };
    }, []);

    const handleCriteriaChange = useCallback((column, patch) => {
        const nextCriteria = {
            ...criteriaMap,
            [column]: {
                enabled: criteriaMap[column]?.enabled ?? false,
                operator: criteriaMap[column]?.operator ?? ">=",
                value: criteriaMap[column]?.value ?? "",
                ...patch,
            },
        };

        if (criteriaTimerRef.current) {
            clearTimeout(criteriaTimerRef.current);
        }
        criteriaTimerRef.current = setTimeout(() => {
            onTableSettingsChange({ criteria: nextCriteria });
            criteriaTimerRef.current = null;
        }, 300);
    }, [criteriaMap, onTableSettingsChange]);

    const handleSizeApply = () => {
        const minW = sizeBounds?.minW ?? 2;
        const maxW = sizeBounds?.maxW ?? 12;
        const minH = sizeBounds?.minH ?? 2;
        const maxH = sizeBounds?.maxH ?? 24;

        const nextWidth = clamp(
            sizeDraft.w,
            minW,
            maxW,
            currentSize?.w ?? minW,
        );
        const nextHeight = clamp(
            sizeDraft.h,
            minH,
            maxH,
            currentSize?.h ?? minH,
        );

        setSizeDraft({ w: nextWidth, h: nextHeight });
        onSizeChange(nextWidth, nextHeight);
    };

    const handleIntervalApply = () => {
        const nextInterval = clamp(intervalDraft, MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC, MIN_REFRESH_INTERVAL_SEC);
        setIntervalDraft(nextInterval);
        onRefreshIntervalChange(nextInterval);
    };

    const handleWidgetMetaApply = () => {
        const nextTitle = titleDraft.trim();
        const nextEndpoint = endpointDraft.trim();
        if (!nextTitle || !nextEndpoint) {
            return;
        }

        if (nextTitle === title && nextEndpoint === endpoint) {
            return;
        }

        onWidgetMetaChange?.({
            title: nextTitle,
            endpoint: nextEndpoint,
        });
    };

    // Ctrl+C: 단일 클릭으로 선택된 행을 헤더 포함 TSV로 클립보드에 복사
    useEffect(() => {
        const handleKeyDown = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "c" && clipboardRow) {
                const headers = visibleColumns.filter(
                    (c) => !c.startsWith("_"),
                );
                const values = headers.map((h) => {
                    const v = clipboardRow[h];
                    if (v === null || v === undefined) return "";
                    if (typeof v === "object") return JSON.stringify(v);
                    return String(v);
                });
                const tsv = headers.join("\t") + "\n" + values.join("\t");
                navigator.clipboard.writeText(tsv).catch(() => {});
                e.preventDefault();
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [clipboardRow, visibleColumns]);

    // 선택된 행의 최신 데이터를 실시간으로 추적
    const liveSelectedRow = useMemo(() => {
        if (!selectedRow) return null;
        // _key 기준으로 매칭, 없으면 인덱스 기준
        if (selectedRow._key !== undefined) {
            return (
                dataRows.find((r) => r._key === selectedRow._key) ?? selectedRow
            );
        }
        const idx = dataRows.findIndex((r) =>
            Object.keys(selectedRow).every((k) => r[k] === selectedRow[k]),
        );
        return idx >= 0 ? dataRows[idx] : selectedRow;
    }, [selectedRow, dataRows]);

    return (
        <div className='api-card'>
            <div className='api-card-header'>
                <div className='api-card-title-section'>
                    <div className='api-card-title-row'>
                        <h4 title={title}>{title}</h4>
                        <span className='title-meta title-meta-rows'>
                            {rowCount} rows
                        </span>
                        <span className={`status-pill ${statusLabel}`}>
                            <span className='status-dot' />
                            {statusText}
                        </span>
                        {enabledCriteriaColumns.length > 0 && (
                            <button
                                type='button'
                                className={`alert-pill ${alertCount > 0 ? "has-alert" : "no-alert"}`}
                                title={`Criteria 조건 충족 row: ${alertCount}`}
                                onClick={() => {
                                    if (alertCount > 0) {
                                        setShowAlertsOnly(
                                            (previous) => !previous,
                                        );
                                    }
                                }}
                                aria-pressed={showAlertsOnly}
                                disabled={alertCount === 0}
                            >
                                ALERT {alertCount}
                                {showAlertsOnly ? " · ON" : ""}
                            </button>
                        )}
                        <div className='title-actions'>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onRefresh();
                                }}
                                title='새로고침'
                            >
                                ⟳
                            </button>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setShowSettings(true);
                                }}
                                title='설정'
                            >
                                ⚙
                            </button>
                            <button
                                type='button'
                                className='compact-icon-btn remove'
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onRemove();
                                }}
                                title='제거'
                            >
                                ✕
                            </button>
                        </div>
                    </div>
                    <div className='api-endpoint-row'>
                        <div className='api-endpoint-info'>
                            <span className='api-endpoint'>{endpoint}</span>
                            <span className='refresh-interval-chip'>
                                ⏱ {formatInterval(refreshIntervalSec ?? 5)}
                            </span>
                        </div>
                        {lastUpdatedAt && (
                            <span className='last-updated-time'>
                                {formatLocalTime(lastUpdatedAt)}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {showSettings && (
                <ApiCardSettingsModal
                    title={title}
                    onClose={() => setShowSettings(false)}
                    titleDraft={titleDraft}
                    endpointDraft={endpointDraft}
                    onTitleDraftChange={setTitleDraft}
                    onEndpointDraftChange={setEndpointDraft}
                    onWidgetMetaApply={handleWidgetMetaApply}
                    sizeDraft={sizeDraft}
                    sizeBounds={sizeBounds}
                    onSizeDraftChange={setSizeDraft}
                    onSizeApply={handleSizeApply}
                    intervalDraft={intervalDraft}
                    onIntervalDraftChange={setIntervalDraft}
                    onIntervalApply={handleIntervalApply}
                    orderedColumns={orderedColumns}
                    visibleColumns={visibleColumns}
                    localColumnWidths={localColumnWidths}
                    draggingColumn={draggingColumn}
                    dragOverColumn={dragOverColumn}
                    onColumnToggle={handleColumnToggle}
                    onColumnWidthChange={handleColumnWidthChange}
                    onColumnDragStart={handleColumnDragStart}
                    onColumnDragEnd={handleColumnDragEnd}
                    onColumnDragOver={handleColumnDragOver}
                    onColumnDropEvent={handleColumnDropEvent}
                    availableColumns={availableColumns}
                    criteriaMap={criteriaMap}
                    onCriteriaChange={handleCriteriaChange}
                />
            )}
            <ApiCardRowDetailModal
                row={liveSelectedRow}
                title={title}
                onClose={() => setSelectedRow(null)}
            />

            <div className='api-card-content'>
                <DynamicTable
                    data={data}
                    title=''
                    columns={visibleColumns}
                    columnWidths={columnWidths}
                    criteria={criteriaMap}
                    showAlertsOnly={showAlertsOnly}
                    fontSize={widgetFontSize}
                    loading={loading}
                    error={error}
                    maxRows={20}
                    showHeader={false}
                    onRowClick={(row) => setClipboardRow(row)}
                    onRowDoubleClick={(row) => setSelectedRow(row)}
                />
            </div>
        </div>
    );
};

export default ApiCard;
