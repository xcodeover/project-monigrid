import { createPortal } from "react-dom";
import {
    DEFAULT_CRITERIA,
    MAX_SERVERS,
    OS_OPTIONS,
} from "./serverResourceHelpers";
import { MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC } from "../pages/dashboardConstants";

/**
 * ServerResource widget settings modal extracted from ServerResourceCard (SRP).
 *
 * Pure presentational — receives every piece of state and every handler
 * as props. The parent ServerResourceCard remains the single source of
 * truth for draft state.
 *
 * NOTE: Does not close on outside click — only the ✕ button. Prevents
 * losing in-progress edits to credentials/criteria.
 */

const ServerSettingRow = ({
    server,
    expanded,
    onToggle,
    onChange,
    onDuplicate,
    onRemove,
}) => {
    const update = (field, value) => onChange(server.id, field, value);
    const updateCriteria = (field, value) => {
        const v = value === "" ? null : Number(value);
        onChange(server.id, "criteria", {
            ...(server.criteria || DEFAULT_CRITERIA),
            [field]: v,
        });
    };
    const isLinux = server.osType?.startsWith("linux");
    const isWindowsSsh = server.osType === "windows-ssh";
    const isWindowsWinrm = server.osType === "windows-winrm";
    const isWindows = server.osType === "windows";
    const isRemote =
        server.host && server.host !== "localhost" && server.host !== "127.0.0.1";
    const crit = server.criteria || DEFAULT_CRITERIA;
    const summary = `${server.label || "(이름없음)"} — ${server.host || "(호스트없음)"}${server.port ? `:${server.port}` : ""}`;

    return (
        <div className={`srv-setting-row${expanded ? " expanded" : ""}`}>
            <div className='srv-setting-summary' onClick={onToggle}>
                <span className='srv-setting-chevron'>
                    {expanded ? "▾" : "▸"}
                </span>
                <span className='srv-setting-summary-text'>{summary}</span>
                <span className='srv-setting-os-badge'>
                    {OS_OPTIONS.find((o) => o.value === server.osType)?.label ||
                        server.osType}
                </span>
                <div className='srv-setting-actions'>
                    <button
                        type='button'
                        className='srv-action-btn'
                        onClick={(e) => {
                            e.stopPropagation();
                            onDuplicate();
                        }}
                        title='복제'
                    >
                        ⧉
                    </button>
                    <button
                        type='button'
                        className='srv-action-btn danger'
                        onClick={(e) => {
                            e.stopPropagation();
                            onRemove();
                        }}
                        title='삭제'
                    >
                        ✕
                    </button>
                </div>
            </div>

            {expanded && (
                <div className='srv-setting-detail'>
                    <div className='srv-setting-grid-2'>
                        <label>
                            <span>서버 이름</span>
                            <input
                                type='text'
                                value={server.label}
                                onChange={(e) => update("label", e.target.value)}
                                placeholder='예: Web-01'
                            />
                        </label>
                        <label>
                            <span>OS 타입</span>
                            <select
                                value={server.osType}
                                onChange={(e) => update("osType", e.target.value)}
                            >
                                {OS_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                    <div className='srv-setting-grid-2'>
                        <label>
                            <span>호스트</span>
                            <input
                                type='text'
                                value={server.host}
                                onChange={(e) => update("host", e.target.value)}
                                placeholder='192.168.0.1'
                            />
                        </label>
                        <label>
                            <span>
                                {isLinux || isWindowsSsh
                                    ? "SSH 포트"
                                    : isWindowsWinrm
                                      ? "WinRM 포트"
                                      : "포트"}
                            </span>
                            <input
                                type='number'
                                value={server.port}
                                onChange={(e) => update("port", e.target.value)}
                                placeholder={isWindowsWinrm ? "5985" : "22"}
                            />
                        </label>
                    </div>
                    {(isLinux || isWindowsSsh) && (
                        <div className='srv-setting-grid-2'>
                            <label>
                                <span>SSH 사용자</span>
                                <input
                                    type='text'
                                    value={server.username}
                                    onChange={(e) =>
                                        update("username", e.target.value)
                                    }
                                />
                            </label>
                            <label>
                                <span>SSH 비밀번호</span>
                                <input
                                    type='password'
                                    value={server.password}
                                    onChange={(e) =>
                                        update("password", e.target.value)
                                    }
                                />
                            </label>
                        </div>
                    )}
                    {isWindowsWinrm && (
                        <>
                            <div className='srv-setting-grid-2'>
                                <label>
                                    <span>사용자명</span>
                                    <input
                                        type='text'
                                        value={server.username || ""}
                                        onChange={(e) =>
                                            update("username", e.target.value)
                                        }
                                        placeholder='Administrator'
                                    />
                                </label>
                                <label>
                                    <span>비밀번호</span>
                                    <input
                                        type='password'
                                        value={server.password || ""}
                                        onChange={(e) =>
                                            update("password", e.target.value)
                                        }
                                    />
                                </label>
                            </div>
                            <div className='srv-setting-grid-2'>
                                <label>
                                    <span>도메인 (선택)</span>
                                    <input
                                        type='text'
                                        value={server.domain || ""}
                                        onChange={(e) =>
                                            update("domain", e.target.value)
                                        }
                                        placeholder='MYDOMAIN'
                                    />
                                </label>
                                <label>
                                    <span>Transport</span>
                                    <select
                                        value={server.transport || "ntlm"}
                                        onChange={(e) =>
                                            update("transport", e.target.value)
                                        }
                                    >
                                        <option value='ntlm'>NTLM</option>
                                        <option value='basic'>Basic</option>
                                        <option value='kerberos'>Kerberos</option>
                                        <option value='credssp'>CredSSP</option>
                                    </select>
                                </label>
                            </div>
                        </>
                    )}
                    {isWindows && isRemote && (
                        <div className='srv-setting-grid-3'>
                            <label>
                                <span>사용자명</span>
                                <input
                                    type='text'
                                    value={server.username || ""}
                                    onChange={(e) =>
                                        update("username", e.target.value)
                                    }
                                    placeholder='Administrator'
                                />
                            </label>
                            <label>
                                <span>비밀번호</span>
                                <input
                                    type='password'
                                    value={server.password || ""}
                                    onChange={(e) =>
                                        update("password", e.target.value)
                                    }
                                />
                            </label>
                            <label>
                                <span>도메인 (선택)</span>
                                <input
                                    type='text'
                                    value={server.domain || ""}
                                    onChange={(e) =>
                                        update("domain", e.target.value)
                                    }
                                    placeholder='MYDOMAIN'
                                />
                            </label>
                        </div>
                    )}
                    <div className='srv-criteria-section'>
                        <span className='srv-criteria-title'>
                            Alert 임계값 (%)
                        </span>
                        <div className='srv-setting-grid-3'>
                            <label>
                                <span>CPU</span>
                                <input
                                    type='number'
                                    value={crit.cpu ?? ""}
                                    onChange={(e) =>
                                        updateCriteria("cpu", e.target.value)
                                    }
                                    placeholder='90'
                                    min='0'
                                    max='100'
                                />
                            </label>
                            <label>
                                <span>Memory</span>
                                <input
                                    type='number'
                                    value={crit.memory ?? ""}
                                    onChange={(e) =>
                                        updateCriteria("memory", e.target.value)
                                    }
                                    placeholder='85'
                                    min='0'
                                    max='100'
                                />
                            </label>
                            <label>
                                <span>Disk</span>
                                <input
                                    type='number'
                                    value={crit.disk ?? ""}
                                    onChange={(e) =>
                                        updateCriteria("disk", e.target.value)
                                    }
                                    placeholder='90'
                                    min='0'
                                    max='100'
                                />
                            </label>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const ServerResourceSettingsModal = ({
    title,
    onClose,
    // Title editor
    titleDraft,
    onTitleDraftChange,
    onTitleApply,
    // Size editor
    sizeDraft,
    sizeBounds,
    onSizeDraftChange,
    onSizeApply,
    // Interval editor
    intervalDraft,
    onIntervalDraftChange,
    onIntervalApply,
    // Server list editor
    serversDraft,
    expandedId,
    onToggleExpanded,
    onAddServer,
    onDuplicateServer,
    onRemoveServer,
    onUpdateServerField,
    onSave,
}) => {
    return createPortal(
        <div
            className='settings-overlay'
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
        >
            <div
                className='settings-popup srv-settings-popup'
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
            >
                <div className='settings-popup-header'>
                    <div>
                        <h5>서버 리소스 위젯 설정</h5>
                        <p>{title}</p>
                    </div>
                    <button
                        type='button'
                        className='close-settings-btn'
                        onClick={onClose}
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
                                    onChange={(e) =>
                                        onTitleDraftChange(e.target.value)
                                    }
                                />
                            </label>
                            <button
                                type='button'
                                className='size-preset-btn'
                                onClick={onTitleApply}
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
                                        onChange={(e) =>
                                            onSizeDraftChange((p) => ({
                                                ...p,
                                                w: e.target.value,
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
                                        onChange={(e) =>
                                            onSizeDraftChange((p) => ({
                                                ...p,
                                                h: e.target.value,
                                            }))
                                        }
                                    />
                                </label>
                                <button
                                    type='button'
                                    className='size-preset-btn'
                                    onClick={onSizeApply}
                                >
                                    적용
                                </button>
                            </div>
                        </div>
                        <div className='settings-section refresh-interval-section'>
                            <h6>갱신 주기 (초)</h6>
                            <div className='refresh-interval-editor'>
                                <label className='refresh-interval-input-label'>
                                    <span>Interval</span>
                                    <input
                                        type='number'
                                        min={MIN_REFRESH_INTERVAL_SEC}
                                        max={MAX_REFRESH_INTERVAL_SEC}
                                        value={intervalDraft}
                                        onChange={(e) =>
                                            onIntervalDraftChange(e.target.value)
                                        }
                                    />
                                </label>
                                <button
                                    type='button'
                                    className='size-preset-btn'
                                    onClick={onIntervalApply}
                                >
                                    적용
                                </button>
                            </div>
                        </div>
                    </div>
                    <div className='settings-section srv-list-section'>
                        <div className='srv-list-header'>
                            <h6>
                                서버 목록 ({serversDraft.length} / {MAX_SERVERS})
                            </h6>
                            <button
                                type='button'
                                className='size-preset-btn srv-add-btn'
                                onClick={onAddServer}
                                disabled={serversDraft.length >= MAX_SERVERS}
                            >
                                ＋ 서버 추가
                            </button>
                        </div>
                        {serversDraft.length === 0 ? (
                            <div className='srv-list-empty'>
                                <p>등록된 서버가 없습니다.</p>
                                <button
                                    type='button'
                                    className='size-preset-btn'
                                    onClick={onAddServer}
                                >
                                    첫 서버 추가
                                </button>
                            </div>
                        ) : (
                            <div className='srv-list-items'>
                                {serversDraft.map((srv) => (
                                    <ServerSettingRow
                                        key={srv.id}
                                        server={srv}
                                        expanded={expandedId === srv.id}
                                        onToggle={() => onToggleExpanded(srv.id)}
                                        onChange={onUpdateServerField}
                                        onDuplicate={() =>
                                            onDuplicateServer(srv)
                                        }
                                        onRemove={() => onRemoveServer(srv.id)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </div>
                <div className='srv-settings-footer'>
                    <button
                        type='button'
                        className='size-preset-btn'
                        onClick={onClose}
                    >
                        취소
                    </button>
                    <button
                        type='button'
                        className='size-preset-btn srv-save-btn'
                        onClick={onSave}
                    >
                        서버 목록 저장 ({serversDraft.length}개)
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default ServerResourceSettingsModal;
