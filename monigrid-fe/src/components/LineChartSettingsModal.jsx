import {
    MAX_REFRESH_INTERVAL_SEC,
    MAX_WIDGET_H,
    MAX_WIDGET_W,
    MIN_REFRESH_INTERVAL_SEC,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
    SIZE_STEP,
} from "../pages/dashboardConstants";
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
        detectedColumns,
        xAxisKey,
        effectiveYKeys,
        handleApplySettings,
        toggleYKey,
        // Phase 2: 임계치 모달 입력은 BE 위젯 설정으로 이전됨.
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

                    {/* 4. 임계치 안내 — Phase 2: BE 중앙 관리로 이전 */}
                    <div className='settings-section'>
                        <h6>임계치 설정</h6>
                        <div className='lc-threshold-empty'>
                            임계치는 백엔드 설정 → <strong>위젯별 설정</strong> 탭에서
                            (data API, 라인 차트) 단위로 중앙 관리됩니다. 알람 발생 여부는
                            BE 가 평가하여 모든 사용자에게 동일하게 반영됩니다.
                        </div>
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
