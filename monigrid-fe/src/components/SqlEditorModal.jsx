import React, { useEffect, useMemo, useState } from "react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import "prismjs/components/prism-sql";
import { dashboardService } from "../services/api";
import "./SqlEditorModal.css";

const SELECT_START_PATTERN = /^\s*(select\b|with\b[\s\S]*\bselect\b)/i;
const FORBIDDEN_SQL_PATTERN =
    /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|call|exec|execute)\b/i;
const FOR_UPDATE_PATTERN = /\bfor\s+update\b/i;
const FROM_PATTERN = /\bfrom\b/i;
const ORDER_WITHOUT_BY_PATTERN = /\border\b(?!\s+by\b)/i;
const WHERE_NO_CONDITION_PATTERN =
    /\bwhere\b\s*(group\s+by\b|order\s+by\b|limit\b|$)/i;
const ORDER_BY_NO_TARGET_PATTERN = /\border\s+by\b\s*(limit\b|$)/i;

const DEFAULT_TYPO_PATTERNS = {
    where: ["whre", "wehre", "wher", "wheer", "wherre", "werhe"],
    order_by: ["oder", "odrer", "ordder", "ordr"],
    group_by: ["gorup", "gruop", "gropu", "grup"],
    having: ["havng", "hvaing", "havign", "haivng"],
    join: ["jion", "joim", "jnio", "joni"],
};

const escapeRegex = (value) =>
    String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeTypoPatterns = (rawPatterns) => {
    const resolved = {};
    Object.entries(DEFAULT_TYPO_PATTERNS).forEach(([key, defaults]) => {
        const rawValues = rawPatterns?.[key];
        const candidateValues = Array.isArray(rawValues) ? rawValues : defaults;

        const normalized = Array.from(
            new Set(
                candidateValues
                    .map((item) =>
                        String(item ?? "")
                            .trim()
                            .toLowerCase(),
                    )
                    .filter(Boolean),
            ),
        );

        resolved[key] = normalized.length > 0 ? normalized : defaults;
    });

    return resolved;
};

const buildTypoRegexes = (rawPatterns) => {
    const patterns = normalizeTypoPatterns(rawPatterns);

    return {
        where: new RegExp(
            `\\b(${patterns.where.map(escapeRegex).join("|")})\\b`,
            "i",
        ),
        order_by: new RegExp(
            `\\b(${patterns.order_by.map(escapeRegex).join("|")})\\s+by\\b`,
            "i",
        ),
        group_by: new RegExp(
            `\\b(${patterns.group_by.map(escapeRegex).join("|")})\\s+by\\b`,
            "i",
        ),
        having: new RegExp(
            `\\b(${patterns.having.map(escapeRegex).join("|")})\\b`,
            "i",
        ),
        join: new RegExp(
            `\\b(${patterns.join.map(escapeRegex).join("|")})\\b`,
            "i",
        ),
    };
};

const validateSqlScript = (sql, typoPatterns) => {
    const issues = [];
    const trimmed = String(sql ?? "").trim();
    const typoRegexes = buildTypoRegexes(typoPatterns);

    if (!trimmed) {
        issues.push({
            severity: "error",
            message: "SQL 스크립트가 비어 있습니다.",
        });
        return issues;
    }

    if (!SELECT_START_PATTERN.test(trimmed)) {
        issues.push({
            severity: "error",
            message: "SELECT 또는 WITH ... SELECT 쿼리만 허용됩니다.",
        });
    }

    if (!FROM_PATTERN.test(trimmed)) {
        issues.push({
            severity: "error",
            message: "FROM 절이 필요합니다.",
        });
    }

    const whereTypoMatch = trimmed.match(typoRegexes.where);
    if (whereTypoMatch) {
        issues.push({
            severity: "error",
            message: `가능한 WHERE 오타가 감지되었습니다: ${whereTypoMatch[1].toUpperCase()}.`,
        });
    }

    const orderByTypoMatch = trimmed.match(typoRegexes.order_by);
    if (orderByTypoMatch) {
        issues.push({
            severity: "error",
            message: `가능한 ORDER BY 오타가 감지되었습니다: ${orderByTypoMatch[1].toUpperCase()} BY.`,
        });
    }

    const groupByTypoMatch = trimmed.match(typoRegexes.group_by);
    if (groupByTypoMatch) {
        issues.push({
            severity: "error",
            message: `가능한 GROUP BY 오타가 감지되었습니다: ${groupByTypoMatch[1].toUpperCase()} BY.`,
        });
    }

    const havingTypoMatch = trimmed.match(typoRegexes.having);
    if (havingTypoMatch) {
        issues.push({
            severity: "error",
            message: `가능한 HAVING 오타가 감지되었습니다: ${havingTypoMatch[1].toUpperCase()}.`,
        });
    }

    const joinTypoMatch = trimmed.match(typoRegexes.join);
    if (joinTypoMatch) {
        issues.push({
            severity: "error",
            message: `가능한 JOIN 오타가 감지되었습니다: ${joinTypoMatch[1].toUpperCase()}.`,
        });
    }

    if (ORDER_WITHOUT_BY_PATTERN.test(trimmed)) {
        issues.push({
            severity: "error",
            message: "ORDER 키워드는 ORDER BY로 사용해야 합니다.",
        });
    }

    if (WHERE_NO_CONDITION_PATTERN.test(trimmed)) {
        issues.push({
            severity: "error",
            message: "WHERE 절은 조건을 포함해야 합니다.",
        });
    }

    if (ORDER_BY_NO_TARGET_PATTERN.test(trimmed)) {
        issues.push({
            severity: "error",
            message: "ORDER BY 절은 정렬 열을 포함해야 합니다.",
        });
    }

    if (FOR_UPDATE_PATTERN.test(trimmed)) {
        issues.push({
            severity: "error",
            message: "SELECT ... FOR UPDATE 구문은 허용되지 않습니다.",
        });
    }

    const forbiddenMatch = trimmed.match(FORBIDDEN_SQL_PATTERN);
    if (forbiddenMatch) {
        issues.push({
            severity: "error",
            message: `금지된 키워드가 포함되어 있습니다: ${forbiddenMatch[1].toUpperCase()}`,
        });
    }

    const sqlWithoutTrailingSemicolon = trimmed.replace(/[;\s]+$/, "");
    if (sqlWithoutTrailingSemicolon.includes(";")) {
        issues.push({
            severity: "error",
            message: "단일 SELECT 구문만 허용됩니다. (중간 세미콜론 금지)",
        });
    }

    let parenthesesBalance = 0;
    for (const char of trimmed) {
        if (char === "(") parenthesesBalance += 1;
        if (char === ")") parenthesesBalance -= 1;
        if (parenthesesBalance < 0) {
            issues.push({
                severity: "error",
                message: "괄호 짝이 맞지 않습니다.",
            });
            break;
        }
    }
    if (parenthesesBalance > 0) {
        issues.push({
            severity: "error",
            message: "닫히지 않은 괄호가 있습니다.",
        });
    }

    const singleQuoteCount = (trimmed.match(/'/g) || []).length;
    if (singleQuoteCount % 2 !== 0) {
        issues.push({
            severity: "error",
            message: "작은따옴표 짝이 맞지 않습니다.",
        });
    }

    return issues;
};

const highlightSql = (code) =>
    Prism.highlight(code || "", Prism.languages.sql, "sql");

const SQL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const SqlEditorModal = ({ open, onClose }) => {
    // mode: "edit" — 기존 활성 API의 SQL 파일을 편집
    //       "create" — 새 sqlId로 sql/<id>.sql 파일을 생성
    const [mode, setMode] = useState("edit");

    const [endpoints, setEndpoints] = useState([]);
    const [selectedApiId, setSelectedApiId] = useState("");
    const [sqlText, setSqlText] = useState("");
    const [originalSql, setOriginalSql] = useState("");
    const [loadingEndpoints, setLoadingEndpoints] = useState(false);
    const [loadingSql, setLoadingSql] = useState(false);
    const [saving, setSaving] = useState(false);
    const [showSaveConfirm, setShowSaveConfirm] = useState(false);
    const [error, setError] = useState("");
    const [successMessage, setSuccessMessage] = useState("");
    const [typoPatterns, setTypoPatterns] = useState(DEFAULT_TYPO_PATTERNS);

    // Create-mode 전용 상태
    const [newSqlId, setNewSqlId] = useState("");
    const [existingSqlFiles, setExistingSqlFiles] = useState([]);

    const issues = useMemo(
        () => validateSqlScript(sqlText, typoPatterns),
        [sqlText, typoPatterns],
    );
    const hasError = issues.some((issue) => issue.severity === "error");
    const selectedEndpoint = useMemo(
        () => endpoints.find((item) => item.id === selectedApiId) ?? null,
        [endpoints, selectedApiId],
    );

    const trimmedNewSqlId = newSqlId.trim();
    const newSqlIdValid = SQL_ID_PATTERN.test(trimmedNewSqlId);
    const newSqlIdAlreadyExists = useMemo(
        () =>
            newSqlIdValid &&
            existingSqlFiles.some((file) => file.sqlId === trimmedNewSqlId),
        [existingSqlFiles, newSqlIdValid, trimmedNewSqlId],
    );

    useEffect(() => {
        if (!open) {
            return;
        }

        const loadEndpoints = async () => {
            setLoadingEndpoints(true);
            setError("");
            setSuccessMessage("");
            try {
                const response =
                    (await dashboardService.getSqlEditableEndpoints()) || [];
                setEndpoints(response || []);
                setSelectedApiId(
                    (current) => current || response?.[0]?.id || "",
                );

                try {
                    const rulesResponse =
                        await dashboardService.getSqlValidationRules();
                    setTypoPatterns(
                        normalizeTypoPatterns(rulesResponse?.typoPatterns),
                    );
                } catch (rulesError) {
                    setTypoPatterns(DEFAULT_TYPO_PATTERNS);
                    console.warn(
                        "SQL validation rules load failed, using defaults.",
                        rulesError,
                    );
                }

                try {
                    const filesResponse = await dashboardService.listSqlFiles();
                    setExistingSqlFiles(filesResponse?.files || []);
                } catch (filesError) {
                    setExistingSqlFiles([]);
                    console.warn(
                        "SQL file list load failed, ignoring.",
                        filesError,
                    );
                }
            } catch (loadError) {
                setError(
                    loadError?.response?.data?.message ||
                        "편집 가능한 API 목록을 불러올 수 없습니다.",
                );
            } finally {
                setLoadingEndpoints(false);
            }
        };

        loadEndpoints();
    }, [open]);

    useEffect(() => {
        if (!open || mode !== "edit" || !selectedApiId) {
            return;
        }

        const loadSql = async () => {
            setLoadingSql(true);
            setError("");
            setSuccessMessage("");
            try {
                const response =
                    await dashboardService.getApiSqlScript(selectedApiId);
                const nextSql = String(response?.sql || "");
                setSqlText(nextSql);
                setOriginalSql(nextSql);
            } catch (loadError) {
                setError(
                    loadError?.response?.data?.message ||
                        "SQL 스크립트를 불러올 수 없습니다.",
                );
            } finally {
                setLoadingSql(false);
            }
        };

        loadSql();
    }, [open, mode, selectedApiId]);

    if (!open) {
        return null;
    }

    const handleSave = async () => {
        setSaving(true);
        setShowSaveConfirm(false);
        setError("");
        setSuccessMessage("");
        try {
            if (mode === "create") {
                const response = await dashboardService.createSqlFile(
                    trimmedNewSqlId,
                    sqlText,
                    { overwrite: true },
                );
                const nextSql = String(response?.sql || sqlText);
                setSqlText(nextSql);
                setOriginalSql(nextSql);
                setSuccessMessage(
                    response?.created
                        ? `새 SQL 파일을 생성했습니다: ${response.fileName}`
                        : `기존 SQL 파일을 덮어썼습니다: ${response.fileName}`,
                );
                // Refresh file list so duplicate-detection stays accurate.
                try {
                    const filesResponse = await dashboardService.listSqlFiles();
                    setExistingSqlFiles(filesResponse?.files || []);
                } catch {
                    /* non-fatal */
                }
            } else {
                const response = await dashboardService.updateApiSqlScript(
                    selectedApiId,
                    sqlText,
                );
                const nextSql = String(response?.sql || sqlText);
                setSqlText(nextSql);
                setOriginalSql(nextSql);
                setSuccessMessage(
                    "SQL 스크립트를 저장했습니다. 다음 API 호출부터 반영됩니다.",
                );
            }
        } catch (saveError) {
            setError(
                saveError?.response?.data?.message ||
                    saveError?.response?.data?.detail ||
                    "SQL 스크립트 저장에 실패했습니다.",
            );
        } finally {
            setSaving(false);
        }
    };

    const handleSaveRequest = () => {
        if (hasError) {
            setError("기본 점검 오류를 먼저 해결해주세요.");
            return;
        }
        if (mode === "create" && !newSqlIdValid) {
            setError("SQL ID는 영문/숫자/밑줄/하이픈 1~64자만 허용됩니다.");
            return;
        }
        setShowSaveConfirm(true);
    };

    const handleModeChange = (nextMode) => {
        if (nextMode === mode) return;
        setMode(nextMode);
        setError("");
        setSuccessMessage("");
        if (nextMode === "create") {
            setSqlText("");
            setOriginalSql("");
        }
    };

    return (
        <div className='modal-overlay'>
            <div
                className='modal-content sql-editor-modal'
                onClick={(event) => event.stopPropagation()}
            >
                <div className='modal-header'>
                    <div>
                        <h3>API SQL 편집</h3>
                        <p className='sql-editor-subtitle'>
                            활성화된 API의 SQL 스크립트를 서버에 직접
                            반영합니다.
                        </p>
                    </div>
                    <button className='close-btn' onClick={onClose}>
                        ✕
                    </button>
                </div>

                <div className='modal-body sql-editor-body'>
                    <div
                        className='sql-mode-tabs'
                        role='tablist'
                        aria-label='SQL editor mode'
                    >
                        <button
                            type='button'
                            role='tab'
                            aria-selected={mode === "edit"}
                            className={`sql-mode-tab${mode === "edit" ? " active" : ""}`}
                            onClick={() => handleModeChange("edit")}
                            disabled={saving}
                        >
                            기존 API 편집
                        </button>
                        <button
                            type='button'
                            role='tab'
                            aria-selected={mode === "create"}
                            className={`sql-mode-tab${mode === "create" ? " active" : ""}`}
                            onClick={() => handleModeChange("create")}
                            disabled={saving}
                        >
                            새 SQL 파일
                        </button>
                    </div>

                    {mode === "edit" ? (
                        <div className='sql-toolbar-grid'>
                            <div className='form-group'>
                                <label htmlFor='sql-api-target'>API 선택</label>
                                <select
                                    id='sql-api-target'
                                    value={selectedApiId}
                                    onChange={(event) =>
                                        setSelectedApiId(event.target.value)
                                    }
                                    disabled={loadingEndpoints || saving}
                                >
                                    {endpoints.map((endpoint) => (
                                        <option
                                            key={endpoint.id}
                                            value={endpoint.id}
                                        >
                                            {endpoint.title} (
                                            {endpoint.restApiPath})
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className='sql-summary-group'>
                                <label className='sql-summary-label'>
                                    SQL ID
                                </label>
                                <div className='sql-endpoint-summary'>
                                    <span className='sql-summary-value'>
                                        {selectedEndpoint?.sqlId || "-"}
                                    </span>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className='sql-toolbar-grid'>
                            <div className='form-group'>
                                <label htmlFor='sql-new-id'>
                                    SQL ID (파일명)
                                </label>
                                <input
                                    id='sql-new-id'
                                    type='text'
                                    value={newSqlId}
                                    onChange={(event) =>
                                        setNewSqlId(event.target.value)
                                    }
                                    placeholder='예: daily_sales_summary'
                                    disabled={saving}
                                    autoComplete='off'
                                    spellCheck={false}
                                />
                                {newSqlId && !newSqlIdValid && (
                                    <p className='sql-id-hint error'>
                                        영문/숫자/밑줄/하이픈 1~64자만 허용됩니다.
                                    </p>
                                )}
                                {newSqlIdValid && newSqlIdAlreadyExists && (
                                    <p className='sql-id-hint warn'>
                                        같은 이름의 파일이 이미 존재합니다 — 저장 시 덮어씁니다.
                                    </p>
                                )}
                                {newSqlIdValid && !newSqlIdAlreadyExists && (
                                    <p className='sql-id-hint ok'>
                                        저장 시 sql/{trimmedNewSqlId}.sql 파일이 생성됩니다.
                                    </p>
                                )}
                            </div>

                            <div className='sql-summary-group'>
                                <label className='sql-summary-label'>
                                    저장 경로
                                </label>
                                <div className='sql-endpoint-summary'>
                                    <span className='sql-summary-value'>
                                        ./sql/{trimmedNewSqlId || "<id>"}.sql
                                    </span>
                                </div>
                            </div>
                        </div>
                    )}

                    {error && <p className='sql-editor-error'>{error}</p>}
                    {successMessage && (
                        <p className='sql-editor-success'>{successMessage}</p>
                    )}

                    <div className='sql-editor-status-row'>
                        <div className='sql-status-pill'>
                            {hasError
                                ? "기본 문법 점검: 오류 있음"
                                : "기본 문법 점검: 통과"}
                        </div>
                        <div className='sql-status-note'>
                            기본적인 실시간 검사만 수행합니다.
                        </div>
                    </div>

                    <div className='sql-editor-surface'>
                        {mode === "edit" && loadingSql ? (
                            <div className='sql-editor-loading'>
                                SQL을 불러오는 중...
                            </div>
                        ) : mode === "edit" && endpoints.length === 0 ? (
                            <div className='sql-editor-loading'>
                                편집 가능한 활성 API가 없습니다.
                            </div>
                        ) : (
                            <Editor
                                value={sqlText}
                                onValueChange={setSqlText}
                                highlight={highlightSql}
                                padding={16}
                                textareaClassName='sql-editor-textarea'
                                preClassName='sql-editor-pre'
                                className='sql-editor-instance'
                                tabSize={2}
                                insertSpaces
                                disabled={saving}
                            />
                        )}
                    </div>

                    <div className='sql-validation-panel'>
                        <h4>실시간 점검</h4>
                        {issues.length === 0 ? (
                            <p className='sql-validation-ok'>
                                기본 문법 검사에서 문제가 발견되지 않았습니다.
                            </p>
                        ) : (
                            <ul className='sql-validation-list'>
                                {issues.map((issue, index) => (
                                    <li
                                        key={`${issue.message}-${index}`}
                                        className={`sql-validation-item ${issue.severity}`}
                                    >
                                        {issue.message}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>

                <div className='modal-footer'>
                    <button className='secondary-btn' onClick={onClose}>
                        닫기
                    </button>
                    <button
                        className='primary-btn'
                        onClick={handleSaveRequest}
                        disabled={
                            saving ||
                            !sqlText.trim() ||
                            (mode === "edit" &&
                                (loadingSql ||
                                    !selectedApiId ||
                                    sqlText === originalSql)) ||
                            (mode === "create" && !newSqlIdValid)
                        }
                    >
                        {saving
                            ? "저장 중..."
                            : mode === "create"
                              ? "새 SQL 파일 저장"
                              : "서버 SQL 저장"}
                    </button>
                </div>

                {showSaveConfirm && (
                    <div className='sql-save-confirm-overlay'>
                        <div className='sql-save-confirm-dialog'>
                            <h4>
                                {mode === "create"
                                    ? "새 SQL 파일 생성"
                                    : "SQL 변경 저장"}
                            </h4>
                            <p>
                                {mode === "create"
                                    ? newSqlIdAlreadyExists
                                        ? `같은 이름의 파일이 존재합니다. sql/${trimmedNewSqlId}.sql 을 덮어씁니까?`
                                        : `sql/${trimmedNewSqlId}.sql 파일을 새로 생성하시겠습니까?`
                                    : "변경된 SQL을 서버 파일에 저장하시겠습니까? 저장 후 다음 API 호출부터 즉시 반영됩니다."}
                            </p>
                            <div className='sql-save-confirm-actions'>
                                <button
                                    className='secondary-btn'
                                    onClick={() => setShowSaveConfirm(false)}
                                    disabled={saving}
                                >
                                    취소
                                </button>
                                <button
                                    className='primary-btn'
                                    onClick={handleSave}
                                    disabled={saving}
                                >
                                    {saving ? "저장 중..." : "저장"}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default SqlEditorModal;
