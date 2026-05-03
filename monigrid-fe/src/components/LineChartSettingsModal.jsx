import {
    MAX_REFRESH_INTERVAL_SEC,
    MAX_WIDGET_H,
    MAX_WIDGET_W,
    MIN_REFRESH_INTERVAL_SEC,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
    SIZE_STEP,
} from "../pages/dashboardConstants";
import {
    OPERATORS as THRESHOLD_OPERATORS,
    THRESHOLD_COLORS,
} from "../utils/chartThresholds.js";
import { IconClose } from "./icons";
import { toGridSize, toUserSize } from "./widgetUtils.js";
import WidgetSettingsModal from "./WidgetSettingsModal.jsx";

/**
 * Settings modal extracted from LineChartCard (SRP).
 *
 * Mirrors BarChartSettingsModal: pure JSX over the drafts owned by
 * useLineChartSettings, wrapped in the shared WidgetSettingsModal chrome.
 */
const LineChartSettingsModal = ({ title, sizeBounds, settings }) => {
    const {
        showSettings,
        setShowSettings,
        titleDraft,
        setTitleDraft,
        endpointDraft,
        setEndpointDraft,
        intervalDraft,
        setIntervalDraft,
        sizeDraft,
        setSizeDraft,
        xKeyDraft,
        setXKeyDraft,
        showLegend,
        setShowLegend,
        maxPointsDraft,
        setMaxPointsDraft,
        thresholdsDraft,
        detectedColumns,
        xAxisKey,
        effectiveYKeys,
        handleApplySettings,
        toggleYKey,
        addThreshold,
        updateThreshold,
        removeThreshold,
    } = settings;

    return (
        <WidgetSettingsModal
            open={showSettings}
            onClose={() => setShowSettings(false)}
            onApply={handleApplySettings}
            title='위젯 설정'
            subtitle={title}
            footerClassName='lc-settings-footer'
        >
            {/* 1. 기본 정보 */}
                    <div className='settings-section'>
                        <h6>기본 정보</h6>
                        <div className='lc-settings-grid lc-settings-grid-single'>
                            <div className='lc-setting-group'>
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
                            <div className='lc-setting-group'>
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

                    {/* 2. 차트 데이터 — 축 설정 */}
                    <div className='settings-section'>
                        <h6>차트 데이터</h6>
                        <div className='lc-settings-grid lc-settings-grid-single'>
                            <div className='lc-setting-group'>
                                <label>X축 (시간/카테고리)</label>
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
                            <div className='lc-setting-group'>
                                <label>
                                    Y축 값{" "}
                                    <span className='lc-hint'>(다중 선택)</span>
                                </label>
                                <div className='lc-check-list'>
                                    {detectedColumns
                                        .filter(
                                            (c) =>
                                                c !== (xKeyDraft || xAxisKey),
                                        )
                                        .map((c) => (
                                            <label
                                                key={c}
                                                className='lc-check-item'
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

                    {/* 3. 표시 옵션 */}
                    <div className='settings-section'>
                        <h6>표시 옵션</h6>
                        <div className='lc-settings-grid'>
                            <div className='lc-setting-group'>
                                <label>범례</label>
                                <label className='lc-toggle-row'>
                                    <input
                                        type='checkbox'
                                        checked={showLegend}
                                        onChange={(e) =>
                                            setShowLegend(e.target.checked)
                                        }
                                    />
                                    범례 표시
                                </label>
                            </div>
                            <div className='lc-setting-group'>
                                <label>
                                    최대 포인트 수{" "}
                                    <span className='lc-hint'>(50 – 10000)</span>
                                </label>
                                <input
                                    type='number'
                                    min='50'
                                    max='10000'
                                    value={maxPointsDraft}
                                    onChange={(e) =>
                                        setMaxPointsDraft(e.target.value)
                                    }
                                />
                            </div>
                        </div>
                    </div>

                    {/* 4. 임계치 설정 */}
                    <div className='settings-section'>
                        <div className='lc-section-header-row'>
                            <h6>임계치 설정</h6>
                            <button
                                type='button'
                                className='lc-threshold-add-btn'
                                onClick={addThreshold}
                                disabled={effectiveYKeys.length === 0}
                            >
                                + 추가
                            </button>
                        </div>
                        {thresholdsDraft.length === 0 ? (
                            <div className='lc-threshold-empty'>
                                설정된 임계치가 없습니다. Y축 컬럼별로 임계치를
                                추가하면 초과 시 위젯 테두리가 빨간색으로 깜빡입니다.
                            </div>
                        ) : (
                            <div className='lc-threshold-list'>
                                {thresholdsDraft.map((t, idx) => (
                                    <div
                                        className='lc-threshold-row'
                                        key={idx}
                                    >
                                        <span
                                            className='lc-threshold-color'
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
                                            className='lc-threshold-enabled'
                                            checked={t.enabled !== false}
                                            title='활성화'
                                            onChange={(e) =>
                                                updateThreshold(idx, {
                                                    enabled: e.target.checked,
                                                })
                                            }
                                        />
                                        <select
                                            className='lc-threshold-key'
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
                                            className='lc-threshold-op'
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
                                            className='lc-threshold-value'
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
                                            className='lc-threshold-label'
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
                                            className='lc-threshold-remove'
                                            onClick={() => removeThreshold(idx)}
                                            title='삭제'
                                            aria-label='삭제'
                                        >
                                            <IconClose size={12} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* 5. 위젯 동작 */}
                    <div className='settings-section'>
                        <h6>위젯 동작</h6>
                        <div className='lc-settings-grid'>
                            <div className='lc-setting-group'>
                                <label>위젯 크기 (W × H)</label>
                                <div className='lc-size-row'>
                                    <input
                                        type='number'
                                        min={toUserSize(sizeBounds?.minW ?? MIN_WIDGET_W)}
                                        max={toUserSize(sizeBounds?.maxW ?? MAX_WIDGET_W)}
                                        step={SIZE_STEP}
                                        value={toUserSize(sizeDraft.w)}
                                        onChange={(e) =>
                                            setSizeDraft((p) => ({
                                                ...p,
                                                w: toGridSize(e.target.value),
                                            }))
                                        }
                                        placeholder='W'
                                    />
                                    <span className='lc-size-sep'>×</span>
                                    <input
                                        type='number'
                                        min={sizeBounds?.minH ?? MIN_WIDGET_H}
                                        max={sizeBounds?.maxH ?? MAX_WIDGET_H}
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
                            <div className='lc-setting-group'>
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

        </WidgetSettingsModal>
    );
};

export default LineChartSettingsModal;
