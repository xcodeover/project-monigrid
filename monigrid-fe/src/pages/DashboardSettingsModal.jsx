import { SOUND_TYPES } from "../store/alarmStore";
import {
    DEFAULT_CONTENT_ZOOM,
    MAX_CONTENT_ZOOM,
    MIN_CONTENT_ZOOM,
    ZOOM_STEP,
} from "./dashboardConstants";

/**
 * "대시보드 설정" modal extracted from DashboardPage (SRP).
 *
 * Pure presentational — receives all draft state and handlers as props.
 * Owns no state of its own.
 */
const DashboardSettingsModal = ({
    onClose,
    apiBaseUrlDraft,
    apiBaseUrlSaved,
    onApiBaseUrlDraftChange,
    onApplyApiBaseUrl,
    fontSizeDraft,
    onFontSizeDraftChange,
    zoomDraft,
    onZoomDraftChange,
    onApplyDashboardSettings,
    alarmSound,
    soundEnabled,
    onSetAlarmSound,
    onSetSoundEnabled,
    configJsonDraft,
    onConfigJsonDraftChange,
    onConfigFileChange,
    configErrorMessage,
    onExportConfig,
    onImportConfigFromText,
}) => {
    return (
        <div className='modal-overlay'>
            <div
                className='modal-content dashboard-settings-modal'
                onClick={(event) => event.stopPropagation()}
            >
                <div className='modal-header'>
                    <h3>대시보드 설정</h3>
                    <button className='close-btn' onClick={onClose}>
                        ✕
                    </button>
                </div>

                <div className='modal-body'>
                    <div className='settings-row-2col'>
                        <div className='form-group'>
                            <label htmlFor='api-base-url'>API 서버 URL</label>
                            <div className='inline-input-group'>
                                <input
                                    id='api-base-url'
                                    type='text'
                                    value={apiBaseUrlDraft}
                                    onChange={(e) =>
                                        onApiBaseUrlDraftChange(e.target.value)
                                    }
                                    placeholder='http://127.0.0.1:5000'
                                    style={{ flex: 1 }}
                                />
                                <button
                                    className='secondary-btn'
                                    onClick={onApplyApiBaseUrl}
                                    title='적용 시 페이지 새로고침'
                                >
                                    {apiBaseUrlSaved ? "✓" : "적용"}
                                </button>
                            </div>
                        </div>

                        <div className='form-group'>
                            <label htmlFor='widget-font-size'>
                                폰트 크기 (px)
                            </label>
                            <div className='inline-input-group'>
                                <input
                                    id='widget-font-size'
                                    type='number'
                                    min='10'
                                    max='18'
                                    value={fontSizeDraft}
                                    onChange={(event) =>
                                        onFontSizeDraftChange(event.target.value)
                                    }
                                    style={{ width: "64px" }}
                                />
                                <button
                                    className='secondary-btn'
                                    onClick={onApplyDashboardSettings}
                                >
                                    적용
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className='form-group'>
                        <label>위젯 영역 확대/축소 ({zoomDraft}%)</label>
                        <div className='zoom-control-row'>
                            <button
                                className='toolbar-btn'
                                title='축소'
                                onClick={() =>
                                    onZoomDraftChange((prev) =>
                                        Math.max(
                                            MIN_CONTENT_ZOOM,
                                            Number(prev) - ZOOM_STEP,
                                        ),
                                    )
                                }
                            >
                                −
                            </button>
                            <input
                                id='content-zoom'
                                type='range'
                                min={MIN_CONTENT_ZOOM}
                                max={MAX_CONTENT_ZOOM}
                                step={ZOOM_STEP}
                                value={zoomDraft}
                                onChange={(event) =>
                                    onZoomDraftChange(Number(event.target.value))
                                }
                                className='zoom-range-input'
                            />
                            <button
                                className='toolbar-btn'
                                title='확대'
                                onClick={() =>
                                    onZoomDraftChange((prev) =>
                                        Math.min(
                                            MAX_CONTENT_ZOOM,
                                            Number(prev) + ZOOM_STEP,
                                        ),
                                    )
                                }
                            >
                                +
                            </button>
                            <button
                                className='secondary-btn'
                                onClick={onApplyDashboardSettings}
                            >
                                적용
                            </button>
                            <button
                                className='toolbar-btn'
                                title='초기화'
                                onClick={() =>
                                    onZoomDraftChange(DEFAULT_CONTENT_ZOOM)
                                }
                            >
                                ↺
                            </button>
                        </div>
                        {zoomDraft !== 100 && (
                            <span className='zoom-warning'>
                                위젯 영역이 100%가 아닐 때 각 위젯의 버튼은
                                비활성화됩니다.
                            </span>
                        )}
                    </div>

                    <div className='form-group'>
                        <label>알람 경고음</label>
                        <div className='alarm-sound-row'>
                            {SOUND_TYPES.map((type) => (
                                <button
                                    key={type}
                                    className={`alarm-sound-btn${alarmSound === type && soundEnabled ? " active" : ""}`}
                                    onClick={() => {
                                        onSetAlarmSound(type);
                                        onSetSoundEnabled(true);
                                    }}
                                >
                                    {type === "beep"
                                        ? "♩ Beep"
                                        : type === "siren"
                                          ? "⚡ Siren"
                                          : "⊛ Pulse"}
                                </button>
                            ))}
                            <button
                                className={`alarm-sound-btn${!soundEnabled ? " active muted" : ""}`}
                                onClick={() => onSetSoundEnabled(false)}
                            >
                                ⊘ Mute
                            </button>
                        </div>
                    </div>

                    <div className='form-group'>
                        <label htmlFor='config-file-upload'>
                            설정 JSON 파일 로드
                        </label>
                        <input
                            id='config-file-upload'
                            type='file'
                            accept='application/json,.json'
                            onChange={onConfigFileChange}
                        />
                    </div>

                    <div className='form-group'>
                        <label htmlFor='config-json-text'>
                            설정 JSON 편집/붙여넣기
                        </label>
                        <textarea
                            id='config-json-text'
                            className='config-json-textarea'
                            value={configJsonDraft}
                            onChange={(event) =>
                                onConfigJsonDraftChange(event.target.value)
                            }
                            placeholder='설정 JSON을 붙여넣거나 파일 로드 후 편집하세요.'
                        />
                        {configErrorMessage && (
                            <p className='config-error-text'>
                                {configErrorMessage}
                            </p>
                        )}
                    </div>
                </div>

                <div className='modal-footer'>
                    <button className='secondary-btn' onClick={onExportConfig}>
                        JSON 저장
                    </button>
                    <button
                        className='primary-btn'
                        onClick={onImportConfigFromText}
                        disabled={!configJsonDraft.trim()}
                    >
                        JSON 로드
                    </button>
                </div>
            </div>
        </div>
    );
};

export default DashboardSettingsModal;
