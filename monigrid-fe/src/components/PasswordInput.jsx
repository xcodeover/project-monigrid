import React, { useState } from "react";
import "./PasswordInput.css";

const EyeOpen = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
);

const EyeOff = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.77 19.77 0 0 1 4.16-5.19" />
        <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.6 19.6 0 0 1-3.16 4.19" />
        <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
);

/**
 * Password input with show/hide toggle.
 * 기존 `<input type="password" ... />` 자리에 그대로 끼워 넣을 수 있도록
 * input 의 모든 prop 을 그대로 전달한다.
 */
const PasswordInput = ({ className, ...rest }) => {
    const [shown, setShown] = useState(false);
    return (
        <span className="pw-input-wrap">
            <input
                {...rest}
                type={shown ? "text" : "password"}
                className={`pw-input${className ? ` ${className}` : ""}`}
            />
            <button
                type="button"
                className="pw-toggle-btn"
                onClick={() => setShown((s) => !s)}
                tabIndex={-1}
                disabled={rest.disabled}
                aria-label={shown ? "비밀번호 숨기기" : "비밀번호 표시"}
                title={shown ? "비밀번호 숨기기" : "비밀번호 표시"}
            >
                {shown ? <EyeOff /> : <EyeOpen />}
            </button>
        </span>
    );
};

export default PasswordInput;
