import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    notificationGlobalService,
    notificationChannelService,
    notificationGroupService,
    notificationRecipientService,
    notificationRuleService,
    notificationSilenceService,
    notificationQueueService,
    notificationStatsService,
} from "../services/notificationService";
import {
    IconPlus, IconRefresh, IconTrash, IconClose, IconEye, IconEyeOff,
} from "./icons";
import {
    useConfigFooterRegister,
    useConfigFooterUnregister,
} from "../pages/configFooterContext";
import "./NotificationsTab.css";

/* ── Constants ─────────────────────────────────────────────────── */

const SUB_TABS = [
    { key: "master", label: "마스터" },
    { key: "channels", label: "채널 (SMTP)" },
    { key: "groups", label: "수신자 그룹" },
    { key: "rules", label: "알림 규칙" },
    { key: "silences", label: "억제 규칙" },
    { key: "queue", label: "발송 이력" },
];

const SOURCE_TYPE_OPTIONS = [
    { value: "", label: "(전체)" },
    { value: "server_resource", label: "서버 리소스" },
    { value: "network", label: "네트워크" },
    { value: "http_status", label: "HTTP 상태" },
    { value: "data_api:table", label: "데이터 API (표)" },
    { value: "data_api:line-chart", label: "데이터 API (라인)" },
    { value: "data_api:bar-chart", label: "데이터 API (바)" },
];

const QUEUE_STATUS_LABELS = {
    pending: "대기",
    sending: "발송 중",
    sent: "성공",
    failed: "실패 (재시도 예정)",
    dead: "사망 (재시도 종료)",
    cancelled: "취소됨",
};

const QUEUE_STATUS_TONES = {
    pending: "info",
    sending: "info",
    sent: "ok",
    failed: "warn",
    dead: "err",
    cancelled: "muted",
};

const DISPATCHER_STATS = [
    ["received", "수신"],
    ["enqueued", "큐 적재"],
    ["matchedRules", "룰 매치"],
    ["suppressedCooldown", "쿨다운 억제"],
    ["suppressedSilence", "Silence 억제"],
    ["suppressedGlobalOff", "글로벌 OFF 억제"],
    ["suppressedMinLevel", "Level 미달 억제"],
    ["suppressedSendOnClear", "Clear 미발송"],
    ["droppedOverflow", "오버플로 폐기"],
    ["enqueueErrors", "Enqueue 에러"],
    ["inflight", "In-flight"],
];

/* ── Helpers ───────────────────────────────────────────────────── */

function formatIso(s) {
    if (!s) return "—";
    try {
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) return s;
        return d.toLocaleString();
    } catch {
        return s;
    }
}

function formatRelative(ms) {
    if (!ms) return "";
    const diff = Math.max(0, Date.now() - ms);
    if (diff < 60_000) return `${Math.floor(diff / 1000)}초 전`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
    return `${Math.floor(diff / 3_600_000)}시간 전`;
}

function errorMessage(err, fallback = "요청에 실패했습니다.") {
    return (
        err?.response?.data?.detail
        || err?.response?.data?.message
        || err?.message
        || fallback
    );
}

function isLikelyEmail(s) {
    return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/* ══════════════════════════════════════════════════════════════════
   Shared UI primitives
   ══════════════════════════════════════════════════════════════════ */

function Toast({ toast, onDismiss }) {
    if (!toast) return null;
    return (
        <div className={`notif-toast notif-toast-${toast.kind}`} role="alert">
            <span className="notif-toast-msg">{toast.message}</span>
            <button type="button" className="notif-toast-close"
                onClick={onDismiss} aria-label="닫기">
                <IconClose size={12} />
            </button>
        </div>
    );
}

// Floating toast 의 기본 노출 시간. 사용자 가독성과 화면 위 잔존 시간을
// 균형 잡기 위해 5초로 고정. ttl: 0 을 명시하면 수동 dismiss 만 가능.
const TOAST_DEFAULT_TTL_MS = 5000;

function useToast() {
    const [toast, setToast] = useState(null);
    useEffect(() => {
        if (!toast || toast.ttl === 0) return undefined;
        const t = setTimeout(() => setToast(null), toast.ttl ?? TOAST_DEFAULT_TTL_MS);
        return () => clearTimeout(t);
    }, [toast]);
    return useMemo(() => ({
        toast,
        toastOk: (message, ttl) => setToast({ kind: "ok", message, ttl, ts: Date.now() }),
        toastWarn: (message, ttl) => setToast({ kind: "warn", message, ttl, ts: Date.now() }),
        toastErr: (message, ttl) => setToast({ kind: "err", message, ttl, ts: Date.now() }),
        dismissToast: () => setToast(null),
    }), [toast]);
}

function ConfirmDialog({ open, title, message, danger, confirmLabel, cancelLabel, onConfirm, onCancel }) {
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === "Escape") onCancel?.(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onCancel]);
    if (!open) return null;
    return (
        <div className="notif-dialog-backdrop" onClick={onCancel} role="dialog" aria-modal="true">
            <div className="notif-dialog" onClick={(e) => e.stopPropagation()}>
                <h3 className="notif-dialog-title">{title}</h3>
                {message && <p className="notif-dialog-msg">{message}</p>}
                <div className="notif-dialog-actions">
                    <button type="button" className="notif-btn-ghost" onClick={onCancel}>
                        {cancelLabel || "취소"}
                    </button>
                    <button type="button"
                        className={danger ? "notif-btn-danger" : "notif-btn-primary"}
                        onClick={onConfirm}>
                        {confirmLabel || "확인"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function useConfirm() {
    const [state, setState] = useState(null);
    // 다이얼로그가 열린 상태에서 패널이 unmount 되면 state 가 폐기되면서
    // resolver 도 같이 사라져 `await confirm(...)` 가 영원히 매달리고, 호출자
    // 의 finally 가 도달 못해 busy 잠금/메모리 누수가 난다. ref 로 최신
    // resolver 를 추적하고 unmount 시 false 로 resolve 해서 "취소된 것처럼"
    // 안전하게 종료한다.
    const pendingResolveRef = useRef(null);
    pendingResolveRef.current = state?.resolve || null;

    const confirm = useCallback((opts) => new Promise((resolve) => {
        setState({ ...opts, resolve });
    }), []);

    const close = (result) => {
        state?.resolve?.(result);
        setState(null);
    };

    useEffect(() => () => {
        // unmount 시 매달려있는 resolver 가 있으면 false 로 resolve.
        // mount-once cleanup 이라 정확히 한 번만 발화.
        pendingResolveRef.current?.(false);
    }, []);

    const ConfirmEl = state ? (
        <ConfirmDialog open {...state}
            onConfirm={() => close(true)} onCancel={() => close(false)} />
    ) : null;
    return { confirm, ConfirmEl };
}

function Toggle({ checked, onChange, disabled, labelOn = "ON", labelOff = "OFF", size = "md" }) {
    return (
        <button type="button"
            className={`notif-switch notif-switch-${size} ${checked ? "on" : "off"}`}
            onClick={(e) => {
                // 부모 클릭 핸들러(예: 리스트 row 선택) 와 분리.
                e.stopPropagation();
                if (!disabled) onChange?.(!checked);
            }}
            disabled={disabled}
            aria-pressed={checked}
            title={checked ? labelOn : labelOff}>
            <span className="notif-switch-track">
                <span className="notif-switch-thumb" />
            </span>
            <span className="notif-switch-label">{checked ? labelOn : labelOff}</span>
        </button>
    );
}

function StatusBadge({ status, label }) {
    const tone = QUEUE_STATUS_TONES[status] || "muted";
    return (
        <span className={`notif-badge notif-badge-${tone}`}>
            {label || QUEUE_STATUS_LABELS[status] || status}
        </span>
    );
}

function FormField({ label, hint, error, required, children, full }) {
    return (
        <label className={`notif-field ${full ? "notif-field-full" : ""} ${error ? "notif-field-error" : ""}`}>
            <span className="notif-field-label">
                {label}
                {required && <span className="notif-field-required" aria-label="필수">*</span>}
            </span>
            {children}
            {error
                ? <span className="notif-field-error-msg">{error}</span>
                : hint && <span className="notif-field-hint">{hint}</span>}
        </label>
    );
}

function EmptyState({ title, hint, action }) {
    return (
        <div className="notif-empty-state">
            <div className="notif-empty-title">{title}</div>
            {hint && <div className="notif-empty-hint">{hint}</div>}
            {action && <div className="notif-empty-action">{action}</div>}
        </div>
    );
}

function SkeletonBlock({ rows = 3 }) {
    return (
        <div className="notif-skeleton-block" aria-busy="true">
            {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="notif-skeleton-row" />
            ))}
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   Master sub-tab
   ══════════════════════════════════════════════════════════════════ */

function MasterPanel() {
    const { toast, toastOk, toastErr, dismissToast } = useToast();
    const [global, setGlobal] = useState({ enabled: false });
    const [stats, setStats] = useState(null);
    const [activeSilences, setActiveSilences] = useState(0);
    const [busy, setBusy] = useState(false);
    const [lastRefresh, setLastRefresh] = useState(null);
    const [error, setError] = useState(null);
    const [tick, setTick] = useState(0);

    const reload = useCallback(async () => {
        try {
            const [g, s, ac] = await Promise.all([
                notificationGlobalService.get(),
                notificationStatsService.get(),
                notificationSilenceService.listActive().catch(() => []),
            ]);
            setGlobal(g);
            setStats(s);
            setActiveSilences(Array.isArray(ac) ? ac.length : 0);
            setLastRefresh(Date.now());
            setError(null);
        } catch (err) {
            setError(errorMessage(err, "통계를 불러올 수 없습니다."));
        }
    }, []);

    useEffect(() => {
        reload();
        const t = setInterval(reload, 10_000);
        return () => clearInterval(t);
    }, [reload]);

    // 갱신 표시는 1초 단위로 살아 움직이도록
    useEffect(() => {
        const t = setInterval(() => setTick((x) => x + 1), 5000);
        return () => clearInterval(t);
    }, []);
    void tick;

    const toggle = async (next) => {
        setBusy(true);
        try {
            const res = await notificationGlobalService.set(!!next);
            setGlobal(res);
            toastOk(`글로벌 메일링을 ${res.enabled ? "ON" : "OFF"} 로 변경했습니다.`);
        } catch (err) {
            toastErr(errorMessage(err, "글로벌 토글 변경 실패"));
        } finally {
            setBusy(false);
        }
    };

    const dispatcher = stats?.dispatcher || {};
    const queueCounts = stats?.queueCounts || {};
    const dead24h = stats?.deadIn24h || 0;
    const deadWindowSec = stats?.deadWindowSec ?? 86400;
    const deadThreshold = stats?.deadThreshold ?? 100;
    const deadWindowHours = Math.max(1, Math.floor(deadWindowSec / 3600));
    const deadAlert = dead24h >= deadThreshold;

    if (!stats && !error) {
        return (
            <div className="notif-pane">
                <section className="notif-card"><SkeletonBlock rows={3} /></section>
                <section className="notif-card"><SkeletonBlock rows={3} /></section>
            </div>
        );
    }

    return (
        <div className="notif-pane">
            <Toast toast={toast} onDismiss={dismissToast} />
            {error && <div className="notif-banner notif-banner-err">{error}</div>}

            <section className="notif-card">
                <div className="notif-master-row">
                    <div className="notif-master-body">
                        <h3>전역 메일링 스위치</h3>
                        <p className="notif-muted">
                            OFF 일 때는 어떤 알림도 발송되지 않습니다 (이벤트 자체는 계속 기록).
                        </p>
                    </div>
                    <Toggle checked={!!global.enabled} onChange={toggle} disabled={busy} size="lg" />
                </div>
                <div className="notif-meta-strip">
                    <div className="notif-meta-item">
                        <span className="notif-meta-label">활성 억제 규칙</span>
                        <span className={`notif-meta-value ${activeSilences > 0 ? "is-warn" : ""}`}>
                            {activeSilences}건
                        </span>
                    </div>
                    <div className="notif-meta-item">
                        <span className="notif-meta-label">마지막 갱신</span>
                        <span className="notif-meta-value">{lastRefresh ? formatRelative(lastRefresh) : "—"}</span>
                    </div>
                    <button type="button" className="notif-btn-ghost notif-btn-sm" onClick={reload}>
                        <IconRefresh size={12} /> 새로고침
                    </button>
                </div>
            </section>

            {deadAlert && (
                <section className="notif-banner notif-banner-warn">
                    경고: 최근 {deadWindowHours}시간 내 발송 사망(dead) <strong>{dead24h}</strong>건
                    (임계 {deadThreshold}). 채널 설정 / SMTP 인증 / 네트워크 점검이 필요합니다.
                </section>
            )}

            <section className="notif-card">
                <div className="notif-card-head">
                    <h3>큐 상태</h3>
                </div>
                <div className="notif-stat-grid">
                    {Object.entries(QUEUE_STATUS_LABELS).map(([k, label]) => (
                        <div key={k} className="notif-stat">
                            <div className="notif-stat-label">{label}</div>
                            <div className="notif-stat-value">
                                {(queueCounts[k] ?? 0).toLocaleString()}
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            <section className="notif-card">
                <h3>디스패처 통계 (프로세스 기동 후 누적)</h3>
                <div className="notif-stat-grid">
                    {DISPATCHER_STATS.map(([k, label]) => (
                        <div key={k} className="notif-stat">
                            <div className="notif-stat-label">{label}</div>
                            <div className="notif-stat-value">
                                {(dispatcher[k] ?? 0).toLocaleString()}
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   SMTP channel sub-tab
   ══════════════════════════════════════════════════════════════════ */

const EMPTY_SMTP_CONFIG = {
    host: "", port: 587, use_tls: true, use_ssl: false,
    username: "", password: "", from_address: "", from_name: "", reply_to: "",
};

function ChannelPanel() {
    const { toast, toastOk, toastErr, dismissToast } = useToast();
    const [enabled, setEnabled] = useState(true);
    const [cfg, setCfg] = useState(EMPTY_SMTP_CONFIG);
    // 원본 — 페이지 footer dirty 추적용. load/save 시점에 갱신, 사용자 편집은
    // 건드리지 않음. password 는 서버에서 strip 되어 항상 "" 로 옴 → 사용자가
    // password 칸을 비워두면 dirty 가 아님 (기존값 유지 의도).
    const [originalEnabled, setOriginalEnabled] = useState(true);
    const [originalCfg, setOriginalCfg] = useState(EMPTY_SMTP_CONFIG);
    const [updatedAt, setUpdatedAt] = useState(null);
    const [updatedBy, setUpdatedBy] = useState(null);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testRecipient, setTestRecipient] = useState("");
    const [testResult, setTestResult] = useState(null);
    const [showPassword, setShowPassword] = useState(false);
    const [validation, setValidation] = useState({});

    const load = useCallback(() => {
        setLoadError(null);
        setLoaded(false);
        notificationChannelService.getConfig("smtp")
            .then((res) => {
                const nextEnabled = res?.enabled ?? true;
                const nextCfg = { ...EMPTY_SMTP_CONFIG, ...(res?.config || {}) };
                setEnabled(nextEnabled);
                setCfg(nextCfg);
                setOriginalEnabled(nextEnabled);
                setOriginalCfg(nextCfg);
                setUpdatedAt(res?.updatedAt);
                setUpdatedBy(res?.updatedBy);
                setLoaded(true);
            })
            .catch((err) => {
                if (err?.response?.status === 404) {
                    // First-time setup — show empty form.
                    setOriginalEnabled(true);
                    setOriginalCfg(EMPTY_SMTP_CONFIG);
                    setLoaded(true);
                } else {
                    setLoadError(errorMessage(err, "SMTP 설정을 불러올 수 없습니다."));
                    setLoaded(true);
                }
            });
    }, []);

    useEffect(() => { load(); }, [load]);

    // ── Footer binding (탭 이탈 시 confirm + footer 저장 버튼) ─────
    const isDirty = useMemo(() => {
        if (!loaded) return false;
        if (enabled !== originalEnabled) return true;
        for (const k of Object.keys(EMPTY_SMTP_CONFIG)) {
            // password 빈 칸 = "기존 유지" 의도 → dirty 아님
            if (k === "password" && (cfg.password || "") === "") continue;
            if ((cfg[k] ?? "") !== (originalCfg[k] ?? "")) return true;
        }
        return false;
    }, [loaded, enabled, originalEnabled, cfg, originalCfg]);

    const validate = () => {
        const v = {};
        if (!cfg.host.trim()) v.host = "필수 항목입니다.";
        if (!cfg.port || cfg.port < 1 || cfg.port > 65535) v.port = "1–65535 범위";
        if (!cfg.from_address.trim()) v.from_address = "필수 항목입니다.";
        else if (!isLikelyEmail(cfg.from_address)) v.from_address = "이메일 형식이 아닙니다.";
        if (cfg.reply_to && !isLikelyEmail(cfg.reply_to)) v.reply_to = "이메일 형식이 아닙니다.";
        setValidation(v);
        return Object.keys(v).length === 0;
    };

    const handleSave = async () => {
        if (!validate()) {
            toastErr("입력값을 확인해주세요.");
            return;
        }
        setSaving(true);
        try {
            await notificationChannelService.save("smtp", { enabled, config: cfg });
            // empty password = keep existing — clear local field after save for clarity
            const cleared = { ...cfg, password: "" };
            setCfg(cleared);
            // Save 성공 시 원본도 갱신 — 이후 dirty 판정 기준이 새 값.
            setOriginalEnabled(enabled);
            setOriginalCfg(cleared);
            toastOk("SMTP 설정을 저장했습니다.");
            // refresh updatedAt/by from server
            const fresh = await notificationChannelService.getConfig("smtp")
                .catch(() => null);
            if (fresh) {
                setUpdatedAt(fresh.updatedAt);
                setUpdatedBy(fresh.updatedBy);
            }
        } catch (err) {
            toastErr(errorMessage(err, "저장 실패"));
        } finally {
            setSaving(false);
        }
    };

    // Footer binding — 페이지 우측 하단의 "저장 & 적용" 버튼이 ChannelPanel 의
    // handleSave 를 호출하도록, 그리고 isDirty 가 ConfigEditorPage 의
    // confirmDiscardIfDirty 에 잡히도록 등록. handleSave 는 매 렌더 새 closure
    // 라 ref 로 latest 를 전달, useEffect 는 dirty/saving 변경에만 재실행.
    const registerFooter = useConfigFooterRegister();
    const unregisterFooter = useConfigFooterUnregister();
    const handleSaveRef = useRef();
    useEffect(() => { handleSaveRef.current = handleSave; });
    useEffect(() => {
        registerFooter({
            _key: "notif-channels",
            isDirty,
            dirtyCount: isDirty ? 1 : 0,
            isSaving: saving,
            save: () => handleSaveRef.current?.(),
            saveLabel: "저장 & 적용",
        });
        return () => unregisterFooter("notif-channels");
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isDirty, saving]);

    const handleTest = async () => {
        const addr = testRecipient.trim();
        if (!isLikelyEmail(addr)) {
            setTestResult({ ok: false, detail: "올바른 이메일 주소를 입력하세요." });
            return;
        }
        setTesting(true);
        setTestResult(null);
        try {
            const result = await notificationChannelService.sendTest("smtp", addr);
            setTestResult(result);
        } catch (err) {
            setTestResult({ ok: false, detail: errorMessage(err, "테스트 발송 실패") });
        } finally {
            setTesting(false);
        }
    };

    if (!loaded) {
        return (
            <div className="notif-pane">
                <section className="notif-card"><SkeletonBlock rows={6} /></section>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="notif-pane">
                <Toast toast={toast} onDismiss={dismissToast} />
                <section className="notif-card">
                    <div className="notif-banner notif-banner-err">
                        {loadError}
                    </div>
                    <div className="notif-actions">
                        <button type="button" className="notif-btn-primary" onClick={load}>
                            <IconRefresh size={12} /> 다시 시도
                        </button>
                    </div>
                </section>
            </div>
        );
    }

    return (
        <div className="notif-pane">
            <Toast toast={toast} onDismiss={dismissToast} />

            <section className="notif-card">
                <div className="notif-card-head">
                    <div>
                        <h3>SMTP 채널 설정</h3>
                        <p className="notif-muted" style={{ marginTop: 4 }}>
                            저장 후 다음 발송부터 적용됩니다 (워커 폴링 주기 약 30초).
                        </p>
                    </div>
                    <div className="notif-master-toggle">
                        <span className="notif-muted">활성화</span>
                        <Toggle checked={enabled} onChange={setEnabled} />
                    </div>
                </div>

                <fieldset className="notif-fieldset">
                    <legend>서버</legend>
                    <div className="notif-form-grid">
                        <FormField label="호스트" required error={validation.host}>
                            <input value={cfg.host}
                                onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
                                placeholder="smtp.example.com" autoComplete="off" />
                        </FormField>
                        <FormField label="포트" required error={validation.port}>
                            <input type="number" min="1" max="65535" value={cfg.port}
                                onChange={(e) => setCfg({ ...cfg, port: parseInt(e.target.value, 10) || 0 })} />
                        </FormField>
                        <FormField label="보안" hint="STARTTLS · SMTPS · 평문 중 택1">
                            <div className="notif-radio-group">
                                <label className="notif-radio">
                                    <input type="radio" name="smtp-sec"
                                        checked={cfg.use_tls && !cfg.use_ssl}
                                        onChange={() => setCfg({ ...cfg, use_tls: true, use_ssl: false })} />
                                    STARTTLS
                                </label>
                                <label className="notif-radio">
                                    <input type="radio" name="smtp-sec"
                                        checked={cfg.use_ssl && !cfg.use_tls}
                                        onChange={() => setCfg({ ...cfg, use_tls: false, use_ssl: true })} />
                                    SMTPS (SSL)
                                </label>
                                <label className="notif-radio">
                                    <input type="radio" name="smtp-sec"
                                        checked={!cfg.use_tls && !cfg.use_ssl}
                                        onChange={() => setCfg({ ...cfg, use_tls: false, use_ssl: false })} />
                                    평문
                                </label>
                            </div>
                        </FormField>
                    </div>
                </fieldset>

                <fieldset className="notif-fieldset">
                    <legend>인증</legend>
                    <div className="notif-form-grid">
                        <FormField label="사용자명">
                            <input value={cfg.username || ""}
                                onChange={(e) => setCfg({ ...cfg, username: e.target.value })}
                                autoComplete="off" />
                        </FormField>
                        <FormField label="비밀번호" hint="비워두면 기존 저장값이 유지됩니다.">
                            <div className="notif-input-with-affordance">
                                <input type={showPassword ? "text" : "password"}
                                    value={cfg.password || ""}
                                    onChange={(e) => setCfg({ ...cfg, password: e.target.value })}
                                    autoComplete="new-password"
                                    placeholder="(unchanged)" />
                                <button type="button" className="notif-input-affordance"
                                    onClick={() => setShowPassword((v) => !v)}
                                    aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 표시"}>
                                    {showPassword ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                                </button>
                            </div>
                        </FormField>
                    </div>
                </fieldset>

                <fieldset className="notif-fieldset">
                    <legend>발신자</legend>
                    <div className="notif-form-grid">
                        <FormField label="발신 주소" required error={validation.from_address}>
                            <input value={cfg.from_address}
                                onChange={(e) => setCfg({ ...cfg, from_address: e.target.value })}
                                placeholder="alerts@example.com" />
                        </FormField>
                        <FormField label="발신 이름">
                            <input value={cfg.from_name || ""}
                                onChange={(e) => setCfg({ ...cfg, from_name: e.target.value })}
                                placeholder="MoniGrid Alerts" />
                        </FormField>
                        <FormField label="Reply-To" error={validation.reply_to}
                            hint="수신자가 답신할 주소 (선택)">
                            <input value={cfg.reply_to || ""}
                                onChange={(e) => setCfg({ ...cfg, reply_to: e.target.value })}
                                placeholder="ops@example.com" />
                        </FormField>
                    </div>
                </fieldset>

                <div className="notif-actions notif-actions-end">
                    {(updatedAt || updatedBy) && (
                        <span className="notif-muted notif-actions-meta">
                            마지막 수정: {formatIso(updatedAt)}
                            {updatedBy ? ` · ${updatedBy}` : ""}
                        </span>
                    )}
                    <button type="button" className="notif-btn-primary"
                        onClick={handleSave} disabled={saving}>
                        {saving ? "저장 중…" : "저장"}
                    </button>
                </div>
            </section>

            <section className="notif-card">
                <h3>테스트 발송</h3>
                <p className="notif-muted">현재 저장된 SMTP 설정으로 즉시 메일을 보내 봅니다.</p>
                <div className="notif-actions">
                    <input className="notif-input-grow"
                        value={testRecipient}
                        onChange={(e) => setTestRecipient(e.target.value)}
                        placeholder="ops@example.com"
                        onKeyDown={(e) => { if (e.key === "Enter") handleTest(); }} />
                    <button type="button" className="notif-btn-primary"
                        onClick={handleTest} disabled={testing}>
                        {testing ? "발송 중…" : "테스트 메일 보내기"}
                    </button>
                </div>
                {testResult && (
                    <div className={`notif-banner ${testResult.ok ? "notif-banner-ok" : "notif-banner-err"}`}>
                        {testResult.ok ? "✔ " : "✘ "}{testResult.detail || (testResult.ok ? "발송 완료" : "발송 실패")}
                    </div>
                )}
            </section>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   Groups + recipients sub-tab
   ══════════════════════════════════════════════════════════════════ */

function GroupsPanel() {
    const { toast, toastOk, toastErr, dismissToast } = useToast();
    const { confirm, ConfirmEl } = useConfirm();
    const [groups, setGroups] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [recipients, setRecipients] = useState([]);
    const [loadingGroups, setLoadingGroups] = useState(true);
    const [loadingRecipients, setLoadingRecipients] = useState(false);
    const [newGroupName, setNewGroupName] = useState("");
    const [newRecipientAddr, setNewRecipientAddr] = useState("");
    const [newRecipientName, setNewRecipientName] = useState("");
    const [busy, setBusy] = useState(false);
    const selectedIdRef = useRef(null);
    selectedIdRef.current = selectedId;

    const reloadGroups = useCallback(async ({ keepSelection = true } = {}) => {
        setLoadingGroups(true);
        try {
            const list = await notificationGroupService.list();
            setGroups(list);
            if (list.length === 0) {
                setSelectedId(null);
            } else if (!keepSelection || selectedIdRef.current == null
                || !list.some((g) => g.id === selectedIdRef.current)) {
                setSelectedId(list[0].id);
            }
        } catch (err) {
            toastErr(errorMessage(err, "그룹 목록을 불러올 수 없습니다."));
        } finally {
            setLoadingGroups(false);
        }
    // toast functions are stable refs from useToast (set in useMemo) — safe to omit
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const reloadRecipients = useCallback(async (groupId) => {
        if (!groupId) { setRecipients([]); return; }
        setLoadingRecipients(true);
        try {
            const list = await notificationRecipientService.listForGroup(groupId);
            setRecipients(list);
        } catch (err) {
            toastErr(errorMessage(err, "수신자 목록을 불러올 수 없습니다."));
        } finally {
            setLoadingRecipients(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => { reloadGroups(); }, [reloadGroups]);
    useEffect(() => { reloadRecipients(selectedId); }, [selectedId, reloadRecipients]);

    const addGroup = async () => {
        const name = newGroupName.trim();
        if (!name) {
            toastErr("그룹 이름을 입력하세요.");
            return;
        }
        setBusy(true);
        try {
            const r = await notificationGroupService.create({ name });
            setNewGroupName("");
            await reloadGroups({ keepSelection: false });
            setSelectedId(r.id);
            toastOk(`그룹 “${name}” 를 추가했습니다.`);
        } catch (err) {
            toastErr(errorMessage(err, "그룹 추가 실패"));
        } finally {
            setBusy(false);
        }
    };

    const removeGroup = async (g) => {
        const ok = await confirm({
            title: `그룹 “${g.name}” 삭제`,
            message: "그룹과 소속 수신자를 모두 삭제합니다. 이 그룹을 참조하는 알림 규칙이 있으면 거부됩니다.",
            danger: true,
            confirmLabel: "삭제",
        });
        if (!ok) return;
        try {
            await notificationGroupService.remove(g.id);
            if (selectedId === g.id) setSelectedId(null);
            await reloadGroups({ keepSelection: false });
            toastOk(`그룹 “${g.name}” 를 삭제했습니다.`);
        } catch (err) {
            const data = err?.response?.data;
            if (err?.response?.status === 409 && data?.ruleIds?.length) {
                toastErr(`삭제 거부: 이 그룹을 참조하는 알림 규칙이 있습니다 (rule id: ${data.ruleIds.join(", ")}).`);
            } else {
                toastErr(errorMessage(err, "그룹 삭제 실패"));
            }
        }
    };

    const toggleGroupEnabled = async (g) => {
        try {
            await notificationGroupService.update(g.id, { enabled: !g.enabled });
            await reloadGroups();
        } catch (err) {
            toastErr(errorMessage(err, "그룹 상태 변경 실패"));
        }
    };

    const addRecipient = async () => {
        if (!selectedId) return;
        const addr = newRecipientAddr.trim();
        if (!isLikelyEmail(addr)) {
            toastErr("올바른 이메일 주소를 입력하세요.");
            return;
        }
        setBusy(true);
        try {
            await notificationRecipientService.create(selectedId, {
                address: addr,
                displayName: newRecipientName.trim() || null,
            });
            setNewRecipientAddr("");
            setNewRecipientName("");
            await reloadRecipients(selectedId);
            toastOk(`수신자 ${addr} 를 추가했습니다.`);
        } catch (err) {
            toastErr(errorMessage(err, "수신자 추가 실패"));
        } finally {
            setBusy(false);
        }
    };

    const toggleRecipientEnabled = async (r) => {
        try {
            await notificationRecipientService.update(r.id, { enabled: !r.enabled });
            await reloadRecipients(selectedId);
        } catch (err) {
            toastErr(errorMessage(err, "수신자 상태 변경 실패"));
        }
    };

    const removeRecipient = async (r) => {
        const ok = await confirm({
            title: "수신자 삭제",
            message: `${r.displayName ? `${r.displayName} <${r.address}>` : r.address} 를 그룹에서 제외합니다.`,
            danger: true,
            confirmLabel: "삭제",
        });
        if (!ok) return;
        try {
            await notificationRecipientService.remove(r.id);
            await reloadRecipients(selectedId);
            toastOk("수신자를 삭제했습니다.");
        } catch (err) {
            toastErr(errorMessage(err, "수신자 삭제 실패"));
        }
    };

    return (
        <div className="notif-pane">
            <Toast toast={toast} onDismiss={dismissToast} />
            {ConfirmEl}

            <div className="notif-split">
            <section className="notif-card notif-split-left">
                <div className="notif-card-head">
                    <h3>그룹</h3>
                    <span className="notif-muted">{groups.length}개</span>
                </div>
                {loadingGroups ? (
                    <SkeletonBlock rows={3} />
                ) : groups.length === 0 ? (
                    <EmptyState
                        title="그룹이 없습니다"
                        hint="첫 그룹을 만들어 수신자를 추가하세요."
                    />
                ) : (
                    <ul className="notif-list">
                        {groups.map((g) => (
                            <li key={g.id}
                                className={`notif-list-row ${selectedId === g.id ? "active" : ""} ${!g.enabled ? "disabled" : ""}`}
                                onClick={() => setSelectedId(g.id)}>
                                <span className="notif-list-name">{g.name}</span>
                                <Toggle checked={g.enabled} size="sm"
                                    onChange={() => toggleGroupEnabled(g)} />
                                <button type="button" className="notif-icon-btn notif-icon-btn-danger"
                                    onClick={(e) => { e.stopPropagation(); removeGroup(g); }}
                                    aria-label="삭제">
                                    <IconTrash size={12} />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <div className="notif-actions">
                    <input className="notif-input-grow"
                        value={newGroupName}
                        onChange={(e) => setNewGroupName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") addGroup(); }}
                        placeholder="새 그룹 이름" />
                    <button type="button" className="notif-btn-primary"
                        onClick={addGroup} disabled={busy}>
                        <IconPlus size={12} /> 추가
                    </button>
                </div>
            </section>

            <section className="notif-card notif-split-right">
                <div className="notif-card-head">
                    <h3>수신자 {selectedId ? `· ${groups.find((g) => g.id === selectedId)?.name || ""}` : ""}</h3>
                    <span className="notif-muted">{selectedId ? `${recipients.length}명` : "그룹 선택 필요"}</span>
                </div>
                {!selectedId ? (
                    <EmptyState
                        title="좌측에서 그룹을 선택하세요"
                        hint="선택한 그룹의 수신자가 여기에 표시됩니다."
                    />
                ) : loadingRecipients ? (
                    <SkeletonBlock rows={3} />
                ) : (
                    <>
                        {recipients.length === 0 ? (
                            <EmptyState
                                title="수신자가 없습니다"
                                hint="아래 입력란에 이메일을 추가하세요."
                            />
                        ) : (
                            <ul className="notif-list">
                                {recipients.map((r) => (
                                    <li key={r.id} className={`notif-list-row ${!r.enabled ? "disabled" : ""}`}>
                                        <span className="notif-list-name">
                                            {r.displayName || r.address}
                                            {r.displayName && <span className="notif-list-sub"> · {r.address}</span>}
                                        </span>
                                        <Toggle checked={r.enabled} size="sm"
                                            onChange={() => toggleRecipientEnabled(r)} />
                                        <button type="button" className="notif-icon-btn notif-icon-btn-danger"
                                            onClick={() => removeRecipient(r)} aria-label="삭제">
                                            <IconTrash size={12} />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div className="notif-actions">
                            <input className="notif-input-grow"
                                value={newRecipientAddr}
                                onChange={(e) => setNewRecipientAddr(e.target.value)}
                                placeholder="이메일 주소"
                                onKeyDown={(e) => { if (e.key === "Enter") addRecipient(); }} />
                            <input value={newRecipientName}
                                onChange={(e) => setNewRecipientName(e.target.value)}
                                placeholder="표시 이름 (선택)"
                                onKeyDown={(e) => { if (e.key === "Enter") addRecipient(); }} />
                            <button type="button" className="notif-btn-primary"
                                onClick={addRecipient} disabled={busy}>
                                <IconPlus size={12} /> 추가
                            </button>
                        </div>
                    </>
                )}
            </section>
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   Rules sub-tab
   ══════════════════════════════════════════════════════════════════ */

function RulesPanel() {
    const { toast, toastOk, toastErr, dismissToast } = useToast();
    const { confirm, ConfirmEl } = useConfirm();
    const [rules, setRules] = useState([]);
    const [groups, setGroups] = useState([]);
    const [channels, setChannels] = useState([]);
    const [draft, setDraft] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const [rs, gs, cs] = await Promise.all([
                notificationRuleService.list(),
                notificationGroupService.list(),
                notificationChannelService.list(),
            ]);
            setRules(rs); setGroups(gs); setChannels(cs);
        } catch (err) {
            toastErr(errorMessage(err, "규칙 목록을 불러올 수 없습니다."));
        } finally {
            setLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => { reload(); }, [reload]);

    const startNew = () => {
        setDraft({
            id: null, name: "", enabled: true,
            sourceType: "", sourceIdPattern: "", metricPattern: "",
            minLevel: "warn",
            recipientGroupId: groups[0]?.id || null,
            channelId: channels[0]?.id || null,
            cooldownSec: 300, digestWindowSec: 0, sendOnClear: false,
        });
    };
    const startEdit = (r) => setDraft({ ...r });
    const cancelEdit = () => setDraft(null);

    const save = async () => {
        if (!draft.name?.trim()) { toastErr("이름이 필요합니다."); return; }
        if (!draft.recipientGroupId) { toastErr("수신자 그룹을 선택하세요."); return; }
        if (!draft.channelId) { toastErr("채널을 선택하세요."); return; }
        setSaving(true);
        try {
            if (draft.id) {
                await notificationRuleService.update(draft.id, draft);
                toastOk(`규칙 “${draft.name}” 을 수정했습니다.`);
            } else {
                await notificationRuleService.create(draft);
                toastOk(`규칙 “${draft.name}” 을 추가했습니다.`);
            }
            setDraft(null);
            await reload();
        } catch (err) {
            toastErr(errorMessage(err, "규칙 저장 실패"));
        } finally {
            setSaving(false);
        }
    };

    // Footer binding — draft 가 열려 있는 동안만 dirty. 페이지 footer 의
    // "저장 & 적용" 버튼이 RulesPanel.save 를 호출하도록 등록. 탭 이탈 시
    // ConfigEditorPage 가 confirm 다이얼로그로 사용자 작업 손실을 방지.
    const registerFooter = useConfigFooterRegister();
    const unregisterFooter = useConfigFooterUnregister();
    const saveRef = useRef();
    useEffect(() => { saveRef.current = save; });
    const isDirty = !!draft;
    useEffect(() => {
        registerFooter({
            _key: "notif-rules",
            isDirty,
            dirtyCount: isDirty ? 1 : 0,
            isSaving: saving,
            save: () => saveRef.current?.(),
            saveLabel: draft?.id ? "수정 & 적용" : "추가 & 적용",
        });
        return () => unregisterFooter("notif-rules");
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isDirty, saving, draft?.id]);

    const remove = async (r) => {
        const ok = await confirm({
            title: `규칙 “${r.name}” 삭제`,
            message: "이 규칙이 매칭하던 이벤트는 더 이상 발송되지 않습니다.",
            danger: true,
            confirmLabel: "삭제",
        });
        if (!ok) return;
        try {
            await notificationRuleService.remove(r.id);
            await reload();
            toastOk("규칙을 삭제했습니다.");
        } catch (err) {
            toastErr(errorMessage(err, "규칙 삭제 실패"));
        }
    };

    const toggleEnabled = async (r) => {
        try {
            await notificationRuleService.update(r.id, { enabled: !r.enabled });
            await reload();
        } catch (err) {
            toastErr(errorMessage(err, "규칙 상태 변경 실패"));
        }
    };

    const groupName = (id) => groups.find((g) => g.id === id)?.name || `(group ${id})`;
    const channelLabel = (id) => {
        const c = channels.find((x) => x.id === id);
        return c ? `${c.kind}${c.enabled ? "" : " (off)"}` : `(channel ${id})`;
    };

    return (
        <div className="notif-pane">
            <Toast toast={toast} onDismiss={dismissToast} />
            {ConfirmEl}

            <section className="notif-card">
                <div className="notif-card-head">
                    <h3>알림 규칙 <span className="notif-muted">({rules.length}개)</span></h3>
                    <button type="button" className="notif-btn-primary"
                        onClick={startNew} disabled={!!draft}>
                        <IconPlus size={12} /> 새 규칙
                    </button>
                </div>
                {loading ? (
                    <SkeletonBlock rows={3} />
                ) : rules.length === 0 ? (
                    <EmptyState
                        title="정의된 규칙이 없습니다"
                        hint="규칙은 이벤트(소스 타입/대상/지표) 와 발송 대상(그룹/채널) 을 연결합니다."
                        action={(
                            <button type="button" className="notif-btn-primary"
                                onClick={startNew} disabled={!!draft}>
                                <IconPlus size={12} /> 첫 규칙 만들기
                            </button>
                        )}
                    />
                ) : (
                    <div className="notif-table-wrap">
                        <table className="notif-table">
                            <thead>
                                <tr>
                                    <th>이름</th><th>활성</th><th>소스타입</th><th>대상 패턴</th>
                                    <th>지표 패턴</th><th>최소 레벨</th><th>그룹</th><th>채널</th>
                                    <th>쿨다운</th><th>다이제스트</th><th>Clear 발송</th><th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {rules.map((r) => (
                                    <tr key={r.id} className={!r.enabled ? "notif-row-disabled" : ""}>
                                        <td title={r.name}>{r.name}</td>
                                        <td><Toggle checked={r.enabled} size="sm" onChange={() => toggleEnabled(r)} /></td>
                                        <td>{r.sourceType || "(전체)"}</td>
                                        <td className="notif-mono">{r.sourceIdPattern || "*"}</td>
                                        <td className="notif-mono">{r.metricPattern || "*"}</td>
                                        <td>{r.minLevel}</td>
                                        <td>{groupName(r.recipientGroupId)}</td>
                                        <td>{channelLabel(r.channelId)}</td>
                                        <td>{r.cooldownSec}s</td>
                                        <td>{r.digestWindowSec ? `${r.digestWindowSec}s` : "—"}</td>
                                        <td>{r.sendOnClear ? "예" : "아니오"}</td>
                                        <td className="notif-row-actions">
                                            <button type="button" className="notif-icon-btn"
                                                onClick={() => startEdit(r)} aria-label="편집">
                                                편집
                                            </button>
                                            <button type="button" className="notif-icon-btn notif-icon-btn-danger"
                                                onClick={() => remove(r)} aria-label="삭제">
                                                <IconTrash size={12} />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            {draft && (
                <section className="notif-card">
                    <div className="notif-card-head">
                        <h3>{draft.id ? `규칙 편집 · #${draft.id}` : "새 규칙"}</h3>
                        <button type="button" className="notif-icon-btn"
                            onClick={cancelEdit} aria-label="닫기">
                            <IconClose size={12} />
                        </button>
                    </div>
                    <fieldset className="notif-fieldset">
                        <legend>식별</legend>
                        <div className="notif-form-grid">
                            <FormField label="이름" required>
                                <input value={draft.name}
                                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                                    placeholder="예: 서버 CPU 90% 알림" />
                            </FormField>
                            <FormField label="활성화">
                                <div className="notif-toggle-inline">
                                    <Toggle checked={draft.enabled}
                                        onChange={(v) => setDraft({ ...draft, enabled: v })} />
                                </div>
                            </FormField>
                        </div>
                    </fieldset>

                    <fieldset className="notif-fieldset">
                        <legend>매치 조건</legend>
                        <div className="notif-form-grid">
                            <FormField label="소스 타입">
                                <select value={draft.sourceType || ""}
                                    onChange={(e) => setDraft({ ...draft, sourceType: e.target.value || null })}>
                                    {SOURCE_TYPE_OPTIONS.map((o) => (
                                        <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                </select>
                            </FormField>
                            <FormField label="대상 ID 패턴" hint="정규식 · 빈 값은 전체">
                                <input value={draft.sourceIdPattern || ""}
                                    onChange={(e) => setDraft({ ...draft, sourceIdPattern: e.target.value })}
                                    placeholder="예: ^web-server-.*"
                                    className="notif-mono" />
                            </FormField>
                            <FormField label="지표 패턴" hint="정규식 · 빈 값은 전체">
                                <input value={draft.metricPattern || ""}
                                    onChange={(e) => setDraft({ ...draft, metricPattern: e.target.value })}
                                    placeholder="예: ^(cpu|memory)$"
                                    className="notif-mono" />
                            </FormField>
                            <FormField label="최소 레벨">
                                <select value={draft.minLevel}
                                    onChange={(e) => setDraft({ ...draft, minLevel: e.target.value })}>
                                    <option value="warn">warn 이상</option>
                                    <option value="critical">critical 만</option>
                                </select>
                            </FormField>
                        </div>
                    </fieldset>

                    <fieldset className="notif-fieldset">
                        <legend>발송 대상</legend>
                        <div className="notif-form-grid">
                            <FormField label="수신자 그룹" required>
                                <select value={draft.recipientGroupId || ""}
                                    onChange={(e) => setDraft({ ...draft, recipientGroupId: parseInt(e.target.value, 10) || null })}>
                                    <option value="">(선택)</option>
                                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                                </select>
                            </FormField>
                            <FormField label="채널" required>
                                <select value={draft.channelId || ""}
                                    onChange={(e) => setDraft({ ...draft, channelId: parseInt(e.target.value, 10) || null })}>
                                    <option value="">(선택)</option>
                                    {channels.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            #{c.id} · {c.kind}{c.enabled ? "" : " (off)"}
                                        </option>
                                    ))}
                                </select>
                            </FormField>
                        </div>
                    </fieldset>

                    <fieldset className="notif-fieldset">
                        <legend>발송 정책</legend>
                        <div className="notif-form-grid">
                            <FormField label="쿨다운 (초)" hint="같은 키로 짧은 시간에 반복 발송되지 않도록 억제">
                                <input type="number" min="0" value={draft.cooldownSec}
                                    onChange={(e) => setDraft({ ...draft, cooldownSec: parseInt(e.target.value, 10) || 0 })} />
                            </FormField>
                            <FormField label="다이제스트 윈도우 (초)" hint="0 = 즉시 발송 · &gt;0 이면 윈도우 동안 모아서 1통">
                                <input type="number" min="0" value={draft.digestWindowSec || 0}
                                    onChange={(e) => setDraft({ ...draft, digestWindowSec: parseInt(e.target.value, 10) || 0 })} />
                            </FormField>
                            <FormField label="Clear 이벤트도 발송"
                                hint="알람 해제 시점에도 메일을 보낼지 여부">
                                <div className="notif-toggle-inline">
                                    <Toggle checked={!!draft.sendOnClear}
                                        onChange={(v) => setDraft({ ...draft, sendOnClear: v })} />
                                </div>
                            </FormField>
                        </div>
                    </fieldset>

                    <div className="notif-actions notif-actions-end">
                        <button type="button" className="notif-btn-ghost" onClick={cancelEdit}>
                            취소
                        </button>
                        <button type="button" className="notif-btn-primary"
                            onClick={save} disabled={saving}>
                            {saving ? "저장 중…" : "저장"}
                        </button>
                    </div>
                </section>
            )}
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   Silence sub-tab
   ══════════════════════════════════════════════════════════════════ */

const HOUR_PRESETS = [1, 4, 8, 24];

function SilencesPanel() {
    const { toast, toastOk, toastErr, dismissToast } = useToast();
    const { confirm, ConfirmEl } = useConfirm();
    const [silences, setSilences] = useState([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [hours, setHours] = useState(1);
    const [reason, setReason] = useState("");
    const [sourceType, setSourceType] = useState("");
    const [sourceIdPattern, setSourceIdPattern] = useState("");

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const list = await notificationSilenceService.list();
            setSilences(list);
        } catch (err) {
            toastErr(errorMessage(err, "억제 규칙을 불러올 수 없습니다."));
        } finally {
            setLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => { reload(); }, [reload]);

    const create = async () => {
        if (!name.trim()) { toastErr("이름을 입력하세요."); return; }
        const h = Number(hours);
        if (!Number.isFinite(h) || h <= 0) {
            toastErr("시간은 0보다 큰 숫자여야 합니다.");
            return;
        }
        setCreating(true);
        try {
            await notificationSilenceService.create({
                name: name.trim(),
                hours: h,
                reason: reason.trim() || null,
                sourceType: sourceType || null,
                sourceIdPattern: sourceIdPattern.trim() || null,
            });
            setName(""); setReason(""); setHours(1);
            setSourceType(""); setSourceIdPattern("");
            await reload();
            toastOk(`억제 규칙을 등록했습니다 (지속 ${h}시간).`);
        } catch (err) {
            toastErr(errorMessage(err, "억제 규칙 등록 실패"));
        } finally {
            setCreating(false);
        }
    };

    const remove = async (s) => {
        const ok = await confirm({
            title: `억제 규칙 “${s.name}” 삭제`,
            message: "삭제 즉시 해당 패턴에 매칭되는 알림이 다시 발송됩니다.",
            danger: true,
            confirmLabel: "삭제",
        });
        if (!ok) return;
        try {
            await notificationSilenceService.remove(s.id);
            await reload();
            toastOk("억제 규칙을 삭제했습니다.");
        } catch (err) {
            toastErr(errorMessage(err, "삭제 실패"));
        }
    };

    const now = Date.now();
    const isActive = (s) => {
        const a = s.startsAt ? new Date(s.startsAt).getTime() : 0;
        const b = s.endsAt ? new Date(s.endsAt).getTime() : 0;
        return a <= now && now <= b;
    };

    return (
        <div className="notif-pane">
            <Toast toast={toast} onDismiss={dismissToast} />
            {ConfirmEl}

            <section className="notif-card">
                <h3>새 억제 규칙 — 지금부터 N시간 동안 알람 발송 중단</h3>
                <p className="notif-muted">
                    점검·유지보수 중 알람 노이즈를 줄일 때 사용합니다. 종료 시각이 지나면 자동 해제됩니다.
                </p>
                <fieldset className="notif-fieldset">
                    <legend>기본</legend>
                    <div className="notif-form-grid">
                        <FormField label="이름" required>
                            <input value={name} onChange={(e) => setName(e.target.value)}
                                placeholder="예: 야간 정기 점검" />
                        </FormField>
                        <FormField label="지속 시간 (시)" required hint="0.5 단위 입력 가능">
                            <div className="notif-input-with-presets">
                                <input type="number" min="0.5" step="0.5" value={hours}
                                    onChange={(e) => setHours(e.target.value)} />
                                {HOUR_PRESETS.map((h) => (
                                    <button key={h} type="button"
                                        className={`notif-preset ${Number(hours) === h ? "active" : ""}`}
                                        onClick={() => setHours(h)}>
                                        {h}h
                                    </button>
                                ))}
                            </div>
                        </FormField>
                        <FormField label="사유" hint="감사 / 회고에 도움" full>
                            <input value={reason} onChange={(e) => setReason(e.target.value)}
                                placeholder="예: DB 패치 적용" />
                        </FormField>
                    </div>
                </fieldset>
                <fieldset className="notif-fieldset">
                    <legend>매치 조건 (선택)</legend>
                    <div className="notif-form-grid">
                        <FormField label="소스 타입">
                            <select value={sourceType}
                                onChange={(e) => setSourceType(e.target.value)}>
                                {SOURCE_TYPE_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                        </FormField>
                        <FormField label="대상 ID 패턴" hint="정규식 · 빈 값은 전체">
                            <input value={sourceIdPattern}
                                onChange={(e) => setSourceIdPattern(e.target.value)}
                                className="notif-mono"
                                placeholder="예: ^web-.*" />
                        </FormField>
                    </div>
                </fieldset>
                <div className="notif-actions notif-actions-end">
                    <button type="button" className="notif-btn-primary"
                        onClick={create} disabled={creating}>
                        <IconPlus size={12} /> {creating ? "등록 중…" : "등록"}
                    </button>
                </div>
            </section>

            <section className="notif-card">
                <div className="notif-card-head">
                    <h3>등록된 억제 규칙 <span className="notif-muted">({silences.length}개)</span></h3>
                    <button type="button" className="notif-btn-ghost notif-btn-sm" onClick={reload}>
                        <IconRefresh size={12} /> 새로고침
                    </button>
                </div>
                {loading ? (
                    <SkeletonBlock rows={3} />
                ) : silences.length === 0 ? (
                    <EmptyState title="등록된 억제 규칙이 없습니다"
                        hint="위에서 새 규칙을 추가하세요." />
                ) : (
                    <div className="notif-table-wrap">
                        <table className="notif-table">
                            <thead>
                                <tr>
                                    <th>이름</th><th>상태</th><th>시작</th><th>종료</th>
                                    <th>소스</th><th>대상 패턴</th><th>사유</th><th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {silences.map((s) => (
                                    <tr key={s.id}>
                                        <td>{s.name}</td>
                                        <td>
                                            <span className={`notif-badge ${isActive(s) ? "notif-badge-warn" : "notif-badge-muted"}`}>
                                                {isActive(s) ? "활성" : "비활성"}
                                            </span>
                                        </td>
                                        <td>{formatIso(s.startsAt)}</td>
                                        <td>{formatIso(s.endsAt)}</td>
                                        <td>{s.sourceType || "(전체)"}</td>
                                        <td className="notif-mono">{s.sourceIdPattern || "*"}</td>
                                        <td>{s.reason || "—"}</td>
                                        <td>
                                            <button type="button"
                                                className="notif-icon-btn notif-icon-btn-danger"
                                                onClick={() => remove(s)} aria-label="삭제">
                                                <IconTrash size={12} />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   Queue sub-tab (delivery history)
   ══════════════════════════════════════════════════════════════════ */

function QueuePanel() {
    const { toast, toastOk, toastErr, toastWarn, dismissToast } = useToast();
    const { confirm, ConfirmEl } = useConfirm();
    const [status, setStatus] = useState("");
    const [data, setData] = useState({ items: [], totalCount: 0 });
    const [offset, setOffset] = useState(0);
    const [loading, setLoading] = useState(true);
    const limit = 50;

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const r = await notificationQueueService.list({
                status: status || undefined, limit, offset,
            });
            setData(r);
        } catch (err) {
            toastErr(errorMessage(err, "발송 이력을 불러올 수 없습니다."));
        } finally {
            setLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status, offset]);

    useEffect(() => { reload(); }, [reload]);

    const retry = async (it) => {
        try {
            const r = await notificationQueueService.retry(it.id);
            if (r?.retried) {
                toastOk(`#${it.id} 재시도 큐에 등록했습니다.`);
            } else {
                toastWarn(`#${it.id} 는 재시도할 수 없는 상태입니다.`);
            }
            await reload();
        } catch (err) {
            toastErr(errorMessage(err, "재시도 요청 실패"));
        }
    };

    const cancel = async (it) => {
        const ok = await confirm({
            title: `발송 #${it.id} 취소`,
            message: `수신자: ${it.recipientAddress}\n제목: ${it.subject}\n\n취소하면 더 이상 재시도되지 않습니다.`,
            danger: true,
            confirmLabel: "취소 처리",
        });
        if (!ok) return;
        try {
            const r = await notificationQueueService.cancel(it.id);
            if (r?.cancelled) {
                toastOk(`#${it.id} 를 취소했습니다.`);
            } else {
                toastWarn(`#${it.id} 는 이미 발송됐거나 취소 불가 상태입니다.`);
            }
            await reload();
        } catch (err) {
            toastErr(errorMessage(err, "취소 요청 실패"));
        }
    };

    const start = data.totalCount === 0 ? 0 : offset + 1;
    const end = Math.min(offset + limit, data.totalCount);

    return (
        <div className="notif-pane">
            <Toast toast={toast} onDismiss={dismissToast} />
            {ConfirmEl}

            <section className="notif-card">
                <div className="notif-card-head">
                    <h3>발송 이력</h3>
                    <div className="notif-card-actions">
                        <select value={status}
                            onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
                            <option value="">상태: 전체</option>
                            {Object.entries(QUEUE_STATUS_LABELS).map(([k, l]) => (
                                <option key={k} value={k}>{l}</option>
                            ))}
                        </select>
                        <button type="button" className="notif-btn-ghost notif-btn-sm" onClick={reload}>
                            <IconRefresh size={12} /> 새로고침
                        </button>
                    </div>
                </div>
                {loading ? (
                    <SkeletonBlock rows={5} />
                ) : data.items.length === 0 ? (
                    <EmptyState title="이력이 없습니다"
                        hint={status ? "필터 조건을 바꿔보세요." : "아직 발송된 알림이 없습니다."} />
                ) : (
                    <div className="notif-table-wrap">
                        <table className="notif-table notif-table-tight">
                            <thead>
                                <tr>
                                    <th>#</th><th>생성</th><th>발송완료</th><th>상태</th><th>시도</th>
                                    <th>수신자</th><th>제목</th><th>마지막 에러</th><th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.items.map((it) => (
                                    <tr key={it.id} className={`notif-status-${it.status}`}>
                                        <td>{it.id}</td>
                                        <td>{formatIso(it.createdAt)}</td>
                                        <td>{formatIso(it.sentAt)}</td>
                                        <td><StatusBadge status={it.status} /></td>
                                        <td>{it.attempt}</td>
                                        <td className="notif-truncate" title={it.recipientAddress}>{it.recipientAddress}</td>
                                        <td className="notif-truncate" title={it.subject}>{it.subject}</td>
                                        <td className="notif-truncate" title={it.lastError || ""}>{it.lastError || "—"}</td>
                                        <td className="notif-row-actions">
                                            {(it.status === "failed" || it.status === "dead") && (
                                                <button type="button" className="notif-icon-btn"
                                                    onClick={() => retry(it)}>재시도</button>
                                            )}
                                            {(it.status === "pending" || it.status === "failed") && (
                                                <button type="button"
                                                    className="notif-icon-btn notif-icon-btn-danger"
                                                    onClick={() => cancel(it)}>취소</button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                <div className="notif-pager">
                    <span>{start.toLocaleString()} – {end.toLocaleString()} / {data.totalCount.toLocaleString()}</span>
                    <div className="notif-pager-spacer" />
                    <button type="button" disabled={offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - limit))}>이전</button>
                    <button type="button" disabled={offset + limit >= data.totalCount}
                        onClick={() => setOffset(offset + limit)}>다음</button>
                </div>
            </section>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   Top-level NotificationsTab
   ══════════════════════════════════════════════════════════════════ */

export default function NotificationsTab() {
    const [sub, setSub] = useState("master");

    const Panel = useMemo(() => {
        switch (sub) {
            case "master": return MasterPanel;
            case "channels": return ChannelPanel;
            case "groups": return GroupsPanel;
            case "rules": return RulesPanel;
            case "silences": return SilencesPanel;
            case "queue": return QueuePanel;
            default: return MasterPanel;
        }
    }, [sub]);

    return (
        <div className="notif-tab-root">
            <nav className="notif-subtabs" role="tablist">
                {SUB_TABS.map((t) => (
                    <button key={t.key} type="button" role="tab"
                        aria-selected={sub === t.key}
                        className={`notif-subtab ${sub === t.key ? "active" : ""}`}
                        onClick={() => setSub(t.key)}>
                        {t.label}
                    </button>
                ))}
            </nav>
            <div className="notif-tab-body">
                <Panel />
            </div>
        </div>
    );
}
