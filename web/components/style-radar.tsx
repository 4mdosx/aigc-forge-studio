"use client";

import { useRef, useState, type FocusEvent, type PointerEvent } from "react";

// 方向来自 critic/embed.py 的 AXIS_HINTS，以及作者对旧 6 维模型的说明。v4 的第 7 维没有记载。
const AXES = [
  {
    short: "对比",
    name: "对比",
    definition: "强烈对比。作者把高值对应更锐利的亮暗对比。",
  },
  {
    short: "复杂",
    name: "复杂度",
    definition: "绘制复杂度。高值线条和细节更多，低值更简单。",
  },
  {
    short: "油画",
    name: "平滑油画",
    definition: "平滑、偏油画的画法。作者在旧模型里看到的是偏低的一端。",
  },
  {
    short: "色块",
    name: "粗线色块",
    definition: "粗线条，或颜色分成大块。作者在旧模型里看到的是偏高的一端。",
  },
  {
    short: "场景",
    name: "复杂场景",
    definition: "复杂场景、风景或很多角色。作者在旧模型里看到的是偏低的一端。",
  },
  {
    short: "阴影",
    name: "漫画阴影",
    definition: "漫画式画法，以及阴影怎么上。",
  },
  {
    short: "第7维",
    name: "第 7 维",
    definition: "v4 多出的一维。作者博客没有说明它表示什么。",
  },
] as const;

const MIN = -2;
const MAX = 2;
const CX = 120;
const CY = 112;
const MAX_R = 68;
const LABEL_R = 86;

export function isStyleVector(values: number[]): boolean {
  return (
    values.length === AXES.length &&
    values.every((value) => Number.isFinite(value))
  );
}

export function StyleRadar({ values }: { values: number[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const axis = active === null ? null : AXES[active];
  const activeValue = active === null ? null : values[active];

  function leaveBox(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch") return;
    setActive(null);
  }

  function blurAxis(event: FocusEvent<SVGGElement>) {
    const next = event.relatedTarget;
    if (next instanceof Node && boxRef.current?.contains(next)) return;
    setActive(null);
  }

  const polygon = values
    .map((value, index) => {
      const point = polar(index, radiusOf(value));
      return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <div ref={boxRef} className="style-radar" onPointerLeave={leaveBox}>
      <svg
        className="style-radar-svg"
        viewBox="0 0 240 228"
        role="img"
        aria-label="七维风格向量。中心是负 2，中间一圈是 0，外圈是正 2。"
      >
        {[-1, 0, 1, 2].map((tick) => (
          <circle
            key={tick}
            className={tick === 0 ? "style-radar-zero" : "style-radar-ring"}
            cx={CX}
            cy={CY}
            r={radiusOf(tick)}
          />
        ))}
        {AXES.map((item, index) => {
          const end = polar(index, MAX_R);
          return (
            <line
              key={item.name}
              className="style-radar-spoke"
              x1={CX}
              y1={CY}
              x2={end.x}
              y2={end.y}
            />
          );
        })}
        <polygon className="style-radar-shape" points={polygon} />
        {AXES.map((item, index) => {
          const value = values[index] ?? 0;
          const point = polar(index, radiusOf(value));
          const label = polar(index, LABEL_R);
          const hitIn = polar(index, 16);
          const hitOut = polar(index, LABEL_R + 8);
          const selected = active === index;
          const outside = value > MAX || value < MIN;
          return (
            <g
              key={item.name}
              className={selected ? "style-radar-axis is-active" : "style-radar-axis"}
              tabIndex={0}
              aria-label={`${item.name}，${formatAxis(value)}。${item.definition}`}
              onPointerEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={blurAxis}
              onClick={() => setActive(index)}
            >
              {selected ? (
                <line
                  className="style-radar-spoke-active"
                  x1={CX}
                  y1={CY}
                  x2={point.x}
                  y2={point.y}
                />
              ) : null}
              <circle
                className={outside ? "style-radar-point is-outside" : "style-radar-point"}
                cx={point.x}
                cy={point.y}
                r={selected ? 4.5 : 3.2}
              />
              <text
                className="style-radar-name"
                x={label.x}
                y={label.y}
                textAnchor={textAnchor(label.cos)}
                dominantBaseline={textBaseline(label.sin)}
              >
                {item.short}
              </text>
              <line
                className="style-radar-hit"
                x1={hitIn.x}
                y1={hitIn.y}
                x2={hitOut.x}
                y2={hitOut.y}
              />
              <circle className="style-radar-hit" cx={label.x} cy={label.y} r={14} />
            </g>
          );
        })}
      </svg>
      <p className="style-radar-def" aria-live="polite">
        {axis && activeValue !== null ? (
          <>
            <span className="style-radar-def-name">
              {axis.name}
              <span className="style-radar-def-value">{formatAxis(activeValue)}</span>
            </span>
            <span className="style-radar-def-text">
              {axis.definition}
              {activeValue > MAX
                ? " 超出 +2，顶点停在外圈。"
                : activeValue < MIN
                  ? " 低于 −2，顶点收在中心。"
                  : ""}
            </span>
          </>
        ) : (
          <span className="style-radar-def-text">中心 −2，中圈 0，外圈 +2。</span>
        )}
      </p>
    </div>
  );
}

function radiusOf(value: number): number {
  const clamped = Math.min(MAX, Math.max(MIN, value));
  return ((clamped - MIN) / (MAX - MIN)) * MAX_R;
}

function polar(index: number, radius: number) {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / AXES.length;
  return {
    x: CX + radius * Math.cos(angle),
    y: CY + radius * Math.sin(angle),
    cos: Math.cos(angle),
    sin: Math.sin(angle),
  };
}

function textAnchor(cos: number): "start" | "middle" | "end" {
  if (cos > 0.35) return "start";
  if (cos < -0.35) return "end";
  return "middle";
}

function textBaseline(sin: number): "auto" | "middle" | "hanging" {
  if (sin < -0.45) return "auto";
  if (sin > 0.45) return "hanging";
  return "middle";
}

function formatAxis(value: number): string {
  const text = Math.abs(value).toFixed(2);
  if (value > 0) return `+${text}`;
  if (value < 0) return `−${text}`;
  return text;
}
