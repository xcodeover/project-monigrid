import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Legend,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import {
    OPERATORS as THRESHOLD_OPERATORS,
    THRESHOLD_COLORS,
    normalizeThresholds,
} from "../utils/chartThresholds.js";
import { MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC } from "../pages/dashboardConstants";
import "./ApiCard.css";
import "./BarChartCard.css";

const CHART_COLORS = [
    "#19a0ff",
    "#00cdb0",
    "#ff8ea0",
    "#ffd166",
    "#a29bfe",
    "#fd79a8",
    "#55efc4",
    "#fdcb6e",
    "#74b9ff",
    "#e17055",
];

// 개별 Cell 컬러링을 적용할 최대 row 수
// 초과 시 단일 색상으로 전환하여 React reconciliation 부하 감소
const CELL_COLOR_THRESHOLD = 30;
// 애니메이션을 비활성화할 최대 row 수
const ANIMATION_THRESHOLD = 100;
// 기본 최대 표시 막대 수
const MAX_BARS_DEFAULT = 200;

const normalizeData = (raw) => {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object") {
        return Object.entries(raw).map(([k, v]) => ({
            _key: k,
            ...(typeof v === "object" && v !== null ? v : { value: v }),
        }));
    }
    return [];
};

const detectColumns = (rows) => {
    const cols = new Set();
    rows.slice(0, 20).forEach((r) => {
        if (r && typeof r === "object") {
            Object.keys(r)
                .filter((k) => !k.startsWith("_"))
                .forEach((k) => cols.add(k));
        }
    });
    return Array.from(cols);
};

const formatInterval = (sec) => {
    if (sec >= 3600) return `every ${Math.floor(sec / 3600)}h`;
    if (sec >= 60) return `every ${Math.floor(sec / 60)}m`;
    return `every ${sec}s`;
};

/**
 * Tooltip formatter — reads the raw value straight from the hovered row
 * (entry.payload[dataKey]) instead of trusting entry.value, because recharts
 * can report 0 when `<Cell>` + `activeBar` are combined. This guarantees the
 * number shown in the tooltip matches the bar the user is actually pointing at.
 */
const formatTooltipValue = (value, _name, entry) => {
    const rawValue =
        entry?.payload != null && entry?.dataKey != null
            ? entry.payload[entry.dataKey]
            : value;
    const num = Number(rawValue);
    if (Number.isFinite(num)) return num.toLocaleString();
    return String(rawValue ?? "—");
};

const TOOLTIP_CONTENT_STYLE = {
    background: "rgba(13, 18, 27, 0.96)",
    border: "1px solid rgba(148, 163, 184, 0.22)",
    borderRadius: "10px",
    padding: "8px 12px",
    boxShadow: "0 14px 32px rgba(0, 0, 0, 0.45)",
    fontSize: "12px",
};
const TOOLTIP_LABEL_STYLE = {
    color: "#cbd5e1",
    fontWeight: 600,
    marginBottom: "4px",
};
const TOOLTIP_ITEM_STYLE = { color: "#e2e8f0" };

const BarChartCard = ({
    title,
    endpoint,
    data,
    loading,
    error,
    apiStatus,
    onRemove,
    onRefresh,
    refreshIntervalSec,
    onRefreshIntervalChange,
    onWidgetMetaChange,
    currentSize,
    sizeBounds,
    onSizeChange,
    chartSettings,
    onChartSettingsChange,
}) => {
    const [showSettings, setShowSettings] = useState(false);
    const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
    // "vertical" = 세로 막대(기본), "horizontal" = 가로 막대
    const [orientation, setOrientation] = useState(
        chartSettings?.orientation ?? "vertical",
    );
    const [xKeyDraft, setXKeyDraft] = useState(chartSettings?.xAxisKey ?? "");
    const [yKeysDraft, setYKeysDraft] = useState(
        chartSettings?.yAxisKeys ?? [],
    );
    const [titleDraft, setTitleDraft] = useState(title);
    const [endpointDraft, setEndpointDraft] = useState(endpoint);
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? 5);
    const [sizeDraft, setSizeDraft] = useState({
        w: currentSize?.w ?? 4,
        h: currentSize?.h ?? 4,
    });
    const [maxBars, setMaxBars] = useState(
        chartSettings?.maxBars ?? MAX_BARS_DEFAULT,
    );
    const [maxBarsDraft, setMaxBarsDraft] = useState(
        chartSettings?.maxBars ?? MAX_BARS_DEFAULT,
    );
    const [thresholdsDraft, setThresholdsDraft] = useState(() =>
        normalizeThresholds(chartSettings?.thresholds),
    );

    useEffect(() => setTitleDraft(title), [title]);
    useEffect(() => setEndpointDraft(endpoint), [endpoint]);
    useEffect(
        () => setIntervalDraft(refreshIntervalSec ?? 5),
        [refreshIntervalSec],
    );
    useEffect(
        () => setSizeDraft({ w: currentSize?.w ?? 4, h: currentSize?.h ?? 4 }),
        [currentSize?.w, currentSize?.h],
    );
    useEffect(() => {
        if (chartSettings?.orientation)
            setOrientation(chartSettings.orientation);
    }, [chartSettings?.orientation]);
    useEffect(() => {
        if (chartSettings?.maxBars != null) {
            setMaxBars(chartSettings.maxBars);
            setMaxBarsDraft(chartSettings.maxBars);
        }
    }, [chartSettings?.maxBars]);
    useEffect(() => {
        setThresholdsDraft(normalizeThresholds(chartSettings?.thresholds));
    }, [chartSettings?.thresholds]);

    useEffect(() => {
        if (data != null) setLastUpdatedAt(new Date());
    }, [data]);

    const rows = useMemo(() => normalizeData(data), [data]);
    const detectedColumns = useMemo(() => detectColumns(rows), [rows]);

    // 최대 표시 개수 제한 — 초과분은 잘라내어 렌더링 부하 방지
    const chartRows = useMemo(
        () => (rows.length > maxBars ? rows.slice(0, maxBars) : rows),
        [rows, maxBars],
    );
    const truncated = rows.length > maxBars;

    const xAxisKey =
        chartSettings?.xAxisKey ||
        (detectedColumns.length > 0 ? detectedColumns[0] : "");
    const yAxisKeys =
        chartSettings?.yAxisKeys?.length > 0
            ? chartSettings.yAxisKeys
            : detectedColumns.filter((c) => c !== xAxisKey).slice(0, 4);

    const isHorizontal = orientation === "horizontal";
    // recharts convention: layout="vertical" → horizontal bars, layout="horizontal" → vertical bars
    const rechartsLayout = isHorizontal ? "vertical" : "horizontal";

    const statusLabel = loading
        ? "loading"
        : apiStatus === "dead"
          ? "dead"
          : apiStatus === "slow-live"
            ? "slow-live"
            : "live";

    const effectiveYKeys = yKeysDraft.length > 0 ? yKeysDraft : yAxisKeys;

    const singleYMode = yAxisKeys.length === 1;
    // 대량 데이터에서 개별 Cell 컬러링은 수백 개의 React 컴포넌트를 생성하므로
    // 임계값 초과 시 단일 색상으로 전환
    const useCellColors = singleYMode && chartRows.length <= CELL_COLOR_THRESHOLD;
    // 대량 데이터에서 입장/퇴장 애니메이션은 렌더링 비용이 높으므로 비활성화
    const animationActive = chartRows.length <= ANIMATION_THRESHOLD;

    const handleApplySettings = () => {
        const resolvedX = xKeyDraft || xAxisKey;
        const resolvedY =
            yKeysDraft.length > 0
                ? yKeysDraft
                : detectedColumns.filter((c) => c !== resolvedX).slice(0, 4);

        const clampedMaxBars = Math.min(
            5000,
            Math.max(10, Math.floor(Number(maxBarsDraft) || MAX_BARS_DEFAULT)),
        );
        setMaxBars(clampedMaxBars);
        setMaxBarsDraft(clampedMaxBars);

        const cleanThresholds = thresholdsDraft
            .map((t) => ({
                key: String(t.key || "").trim(),
                operator: t.operator || ">=",
                value: t.value === "" || t.value == null ? "" : Number(t.value),
                enabled: t.enabled !== false,
                label: (t.label || "").trim(),
            }))
            .filter(
                (t) =>
                    t.key && Number.isFinite(Number(t.value)) && t.value !== "",
            );

        onChartSettingsChange?.({
            xAxisKey: resolvedX,
            yAxisKeys: resolvedY,
            orientation,
            maxBars: clampedMaxBars,
            thresholds: cleanThresholds,
        });

        if (
            titleDraft.trim() &&
            endpointDraft.trim() &&
            (titleDraft.trim() !== title || endpointDraft.trim() !== endpoint)
        ) {
            onWidgetMetaChange?.({
                title: titleDraft.trim(),
                endpoint: endpointDraft.trim(),
            });
        }

        const nextInterval = Math.min(
            MAX_REFRESH_INTERVAL_SEC,
            Math.max(MIN_REFRESH_INTERVAL_SEC, Number(intervalDraft) || MIN_REFRESH_INTERVAL_SEC),
        );
        setIntervalDraft(nextInterval);
        onRefreshIntervalChange?.(nextInterval);

        const minW = sizeBounds?.minW ?? 2;
        const maxW = sizeBounds?.maxW ?? 12;
        const minH = sizeBounds?.minH ?? 2;
        const maxH = sizeBounds?.maxH ?? 24;
        const nw = Math.min(
            maxW,
            Math.max(minW, Math.floor(Number(sizeDraft.w) || minW)),
        );
        const nh = Math.min(
            maxH,
            Math.max(minH, Math.floor(Number(sizeDraft.h) || minH)),
        );
        setSizeDraft({ w: nw, h: nh });
        onSizeChange?.(nw, nh);

        setShowSettings(false);
    };

    const toggleYKey = (col) => {
        setYKeysDraft((prev) =>
            prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col],
        );
    };

    const addThreshold = () => {
        const firstKey = effectiveYKeys[0] || yAxisKeys[0] || "";
        setThresholdsDraft((prev) => [
            ...prev,
            {
                key: firstKey,
                operator: ">=",
                value: "",
                enabled: true,
                label: "",
            },
        ]);
    };

    const updateThreshold = (index, patch) => {
        setThresholdsDraft((prev) =>
            prev.map((t, i) => (i === index ? { ...t, ...patch } : t)),
        );
    };

    const removeThreshold = (index) => {
        setThresholdsDraft((prev) => prev.filter((_, i) => i !== index));
    };

    const activeThresholds = useMemo(
        () =>
            (chartSettings?.thresholds ?? []).filter(
                (t) =>
                    t?.enabled !== false &&
                    t?.key &&
                    Number.isFinite(Number(t?.value)),
            ),
        [chartSettings?.thresholds],
    );

    const settingsModal = showSettings ? (
        <div
            className='settings-overlay'
        >
            <div
                className='settings-popup'
                onClick={(e) => e.stopPropagation()}
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
                    {/* 1. 기본 정보 */}
                    <div className='settings-section'>
                        <h6>기본 정보</h6>
                        <div className='bc-settings-grid bc-settings-grid-single'>
                            <div className='bc-setting-group'>
                                <label>제목</label>
                                <input
                                    type='text'
                                    value={titleDraft}
                                    onChange={(e) =>
                                        setTitleDraft(e.target.value)
                                    }
                                    placeholder='위젯 제목'
                                />
                            </div>
                            <div className='bc-setting-group'>
                                <label>엔드포인트</label>
                                <input
                                    type='text'
                                    value={endpointDraft}
                                    onChange={(e) =>
                                        setEndpointDraft(e.target.value)
                                    }
                                    placeholder='/api/...'
                                />
                            </div>
                        </div>
                    </div>

                    {/* 2. 차트 데이터 */}
                    <div className='settings-section'>
                        <h6>차트 데이터</h6>
                        <div className='bc-settings-grid bc-settings-grid-single'>
                            <div className='bc-setting-group'>
                                <label>기준 컬럼 (카테고리)</label>
                                <select
                                    value={xKeyDraft || xAxisKey}
                                    onChange={(e) =>
                                        setXKeyDraft(e.target.value)
                                    }
                                >
                                    {detectedColumns.map((c) => (
                                        <option key={c} value={c}>
                                            {c}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className='bc-setting-group'>
                                <label>
                                    수량 컬럼{" "}
                                    <span className='bc-hint'>(다중 선택)</span>
                                </label>
                                <div className='bc-check-list'>
                                    {detectedColumns
                                        .filter(
                                            (c) =>
                                                c !== (xKeyDraft || xAxisKey),
                                        )
                                        .map((c) => (
                                            <label
                                                key={c}
                                                className='bc-check-item'
                                            >
                                                <input
                                                    type='checkbox'
                                                    checked={effectiveYKeys.includes(
                                                        c,
                                                    )}
                                                    onChange={() =>
                                                        toggleYKey(c)
                                                    }
                                                />
                                                {c}
                                            </label>
                                        ))}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* 3. 표시 옵션 — 방향 / 최대 항목 */}
                    <div className='settings-section'>
                        <h6>표시 옵션</h6>
                        <div className='bc-settings-grid bc-settings-grid-single'>
                            <div className='bc-setting-group'>
                                <label>막대 방향</label>
                                <div className='bc-radio-row'>
                                    <label className='bc-radio-item'>
                                        <input
                                            type='radio'
                                            name='bc-orientation'
                                            value='vertical'
                                            checked={
                                                orientation === "vertical"
                                            }
                                            onChange={() =>
                                                setOrientation("vertical")
                                            }
                                        />
                                        세로 막대
                                    </label>
                                    <label className='bc-radio-item'>
                                        <input
                                            type='radio'
                                            name='bc-orientation'
                                            value='horizontal'
                                            checked={
                                                orientation === "horizontal"
                                            }
                                            onChange={() =>
                                                setOrientation("horizontal")
                                            }
                                        />
                                        가로 막대
                                    </label>
                                </div>
                            </div>
                            <div className='bc-setting-group'>
                                <label>
                                    최대 표시 항목{" "}
                                    <span className='bc-hint'>(10 – 5000)</span>
                                </label>
                                <input
                                    type='number'
                                    min='10'
                                    max='5000'
                                    value={maxBarsDraft}
                                    onChange={(e) =>
                                        setMaxBarsDraft(e.target.value)
                                    }
                                />
                            </div>
                        </div>
                    </div>

                    {/* 4. 임계치 설정 */}
                    <div className='settings-section'>
                        <div className='bc-section-header-row'>
                            <h6>임계치 설정</h6>
                            <button
                                type='button'
                                className='bc-threshold-add-btn'
                                onClick={addThreshold}
                                disabled={effectiveYKeys.length === 0}
                            >
                                + 추가
                            </button>
                        </div>
                        {thresholdsDraft.length === 0 ? (
                            <div className='bc-threshold-empty'>
                                설정된 임계치가 없습니다. 값 컬럼별로 임계치를
                                추가하면 초과 시 위젯 테두리가 빨간색으로 깜빡입니다.
                            </div>
                        ) : (
                            <div className='bc-threshold-list'>
                                {thresholdsDraft.map((t, idx) => (
                                    <div
                                        className='bc-threshold-row'
                                        key={idx}
                                    >
                                        <span
                                            className='bc-threshold-color'
                                            style={{
                                                background:
                                                    THRESHOLD_COLORS[
                                                        idx %
                                                            THRESHOLD_COLORS.length
                                                    ],
                                            }}
                                        />
                                        <input
                                            type='checkbox'
                                            className='bc-threshold-enabled'
                                            checked={t.enabled !== false}
                                            title='활성화'
                                            onChange={(e) =>
                                                updateThreshold(idx, {
                                                    enabled: e.target.checked,
                                                })
                                            }
                                        />
                                        <select
                                            className='bc-threshold-key'
                                            value={t.key}
                                            onChange={(e) =>
                                                updateThreshold(idx, {
                                                    key: e.target.value,
                                                })
                                            }
                                        >
                                            {effectiveYKeys.length === 0 && (
                                                <option value=''>(없음)</option>
                                            )}
                                            {effectiveYKeys.map((k) => (
                                                <option key={k} value={k}>
                                                    {k}
                                                </option>
                                            ))}
                                        </select>
                                        <select
                                            className='bc-threshold-op'
                                            value={t.operator}
                                            onChange={(e) =>
                                                updateThreshold(idx, {
                                                    operator: e.target.value,
                                                })
                                            }
                                        >
                                            {THRESHOLD_OPERATORS.map((op) => (
                                                <option
                                                    key={op.value}
                                                    value={op.value}
                                                >
                                                    {op.label}
                                                </option>
                                            ))}
                                        </select>
                                        <input
                                            type='number'
                                            className='bc-threshold-value'
                                            value={t.value}
                                            placeholder='값'
                                            onChange={(e) =>
                                                updateThreshold(idx, {
                                                    value: e.target.value,
                                                })
                                            }
                                        />
                                        <input
                                            type='text'
                                            className='bc-threshold-label'
                                            value={t.label}
                                            placeholder='라벨(선택)'
                                            onChange={(e) =>
                                                updateThreshold(idx, {
                                                    label: e.target.value,
                                                })
                                            }
                                        />
                                        <button
                                            type='button'
                                            className='bc-threshold-remove'
                                            onClick={() => removeThreshold(idx)}
                                            title='삭제'
                                        >
                                            ✕
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* 5. 위젯 동작 */}
                    <div className='settings-section'>
                        <h6>위젯 동작</h6>
                        <div className='bc-settings-grid'>
                            <div className='bc-setting-group'>
                                <label>위젯 크기 (W × H)</label>
                                <div className='bc-size-row'>
                                    <input
                                        type='number'
                                        min={sizeBounds?.minW ?? 2}
                                        max={sizeBounds?.maxW ?? 12}
                                        value={sizeDraft.w}
                                        onChange={(e) =>
                                            setSizeDraft((p) => ({
                                                ...p,
                                                w: e.target.value,
                                            }))
                                        }
                                        placeholder='W'
                                    />
                                    <span className='bc-size-sep'>×</span>
                                    <input
                                        type='number'
                                        min={sizeBounds?.minH ?? 2}
                                        max={sizeBounds?.maxH ?? 24}
                                        value={sizeDraft.h}
                                        onChange={(e) =>
                                            setSizeDraft((p) => ({
                                                ...p,
                                                h: e.target.value,
                                            }))
                                        }
                                        placeholder='H'
                                    />
                                </div>
                            </div>
                            <div className='bc-setting-group'>
                                <label>체크 주기 (초)</label>
                                <input
                                    type='number'
                                    min={MIN_REFRESH_INTERVAL_SEC}
                                    max={MAX_REFRESH_INTERVAL_SEC}
                                    value={intervalDraft}
                                    onChange={(e) =>
                                        setIntervalDraft(e.target.value)
                                    }
                                />
                            </div>
                        </div>
                    </div>

                    <div className='bc-settings-footer'>
                        <button
                            type='button'
                            className='secondary-btn'
                            onClick={() => setShowSettings(false)}
                        >
                            취소
                        </button>
                        <button
                            type='button'
                            className='primary-btn'
                            onClick={handleApplySettings}
                        >
                            적용
                        </button>
                    </div>
                </div>
            </div>
        </div>
    ) : null;

    return (
        <div className='bc-card'>
            {/* Header */}
            <div className='api-card-header bc-header'>
                <div className='api-card-title-section'>
                    <div className='api-card-title-row'>
                        <h4 title={title}>{title}</h4>
                        <span className={`status-pill ${statusLabel}`}>
                            <span className='status-dot' />
                            {statusLabel === "loading"
                                ? "..."
                                : statusLabel === "dead"
                                  ? "DEAD"
                                  : statusLabel === "slow-live"
                                    ? "SLOW"
                                    : "LIVE"}
                        </span>
                        <div className='title-actions'>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                title={isHorizontal ? "가로 막대 (클릭: 세로 전환)" : "세로 막대 (클릭: 가로 전환)"}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    const next = isHorizontal ? "vertical" : "horizontal";
                                    setOrientation(next);
                                    onChartSettingsChange?.({ orientation: next });
                                }}
                            >
                                <span className={`bc-orient-icon${isHorizontal ? "" : " rotated"}`}>≡</span>
                            </button>
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
                                    setShowSettings((v) => !v);
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
                                title='삭제'
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
                                {lastUpdatedAt.toLocaleTimeString("en-GB", { hour12: false })}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {settingsModal && createPortal(settingsModal, document.body)}

            {/* Chart body */}
            <div className='bc-body'>
                {error ? (
                    <div className='bc-state bc-error'>⚠️ 오류: {error}</div>
                ) : loading ? (
                    <div className='bc-state'>
                        <div className='bc-spinner' />
                    </div>
                ) : chartRows.length === 0 ? (
                    <div className='bc-state bc-empty'>데이터가 없습니다</div>
                ) : (
                    <>
                        {truncated && (
                            <div className='bc-truncation-notice'>
                                상위 {maxBars.toLocaleString()}개 표시 중 (전체{" "}
                                {rows.length.toLocaleString()}개)
                            </div>
                        )}
                        <ResponsiveContainer width='100%' height='100%' minWidth={0} minHeight={0}>
                            <BarChart
                                layout={rechartsLayout}
                                data={chartRows}
                                margin={{ top: 6, right: 16, left: 0, bottom: truncated ? 0 : 4 }}
                            >
                                <CartesianGrid
                                    strokeDasharray='3 3'
                                    stroke='rgba(255,255,255,0.06)'
                                />
                                {isHorizontal ? (
                                    <>
                                        <XAxis
                                            type='number'
                                            tick={{ fill: "#7a90a8", fontSize: 11 }}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <YAxis
                                            type='category'
                                            dataKey={xAxisKey}
                                            tick={{ fill: "#7a90a8", fontSize: 11 }}
                                            tickLine={false}
                                            axisLine={{
                                                stroke: "rgba(255,255,255,0.08)",
                                            }}
                                            width={80}
                                        />
                                    </>
                                ) : (
                                    <>
                                        <XAxis
                                            dataKey={xAxisKey}
                                            tick={{ fill: "#7a90a8", fontSize: 11 }}
                                            tickLine={false}
                                            axisLine={{
                                                stroke: "rgba(255,255,255,0.08)",
                                            }}
                                            interval='preserveStartEnd'
                                        />
                                        <YAxis
                                            tick={{ fill: "#7a90a8", fontSize: 11 }}
                                            tickLine={false}
                                            axisLine={false}
                                            width={44}
                                        />
                                    </>
                                )}
                                <Tooltip
                                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                                    contentStyle={TOOLTIP_CONTENT_STYLE}
                                    labelStyle={TOOLTIP_LABEL_STYLE}
                                    itemStyle={TOOLTIP_ITEM_STYLE}
                                    formatter={formatTooltipValue}
                                />
                                {activeThresholds.map((t, idx) => {
                                    const numericValue = Number(t.value);
                                    if (!Number.isFinite(numericValue))
                                        return null;
                                    const color =
                                        THRESHOLD_COLORS[
                                            idx % THRESHOLD_COLORS.length
                                        ];
                                    // vertical bars (recharts layout="horizontal"):
                                    //   value axis = Y  → horizontal threshold line (y=value)
                                    // horizontal bars (recharts layout="vertical"):
                                    //   value axis = X  → vertical threshold line (x=value)
                                    const lineProps = isHorizontal
                                        ? { x: numericValue }
                                        : { y: numericValue };
                                    return (
                                        <ReferenceLine
                                            key={`threshold-${idx}`}
                                            {...lineProps}
                                            stroke={color}
                                            strokeDasharray='4 4'
                                            strokeWidth={1.6}
                                            ifOverflow='extendDomain'
                                            label={{
                                                value:
                                                    t.label ||
                                                    `${t.key} ${t.operator} ${numericValue}`,
                                                fill: color,
                                                fontSize: 10,
                                                position: isHorizontal
                                                    ? "top"
                                                    : "right",
                                            }}
                                        />
                                    );
                                })}
                                {yAxisKeys.length > 1 && (
                                    <Legend
                                        wrapperStyle={{
                                            fontSize: 11,
                                            color: "#7a90a8",
                                            paddingTop: 2,
                                        }}
                                    />
                                )}
                                {yAxisKeys.map((key, i) =>
                                    useCellColors ? (
                                        // 소량 데이터: 막대별 개별 색상
                                        <Bar
                                            key={key}
                                            dataKey={key}
                                            isAnimationActive={animationActive}
                                            radius={
                                                isHorizontal
                                                    ? [0, 4, 4, 0]
                                                    : [4, 4, 0, 0]
                                            }
                                            maxBarSize={40}
                                            activeBar={{ fillOpacity: 0.75, stroke: "rgba(255,255,255,0.18)", strokeWidth: 1 }}
                                        >
                                            {chartRows.map((_, idx) => (
                                                <Cell
                                                    key={idx}
                                                    fill={
                                                        CHART_COLORS[
                                                            idx %
                                                                CHART_COLORS.length
                                                        ]
                                                    }
                                                />
                                            ))}
                                        </Bar>
                                    ) : (
                                        // 대량 데이터: 단일/계열 색상 (Cell 컴포넌트 생성 없음)
                                        <Bar
                                            key={key}
                                            dataKey={key}
                                            fill={
                                                CHART_COLORS[
                                                    i % CHART_COLORS.length
                                                ]
                                            }
                                            isAnimationActive={animationActive}
                                            radius={
                                                isHorizontal
                                                    ? [0, 4, 4, 0]
                                                    : [4, 4, 0, 0]
                                            }
                                            maxBarSize={singleYMode ? 40 : 32}
                                            activeBar={{ fillOpacity: 0.75, stroke: "rgba(255,255,255,0.18)", strokeWidth: 1 }}
                                        />
                                    ),
                                )}
                            </BarChart>
                        </ResponsiveContainer>
                    </>
                )}
            </div>
        </div>
    );
};

export default BarChartCard;
