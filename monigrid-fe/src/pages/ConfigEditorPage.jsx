import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { configService } from "../services/api";
import { useAuthStore } from "../store/authStore";
import { useDirtyList } from "../hooks/useDirtyList";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import DirtyListSummary from "../components/DirtyListSummary";
import PasswordInput from "../components/PasswordInput";
import MonitorTargetsTab from "../components/MonitorTargetsTab";
import TimemachineSettingsTab from "../components/TimemachineSettingsTab";
import BackendConfigPasswordPrompt from "../components/BackendConfigPasswordPrompt";
import { ConfigFooterContext } from "./configFooterContext";
import {
    IconArrowLeft,
    IconClose,
    IconCode,
    IconCopy,
    IconPlus,
    IconRefresh,
    IconTrash,
} from "../components/icons";

// SQL 편집기와 임계치 편집기는 prismjs / react-simple-code-editor 등을 끌고 와서
// 무겁다 — ConfigEditorPage 진입 직후가 아니라 row 의 버튼을 누른 시점에만 로드.
const SqlEditorModal = lazy(() => import("../components/SqlEditorModal"));
const ApiThresholdsEditorModal = lazy(() => import("../components/ApiThresholdsEditorModal"));
import AuditCells from "../components/AuditCells.jsx";
import "../components/ConfigEditorModal.css";
import "./ConfigEditorPage.css";

/* ── Constants & helpers ───────────────────────────────────────── */

const OS_TYPE_LABELS = {
    oracle: "Oracle",
    mariadb: "MariaDB",
    mssql: "MS SQL Server",
};

const LOG_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"];

// 페이지 인증 게이트 — 새로고침/직접 진입까지 막는다.
// sessionStorage 만 사용해 탭이 닫히면 재인증을 강제한다.
const AUTH_FLAG_KEY = "monigrid:configPage:verified";

const incrementLabel = (label) => {
    const text = String(label || "");
    const m = text.match(/^(.*?)(\d+)$/);
    if (m) return m[1] + (parseInt(m[2], 10) + 1);
    return text ? `${text}-2` : "";
};

const nextAvailable = (label, existing) => {
    let candidate = incrementLabel(label);
    while (candidate && existing.has(candidate)) {
        candidate = incrementLabel(candidate);
    }
    return candidate;
};

const insertAfter = (arr, idx, item) => [
    ...arr.slice(0, idx + 1),
    item,
    ...arr.slice(idx + 1),
];

const shiftCollapsedForInsert = (prev, idx) => {
    const next = {};
    Object.keys(prev).forEach((k) => {
        const i = Number(k);
        if (i <= idx) next[i] = prev[k];
        else next[i + 1] = prev[k];
    });
    next[idx + 1] = false;
    return next;
};

/* ── Grid editors ──────────────────────────────────────────────
 * Phase 2 revised UX (요구 1): DB 연결 / 데이터 API 는 collapsible card 가
 * 아니라 스프레드시트형 grid row 로 한 눈에 비교하며 inline 편집한다.
 *
 * 구조: pane-body 가 (가로) 스크롤하는 grid 컨테이너. 첫 행은 sticky 헤더,
 * 나머지 행은 입력 셀들. 컬럼 폭은 grid-template-columns 로 명시해 좁은
 * 입력(ID/주기/체크박스)은 짧게, 긴 입력(JDBC URL)은 넓게.
 *  ───────────────────────────────────────────────────────────── */

const ConnectionRow = ({ conn, index, onChange, onRemove, onDuplicate }) => {
    const update = (field, value) => onChange(index, { ...conn, [field]: value });
    return (
        <div className="cfg-grid-row">
            <span className="cfg-grid-no">{index + 1}</span>
            <input
                type="text"
                value={conn.id || ""}
                onChange={(e) => update("id", e.target.value)}
                placeholder="oracle-main"
            />
            <select
                value={conn.db_type || ""}
                onChange={(e) => update("db_type", e.target.value)}
            >
                <option value="oracle">Oracle</option>
                <option value="mariadb">MariaDB</option>
                <option value="mssql">MS SQL Server</option>
            </select>
            <input
                type="text"
                value={conn.jdbc_driver_class || ""}
                onChange={(e) => update("jdbc_driver_class", e.target.value)}
                placeholder="oracle.jdbc.OracleDriver"
            />
            <input
                type="text"
                value={conn.jdbc_url || ""}
                onChange={(e) => update("jdbc_url", e.target.value)}
                placeholder="jdbc:oracle:thin:@//localhost:1521/XEPDB1"
            />
            <input
                type="text"
                value={conn.username || ""}
                onChange={(e) => update("username", e.target.value)}
                placeholder="user"
            />
            <PasswordInput
                value={conn.password || ""}
                onChange={(e) => update("password", e.target.value)}
            />
            <div className="cfg-grid-actions">
                <button
                    type="button"
                    className="cfg-duplicate-btn"
                    onClick={() => onDuplicate(index)}
                    title="복제"
                >
                    <IconCopy size={14} />
                </button>
                <button
                    type="button"
                    className="cfg-remove-btn"
                    onClick={() => onRemove(index)}
                    title="삭제"
                >
                    <IconTrash size={14} />
                </button>
            </div>
        </div>
    );
};

const ConnectionsGrid = ({ connections, onChange, onRemove, onDuplicate }) => (
    <div className="cfg-grid cfg-grid-connections" role="grid">
        <div className="cfg-grid-row cfg-grid-head" role="row">
            <span>No</span>
            <span>Connection ID</span>
            <span>DB 타입</span>
            <span>JDBC Driver Class</span>
            <span>JDBC URL</span>
            <span>사용자</span>
            <span>비밀번호</span>
            <span></span>
        </div>
        {connections.map((conn, i) => (
            <ConnectionRow
                key={i}
                conn={conn}
                index={i}
                onChange={onChange}
                onRemove={onRemove}
                onDuplicate={onDuplicate}
            />
        ))}
    </div>
);

const ApiRow = ({
    api,
    index,
    rowStateClass,
    validationError,
    connectionIds,
    onUpdate,
    onRemove,
    onRestore,
    onDuplicate,
    onEditSql,
    onEditThresholds,
    thresholdsCount,
}) => {
    const update = (field, value) => onUpdate({ ...api, [field]: value });
    const isDeleted = !!api._isDeleted;
    const isPersisted = !api._isNew && !!api.id; // 신규 행은 저장 후에야 SQL/임계치 편집 가능

    const rowClasses = [
        "cfg-grid-row",
        rowStateClass || "",
        validationError ? "row-state-invalid" : "",
        isDeleted ? "cfg-grid-row-deleted" : "",
    ].filter(Boolean).join(" ");

    return (
        <>
            <div className={rowClasses} data-row-id={api.id}>
                <span className="cfg-grid-no">{index + 1}</span>
                <label className="cfg-toggle" title={api.enabled ? "활성" : "비활성"}>
                    <input
                        type="checkbox"
                        checked={api.enabled ?? false}
                        onChange={(e) => update("enabled", e.target.checked)}
                        disabled={isDeleted}
                    />
                    <span className="cfg-toggle-slider" />
                </label>
                <input
                    type="text"
                    value={api.id || ""}
                    onChange={(e) => update("id", e.target.value)}
                    placeholder="status"
                    disabled={!api._isNew || isDeleted}
                />
                <input
                    type="text"
                    value={api.rest_api_path || ""}
                    onChange={(e) => update("rest_api_path", e.target.value)}
                    placeholder="/api/status"
                    disabled={isDeleted}
                />
                <select
                    value={api.connection_id || ""}
                    onChange={(e) => update("connection_id", e.target.value)}
                    disabled={isDeleted}
                >
                    <option value="">-- 선택 --</option>
                    {connectionIds.map((id) => (
                        <option key={id} value={id}>{id}</option>
                    ))}
                </select>
                <input
                    type="text"
                    value={api.sql_id || ""}
                    onChange={(e) => update("sql_id", e.target.value)}
                    placeholder="status"
                    disabled={isDeleted}
                />
                <input
                    type="number"
                    value={api.refresh_interval_sec ?? 5}
                    onChange={(e) => update("refresh_interval_sec", Number(e.target.value))}
                    min="1"
                    max="3600"
                    disabled={isDeleted}
                />
                <AuditCells updatedAt={api.updated_at} updatedBy={api.updated_by} />
                <div className="cfg-grid-actions">
                    {/* SQL 편집 (요구 ②): row 의 sqlId 로 SQL 편집기 모달 진입 */}
                    {!isDeleted && (
                        <button
                            type="button"
                            className="cfg-row-action-btn"
                            onClick={() => onEditSql?.(api)}
                            disabled={!isPersisted}
                            title={isPersisted ? "SQL 편집" : "신규 행은 저장 후 SQL 편집 가능"}
                        >
                            <IconCode size={14} />
                        </button>
                    )}
                    {/* 임계치 편집 (요구 ①): row 단위 alarm thresholds */}
                    {!isDeleted && (
                        <button
                            type="button"
                            className="cfg-row-action-btn cfg-thresholds-btn"
                            onClick={() => onEditThresholds?.(api)}
                            disabled={!isPersisted}
                            title={
                                isPersisted
                                    ? (thresholdsCount > 0 ? `알람 임계치 편집 (${thresholdsCount}개 정의됨)` : "알람 임계치 편집")
                                    : "신규 행은 저장 후 임계치 편집 가능"
                            }
                        >
                            <span aria-hidden style={{ fontSize: 12, fontWeight: 700 }}>⚠</span>
                            {!api._isNew && thresholdsCount > 0 && (
                                <span
                                    className="cfg-thresholds-count-badge"
                                    aria-label={`임계치 ${thresholdsCount}개`}
                                >
                                    {thresholdsCount}
                                </span>
                            )}
                        </button>
                    )}
                    {!isDeleted && (
                        <button
                            type="button"
                            className="cfg-duplicate-btn"
                            onClick={onDuplicate}
                            title="복제"
                        >
                            <IconCopy size={14} />
                        </button>
                    )}
                    {isDeleted ? (
                        <button
                            type="button"
                            className="row-restore-btn"
                            onClick={onRestore}
                            title="복원"
                        >
                            ↺
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="cfg-remove-btn"
                            onClick={onRemove}
                            title="삭제"
                        >
                            <IconTrash size={14} />
                        </button>
                    )}
                </div>
            </div>
            {validationError && (
                <div className="cfg-grid-error-row">{validationError}</div>
            )}
        </>
    );
};

const ApisGrid = ({
    items,
    apiList,
    connectionIds,
    onUpdate,
    onRemove,
    onRestore,
    onDuplicate,
    onEditSql,
    onEditThresholds,
    thresholdsCountByApiId,
}) => (
    <div className="cfg-grid cfg-grid-apis" role="grid">
        <div className="cfg-grid-row cfg-grid-head" role="row">
            <span>No</span>
            <span>활성</span>
            <span>API ID</span>
            <span>REST API Path</span>
            <span>Connection</span>
            <span>SQL ID</span>
            <span>주기(초)</span>
            <span>수정 시각</span>
            <span>편집자</span>
            <span></span>
        </div>
        {items.map((api, idx) => {
            const state = apiList.rowState(api.id);
            const rowStateClass =
                state === "new" ? "row-state-new"
                : state === "modified" ? "row-state-modified"
                : state === "deleted" ? "row-state-deleted"
                : "";
            const valError = apiList.validationError(api.id);
            const tCount = thresholdsCountByApiId
                ? (thresholdsCountByApiId[api.id] || 0)
                : 0;
            return (
                <ApiRow
                    key={api.id}
                    api={api}
                    index={idx}
                    rowStateClass={rowStateClass}
                    validationError={valError}
                    connectionIds={connectionIds}
                    onUpdate={(next) => onUpdate(api.id, next)}
                    onRemove={() => onRemove(api.id)}
                    onRestore={() => onRestore(api.id)}
                    onDuplicate={() => onDuplicate(api.id)}
                    onEditSql={onEditSql}
                    onEditThresholds={onEditThresholds}
                    thresholdsCount={tCount}
                />
            );
        })}
    </div>
);

/* ── Endpoint validator ───────────────────────────────────────── */

function buildEndpointValidator(allItems) {
    return (item) => {
        const id = (item.id || "").trim();
        if (!id) return "API ID는 필수입니다.";
        if (!/^[a-zA-Z0-9_]+$/.test(id)) return "API ID는 영문자·숫자·밑줄만 허용됩니다.";

        const dupCount = allItems.filter(
            (it) => !it._isDeleted && (it.id || "").trim() === id && it !== item,
        ).length;
        if (dupCount > 0) return "API ID가 중복됩니다.";

        const path = (item.rest_api_path || "").trim();
        if (!path) return "REST API Path는 필수입니다.";
        if (!path.startsWith("/")) return "REST API Path는 '/'로 시작해야 합니다.";

        if (!item.sql_id || !(item.sql_id + "").trim()) return "SQL ID는 필수입니다.";

        const timeout = item.refresh_interval_sec;
        if (timeout === undefined || timeout === null || timeout === "") return "갱신 주기(초)는 필수입니다.";
        if (!Number.isInteger(Number(timeout)) || Number(timeout) < 1) return "갱신 주기(초)는 1 이상의 정수여야 합니다.";

        return null;
    };
}

/* ══════════════════════════════════════════════════════════════════
   ConfigEditorPage — main page component
   ══════════════════════════════════════════════════════════════════ */

/**
 * 탭 navigation (요구 ②):
 *  - "위젯별 설정" 은 그룹 탭. 활성화 시 sub-tab bar 가 표시되어 데이터 API /
 *    서버 리소스 / 네트워크 체크 / API 상태 중 하나를 선택.
 *  - 임계치는 더 이상 단독 탭(thresholds-only) 이 아니라 각 sub-tab 의 항목
 *    행에서 직접 설정한다.
 */
const TABS = [
    { key: "general", label: "기본" },
    { key: "connections", label: "DB 연결" },
    { key: "widgetGroup", label: "위젯별 설정" },
    { key: "timemachine", label: "타임머신" },
];

const WIDGET_SUB_TABS = [
    { key: "apis", label: "데이터 API" },
    { key: "serverTargets", label: "서버 리소스" },
    { key: "networkTargets", label: "네트워크 체크" },
    { key: "httpStatusTargets", label: "API 상태" },
];

// 페이지 footer 저장 버튼 동작 분기: 자체 binding (모니터/타임머신/데이터 API
// dirty list) 가 등록된 활성 탭은 그 binding 의 save() 를 호출, 그 외(기본/
// DB 연결/JSON) 는 ConfigEditorPage 의 handleSave (PUT /dashboard/config).
const SELF_BINDING_SUB_TABS = new Set([
    "serverTargets", "networkTargets", "httpStatusTargets",
]);
const SELF_BINDING_TOP_TABS = new Set(["timemachine"]);

export default function ConfigEditorPage() {
    const navigate = useNavigate();
    const user = useAuthStore((s) => s.user);
    const isAdmin =
        user?.role === "admin" ||
        String(user?.username || "").trim().toLowerCase() === "admin";

    // 비밀번호 게이트 상태
    const [verified, setVerified] = useState(() => {
        try {
            return sessionStorage.getItem(AUTH_FLAG_KEY) === "1";
        } catch {
            return false;
        }
    });

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [successMsg, setSuccessMsg] = useState(null);
    const [activeTab, setActiveTab] = useState("general");
    const [activeWidgetSubTab, setActiveWidgetSubTab] = useState("apis");

    // 데이터 API row 에서 진입하는 SQL 편집기 / 임계치 편집기 (요구 ②/①)
    const [sqlEditorOpen, setSqlEditorOpen] = useState(false);
    const [sqlEditorInitialApiId, setSqlEditorInitialApiId] = useState(null);
    const [thresholdsEditorApi, setThresholdsEditorApi] = useState(null);

    // 데이터 API row 의 thresholds 카운트 표시용 카탈로그.
    // 운영자가 thresholds 편집 모달에서 저장 시 reloadWidgetConfigs() 로 갱신.
    const [widgetConfigsByApiId, setWidgetConfigsByApiId] = useState({});
    const reloadWidgetConfigs = useCallback(async () => {
        try {
            const { widgetConfigService } = await import("../services/api");
            const data = await widgetConfigService.list();
            const map = {};
            const list = Array.isArray(data?.configs) ? data.configs : [];
            for (const c of list) {
                // (api_id, widget_type) 별로 저장되지만 row 의 카운트 표시는
                // widget_type=table 한 군데를 단일 출처로 본다 (UX 단순화).
                if (!c?.apiId || c.widgetType !== "table") continue;
                const ths = c.config?.thresholds;
                map[c.apiId] = Array.isArray(ths) ? ths.length : 0;
            }
            setWidgetConfigsByApiId(map);
        } catch {
            /* swallow — 카운트 표시 실패는 row 동작에 영향 없음 */
        }
    }, []);
    useEffect(() => { reloadWidgetConfigs(); }, [reloadWidgetConfigs]);

    // 데이터 API sub-tab 의 새로고침 버튼 정의는 apiList / loadConfig 가
    // 모두 선언된 뒤에 위치해야 한다 (TDZ 회피). 이곳에는 ref 만 미리 두고
    // 실제 useCallback 은 아래 apiList 정의 후 부분에서 만든다.
    const loadConfigRef = useRef();

    const handleEditSql = useCallback((api) => {
        if (!api?.id) return;
        setSqlEditorInitialApiId(api.id);
        setSqlEditorOpen(true);
    }, []);
    const handleCloseSql = useCallback(() => {
        setSqlEditorOpen(false);
        setSqlEditorInitialApiId(null);
    }, []);
    const handleEditThresholds = useCallback((api) => {
        if (!api?.id) return;
        setThresholdsEditorApi({ apiId: api.id, title: api.title || api.id });
    }, []);
    const handleCloseThresholds = useCallback(() => setThresholdsEditorApi(null), []);
    const handleThresholdsSaved = useCallback(() => {
        reloadWidgetConfigs();
    }, [reloadWidgetConfigs]);

    // 페이지 footer 단일 저장 버튼 (요구 ①): 자식 탭이 자기 save 핸들러를
    // 등록. activeBindingKey 는 현재 어느 탭이 footer 를 점유하는지 추적.
    const [tabBindings, setTabBindings] = useState({});
    const registerTabBinding = useCallback((key, binding) => {
        if (!key) return;
        setTabBindings((prev) => {
            if (binding == null) {
                if (!(key in prev)) return prev;
                const next = { ...prev };
                delete next[key];
                return next;
            }
            return { ...prev, [key]: binding };
        });
    }, []);
    const footerCtxValue = useMemo(
        () => ({
            register: (binding) => {
                // 호출 측이 key 를 모르는 경우(컴포넌트가 자기 식별자 모름),
                // binding 안에 _key 를 넣게 한다. binding === null 이면 _key
                // 만 가진 빈 binding 으로 호출하도록 가이드 — 단순화를 위해
                // register 호출 시 두 인자 (key, binding) 패턴 대신 객체에
                // _key 를 강제한다.
                if (!binding) return; // child sets to null via cleanup; ignored
                const k = binding._key;
                if (!k) return;
                registerTabBinding(k, binding);
            },
            unregister: (key) => registerTabBinding(key, null),
        }),
        [registerTabBinding],
    );

    // 활성 탭 → 어떤 binding 을 사용할지 결정. 위젯 그룹의 sub-tab 도 고려.
    const activeBindingKey = useMemo(() => {
        if (activeTab === "widgetGroup") {
            if (activeWidgetSubTab === "apis") return "apis-list";
            if (SELF_BINDING_SUB_TABS.has(activeWidgetSubTab)) return activeWidgetSubTab;
        }
        if (SELF_BINDING_TOP_TABS.has(activeTab)) return activeTab;
        return null;
    }, [activeTab, activeWidgetSubTab]);
    const activeBinding = activeBindingKey ? tabBindings[activeBindingKey] : null;

    // Draft state
    const [server, setServer] = useState({});
    const [auth, setAuth] = useState({});
    const [logging, setLogging] = useState({});
    const [connections, setConnections] = useState([]);
    const [globalJdbcJars, setGlobalJdbcJars] = useState("");
    const [sqlValidation, setSqlValidation] = useState({});

    const [collapsedConns, setCollapsedConns] = useState({});
    const [collapsedApis, setCollapsedApis] = useState({});

    const [jsonMode, setJsonMode] = useState(false);
    const [rawJson, setRawJson] = useState("");

    // Monitor 탭 dirty 신호 (children → parent aggregation)
    const [monitorDirtyMap, setMonitorDirtyMap] = useState({});
    const handleMonitorDirtyChange = useCallback((targetType, isDirty, count) => {
        setMonitorDirtyMap((prev) => {
            if (prev[targetType]?.isDirty === isDirty && prev[targetType]?.count === count) {
                return prev;
            }
            return { ...prev, [targetType]: { isDirty, count } };
        });
    }, []);
    const monitorTotalDirty = Object.values(monitorDirtyMap).reduce(
        (sum, v) => sum + (v?.count || 0),
        0,
    );

    // 데이터 API dirty list
    const visibleApiItemsRef = useRef([]);
    const endpointValidator = useCallback(
        (item) => buildEndpointValidator(visibleApiItemsRef.current)(item),
        [],
    );
    const endpointNewItemFactory = useCallback(
        () => ({
            id: "",
            rest_api_path: "/api/",
            connection_id: "",
            sql_id: "",
            refresh_interval_sec: 5,
            enabled: true,
        }),
        [],
    );
    const apiList = useDirtyList({
        initial: [],
        idKey: "id",
        newItemFactory: endpointNewItemFactory,
        validator: endpointValidator,
    });
    visibleApiItemsRef.current = apiList.visibleItems;

    // 데이터 API sub-tab 의 새로고침 — apiList 와 loadConfig 두 정의가 모두
    // 끝난 뒤에 위치해야 deps 평가가 TDZ 에 걸리지 않는다.
    const handleRefreshApis = useCallback(() => {
        if (apiList.isDirty) {
            const ok = window.confirm(
                `데이터 API 미저장 변경 ${apiList.dirtyCount.total}건이 있습니다.\n` +
                `폐기하고 서버 상태를 다시 불러올까요?`,
            );
            if (!ok) return;
        }
        // loadConfig 는 본 컴포넌트 함수 본문 더 아래에서 const 로 선언되므로
        // 클로저로 직접 참조하지 못한다(TDZ) → ref 우회.
        loadConfigRef.current?.();
        reloadWidgetConfigs();
    }, [apiList.isDirty, apiList.dirtyCount.total, reloadWidgetConfigs]);

    // 페이지 전체 dirty
    const isPageDirty = apiList.isDirty || monitorTotalDirty > 0;
    const pageDirtyCount = apiList.dirtyCount.total + monitorTotalDirty;

    // 닫기 가드 — 페이지 이탈 시 navigate
    const closeToDashboard = useCallback(() => {
        navigate("/dashboard");
    }, [navigate]);

    const guardedClose = useUnsavedChangesGuard({
        isDirty: isPageDirty,
        dirtyCount: pageDirtyCount,
        onClose: closeToDashboard,
        isBlocked: saving,
    });

    /* ── 데이터 로드 ─────────────────────────────────────────── */
    const loadConfig = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await configService.getConfig();
            setServer(data.server || {});
            setAuth(data.auth || {});
            setLogging(data.logging || {});
            const loadedConnections = Array.isArray(data.connections) ? data.connections : [];
            const loadedApis = Array.isArray(data.apis) ? data.apis : [];
            setConnections(loadedConnections);
            setCollapsedConns(
                Object.fromEntries(loadedConnections.map((_, i) => [i, true])),
            );
            apiList.reset(loadedApis);
            setCollapsedApis(
                Object.fromEntries(loadedApis.map((a) => [a.id, true])),
            );
            setGlobalJdbcJars(data.global_jdbc_jars || "");
            setSqlValidation(data.sql_validation || {});
            setRawJson(JSON.stringify(data, null, 2));
        } catch (e) {
            setError(e?.response?.data?.message || e?.message || "설정을 불러오지 못했습니다.");
        } finally {
            setLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // handleRefreshApis 가 ref 로 latest loadConfig 를 참조하도록 매 렌더 갱신.
    useEffect(() => { loadConfigRef.current = loadConfig; });

    useEffect(() => {
        if (verified) loadConfig();
    }, [verified, loadConfig]);

    // 권한 가드 — admin 이 아니면 진입 자체 거부
    useEffect(() => {
        if (!isAdmin) {
            navigate("/dashboard", { replace: true });
        }
    }, [isAdmin, navigate]);

    /* ── 빌드/저장 ───────────────────────────────────────────── */
    const buildApisForSave = useCallback(() => {
        const diff = apiList.computeDiff();
        const existing = apiList.visibleItems
            .filter((it) => !it._isNew && !it._isDeleted)
            .map((it) => {
                const { _isNew: _n, _isDeleted: _d, ...clean } = it;
                return clean;
            });
        const created = diff.creates.map(({ _isNew: _n, _isDeleted: _d, ...clean }) => clean);
        return [...existing, ...created];
    }, [apiList]);

    const buildConfigObject = () => {
        if (jsonMode) return JSON.parse(rawJson);
        return {
            server,
            auth,
            logging,
            global_jdbc_jars: globalJdbcJars,
            sql_validation: sqlValidation,
            connections,
            apis: buildApisForSave(),
        };
    };

    const handleSave = async () => {
        if (apiList.isDirty && !apiList.isValid) {
            const firstInvalidId = apiList.invalidIds[0];
            const el = document.querySelector(`[data-row-id="${firstInvalidId}"]`);
            if (el) {
                setActiveTab("apis");
                el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
            setError(`데이터 API 설정에 ${apiList.invalidIds.length}개 오류가 있습니다. 확인 후 다시 저장하세요.`);
            return;
        }

        setSaving(true);
        setError(null);
        setSuccessMsg(null);
        try {
            const configObj = buildConfigObject();
            const result = await configService.updateConfig(configObj);
            setSuccessMsg(
                `저장 완료! API ${result.endpointCount ?? "?"}개, Connection ${result.connectionCount ?? "?"}개 로드됨.`,
            );
            setRawJson(JSON.stringify(configObj, null, 2));
            apiList.reset(configObj.apis || []);
        } catch (e) {
            if (e instanceof SyntaxError) setError("JSON 형식이 올바르지 않습니다.");
            else setError(e?.response?.data?.message || e?.message || "저장 실패");
        } finally {
            setSaving(false);
        }
    };

    const handleReloadOnly = async () => {
        setSaving(true);
        setError(null);
        setSuccessMsg(null);
        try {
            const result = await configService.reloadConfig();
            setSuccessMsg(result.message || "설정 리로드 완료.");
        } catch (e) {
            setError(e?.response?.data?.message || e?.message || "리로드 실패");
        } finally {
            setSaving(false);
        }
    };

    const handleToggleJsonMode = () => {
        if (!jsonMode) {
            try { setRawJson(JSON.stringify(buildConfigObject(), null, 2)); } catch { /* ignore */ }
        } else {
            try {
                const data = JSON.parse(rawJson);
                setServer(data.server || {});
                setAuth(data.auth || {});
                setLogging(data.logging || {});
                const parsedConnections = Array.isArray(data.connections) ? data.connections : [];
                const parsedApis = Array.isArray(data.apis) ? data.apis : [];
                setConnections(parsedConnections);
                setCollapsedConns(
                    Object.fromEntries(parsedConnections.map((_, i) => [i, true])),
                );
                apiList.reset(parsedApis);
                setCollapsedApis(
                    Object.fromEntries(parsedApis.map((a) => [a.id, true])),
                );
                setGlobalJdbcJars(data.global_jdbc_jars || "");
                setSqlValidation(data.sql_validation || {});
            } catch {
                setError("JSON 파싱 실패. 형식을 확인해 주세요.");
                return;
            }
        }
        setJsonMode(!jsonMode);
    };

    /* ── connection helpers ─────────────────────────────────── */
    const handleConnectionChange = (idx, updated) =>
        setConnections((prev) => prev.map((c, i) => (i === idx ? updated : c)));

    const handleConnectionRemove = (idx) => {
        setConnections((prev) => prev.filter((_, i) => i !== idx));
        setCollapsedConns((prev) => {
            const next = {};
            Object.keys(prev).forEach((k) => {
                const i = Number(k);
                if (i < idx) next[i] = prev[k];
                else if (i > idx) next[i - 1] = prev[k];
            });
            return next;
        });
    };

    const handleConnectionAdd = () =>
        setConnections((prev) => [
            ...prev,
            { id: "", db_type: "oracle", jdbc_driver_class: "oracle.jdbc.OracleDriver", jdbc_url: "", username: "", password: "" },
        ]);

    const handleConnectionDuplicate = (idx) => {
        setConnections((prev) => {
            const src = prev[idx];
            if (!src) return prev;
            const existingIds = new Set(prev.map((c) => c.id).filter(Boolean));
            const dup = { ...src, id: nextAvailable(src.id, existingIds) };
            return insertAfter(prev, idx, dup);
        });
        setCollapsedConns((prev) => shiftCollapsedForInsert(prev, idx));
    };

    /* ── api helpers ────────────────────────────────────────── */
    const connectionIds = useMemo(
        () => connections.map((c) => c.id).filter(Boolean),
        [connections],
    );

    const handleApiUpdate = useCallback((id, updated) => {
        const { _isNew: _n, _isDeleted: _d, ...patch } = updated;
        apiList.updateItem(id, patch);
    }, [apiList]);

    const handleApiAdd = useCallback(() => {
        const tmpId = apiList.addItem({ connection_id: connectionIds[0] || "" });
        setCollapsedApis((prev) => ({ ...prev, [tmpId]: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiList, connectionIds]);

    const handleApiRemove = useCallback((id) => apiList.deleteItem(id), [apiList]);
    const handleApiRestore = useCallback((id) => apiList.restoreItem(id), [apiList]);

    const handleApiDuplicate = useCallback((id) => {
        const src = apiList.visibleItems.find((a) => a.id === id);
        if (!src) return;
        const existingPaths = new Set(
            apiList.visibleItems.map((a) => a.rest_api_path).filter(Boolean),
        );
        const tmpId = apiList.addItem({
            ...endpointNewItemFactory(),
            sql_id: src.sql_id,
            connection_id: src.connection_id,
            refresh_interval_sec: src.refresh_interval_sec,
            enabled: src.enabled,
            rest_api_path: nextAvailable(src.rest_api_path, existingPaths),
        });
        setCollapsedApis((prev) => ({ ...prev, [tmpId]: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiList, endpointNewItemFactory]);

    /* ── 비밀번호 게이트 ───────────────────────────────────── */
    if (!isAdmin) return null;

    if (!verified) {
        return (
            <BackendConfigPasswordPrompt
                open={true}
                onClose={() => navigate("/dashboard")}
                onSuccess={() => {
                    try { sessionStorage.setItem(AUTH_FLAG_KEY, "1"); } catch { /* ignore */ }
                    setVerified(true);
                }}
            />
        );
    }

    const apisVisibleCount = apiList.visibleItems.filter((a) => !a._isDeleted).length;

    // 데이터 API sub-tab 의 dirty/save 정보를 footer binding 으로 노출.
    // handleSave 는 매 렌더 새 closure 라 ref 로 latest 를 전달, useEffect 는
    // dirty/saving 변경에만 재실행 → 무한 루프 회피 + footer 클릭 시 항상
    // 최신 함수 호출.
    const handleSaveRef = useRef();
    useEffect(() => {
        handleSaveRef.current = handleSave;
    });
    useEffect(() => {
        registerTabBinding("apis-list", {
            _key: "apis-list",
            isDirty: apiList.isDirty,
            dirtyCount: apiList.dirtyCount.total,
            isSaving: saving,
            save: () => handleSaveRef.current?.(),
            saveLabel: "저장 & 적용",
        });
        return () => registerTabBinding("apis-list", null);
    }, [apiList.isDirty, apiList.dirtyCount.total, saving, registerTabBinding]);

    return (
        <ConfigFooterContext.Provider value={footerCtxValue}>
        <div className="cfgpage-root">
            {/* ── 페이지 헤더 (sticky) ──────────────────────────── */}
            <header className="cfgpage-header">
                <button
                    type="button"
                    className="cfgpage-back-btn"
                    onClick={guardedClose}
                    aria-label="뒤로가기"
                    title="대시보드로 돌아가기"
                >
                    <IconArrowLeft size={16} />
                </button>
                <div className="cfgpage-header-text">
                    <h1>백엔드 설정</h1>
                    <p>서버 · DB 연결 · 데이터 API · 모니터 대상을 관리합니다. 저장 시 설정 DB에 기록되어 모든 A-A 노드에 즉시 반영됩니다.</p>
                </div>
                <button
                    type="button"
                    className="cfgpage-close-btn"
                    onClick={guardedClose}
                    aria-label="닫기"
                >
                    <IconClose size={16} />
                </button>
            </header>

            {/* ── 탭 바 (sticky) ───────────────────────────────── */}
            <nav className="cfg-tab-bar cfgpage-tab-bar">
                {TABS.map((tab) => (
                    <button
                        key={tab.key}
                        type="button"
                        className={`cfg-tab ${activeTab === tab.key ? "active" : ""}`}
                        onClick={() => setActiveTab(tab.key)}
                        disabled={jsonMode}
                    >
                        {tab.label}
                    </button>
                ))}
                <button
                    type="button"
                    className={`cfg-tab cfg-tab-json ${jsonMode ? "active" : ""}`}
                    onClick={handleToggleJsonMode}
                >
                    JSON
                </button>
            </nav>

            {/* ── 위젯별 설정 sub-tab bar (요구 ②) ───────────────── */}
            {activeTab === "widgetGroup" && !jsonMode && (
                <nav className="cfg-tab-bar cfgpage-subtab-bar" aria-label="위젯별 설정 하위 탭">
                    {WIDGET_SUB_TABS.map((tab) => (
                        <button
                            key={tab.key}
                            type="button"
                            className={`cfg-tab ${activeWidgetSubTab === tab.key ? "active" : ""}`}
                            onClick={() => setActiveWidgetSubTab(tab.key)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </nav>
            )}

            {/* ── 탭 본문 ─────────────────────────────────────── */}
            <main className="cfgpage-main">
                {loading ? (
                    <div className="cfg-loading">설정을 불러오는 중...</div>
                ) : jsonMode ? (
                    <div className="cfgpage-pane">
                        <div className="cfgpage-pane-body cfgpage-pane-body-padded">
                            <textarea
                                className="cfg-raw-json"
                                value={rawJson}
                                onChange={(e) => setRawJson(e.target.value)}
                                spellCheck={false}
                            />
                        </div>
                    </div>
                ) : (
                    <>
                        {/* ── 기본 탭: 서버 + 인증 + 로깅 + 고급 ─────── */}
                        {activeTab === "general" && (
                            <div className="cfgpage-pane">
                                <div className="cfgpage-pane-body cfgpage-pane-body-padded">
                                    <section className="cfgpage-group">
                                        <header className="cfgpage-group-header">
                                            <h2>서버</h2>
                                            <p>HTTP 리스너 및 워커 설정. Host/Port 는 빌드 시 결정되어 변경 불가입니다.</p>
                                        </header>
                                        <div className="cfgpage-group-body">
                                            <div className="cfg-row-2">
                                                <label><span>Host</span>
                                                    <input type="text" value={server.host || ""} disabled className="input-disabled" />
                                                </label>
                                                <label><span>Port</span>
                                                    <input type="number" value={server.port ?? 5000} disabled className="input-disabled" />
                                                </label>
                                            </div>
                                            <div className="cfg-row-3">
                                                <label><span>Thread Pool Size</span>
                                                    <input type="number" value={server.thread_pool_size ?? 16} onChange={(e) => setServer((p) => ({ ...p, thread_pool_size: Number(e.target.value) }))} min="1" max="64" />
                                                </label>
                                                <label><span>Refresh Interval (초)</span>
                                                    <input type="number" value={server.refresh_interval_sec ?? 5} onChange={(e) => setServer((p) => ({ ...p, refresh_interval_sec: Number(e.target.value) }))} min="1" />
                                                </label>
                                                <label><span>Query Timeout (초)</span>
                                                    <input type="number" value={server.query_timeout_sec ?? 10} onChange={(e) => setServer((p) => ({ ...p, query_timeout_sec: Number(e.target.value) }))} min="1" />
                                                </label>
                                            </div>
                                        </div>
                                    </section>

                                    <section className="cfgpage-group">
                                        <header className="cfgpage-group-header">
                                            <h2>인증</h2>
                                            <p>관리자 부트스트랩 계정. DB 의 user 테이블이 활성화되면 fallback 으로만 사용됩니다.</p>
                                        </header>
                                        <div className="cfgpage-group-body">
                                            <div className="cfg-row-2">
                                                <label><span>Username</span>
                                                    <input type="text" value={auth.username || ""} onChange={(e) => setAuth((p) => ({ ...p, username: e.target.value }))} />
                                                </label>
                                                <label><span>Password</span>
                                                    <PasswordInput value={auth.password || ""} onChange={(e) => setAuth((p) => ({ ...p, password: e.target.value }))} />
                                                </label>
                                            </div>
                                        </div>
                                    </section>

                                    <section className="cfgpage-group">
                                        <header className="cfgpage-group-header">
                                            <h2>로깅</h2>
                                            <p>로그 파일 경로/접두/레벨/보존 기간 및 슬로우 쿼리 임계치.</p>
                                        </header>
                                        <div className="cfgpage-group-body">
                                            <div className="cfg-row-2">
                                                <label><span>Log Directory</span>
                                                    <input type="text" value={logging.directory || ""} onChange={(e) => setLogging((p) => ({ ...p, directory: e.target.value }))} />
                                                </label>
                                                <label><span>File Prefix</span>
                                                    <input type="text" value={logging.file_prefix || ""} onChange={(e) => setLogging((p) => ({ ...p, file_prefix: e.target.value }))} />
                                                </label>
                                            </div>
                                            <div className="cfg-row-3">
                                                <label><span>Log Level</span>
                                                    <select value={logging.level || "INFO"} onChange={(e) => setLogging((p) => ({ ...p, level: e.target.value }))}>
                                                        {LOG_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                                                    </select>
                                                </label>
                                                <label><span>Retention (일)</span>
                                                    <input type="number" value={logging.retention_days ?? 7} onChange={(e) => setLogging((p) => ({ ...p, retention_days: Number(e.target.value) }))} min="1" />
                                                </label>
                                                <label><span>Slow Query Threshold (초)</span>
                                                    <input type="number" value={logging.slow_query_threshold_sec ?? 10} onChange={(e) => setLogging((p) => ({ ...p, slow_query_threshold_sec: Number(e.target.value) }))} min="1" />
                                                </label>
                                            </div>
                                        </div>
                                    </section>

                                    <section className="cfgpage-group">
                                        <header className="cfgpage-group-header">
                                            <h2>고급</h2>
                                            <p>전역 JDBC JAR 경로(세미콜론 구분) 및 SQL Validation 룰(JSON).</p>
                                        </header>
                                        <div className="cfgpage-group-body">
                                            <label><span>Global JDBC JARs</span>
                                                <input type="text" value={globalJdbcJars} onChange={(e) => setGlobalJdbcJars(e.target.value)} placeholder="drivers/ojdbc11.jar;drivers/mariadb-java-client.jar" />
                                            </label>
                                            <label><span>SQL Validation (typo patterns) — JSON</span>
                                                <textarea
                                                    className="cfg-json-mini"
                                                    value={JSON.stringify(sqlValidation, null, 2)}
                                                    onChange={(e) => {
                                                        try { setSqlValidation(JSON.parse(e.target.value)); } catch { /* allow transient */ }
                                                    }}
                                                    spellCheck={false}
                                                />
                                            </label>
                                        </div>
                                    </section>
                                </div>
                            </div>
                        )}

                        {/* ── DB 연결 탭 (grid) ─────────────────────── */}
                        {activeTab === "connections" && (
                            <div className="cfgpage-pane">
                                <header className="cfgpage-pane-header">
                                    <span className="cfgpage-pane-title">DB 연결 ({connections.length}개)</span>
                                    <div className="cfgpage-pane-actions">
                                        <button type="button" className="cfg-add-btn" onClick={handleConnectionAdd}>
                                            <IconPlus size={14} /> 추가
                                        </button>
                                    </div>
                                </header>
                                <div className="cfgpage-pane-body cfgpage-pane-body-padded cfgpage-pane-body-grid">
                                    {connections.length === 0 ? (
                                        <div className="cfg-empty">등록된 연결이 없습니다.</div>
                                    ) : (
                                        <ConnectionsGrid
                                            connections={connections}
                                            onChange={handleConnectionChange}
                                            onRemove={handleConnectionRemove}
                                            onDuplicate={handleConnectionDuplicate}
                                        />
                                    )}
                                </div>
                            </div>
                        )}

                        {/* ── 위젯별 설정 (그룹) ───────────────────── */}
                        {activeTab === "widgetGroup" && activeWidgetSubTab === "apis" && (
                            <div className="cfgpage-pane">
                                <header className="cfgpage-pane-header">
                                    <span className="cfgpage-pane-title">데이터 API ({apisVisibleCount}개)</span>
                                    <div className="cfgpage-pane-actions">
                                        <button
                                            type="button"
                                            className="cfg-add-btn"
                                            onClick={handleRefreshApis}
                                            disabled={loading || saving}
                                            title="새로고침 — 미저장 변경은 폐기됩니다"
                                        >
                                            <IconRefresh size={14} /> 새로고침
                                        </button>
                                        <button type="button" className="cfg-add-btn" onClick={handleApiAdd}>
                                            <IconPlus size={14} /> 추가
                                        </button>
                                    </div>
                                </header>
                                <div className="cfgpage-pane-body cfgpage-pane-body-padded cfgpage-pane-body-grid">
                                    {apiList.visibleItems.length === 0 ? (
                                        <div className="cfg-empty">등록된 API가 없습니다.</div>
                                    ) : (
                                        <ApisGrid
                                            items={apiList.visibleItems}
                                            apiList={apiList}
                                            connectionIds={connectionIds}
                                            onUpdate={handleApiUpdate}
                                            onRemove={handleApiRemove}
                                            onRestore={handleApiRestore}
                                            onDuplicate={handleApiDuplicate}
                                            onEditSql={handleEditSql}
                                            onEditThresholds={handleEditThresholds}
                                            thresholdsCountByApiId={widgetConfigsByApiId}
                                        />
                                    )}
                                </div>
                            </div>
                        )}
                        {activeTab === "widgetGroup" && activeWidgetSubTab === "serverTargets" && (
                            <div className="cfgpage-pane cfgpage-pane-monitor">
                                <MonitorTargetsTab
                                    targetType="server_resource"
                                    onDirtyChange={(isDirty, count) =>
                                        handleMonitorDirtyChange("server_resource", isDirty, count)
                                    }
                                />
                            </div>
                        )}
                        {activeTab === "widgetGroup" && activeWidgetSubTab === "networkTargets" && (
                            <div className="cfgpage-pane cfgpage-pane-monitor">
                                <MonitorTargetsTab
                                    targetType="network"
                                    onDirtyChange={(isDirty, count) =>
                                        handleMonitorDirtyChange("network", isDirty, count)
                                    }
                                />
                            </div>
                        )}
                        {activeTab === "widgetGroup" && activeWidgetSubTab === "httpStatusTargets" && (
                            <div className="cfgpage-pane cfgpage-pane-monitor">
                                <MonitorTargetsTab
                                    targetType="http_status"
                                    onDirtyChange={(isDirty, count) =>
                                        handleMonitorDirtyChange("http_status", isDirty, count)
                                    }
                                />
                            </div>
                        )}

                        {/* ── 타임머신 탭 ────────────────────────────── */}
                        {activeTab === "timemachine" && (
                            <div className="cfgpage-pane cfgpage-pane-monitor">
                                <TimemachineSettingsTab />
                            </div>
                        )}
                    </>
                )}
            </main>

            {/* ── 메시지 ───────────────────────────────────────── */}
            {error && <div className="cfg-msg cfg-msg-error">{error}</div>}
            {successMsg && <div className="cfg-msg cfg-msg-success">{successMsg}</div>}

            {/* ── 데이터 API row 에서 진입하는 SQL 편집기 모달 ──── */}
            {sqlEditorOpen && (
                <Suspense fallback={null}>
                    <SqlEditorModal
                        open={sqlEditorOpen}
                        onClose={handleCloseSql}
                        initialApiId={sqlEditorInitialApiId}
                    />
                </Suspense>
            )}

            {/* ── 데이터 API row 에서 진입하는 임계치 편집기 모달 ── */}
            {thresholdsEditorApi && (
                <Suspense fallback={null}>
                    <ApiThresholdsEditorModal
                        open={!!thresholdsEditorApi}
                        apiId={thresholdsEditorApi.apiId}
                        apiTitle={thresholdsEditorApi.title}
                        onClose={handleCloseThresholds}
                        onSaved={handleThresholdsSaved}
                    />
                </Suspense>
            )}

            {/* ── 페이지 푸터 (sticky bottom) ─────────────────── */}
            {/*
              요구 ①: 모든 탭에서 우측 최하단의 동일한 단일 "저장 & 적용"
              버튼이 활성 탭의 저장을 수행한다. 활성 탭이 자체 binding 을
              등록한 경우(monitor / timemachine / data API) 그것을 호출하고,
              아니면 페이지 단의 handleSave (PUT /dashboard/config) 를 호출.
            */}
            <footer className="cfgpage-footer">
                <button type="button" className="cfg-footer-btn cfg-btn-secondary" onClick={handleReloadOnly} disabled={saving}>
                    Reload Only
                </button>
                {(() => {
                    const useBinding = !!activeBinding;
                    const isDirty = useBinding ? !!activeBinding.isDirty : true;
                    const isSavingNow = useBinding ? !!activeBinding.isSaving : saving;
                    const dirtyCount = useBinding ? activeBinding.dirtyCount : null;
                    const onSave = useBinding ? activeBinding.save : handleSave;
                    const label = (activeBinding && activeBinding.saveLabel) || "저장 & 적용";
                    return (
                        <div className="cfgpage-footer-right">
                            {useBinding && dirtyCount != null && (
                                <span className="cfgpage-footer-dirty">
                                    {dirtyCount > 0 ? `변경 ${dirtyCount}건` : "변경 없음"}
                                </span>
                            )}
                            <button type="button" className="cfg-footer-btn cfg-btn-secondary" onClick={guardedClose}>
                                닫기
                            </button>
                            <button
                                type="button"
                                className="cfg-footer-btn cfg-btn-primary"
                                onClick={() => onSave?.()}
                                disabled={isSavingNow || loading || (useBinding && !isDirty)}
                            >
                                {isSavingNow ? "저장 중..." : label}
                            </button>
                        </div>
                    );
                })()}
            </footer>
        </div>
        </ConfigFooterContext.Provider>
    );
}
