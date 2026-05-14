import {
    WIDGET_TYPE_BAR_CHART,
    WIDGET_TYPE_HEALTH_CHECK,
    WIDGET_TYPE_LINE_CHART,
    WIDGET_TYPE_NETWORK_TEST,
    WIDGET_TYPE_SERVER_RESOURCE,
    WIDGET_TYPE_STATUS_LIST,
    WIDGET_TYPE_TABLE,
} from "./dashboardConstants";
import MonitorTargetPicker from "../components/MonitorTargetPicker";
import EndpointSelect from "../components/EndpointSelect";
import { IconClose, IconPlus } from "../components/icons";

/**
 * "API 추가" modal extracted from DashboardPage (SRP).
 *
 * Pure presentational — receives the form draft, change handler, and
 * submit/cancel callbacks. Parent owns the draft state.
 *
 * Server Resource / Network Test 위젯은 백엔드 설정의 "서버/네트워크 체크"
 * 탭에 등록된 모니터 대상 중에서만 골라 추가할 수 있다.
 */
const AddApiModal = ({
    form,
    onChange,
    onSubmit,
    onClose,
    monitorTargets = [],
    monitorTargetsError = null,
}) => {
    const isServer = form.type === WIDGET_TYPE_SERVER_RESOURCE;
    const isNetwork = form.type === WIDGET_TYPE_NETWORK_TEST;
    const isStatusList = form.type === WIDGET_TYPE_STATUS_LIST;
    const usesMonitorTargets = isServer || isNetwork || isStatusList;
    // generic 데이터 API 위젯 (table / line-chart / bar-chart) 은 BE 등록 API
    // 드롭다운에서 선택. health-check 는 임의 외부 URL 도 핑할 수 있어야 해서
    // text input 유지.
    const usesEndpointSelect =
        form.type === WIDGET_TYPE_TABLE ||
        form.type === WIDGET_TYPE_LINE_CHART ||
        form.type === WIDGET_TYPE_BAR_CHART;
    const selectedIds = Array.isArray(form.targetIds) ? form.targetIds : [];

    const monitorPickerTargetType = isServer
        ? "server_resource"
        : isNetwork
          ? "network"
          : "http_status";
    const monitorPickerLabel = isServer
        ? "서버 대상 선택"
        : isNetwork
          ? "네트워크 대상 선택"
          : "API 상태 대상 선택";

    return (
        <div className='modal-overlay'>
            <div
                className={`modal-content${usesMonitorTargets ? " modal-content-wide" : ""}`}
                onClick={(event) => event.stopPropagation()}
            >
                <div className='modal-header'>
                    <h3>위젯 추가</h3>
                    <button className='close-btn' onClick={onClose} aria-label='닫기'>
                        <IconClose size={16} />
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

                    {usesMonitorTargets ? (
                        <div className='form-group'>
                            <label>{monitorPickerLabel}</label>
                            <MonitorTargetPicker
                                targetType={monitorPickerTargetType}
                                selectedIds={selectedIds}
                                onChange={(ids) =>
                                    onChange({ ...form, targetIds: ids })
                                }
                                presetTargets={monitorTargets}
                                presetError={monitorTargetsError}
                            />
                            <span className='form-hint'>
                                선택 {selectedIds.length}개 — 수집 주기/접속 정보는 백엔드 설정에서 관리됩니다.
                            </span>
                        </div>
                    ) : usesEndpointSelect ? (
                        <div className='form-group'>
                            <label htmlFor='api-endpoint'>엔드포인트 (데이터 API)</label>
                            <EndpointSelect
                                id='api-endpoint'
                                value={form.endpoint}
                                onChange={(next) =>
                                    onChange({ ...form, endpoint: next })
                                }
                            />
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
                                onChange({
                                    ...form,
                                    type: event.target.value,
                                    targetIds: [],
                                })
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
                    <button
                        className='primary-btn'
                        onClick={onSubmit}
                        disabled={
                            usesMonitorTargets && selectedIds.length === 0
                        }
                    >
                        추가
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AddApiModal;
