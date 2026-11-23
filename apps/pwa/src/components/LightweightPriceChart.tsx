import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { TokenPriceCandle, TokenPriceTimeframe } from "@astrowallet/stellar-core";
import { IconChart } from "./Icons.js";
import { formatCompactNumber, formatTokenPriceValue } from "./token-catalog.js";

export interface LightweightPriceChartProps {
  candles: readonly TokenPriceCandle[];
  quoteCode: string;
  positive: boolean;
  chartMode: "area" | "candles";
  timeframe: TokenPriceTimeframe;
  expanded?: boolean;
}

function resolvePriceFormat(candles: readonly TokenPriceCandle[]): {
  precision: number;
  minMove: number;
} {
  if (candles.length === 0) return { precision: 4, minMove: 0.0001 };
  const sorted = candles.map((c) => c.close).filter((v) => v > 0).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] ?? 1;
  if (med < 0.001) return { precision: 7, minMove: 0.0000001 };
  if (med < 0.05) return { precision: 6, minMove: 0.000001 };
  if (med < 2) return { precision: 4, minMove: 0.0001 };
  if (med < 100) return { precision: 3, minMove: 0.001 };
  return { precision: 2, minMove: 0.01 };
}

export function LightweightPriceChart({
  candles,
  quoteCode,
  positive,
  chartMode,
  timeframe,
  expanded = false,
}: LightweightPriceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hoveredCandle, setHoveredCandle] = useState<TokenPriceCandle | null>(null);

  const normalized = useMemo(() => {
    const bySec = new Map<number, TokenPriceCandle>();
    for (const c of candles) {
      const sec = Math.floor(c.timestamp / 1000);
      if (sec > 0 && Number.isFinite(c.close) && c.close > 0) {
        bySec.set(sec, { ...c, timestamp: sec * 1000 });
      }
    }
    return Array.from(bySec.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([sec, candle]) => ({ sec: sec as UTCTimestamp, candle }));
  }, [candles]);

  useEffect(() => {
    setHoveredCandle(null);
  }, [candles, chartMode, timeframe]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || normalized.length === 0) return undefined;

    const chartHeight = expanded
      ? Math.max(300, Math.min(460, Math.floor(window.innerHeight * 0.56)))
      : 220;

    const chart = createChart(el, {
      width: Math.max(240, el.clientWidth),
      height: chartHeight,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(226, 232, 240, 0.78)",
        fontFamily: "inherit",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(165, 139, 224, 0.10)" },
        horzLines: { color: "rgba(165, 139, 224, 0.12)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(245, 201, 40, 0.55)",
          labelBackgroundColor: "#172C69",
        },
        horzLine: {
          color: "rgba(245, 201, 40, 0.55)",
          labelBackgroundColor: "#172C69",
        },
      },
      timeScale: {
        borderColor: "rgba(165, 139, 224, 0.18)",
        timeVisible: timeframe === "24h" || timeframe === "7d",
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: "rgba(165, 139, 224, 0.18)",
        scaleMargins: { top: 0.1, bottom: 0.22 },
      },
      handleScroll: {
        vertTouchDrag: false,
        horzTouchDrag: true,
        mouseWheel: expanded,
        pressedMouseMove: true,
      },
      handleScale: {
        pinch: true,
        mouseWheel: expanded,
        axisPressedMouseMove: true,
      },
    });
    chartRef.current = chart;

    const priceFormat = resolvePriceFormat(candles);
    const lineColor = positive ? "#10B981" : "#F15A24";

    let mainSeries: ISeriesApi<"Candlestick"> | ISeriesApi<"Area">;
    if (chartMode === "candles") {
      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#10B981",
        downColor: "#F15A24",
        borderVisible: false,
        wickUpColor: "#10B981",
        wickDownColor: "#F15A24",
        priceFormat: { type: "price", ...priceFormat },
      });
      candleSeries.setData(
        normalized.map(({ sec, candle }) => ({
          time: sec,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        })),
      );
      mainSeries = candleSeries;
    } else {
      const areaSeries = chart.addSeries(AreaSeries, {
        lineColor,
        topColor: positive ? "rgba(16, 185, 129, 0.34)" : "rgba(241, 90, 36, 0.34)",
        bottomColor: "rgba(11, 20, 51, 0.02)",
        lineWidth: 2,
        priceFormat: { type: "price", ...priceFormat },
      });
      areaSeries.setData(
        normalized.map(({ sec, candle }) => ({
          time: sec,
          value: candle.close,
        })),
      );
      mainSeries = areaSeries;
    }

    const volSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    volSeries.setData(
      normalized.map(({ sec, candle }) => ({
        time: sec,
        value: candle.baseVolume ?? 0,
        color:
          candle.close >= candle.open
            ? "rgba(16, 185, 129, 0.30)"
            : "rgba(241, 90, 36, 0.30)",
      })),
    );

    chart.timeScale().fitContent();

    const bySecLookup = new Map<number, TokenPriceCandle>(
      normalized.map(({ sec, candle }) => [Number(sec), candle]),
    );

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        setHoveredCandle(null);
        return;
      }
      const key = typeof param.time === "number" ? param.time : null;
      if (key !== null && param.seriesData.has(mainSeries)) {
        setHoveredCandle(bySecLookup.get(key) ?? null);
      } else {
        setHoveredCandle(null);
      }
    });

    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) {
        chart.applyOptions({ width: Math.floor(width) });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [normalized, candles, chartMode, positive, timeframe, expanded]);

  if (normalized.length === 0) {
    return (
      <div className="aw-token-chart-box">
        <div className="aw-empty-state" style={{ padding: "24px 12px" }}>
          <IconChart size={20} />
          <div style={{ fontWeight: 600, fontSize: 13 }}>No historical SDEX trades in this window</div>
          <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
            Switch timeframe (7D / 30D / 1Y / ALL) or check the Orderbook tab for resting liquidity.
          </div>
        </div>
      </div>
    );
  }

  const active = hoveredCandle ?? normalized[normalized.length - 1]!.candle;
  const dateLabel =
    timeframe === "24h" || timeframe === "7d"
      ? new Date(active.timestamp).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : new Date(active.timestamp).toLocaleDateString([], {
          year: "numeric",
          month: "short",
          day: "numeric",
        });

  return (
    <div className="aw-token-chart-box">
      <div className="aw-token-chart-readout">
        <span className="tabular-nums" style={{ minWidth: 0 }}>
          <strong style={{ color: "var(--aw-ink-primary)" }}>
            {formatTokenPriceValue(active.close)} {quoteCode}
          </strong>{" "}
          · {dateLabel}
        </span>
        <span className="tabular-nums" style={{ flexShrink: 0, display: "flex", gap: 8, alignItems: "center" }}>
          <span>
            {chartMode === "candles"
              ? `O:${formatTokenPriceValue(active.open)} H:${formatTokenPriceValue(active.high)} L:${formatTokenPriceValue(active.low)} · V:${formatCompactNumber(active.baseVolume)}`
              : `H:${formatTokenPriceValue(active.high)} · L:${formatTokenPriceValue(active.low)}`}
          </span>
          {expanded && (
            <button
              type="button"
              className="aw-mini-chip"
              onClick={() => chartRef.current?.timeScale().fitContent()}
              title="Reset zoom to fit all candles"
            >
              Fit
            </button>
          )}
        </span>
      </div>

      <div
        ref={containerRef}
        role="img"
        aria-label={`Interactive ${chartMode} price chart in ${quoteCode}`}
        style={{
          width: "100%",
          height: expanded ? "min(56vh, 460px)" : 220,
          minHeight: expanded ? 300 : 220,
          position: "relative",
          touchAction: expanded ? "none" : "pan-y",
        }}
      />
    </div>
  );
}
