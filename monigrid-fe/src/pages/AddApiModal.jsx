import {
    WIDGET_TYPE_BAR_CHART,
    WIDGET_TYPE_HEALTH_CHECK,
    WIDGET_TYPE_LINE_CHART,
    WIDGET_TYPE_NETWORK_TEST,
    WIDGET_TYPE_SERVER_RESOURCE,
    WIDGET_TYPE_STATUS_LIST,
    WIDGET_TYPE_TABLE,
} from "./dashboardConstants";

/**
 * "API 추가" modal extracted from DashboardPage (SRP).
 *
 * Pure presentational — receives the form draft, change handler, and
 * submit/cancel callbacks. Parent owns the draft state.
 */
const AddApiModal = ({ form, onChange, onSubmit, onClose }) => {
    return (
        <div className='modal-overlay'>
            <div
                className='modal-content'
                onClick={(event) => event.stopPropagation()}
            >
                <div className='modal-header'>
                    <h3>API 엔드포인트 추가</h3>
                    <button className='close-btn' onClick={onClose}>
                        ✕
                    </button>
                </div>

                <div className='modal-body'>
                    <div className='form-group'>
                        <label htmlFor='api-title'>제목</label>
                        <input
                            id='api-title'
                            type='text'
                            placeholder='예: CoinTrader Status'
                            value={form.title}
                            onChange={(event) =>
                                onChange({ ...form, title: event.target.value })
                            }
                        />
                    </div>

                    {form.type === WIDGET_TYPE_STATUS_LIST ? (
                        <div className='form-group'>
                            <label htmlFor='api-endpoints-text'>
                                엔드포인트 목록
                            </label>
                            <textarea
                                id='api-endpoints-text'
                                className='config-json-textarea'
                                placeholder={
                                    "한 줄에 하나씩 입력하세요.\nlabel | https://example.com/health"
                                }
                                value={form.endpointsText}
                                onChange={(event) =>
                                    onChange({
                                        ...form,
                                        endpointsText: event.target.value,
                                    })
                                }
                            />
                        </div>
                    ) : form.type === WIDGET_TYPE_NETWORK_TEST ||
                      form.type === WIDGET_TYPE_SERVER_RESOURCE ? (
                        <div className='form-group'>
                            <label htmlFor='api-endpoint'>엔드포인트 URL</label>
                            <input
                                id='api-endpoint'
                                type='text'
                                value={
                                    form.type === WIDGET_TYPE_NETWORK_TEST
                                        ? "/dashboard/network-test"
                                        : "/dashboard/server-resources"
                                }
                                disabled
                                className='input-disabled'
                            />
                            <span className='form-hint'>
                                백엔드 고정 엔드포인트 (자동 설정)
                            </span>
                        </div>
                    ) : (
                        <div className='form-group'>
                            <label htmlFor='api-endpoint'>엔드포인트 URL</label>
                            <input
                                id='api-endpoint'
                                type='text'
                                placeholder='예: http://localhost:5000/api/status'
                                value={form.endpoint}
                                onChange={(event) =>
                                    onChange({
                                        ...form,
                                        endpoint: event.target.value,
                                    })
                                }
                            />
                        </div>
                    )}

                    <div className='form-group'>
                        <label htmlFor='api-widget-type'>위젯 타입</label>
                        <select
                            id='api-widget-type'
                            value={form.type}
                            onChange={(event) =>
                                onChange({ ...form, type: event.target.value })
                            }
                        >
                            <option value={WIDGET_TYPE_TABLE}>
                                데이터 테이블
                            </option>
                            <option value={WIDGET_TYPE_HEALTH_CHECK}>
                                웹서버 상태 체크 (HTTP 200)
                            </option>
                            <option value={WIDGET_TYPE_LINE_CHART}>
                                시간대별 추이 (라인차트)
                            </option>
                            <option value={WIDGET_TYPE_BAR_CHART}>
                                기준별 수량 (바차트)
                            </option>
                            <option value={WIDGET_TYPE_STATUS_LIST}>
                                API 상태 리스트 (다중 200 체크)
                            </option>
                            <option value={WIDGET_TYPE_NETWORK_TEST}>
                                네트워크 테스트 (Ping/Telnet)
                            </option>
                            <option value={WIDGET_TYPE_SERVER_RESOURCE}>
                                서버 리소스 모니터링 (CPU/Memory/Disk)
                            </option>
                        </select>
                    </div>
                </div>

                <div className='modal-footer'>
                    <button className='secondary-btn' onClick={onClose}>
                        취소
                    </button>
                    <button className='primary-btn' onClick={onSubmit}>
                        추가
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AddApiModal;
