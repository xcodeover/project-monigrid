import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC } from "../pages/dashboardConstants";
import "./ApiCard.css";
import "./StatusListCard.css";

const MAX_ENDPOINTS = 50;

const clamp = (value, min, max, fallback) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(numericValue)));
};

const serializeEndpoints = (endpoints = []) =>
    (endpoints || [])
        .map((item) => `${item.label || item.url} | ${item.url}`)
        .join("\n");

const parseEndpointLines = (rawValue) =>
    String(rawValue ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
            const [rawLabel, ...rawUrlTokens] = line.includes("|")
                ? line.split("|")
                : ["", line];
            const url = (
                rawUrlTokens.length > 0 ? rawUrlTokens.join("|") : rawLabel
            ).trim();
            const fallbackLabel = url || `API ${index + 1}`;

            return {
                id: `status-list-${index}-${url}`,
                label:
                    (rawUrlTokens.length > 0
                        ? rawLabel
                        : fallbackLabel
                    ).trim() || fallbackLabel,
                url,
            };
        })
        .filter((item) => item.url);

const formatInterval = (sec) => {
    if (sec >= 3600) return `every ${Math.floor(sec / 3600)}h`;
    if (sec >= 60) return `every ${Math.floor(sec / 60)}m`;
    return `every ${sec}s`;
};

const formatLocalTime = (date) =>
    date ? date.toLocaleTimeString("en-GB", { hour12: false }) : null;

const StatusListCard = ({
    title,
    endpoints,
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
    onEndpointsChange,
}) => {
    const [showSettings, setShowSettings] = useState(false);
    const [sizeDraft, setSizeDraft] = useState({ w: 4, h: 5 });
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? 5);
    const [titleDraft, setTitleDraft] = useState(title);
    const [endpointsDraft, setEndpointsDraft] = useState(
        serializeEndpoints(endpoints),
    );
    const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

    useEffect(() => {
        // 부모(useWidgetApiData)가 새 결과를 내려줄 때마다 갱신 시각을 저장.
        if (data != null) {
            setLastUpdatedAt(new Date());
        }
    }, [data]);

    const items = useMemo(() => {
        const raw = data?.items || [];
        return [...raw].sort((a, b) => {
            const aFail = a.ok ? 1 : 0;
            const bFail = b.ok ? 1 : 0;
            return aFail - bFail; // NG(ok=false) first
        });
    }, [data]);
    const okCount = Number(data?.okCount || 0);
    const failCount = Number(data?.failCount || 0);

    useEffect(() => {
        setSizeDraft({
            w: currentSize?.w ?? 4,
            h: currentSize?.h ?? 5,
        });
    }, [currentSize?.w, currentSize?.h]);

    useEffect(() => {
        setIntervalDraft(refreshIntervalSec ?? 5);
    }, [refreshIntervalSec]);

    useEffect(() => {
        setTitleDraft(title);
    }, [title]);

    useEffect(() => {
        setEndpointsDraft(serializeEndpoints(endpoints));
    }, [endpoints]);

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
        if (!nextTitle) {
            return;
        }

        onWidgetMetaChange?.({ title: nextTitle });
    };

    const parsedDraftCount = useMemo(
        () => parseEndpointLines(endpointsDraft).length,
        [endpointsDraft],
    );

    const handleEndpointsApply = () => {
        const nextEndpoints = parseEndpointLines(endpointsDraft);
        if (nextEndpoints.length === 0) {
            return;
        }
        if (nextEndpoints.length > MAX_ENDPOINTS) {
            window.alert(`최대 ${MAX_ENDPOINTS}개까지 등록할 수 있습니다. (현재 ${nextEndpoints.length}개)`);
            return;
        }

        onEndpointsChange?.(nextEndpoints);
    };

    const settingsPopup = showSettings ? (
        <div
            className='settings-overlay'
        >
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
                        onClick={() => setShowSettings(false)}
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
                                        setTitleDraft(event.target.value)
                                    }
                                />
                            </label>
                            <button
                                type='button'
                                className='size-preset-btn'
                                onClick={handleWidgetMetaApply}
                            >
                                적용
                            </button>
                        </div>
                    </div>

                    <div className='settings-section'>
                        <h6>
                            API 목록
                            <span className={`status-list-count${parsedDraftCount > MAX_ENDPOINTS ? " over-limit" : ""}`}>
                                {parsedDraftCount} / {MAX_ENDPOINTS}
                            </span>
                        </h6>
                        <textarea
                            className='status-list-textarea'
                            value={endpointsDraft}
                            onChange={(event) =>
                                setEndpointsDraft(event.target.value)
                            }
                            placeholder={
                                "label | https://example.com/health\nhttps://example.com/ping\n\n(최대 50개)"
                            }
                        />
                        {parsedDraftCount > MAX_ENDPOINTS && (
                            <p className="status-list-limit-warn">
                                최대 {MAX_ENDPOINTS}개까지 등록 가능합니다. ({parsedDraftCount - MAX_ENDPOINTS}개 초과)
                            </p>
                        )}
                        <button
                            type='button'
                            className={`size-preset-btn status-list-apply-btn${parsedDraftCount > MAX_ENDPOINTS ? " disabled" : ""}`}
                            onClick={handleEndpointsApply}
                            disabled={parsedDraftCount > MAX_ENDPOINTS}
                        >
                            목록 적용
                        </button>
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
                                            setSizeDraft((previousDraft) => ({
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
                                            setSizeDraft((previousDraft) => ({
                                                ...previousDraft,
                                                h: event.target.value,
                                            }))
                                        }
                                    />
                                </label>
                                <button
                                    type='button'
                                    className='size-preset-btn'
                                    onClick={handleSizeApply}
                                >
                                    적용
                                </button>
                            </div>
                        </div>

                        <div className='settings-section refresh-interval-section'>
                            <h6>체크 주기 (초)</h6>
                            <div className='refresh-interval-editor'>
                                <label className='refresh-interval-input-label'>
                                    <span>Interval</span>
                                    <input
                                        type='number'
                                        min={MIN_REFRESH_INTERVAL_SEC}
                                        max={MAX_REFRESH_INTERVAL_SEC}
                                        value={intervalDraft}
                                        onChange={(event) =>
                                            setIntervalDraft(event.target.value)
                                        }
                                    />
                                </label>
                                <button
                                    type='button'
                                    className='size-preset-btn'
                                    onClick={handleIntervalApply}
                                >
                                    적용
                                </button>
                            </div>
                        </div>
                    </div>

                    <button
                        type='button'
                        className='size-preset-btn status-list-reconnect-btn'
                        onClick={onRefresh}
                    >
                        리프레시 + 재연결 시도
                    </button>
                </div>
            </div>
        </div>
    ) : null;

    return (
        <div className='api-card'>
            <div className='api-card-header'>
                <div className='api-card-title-section'>
                    <div className='api-card-title-row'>
                        <h4 title={title}>{title}</h4>
                        <span className='status-pill live'>
                            <span className='status-dot' />
                            OK {okCount}
                        </span>
                        {failCount > 0 && (
                            <span className='status-pill dead'>
                                <span className='status-dot' />
                                NG {failCount}
                            </span>
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
                                    if (window.confirm(`"${title}" 위젯을 대시보드에서 제거하시겠습니까?`)) {
                                        onRemove();
                                    }
                                }}
                                title='제거'
                            >
                                ✕
                            </button>
                        </div>
                    </div>

                    <div className='api-endpoint-row'>
                        <div className='api-endpoint-info'>
                            <span className='api-endpoint'>
                                {endpoints?.length || 0} endpoints
                            </span>
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

            {settingsPopup && createPortal(settingsPopup, document.body)}

            <div className='api-card-content'>
                {error && <div className='status-list-error'>{error}</div>}

                {items.length === 0 && !loading ? (
                    <div className='status-list-empty'>
                        표시할 API 상태가 없습니다.
                    </div>
                ) : (
                    <div className='status-list-items'>
                        {items.map((item) => (
                            <div key={item.id} className='status-list-item'>
                                <span
                                    className={`status-pill ${item.ok ? "live" : "dead"}`}
                                    style={{ fontSize: "10px", padding: "2px 5px", flexShrink: 0 }}
                                >
                                    <span className='status-dot' />
                                    {item.ok
                                        ? "OK"
                                        : item.httpStatus
                                          ? `${item.httpStatus}`
                                          : "ERR"}
                                </span>
                                <strong className='status-list-label'>
                                    {item.label}
                                </strong>
                                <span className='status-list-url'>
                                    {item.url}
                                </span>
                                <span className='status-list-latency'>
                                    {item.responseTimeMs != null
                                        ? `${item.responseTimeMs} ms`
                                        : item.error || "-"}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default StatusListCard;
