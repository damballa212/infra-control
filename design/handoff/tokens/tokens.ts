// GENERADO por `npm run tokens` desde tokens.json. No editar a mano.
export const tokens = {
  "color": {
    "light": {
      "bg": "#FAFAFA",
      "surface": "#FFFFFF",
      "sunken": "#F4F4F5",
      "border": "#E4E4E7",
      "divider": "#F0F0F2",
      "text": "#18181B",
      "text2": "#52525B",
      "text3": "#62626C",
      "text4": "#666670",
      "primary": "#18181B",
      "onPrimary": "#FFFFFF",
      "ok": "#17B26A",
      "okText": "#067647",
      "okBg": "#ECFDF3",
      "bad": "#F04438",
      "badText": "#B42318",
      "badBg": "#FEF3F2",
      "unc": "#7C5CFF",
      "uncText": "#5925DC",
      "uncBg": "#F4F3FF",
      "stale": "#FDB022",
      "staleText": "#B54708",
      "staleBg": "#FFFAEB",
      "busy": "#2E90FA",
      "busyText": "#175CD3",
      "busyBg": "#EFF8FF",
      "off": "#A1A1AA",
      "key": "#C2410C",
      "keyBg": "#FFF1EA",
      "keyBorder": "#FDC8B0",
      "scrim": "rgba(24, 24, 27, 0.4)",
      "bar": "rgba(250, 250, 250, 0.94)"
    },
    "dark": {
      "bg": "#0B0B0D",
      "surface": "#111114",
      "sunken": "#18181C",
      "border": "#2E2E34",
      "divider": "#1C1C21",
      "text": "#EDEDEF",
      "text2": "#A1A1AA",
      "text3": "#8B8B94",
      "text4": "#8B8B94",
      "primary": "#EDEDEF",
      "onPrimary": "#0B0B0D",
      "ok": "#17B26A",
      "okText": "#47CD89",
      "okBg": "rgba(23, 178, 106, 0.14)",
      "bad": "#F04438",
      "badText": "#F97066",
      "badBg": "rgba(240, 68, 56, 0.14)",
      "unc": "#9B8AFB",
      "uncText": "#B9ACFD",
      "uncBg": "rgba(155, 138, 251, 0.14)",
      "stale": "#FDB022",
      "staleText": "#FDB022",
      "staleBg": "rgba(253, 176, 34, 0.12)",
      "busy": "#2E90FA",
      "busyText": "#53B1FD",
      "busyBg": "rgba(46, 144, 250, 0.14)",
      "off": "#5E5E66",
      "key": "#FB923C",
      "keyBg": "rgba(194, 65, 12, 0.2)",
      "keyBorder": "#5A2F1C",
      "scrim": "rgba(0, 0, 0, 0.6)",
      "bar": "rgba(17, 17, 20, 0.94)"
    },
    "brand": {
      "dusk": "#5B3F8C",
      "coral": "#FF7A6B",
      "sun": "#FFB347",
      "accent": "#FF6A3D",
      "accentPressed": "#E4562B",
      "onAccent": "#18181B",
      "hairline": "linear-gradient(90deg, #5B3F8C, #FF7A6B 55%, #FFB347)"
    }
  },
  "font": {
    "family": {
      "sans": "\"Geist\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif",
      "mono": "\"Geist Mono\", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    },
    "size": {
      "display": "32px",
      "title": "24px",
      "heading": "17px",
      "body": "15px",
      "row": "14.5px",
      "small": "13px",
      "caption": "12px",
      "micro": "11px"
    },
    "weight": {
      "regular": "400",
      "medium": "500",
      "semibold": "600",
      "bold": "700"
    },
    "lineHeight": {
      "tight": "1.15",
      "body": "1.5"
    }
  },
  "space": {
    "1": "4px",
    "2": "8px",
    "3": "12px",
    "4": "16px",
    "5": "20px",
    "6": "24px",
    "8": "32px",
    "10": "40px"
  },
  "size": {
    "hitbox": "48px",
    "button": "44px",
    "buttonSm": "32px",
    "row": "52px",
    "tabbar": "84px",
    "sidebar": "232px",
    "inspector": "360px",
    "content": "1120px"
  },
  "radius": {
    "sm": "6px",
    "md": "10px",
    "lg": "14px",
    "xl": "22px",
    "pill": "999px"
  },
  "elevation": {
    "sheet": "0 -12px 40px rgba(0, 0, 0, 0.22)",
    "popover": "0 20px 40px rgba(0, 0, 0, 0.28)"
  },
  "breakpoint": {
    "compact": 700,
    "medium": 1100
  },
  "motion": {
    "fast": "120ms",
    "base": "200ms",
    "sheet": "280ms",
    "pulse": "1.5s",
    "ease": "cubic-bezier(0.2, 0.8, 0.2, 1)"
  }
} as const;

export type Tokens = typeof tokens;
