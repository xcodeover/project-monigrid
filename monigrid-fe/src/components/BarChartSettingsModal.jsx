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
 * Settings modal extracted from BarChartCard (SRP).
 *
 * The parent owns all state via `useBarChartSettings`; this component is a
 * pure JSX shell that wires those drafts to inputs. The shared
 * `WidgetSettingsModal` wrapper handles overlay/portal/Esc/focus, so this
 * file only owns the bar-chart-specific sections.
 */
const BarChartSettingsModal = ({ title, sizeBounds, settings }) => {
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
        orientation,
        setOrientation,
        xKeyDraft,
        setXKeyDraft,
        yKeysDraft,
        maxBarsDraft,
        setMaxBarsDraft,
        thresholdsDraft,
        detectedColumns,
        xAxisKey,
        yAxisKeys,
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
            footerClassName='bc-settings-footer'
        >
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
                        <div className='bc-settings-grid'>
                            <div className='bc-setting-group'>
                                <label>위젯 크기 (W × H)</label>
                                <div className='bc-size-row'>
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
                                    <span className='bc-size-sep'>×</span>
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

        </WidgetSettingsModal>
    );
};

export default BarChartSettingsModal;
