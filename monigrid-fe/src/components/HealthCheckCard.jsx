import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC } from "../pages/dashboardConstants";
import "./ApiCard.css";
import "./HealthCheckCard.css";

const clamp = (value, min, max, fallback) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(numericValue)));
};

const HealthCheckCard = ({
    title,
    endpoint,
    healthData,
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
}) => {
    const [showSettings, setShowSettings] = useState(false);
    const [sizeDraft, setSizeDraft] = useState({ w: 4, h: 4 });
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? 5);
    const [titleDraft, setTitleDraft] = useState(title);
    const [endpointDraft, setEndpointDraft] = useState(endpoint);
    const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

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
        if (healthData != null) {
            setLastUpdatedAt(new Date());
        }
    }, [healthData]);

    useEffect(() => {
        setTitleDraft(title);
    }, [title]);

    useEffect(() => {
        setEndpointDraft(endpoint);
    }, [endpoint]);

    const formatInterval = (sec) => {
        if (sec >= 3600) return `every ${Math.floor(sec / 3600)}h`;
        if (sec >= 60) return `every ${Math.floor(sec / 60)}m`;
        return `every ${sec}s`;
    };

    const formatLocalTime = (date) =>
        date ? date.toLocaleTimeString("en-GB", { hour12: false }) : null;

    const statusLabel = loading
        ? "loading"
        : apiStatus === "dead"
          ? "dead"
          : apiStatus === "slow-live"
            ? "slow-live"
            : "live";

    const statusText = useMemo(() => {
        if (loading) {
            return "Checking...";
        }

        if (error) {
            return error;
        }

        if (!healthData) {
            return "No response";
        }

        if (healthData.ok) {
            return "HTTP 200 OK";
        }

        return `HTTP ${healthData.httpStatus}`;
    }, [error, healthData, loading]);

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

        // 상위(DashboardPage)에서 resolveEndpointWithBase 정규화를 거치므로
        // 입력값이 prop과 동일해 보여도 항상 콜백을 호출해 변경을 보장한다.
        onWidgetMetaChange?.({
            title: nextTitle,
            endpoint: nextEndpoint,
        });
        setShowSettings(false);
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
                            <label>
                                Endpoint
                                <input
                                    type='text'
                                    value={endpointDraft}
                                    onChange={(event) =>
                                        setEndpointDraft(event.target.value)
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
                        <span className={`status-pill ${statusLabel}`}>
                            <span className='status-dot' />
                            {statusLabel}
                        </span>
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

            {settingsPopup && createPortal(settingsPopup, document.body)}

            <div className='api-card-content'>
                <div className='health-widget-content'>
                    <div
                        className={`health-summary-chip ${healthData?.ok ? "ok" : "fail"}`}
                    >
                        {statusText}
                    </div>

                    <div className='health-meta-grid'>
                        <div className='health-meta-item'>
                            <span className='health-meta-label'>HTTP</span>
                            <span className='health-meta-value'>
                                {healthData?.httpStatus ?? "-"}
                            </span>
                        </div>
                        <div className='health-meta-item'>
                            <span className='health-meta-label'>Latency</span>
                            <span className='health-meta-value'>
                                {healthData?.responseTimeMs != null
                                    ? `${healthData.responseTimeMs} ms`
                                    : "-"}
                            </span>
                        </div>
                    </div>

                    {healthData?.body !== undefined && (
                        <pre className='health-body-preview'>
                            {JSON.stringify(healthData.body, null, 2)}
                        </pre>
                    )}
                </div>
            </div>
        </div>
    );
};

export default HealthCheckCard;
