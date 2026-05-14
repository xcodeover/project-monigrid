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
import EndpointSelect from "./EndpointSelect.jsx";

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
        detectedColumns,
        xAxisKey,
        yAxisKeys,
        effectiveYKeys,
        handleApplySettings,
        toggleYKey,
        // Phase 2: 임계치는 BE 위젯 설정에서 단일 출처로 관리한다 — 모달에서
        // 더 이상 thresholds draft 를 노출하지 않는다. settings 객체 자체에는
        // 남아 있지만 (다른 화면 호환성) 여기서는 destructure 안 한다.
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
                                <EndpointSelect
                                    value={endpointDraft}
                                    onChange={setEndpointDraft}
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

                    {/* 4. 임계치 안내 — Phase 2: BE 중앙 관리로 이전 */}
                    <div className='settings-section'>
                        <h6>임계치 설정</h6>
                        <div className='bc-threshold-empty'>
                            임계치는 백엔드 설정 → <strong>위젯별 설정</strong> 탭에서
                            (data API, 바 차트) 단위로 중앙 관리됩니다. 알람 발생 여부는
                            BE 가 평가하여 모든 사용자에게 동일하게 반영됩니다.
                        </div>
                    </div>

                    {/* 5. 위젯 동작 — footer 의 통합 "적용" 이 size/interval/font 까지 일괄 처리 */}
                    <div className='settings-section'>
                        <h6>위젯 동작</h6>
                        <div className='widget-action-row widget-action-row-no-apply'>
                            <div className='widget-action-cell'>
                                <label>크기 (W × H)</label>
                                <div className='widget-action-size'>
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
                                    <span className='widget-action-size-sep'>×</span>
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
                            <div className='widget-action-cell'>
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
