import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyAppearanceFontVariables } from "./appearanceFonts";

function renderedFontSize(style: (probe: HTMLElement) => void): string {
  const probe = document.createElement("div");
  style(probe);
  document.body.append(probe);
  try {
    return getComputedStyle(probe).fontSize;
  } finally {
    probe.remove();
  }
}

const composerFontSize = () =>
  renderedFontSize((probe) => {
    // The composer editor's own size class.
    probe.className = "text-(length:--font-size-prompt,var(--text-sm))";
  });

const touchComposerFontSize = () =>
  renderedFontSize((probe) => {
    probe.style.fontSize = "var(--font-size-prompt-touch)";
  });

describe("applyAppearanceFontVariables", () => {
  it("sizes the composer from the interface size until fonts are set separately", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    const preferences = {
      sans: "",
      code: "",
      composer: "",
      sizeInterface: 20,
      sizePrompt: 14,
      sizeSidebar: null,
      sizeCode: 13,
      smoothing: true,
    };
    try {
      applyAppearanceFontVariables(root, { ...preferences, separate: false });
      expect(composerFontSize()).toBe("17.5px");
      expect(touchComposerFontSize()).toBe("17.5px");

      applyAppearanceFontVariables(root, { ...preferences, separate: true });
      expect(composerFontSize()).toBe("14px");
      // iOS zooms into inputs under 16px.
      expect(touchComposerFontSize()).toBe("16px");
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });

  it("scales sidebar text and icons from the sidebar size, leaving the rest alone", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    const sidebar = document.createElement("div");
    sidebar.setAttribute("data-app-sidebar", "");
    document.body.append(sidebar);
    const measure = (parent: HTMLElement) => {
      const text = document.createElement("span");
      text.className = "text-sm";
      const smallText = document.createElement("span");
      smallText.className = "text-2xs";
      const icon = document.createElement("div");
      icon.className = "size-4";
      parent.append(text, smallText, icon);
      try {
        return {
          text: getComputedStyle(text).fontSize,
          smallText: getComputedStyle(smallText).fontSize,
          icon: getComputedStyle(icon).width,
        };
      } finally {
        text.remove();
        smallText.remove();
        icon.remove();
      }
    };
    const preferences = {
      sans: "",
      code: "",
      composer: "",
      sizeInterface: 16,
      sizePrompt: 14,
      sizeCode: 13,
      smoothing: true,
      separate: false,
    };
    try {
      applyAppearanceFontVariables(root, { ...preferences, sizeSidebar: null });
      expect(measure(sidebar)).toEqual({ text: "14px", smallText: "11px", icon: "16px" });

      applyAppearanceFontVariables(root, { ...preferences, sizeSidebar: 20 });
      expect(measure(sidebar)).toEqual({ text: "17.5px", smallText: "13.75px", icon: "20px" });
      expect(measure(document.body)).toEqual({ text: "14px", smallText: "11px", icon: "16px" });
    } finally {
      sidebar.remove();
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });
});
