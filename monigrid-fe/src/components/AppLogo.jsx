/**
 * AppLogo — modern monitoring brand mark used in the dashboard header and
 * the login page. Pure SVG (no external asset) so it stays crisp at any size
 * and inherits colors from the parent via `currentColor` where possible.
 *
 * Design brief: a rounded-square "screen" with a layered gradient fill, an
 * ascending line-chart stroke, and a glowing pulse dot at the latest point —
 * matches the dark glassy theme of the dashboard.
 */
const AppLogo = ({ size = 36, className = "" }) => {
    return (
        <svg
            className={`app-logo ${className}`.trim()}
            width={size}
            height={size}
            viewBox='0 0 48 48'
            fill='none'
            xmlns='http://www.w3.org/2000/svg'
            aria-hidden='true'
        >
            <defs>
                <linearGradient
                    id='appLogoBg'
                    x1='4'
                    y1='4'
                    x2='44'
                    y2='44'
                    gradientUnits='userSpaceOnUse'
                >
                    <stop offset='0%' stopColor='#4f8bff' />
                    <stop offset='55%' stopColor='#6366f1' />
                    <stop offset='100%' stopColor='#9333ea' />
                </linearGradient>
                <linearGradient
                    id='appLogoStroke'
                    x1='10'
                    y1='32'
                    x2='38'
                    y2='14'
                    gradientUnits='userSpaceOnUse'
                >
                    <stop offset='0%' stopColor='#f0f9ff' stopOpacity='0.95' />
                    <stop offset='100%' stopColor='#ffffff' />
                </linearGradient>
                <radialGradient
                    id='appLogoGlow'
                    cx='35'
                    cy='15'
                    r='6'
                    gradientUnits='userSpaceOnUse'
                >
                    <stop offset='0%' stopColor='#ffffff' stopOpacity='0.95' />
                    <stop offset='100%' stopColor='#ffffff' stopOpacity='0' />
                </radialGradient>
            </defs>

            {/* screen panel */}
            <rect
                x='4'
                y='4'
                width='40'
                height='40'
                rx='11'
                fill='url(#appLogoBg)'
            />
            <rect
                x='4'
                y='4'
                width='40'
                height='40'
                rx='11'
                fill='none'
                stroke='rgba(255,255,255,0.22)'
                strokeWidth='1'
            />

            {/* grid hint */}
            <path
                d='M10 32 H38'
                stroke='rgba(255,255,255,0.18)'
                strokeWidth='1'
                strokeLinecap='round'
            />
            <path
                d='M10 24 H38'
                stroke='rgba(255,255,255,0.12)'
                strokeWidth='1'
                strokeLinecap='round'
                strokeDasharray='2 3'
            />

            {/* line chart */}
            <path
                d='M10 32 L17 25 L22 29 L29 18 L38 14'
                stroke='url(#appLogoStroke)'
                strokeWidth='2.6'
                strokeLinecap='round'
                strokeLinejoin='round'
                fill='none'
            />

            {/* pulse glow + dot at last point */}
            <circle cx='35' cy='15' r='6' fill='url(#appLogoGlow)' />
            <circle cx='35' cy='15' r='2.4' fill='#ffffff' />
        </svg>
    );
};

export default AppLogo;
