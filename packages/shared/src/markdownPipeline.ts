import type { Paragraph, PhrasingContent, Root, RootContent } from "mdast";
import { remarkKeepWindowsPaths } from "./markdownWindowsPaths.ts";
import { parseComposerContextHref } from "./composerContextReferences.ts";
import { mediaKindFromPath } from "./filePreview.ts";
import type { PluggableList } from "unified";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkGithubAlerts } from "./markdownGithubAlerts.ts";
import { remarkNormalizeListItemIndentation } from "./markdownListIndentation.ts";
import {
  CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES,
  remarkCodexDirectives,
} from "./codexMarkdownDirectives.ts";
import { isWindowsDrivePathHref } from "./markdownLinks.ts";
import { THREAD_LINK_PROTOCOL } from "./threadLinks.ts";

type MarkdownImageHastNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownImageHastNode[];
};

function meaningfulHastChildren(node: MarkdownImageHastNode): MarkdownImageHastNode[] {
  return (node.children ?? []).filter(
    (child) => !(child.type === "text" && (child as { value?: string }).value?.trim() === ""),
  );
}

const STANDALONE_IMAGE_BLOCKS = new Set([
  "p",
  "div",
  "li",
  "td",
  "th",
  "figure",
  "center",
  "blockquote",
]);

function soleImageDescendant(node: MarkdownImageHastNode): MarkdownImageHastNode | undefined {
  const children = meaningfulHastChildren(node);
  if (children.length !== 1) return undefined;
  const only = children[0];
  if (only?.type !== "element") return undefined;
  if (only.tagName === "img") return only;
  return only.tagName === "a" || only.tagName === "strong" || only.tagName === "em"
    ? soleImageDescendant(only)
    : undefined;
}

function markStandaloneImages(node: MarkdownImageHastNode) {
  if (node.type === "root" || (node.tagName && STANDALONE_IMAGE_BLOCKS.has(node.tagName))) {
    const image = soleImageDescendant(node);
    if (image) image.properties = { ...image.properties, dataStandalone: true };
  }
  node.children?.forEach((child) => {
    if (child.type === "element") markStandaloneImages(child);
  });
}

function rehypePreserveBareAnchorPlaceholders() {
  return (tree: MarkdownImageHastNode) => {
    const anchors: Array<MarkdownImageHastNode | null> = [];
    let rawTextTag: string | undefined;
    const visit = (node: MarkdownImageHastNode) => {
      if (node.type === "raw" && typeof node.value === "string") {
        // Scan whole tags, attributes, and comments so embedded closing-anchor text cannot match a placeholder.
        const tags = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
        let offset = 0;
        while (rawTextTag !== "plaintext") {
          // Raw text ends at its closing tag even inside comment-looking text.
          const matcher = rawTextTag ? new RegExp(`</${rawTextTag}\\s*>`, "gi") : tags;
          matcher.lastIndex = offset;
          const match = matcher.exec(node.value);
          if (!match) break;
          const [tag] = match;
          offset = matcher.lastIndex;
          if (rawTextTag) {
            rawTextTag = undefined;
            continue;
          }
          if (tag.startsWith("<!--")) continue;
          const closing = /^<\/([a-z]+)\s*>$/i.exec(tag)?.[1]?.toLowerCase();
          const opening = /^<([a-z]+)(?:\s|\/?>)/i.exec(tag)?.[1]?.toLowerCase();
          if (
            opening &&
            /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/.test(opening)
          ) {
            rawTextTag = opening;
          } else if (opening === "a") {
            anchors.push(node.value === tag && /^<a\s*\/?>$/i.test(tag) ? node : null);
          } else if (closing === "a") {
            anchors.pop();
          }
        }
      }
      node.children?.forEach(visit);
    };

    visit(tree);
    for (const anchor of anchors) {
      if (anchor) anchor.type = "text";
    }
  };
}

function rehypePreserveImageSourceMeta() {
  return (tree: MarkdownImageHastNode) => {
    const visit = (node: MarkdownImageHastNode) => {
      const src = node.properties?.src;
      const title = node.properties?.title;
      if (node.type === "element" && node.tagName === "img") {
        node.properties = {
          ...node.properties,
          ...(typeof src === "string" && isWindowsDrivePathHref(src) ? { dataLocalSrc: src } : {}),
          ...(typeof title === "string" ? { dataMarkdownTitle: title } : {}),
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
    markStandaloneImages(tree);
  };
}

function foldableImage(node: MarkdownImageHastNode): MarkdownImageHastNode | undefined {
  const image = soleImageDescendant({ children: [node] });
  const src = image?.properties?.src;
  if (typeof src !== "string") return undefined;
  if (parseComposerContextHref(src) !== null || mediaKindFromPath(src) === "video") {
    return undefined;
  }
  return image;
}

function splitAtLineBreaks(children: MarkdownImageHastNode[]): MarkdownImageHastNode[][] {
  const lines: MarkdownImageHastNode[][] = [[]];
  for (const child of children) {
    if (child.type === "element" && child.tagName === "br") lines.push([]);
    else lines.at(-1)!.push(child);
  }
  return lines;
}

const isBlankText = (node: MarkdownImageHastNode | undefined) =>
  node?.type === "text" && node.value?.trim() === "";

function trimBlankEdges(line: MarkdownImageHastNode[]): MarkdownImageHastNode[] {
  let start = 0;
  let end = line.length;
  while (isBlankText(line[start])) start++;
  while (isBlankText(line[end - 1])) end--;
  const trimmed = line.slice(start, end);
  const first = trimmed[0];
  if (first?.type === "text" && first.value !== undefined) {
    trimmed[0] = { ...first, value: first.value.trimStart() };
  }
  const lastIndex = trimmed.length - 1;
  const last = trimmed[lastIndex];
  if (last?.type === "text" && last.value !== undefined) {
    trimmed[lastIndex] = { ...last, value: last.value.trimEnd() };
  }
  return trimmed;
}

function lineImage(line: MarkdownImageHastNode[]): MarkdownImageHastNode | undefined {
  const meaningful = meaningfulHastChildren({ children: line });
  return meaningful.length === 1 ? meaningful[0] : undefined;
}

const IMAGE_FOLD_CONTAINERS = new Set(["ul", "ol", "li", "blockquote"]);

function foldImageRunsIn(container: MarkdownImageHastNode) {
  const output: MarkdownImageHastNode[] = [];
  let fold: MarkdownImageHastNode | null = null;
  const addImage = (node: MarkdownImageHastNode, image: MarkdownImageHastNode) => {
    image.properties = { ...image.properties, dataStandalone: true };
    if (!fold) {
      fold = { type: "element", tagName: "div", properties: { dataImageFold: true }, children: [] };
      output.push(fold);
    }
    fold.children!.push(node);
  };

  for (const child of container.children ?? []) {
    if (child.type === "text" && child.value?.trim() === "") {
      if (!fold) output.push(child);
      continue;
    }
    const directImage = foldableImage(child);
    if (directImage) {
      addImage(child, directImage);
      continue;
    }
    if (child.type === "element" && child.tagName === "p") {
      const lines = splitAtLineBreaks(child.children ?? []);
      const lineImages = lines.map((line) => {
        const only = lineImage(line);
        return only ? foldableImage(only) : undefined;
      });
      if (lineImages.every((image) => image === undefined)) {
        fold = null;
        output.push(child);
        continue;
      }
      // An image on its own line leaves the paragraph, so labels above it stay as text.
      let textLines: MarkdownImageHastNode[][] = [];
      const flushText = () => {
        if (textLines.length === 0) return;
        output.push({
          ...child,
          children: textLines.flatMap((line, index) =>
            index === 0
              ? line
              : [{ type: "element", tagName: "br", properties: {}, children: [] }, ...line],
          ),
        });
        textLines = [];
      };
      lines.forEach((line, index) => {
        const image = lineImages[index];
        if (image) {
          flushText();
          addImage(lineImage(line)!, image);
        } else if (meaningfulHastChildren({ children: line }).length > 0) {
          fold = null;
          textLines.push(trimBlankEdges(line));
        }
      });
      flushText();
      continue;
    }
    fold = null;
    if (child.type === "element" && IMAGE_FOLD_CONTAINERS.has(child.tagName ?? "")) {
      foldImageRunsIn(child);
    }
    output.push(child);
  }
  container.children = output;
}

/**
 * Wraps each run of images with nothing but blank lines between them in a
 * `div[dataImageFold]`, so a reply can show them folded. It runs after
 * sanitizing, which would strip the marker.
 */
export function rehypeFoldImageRuns() {
  return (tree: MarkdownImageHastNode) => foldImageRunsIn(tree);
}

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    // Fence languages plus the two math classes the web chat's math plugin emits.
    code: [
      ["className", /^language-./, "math-inline", "math-display"],
      "dataCodeMeta",
      "dataInlineCode",
    ],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
    div: [...(defaultSchema.attributes?.div ?? []), ...CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES],
    a: [...(defaultSchema.attributes?.a ?? []), "dataPullRequestAutolink"],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "dataLocalSrc",
      "dataMarkdownTitle",
      "dataStandalone",
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [
      ...(defaultSchema.protocols?.href ?? []),
      "file",
      "t3-citation",
      "t3-context",
      THREAD_LINK_PROTOCOL,
    ],
    src: [...(defaultSchema.protocols?.src ?? []), "file", "t3-context"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

export const CHAT_MARKDOWN_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkKeepWindowsPaths,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkCodexDirectives,
  remarkBreakAroundImageLines,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: PluggableList = [
  remarkGfm,
  remarkKeepWindowsPaths,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkCodexDirectives,
  remarkBreakAroundImageLines,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

export const CHAT_MARKDOWN_REHYPE_PLUGINS: PluggableList = [
  rehypePreserveBareAnchorPlaceholders,
  rehypeRaw,
  rehypePreserveImageSourceMeta,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
];

const isImageNode = (node: PhrasingContent | undefined): boolean =>
  node?.type === "image" ||
  node?.type === "imageReference" ||
  ((node?.type === "link" || node?.type === "linkReference") &&
    node.children.length === 1 &&
    isImageNode(node.children[0]));
const endsLine = (node: PhrasingContent | undefined) =>
  node === undefined ||
  node.type === "break" ||
  (node.type === "text" && /\n[ \t]*$/.test(node.value));
const startsLine = (node: PhrasingContent | undefined) =>
  node === undefined ||
  node.type === "break" ||
  (node.type === "text" && /^[ \t]*\n/.test(node.value));

function breakLinesAroundImages(paragraph: Paragraph) {
  const children = paragraph.children;
  const ownsLine = (index: number) =>
    isImageNode(children[index]) &&
    endsLine(children[index - 1]) &&
    startsLine(children[index + 1]);
  paragraph.children = children.flatMap((child, index): PhrasingContent[] => {
    if (child.type !== "text") return [child];
    const afterImage = ownsLine(index - 1);
    const beforeImage = ownsLine(index + 1);
    if (!afterImage && !beforeImage) return [child];
    const parts: PhrasingContent[] = [];
    let value = child.value;
    if (afterImage) {
      value = value.replace(/^[ \t]*\n/, "");
      parts.push({ type: "break" });
    }
    const breakAfter = beforeImage && /\n[ \t]*$/.test(value);
    if (breakAfter) value = value.replace(/[ \t]*\n[ \t]*$/, "");
    if (value) parts.push({ type: "text", value });
    if (breakAfter) parts.push({ type: "break" });
    return parts;
  });
}

/**
 * Agents label screenshots with a line like `**Palette**` right above the image. CommonMark
 * joins those lines into one paragraph, which puts the image inline beside its label. An
 * image alone on its source line keeps that line; prose and inline badges still wrap.
 */
function remarkBreakAroundImageLines() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (node.type === "paragraph") breakLinesAroundImages(node);
      else if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  url?: string;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

function remarkNormalizeLinksAndTagInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (
        (node.type === "link" || node.type === "definition") &&
        typeof node.url === "string" &&
        /^[A-Za-z]:[\\/]/.test(node.url)
      ) {
        node.url = `file:///${node.url.replaceAll("\\", "/")}`;
      }
      if (node.type === "inlineCode" && !insideLink) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataInlineCode: "",
          },
        };
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
  };
}

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
}
