import { useMemo } from 'react';

type AgentState = 'idle' | 'reading' | 'planning' | 'thinking' | 'executing' | 'reviewing' | 'building' | 'delivering' | 'error';

interface AgentStateIconProps {
  state: AgentState;
  tint: string;
  size?: number;
}

export function AgentStateIcon({ state, tint, size = 18 }: AgentStateIconProps) {
  const style = useMemo(() => ({ width: size, height: size }), [size]);

  switch (state) {
    case 'idle':
      return (
        <svg viewBox="0 0 20 20" style={style} className="shrink-0">
          <circle cx="10" cy="10" r="3" fill={tint} opacity="0.3">
            <animate attributeName="opacity" values="0.2;0.4;0.2" dur="3s" repeatCount="indefinite" />
          </circle>
        </svg>
      );

    case 'reading':
      return (
        <svg viewBox="0 0 20 20" style={style} className="shrink-0">
          <ellipse cx="10" cy="10" rx="7" ry="4" fill="none" stroke={tint} strokeWidth="1.2" opacity="0.6" />
          <circle cx="10" cy="10" r="2" fill={tint} opacity="0.7">
            <animate attributeName="r" values="2;1.5;2" dur="1.5s" repeatCount="indefinite" />
          </circle>
          <line x1="3" y1="10" x2="17" y2="10" stroke={tint} strokeWidth="0.5" opacity="0.3">
            <animate attributeName="y1" values="8;12;8" dur="2s" repeatCount="indefinite" />
            <animate attributeName="y2" values="8;12;8" dur="2s" repeatCount="indefinite" />
          </line>
        </svg>
      );

    case 'planning':
      return (
        <svg viewBox="0 0 20 20" style={style} className="shrink-0">
          <circle cx="10" cy="5" r="1.5" fill={tint} opacity="0.7">
            <animate attributeName="opacity" values="0.4;0.8;0.4" dur="2s" repeatCount="indefinite" />
          </circle>
          <circle cx="5" cy="14" r="1.5" fill={tint} opacity="0.7">
            <animate attributeName="opacity" values="0.4;0.8;0.4" dur="2s" begin="0.5s" repeatCount="indefinite" />
          </circle>
          <circle cx="15" cy="14" r="1.5" fill={tint} opacity="0.7">
            <animate attributeName="opacity" values="0.4;0.8;0.4" dur="2s" begin="1s" repeatCount="indefinite" />
          </circle>
          <line x1="10" y1="5" x2="5" y2="14" stroke={tint} strokeWidth="0.6" opacity="0.3">
            <animate attributeName="opacity" values="0.15;0.4;0.15" dur="2s" begin="0.3s" repeatCount="indefinite" />
          </line>
          <line x1="10" y1="5" x2="15" y2="14" stroke={tint} strokeWidth="0.6" opacity="0.3">
            <animate attributeName="opacity" values="0.15;0.4;0.15" dur="2s" begin="0.7s" repeatCount="indefinite" />
          </line>
          <line x1="5" y1="14" x2="15" y2="14" stroke={tint} strokeWidth="0.6" opacity="0.3">
            <animate attributeName="opacity" values="0.15;0.4;0.15" dur="2s" begin="1.1s" repeatCount="indefinite" />
          </line>
        </svg>
      );

    case 'thinking':
      return (
        <svg viewBox="0 0 20 20" style={style} className="shrink-0">
          <circle cx="10" cy="10" r="2" fill={tint} opacity="0.6" />
          <circle cx="10" cy="10" r="4" fill="none" stroke={tint} strokeWidth="0.5" opacity="0">
            <animate attributeName="r" values="3;8" dur="1.8s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.5;0" dur="1.8s" repeatCount="indefinite" />
          </circle>
          <circle cx="10" cy="10" r="4" fill="none" stroke={tint} strokeWidth="0.5" opacity="0">
            <animate attributeName="r" values="3;8" dur="1.8s" begin="0.6s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.5;0" dur="1.8s" begin="0.6s" repeatCount="indefinite" />
          </circle>
          <circle cx="10" cy="10" r="4" fill="none" stroke={tint} strokeWidth="0.5" opacity="0">
            <animate attributeName="r" values="3;8" dur="1.8s" begin="1.2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.5;0" dur="1.8s" begin="1.2s" repeatCount="indefinite" />
          </circle>
        </svg>
      );

    case 'executing':
      return (
        <svg viewBox="0 0 20 20" style={style} className="shrink-0">
          <polygon points="11,2 7,11 10,11 9,18 13,9 10,9" fill={tint} opacity="0.6">
            <animate attributeName="opacity" values="0.3;0.8;0.3" dur="0.8s" repeatCount="indefinite" />
          </polygon>
        </svg>
      );

    case 'reviewing':
      return (
        <svg viewBox="0 0 20 20" style={style} className="shrink-0">
          <circle cx="9" cy="9" r="4.5" fill="none" stroke={tint} strokeWidth="1" opacity="0.5" />
          <line x1="12.5" y1="12.5" x2="17" y2="17" stroke={tint} strokeWidth="1.2" opacity="0.5" />
          <circle cx="9" cy="9" r="2" fill={tint} opacity="0.15">
            <animate attributeName="opacity" values="0.1;0.3;0.1" dur="1.5s" repeatCount="indefinite" />
          </circle>
        </svg>
      );

    case 'building':
      return (
        <svg viewBox="0 0 20 20" style={style} className="shrink-0">
          <g transform="translate(10,10)">
            <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="4s" repeatCount="indefinite" additive="sum" />
            <path d="M-1.5,-6.5 L1.5,-6.5 L1.5,-4.5 L3,-3.5 L5,-5 L6.5,-3.5 L5,-1.5 L5.5,0.5 L7.5,1 L7.5,3 L5.5,3.5 L5,5.5 L6.5,7 L5,8.5 L3,7 L0.5,7.5 L0,9.5 L-2,9.5 L-2.5,7.5 L-4.5,7 L-6.5,8.5 L-8,7 L-6.5,5 L-6.5,3 L-8.5,2.5 L-8.5,0.5 L-6.5,-0.5 L-6,-2.5 L-7.5,-4.5 L-6,-6 L-4,-4.5 L-2,-5.5 Z"
              fill="none" stroke={tint} strokeWidth="0.6" opacity="0.4"
              transform="scale(0.7)"
            />
            <circle cx="0" cy="0" r="2" fill="none" stroke={tint} strokeWidth="0.6" opacity="0.4" />
          </g>
        </svg>
      );

    case 'delivering':
      return (
        <svg viewBox="0 0 20 20" style={style} className="shrink-0">
          <circle cx="10" cy="10" r="2" fill={tint} opacity="0.5" />
          <path d="M 5 7 A 6 6 0 0 1 5 13" fill="none" stroke={tint} strokeWidth="0.8" opacity="0">
            <animate attributeName="opacity" values="0;0.5;0" dur="1.5s" repeatCount="indefinite" />
          </path>
          <path d="M 15 7 A 6 6 0 0 0 15 13" fill="none" stroke={tint} strokeWidth="0.8" opacity="0">
            <animate attributeName="opacity" values="0;0.5;0" dur="1.5s" repeatCount="indefinite" />
          </path>
          <path d="M 3 5 A 9 9 0 0 1 3 15" fill="none" stroke={tint} strokeWidth="0.6" opacity="0">
            <animate attributeName="opacity" values="0;0.3;0" dur="1.5s" begin="0.3s" repeatCount="indefinite" />
          </path>
          <path d="M 17 5 A 9 9 0 0 0 17 15" fill="none" stroke={tint} strokeWidth="0.6" opacity="0">
            <animate attributeName="opacity" values="0;0.3;0" dur="1.5s" begin="0.3s" repeatCount="indefinite" />
          </path>
        </svg>
      );

    case 'error':
      return (
        <svg viewBox="0 0 20 20" style={style} className="shrink-0">
          <line x1="6" y1="6" x2="14" y2="14" stroke="hsl(0,80%,55%)" strokeWidth="1.5" strokeLinecap="round">
            <animate attributeName="opacity" values="0.5;0.9;0.5" dur="1s" repeatCount="indefinite" />
          </line>
          <line x1="14" y1="6" x2="6" y2="14" stroke="hsl(0,80%,55%)" strokeWidth="1.5" strokeLinecap="round">
            <animate attributeName="opacity" values="0.5;0.9;0.5" dur="1s" repeatCount="indefinite" />
          </line>
        </svg>
      );

    default:
      return null;
  }
}
