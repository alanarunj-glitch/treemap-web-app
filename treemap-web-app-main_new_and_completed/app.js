const SVG_NS = "http://www.w3.org/2000/svg";

const PREVIEW_PADDING = 28;
const OUTER_TITLE_GAP = 56;
const HANDLE_RADIUS = 5;
const MIN_RESIZE_SPAN = 24;
const MIN_EDITOR_WIDTH = 96;
const MIN_EDITOR_HEIGHT = 58;
const MIN_GROUP_WIDTH = 180;
const MAX_GROUP_WIDTH = 540;
const MIN_GROUP_HEIGHT = 140;
const MAX_GROUP_HEIGHT = 520;
const DEFAULT_GROUP_HEIGHT = 220;
const EXPORT_MARGIN = 24;

const svg = document.getElementById("treemap-svg");
const addItemButton = document.getElementById("add-item");
const removeItemButton = document.getElementById("remove-item");
const pickColorButton = document.getElementById("pick-color");
const saveChartButton = document.getElementById("save-chart");
const loadChartButton = document.getElementById("load-chart");
const exportSvgButton = document.getElementById("export-svg");
const colorModeSelect = document.getElementById("color-mode");
const groupWidthSlider = document.getElementById("group-width");
const groupWidthValue = document.getElementById("group-width-value");
const groupHeightSlider = document.getElementById("group-height");
const groupHeightValue = document.getElementById("group-height-value");
const statusEl = document.getElementById("status");
const colorInput = document.getElementById("group-color-input");
const chartFileInput = document.getElementById("chart-file-input");

const state = {
  chart: createDefaultChart(),
  selectedItemIndex: 0,
  colorMode: "value-shade",
  displayGroupRect: null,
  displayItemRects: new Map(),
  targetGroupRect: null,
  targetItemRects: new Map(),
  titleEditor: null,
  itemEditors: new Map(),
  dragState: null,
  animationFrame: 0,
  syncWidthSlider: false,
};

function createDefaultChart() {
  return {
    name: "Main Group",
    layout: { width: 300, height: DEFAULT_GROUP_HEIGHT },
    baseColor: "#3b82f6",
    items: [
      { label: "Block 1", value: 18 },
      { label: "Block 2", value: 12 },
    ],
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeSizes(values, width, height) {
  const positive = values.map((value) => Math.max(Number(value) || 0, 0));
  const total = positive.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return positive.map(() => 0);
  const scale = (width * height) / total;
  return positive.map((value) => value * scale);
}

function worstRatio(row, shortSide) {
  if (!row.length || shortSide <= 0) return Infinity;
  const rowSum = row.reduce((sum, value) => sum + value, 0);
  const largest = Math.max(...row);
  const smallest = Math.min(...row);
  if (rowSum <= 0 || smallest <= 0) return Infinity;
  const sideSquared = shortSide * shortSide;
  return Math.max(
    (sideSquared * largest) / (rowSum * rowSum),
    (rowSum * rowSum) / (sideSquared * smallest),
  );
}

function layoutRow(row, x, y, width, height) {
  const rowTotal = row.reduce((sum, value) => sum + value, 0);
  const rects = [];
  if (width >= height) {
    const rowHeight = width ? rowTotal / width : 0;
    let cursorX = x;
    for (const area of row) {
      const rectWidth = rowHeight ? area / rowHeight : 0;
      rects.push([cursorX, y, rectWidth, rowHeight]);
      cursorX += rectWidth;
    }
    return [rects, x, y + rowHeight, width, Math.max(0, height - rowHeight)];
  }

  const rowWidth = height ? rowTotal / height : 0;
  let cursorY = y;
  for (const area of row) {
    const rectHeight = rowWidth ? area / rowWidth : 0;
    rects.push([x, cursorY, rowWidth, rectHeight]);
    cursorY += rectHeight;
  }
  return [rects, x + rowWidth, y, Math.max(0, width - rowWidth), height];
}

function squarify(areas, x, y, width, height) {
  const remaining = areas.filter((area) => area > 0);
  const rects = [];
  let row = [];
  let currentX = x;
  let currentY = y;
  let currentWidth = width;
  let currentHeight = height;

  while (remaining.length) {
    const candidate = remaining[0];
    const shortSide = Math.min(currentWidth, currentHeight);
    if (!row.length || worstRatio([...row, candidate], shortSide) <= worstRatio(row, shortSide)) {
      row.push(remaining.shift());
      continue;
    }
    const [laidOut, nextX, nextY, nextWidth, nextHeight] = layoutRow(
      row,
      currentX,
      currentY,
      currentWidth,
      currentHeight,
    );
    rects.push(...laidOut);
    row = [];
    currentX = nextX;
    currentY = nextY;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }

  if (row.length) {
    const [laidOut] = layoutRow(row, currentX, currentY, currentWidth, currentHeight);
    rects.push(...laidOut);
  }
  return rects;
}

function normalizeHexColor(value, fallback = "#3b82f6") {
  let raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (!raw.startsWith("#")) raw = `#${raw}`;
  if (!/^#[0-9a-f]{6}$/i.test(raw)) return fallback;
  return raw;
}

function hexToRgb(value) {
  const color = normalizeHexColor(value);
  return [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ];
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((part) => clamp(Math.round(part), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl([r, g, b]) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return [0, 0, lightness];

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;

  if (max === rn) hue = ((gn - bn) / delta) % 6;
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;

  return [((hue * 60) + 360) % 360, saturation, lightness];
}

function hslToRgb([h, s, l]) {
  const hue = ((h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = hue / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  let rgb = [0, 0, 0];

  if (segment >= 0 && segment < 1) rgb = [chroma, x, 0];
  else if (segment < 2) rgb = [x, chroma, 0];
  else if (segment < 3) rgb = [0, chroma, x];
  else if (segment < 4) rgb = [0, x, chroma];
  else if (segment < 5) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];

  const match = l - chroma / 2;
  return rgb.map((channel) => (channel + match) * 255);
}

function complementaryColor(color) {
  const [h, s, l] = rgbToHsl(hexToRgb(color));
  return rgbToHex(hslToRgb([(h + 180) % 360, s, l]));
}

function interpolateHue(start, end, amount) {
  let delta = end - start;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return (start + delta * amount + 360) % 360;
}

function blendColorTheory(baseColor, targetColor, amount) {
  const [h1, s1, l1] = rgbToHsl(hexToRgb(baseColor));
  const [h2, s2, l2] = rgbToHsl(hexToRgb(targetColor));
  const ratio = clamp(amount, 0, 1);
  return rgbToHex(hslToRgb([
    interpolateHue(h1, h2, ratio),
    s1 + (s2 - s1) * ratio,
    l1 + (l2 - l1) * ratio,
  ]));
}

function relativeLuminance(color) {
  const [r, g, b] = hexToRgb(color);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function textColorForFill(color) {
  return relativeLuminance(color) > 0.62 ? "#111827" : "#ffffff";
}

function rectClose(a, b, tolerance = 0.75) {
  return a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
}

function lerpRect(a, b, amount) {
  return a.map((value, index) => value + (b[index] - value) * amount);
}

function createSvg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

function syncDimensionSliders() {
  state.syncWidthSlider = true;
  groupWidthSlider.value = String(state.chart.layout.width);
  groupHeightSlider.value = String(state.chart.layout.height);
  groupWidthValue.textContent = String(Math.round(state.chart.layout.width));
  groupHeightValue.textContent = String(Math.round(state.chart.layout.height));
  state.syncWidthSlider = false;
}

function ensureSelectedItem() {
  if (state.chart.items.length === 0) {
    state.chart.items.push({ label: "Block 1", value: 10 });
  }
  state.selectedItemIndex = clamp(state.selectedItemIndex, 0, state.chart.items.length - 1);
}

function removeStaleItemEditors(activeKeys) {
  for (const [key, editor] of state.itemEditors.entries()) {
    if (!activeKeys.has(key)) {
      editor.wrap.remove();
      state.itemEditors.delete(key);
    }
  }
}

function getOrCreateTitleEditor() {
  if (state.titleEditor) return state.titleEditor;
  const wrap = document.createElement("div");
  wrap.className = "title-editor";
  const input = document.createElement("input");
  input.className = "title-input";
  input.type = "text";
  input.addEventListener("blur", () => {
    const text = input.value.trim();
    if (text) {
      state.chart.name = text;
      queueRender();
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
  });
  wrap.appendChild(input);
  svg.parentElement.appendChild(wrap);
  state.titleEditor = wrap;
  return wrap;
}

function getOrCreateItemEditor(itemIndex) {
  const key = String(itemIndex);
  if (state.itemEditors.has(key)) return state.itemEditors.get(key);

  const wrap = document.createElement("div");
  wrap.className = "html-editor";

  const labelInput = document.createElement("input");
  labelInput.className = "block-input";
  labelInput.type = "text";
  labelInput.addEventListener("focus", () => {
    state.selectedItemIndex = itemIndex;
    render();
  });
  labelInput.addEventListener("blur", () => {
    const text = labelInput.value.trim();
    if (text) {
      state.chart.items[itemIndex].label = text;
      queueRender();
    }
  });
  labelInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") labelInput.blur();
  });

  const valueInput = document.createElement("input");
  valueInput.className = "block-input";
  valueInput.type = "text";
  valueInput.inputMode = "numeric";
  valueInput.addEventListener("focus", () => {
    state.selectedItemIndex = itemIndex;
    render();
  });
  valueInput.addEventListener("blur", () => {
    const current = state.chart.items[itemIndex].value;
    const value = Math.max(1, Math.round(Number(valueInput.value) || current));
    state.chart.items[itemIndex].value = value;
    valueInput.value = String(value);
    queueRender();
  });
  valueInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") valueInput.blur();
  });

  wrap.append(labelInput, valueInput);
  wrap.addEventListener("pointerdown", () => {
    state.selectedItemIndex = itemIndex;
    render();
  });
  svg.parentElement.appendChild(wrap);

  const editor = { wrap, labelInput, valueInput };
  state.itemEditors.set(key, editor);
  return editor;
}

function computeShadeFactor(items, value) {
  if (items.length <= 1) return 0;
  const values = items.map((item) => Math.max(1, Number(item.value) || 1));
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const spread = maxValue - minValue;
  if (spread <= 0) return 0;

  const normalizedPosition = (value - minValue) / spread;
  const relativeSpread = spread / Math.max(maxValue, 1);
  const contrastStrength = Math.pow(relativeSpread, 0.8);
  return clamp(normalizedPosition * contrastStrength, 0, 1);
}

function colorForItem(item) {
  if (state.colorMode !== "value-shade") return normalizeHexColor(state.chart.baseColor);
  const baseColor = normalizeHexColor(state.chart.baseColor);
  const complement = complementaryColor(baseColor);
  const shift = computeShadeFactor(state.chart.items, item.value);
  return blendColorTheory(baseColor, complement, shift);
}

function computeLayout(viewportWidth, viewportHeight) {
  const chart = state.chart;
  const usableWidth = Math.max(120, viewportWidth - PREVIEW_PADDING * 2);
  const usableHeight = Math.max(120, viewportHeight - PREVIEW_PADDING * 2 - OUTER_TITLE_GAP);
  const scale = Math.min(usableWidth / chart.layout.width, usableHeight / chart.layout.height);
  const outerWidth = chart.layout.width * scale;
  const outerHeight = chart.layout.height * scale;
  const outerX = (viewportWidth - outerWidth) / 2;
  const outerY = PREVIEW_PADDING + OUTER_TITLE_GAP + Math.max(0, (usableHeight - outerHeight) / 2);
  const normalized = normalizeSizes(
    chart.items.map((item) => Math.max(item.value, 1)),
    chart.layout.width,
    chart.layout.height,
  );
  const itemRects = new Map();
  squarify(normalized, 0, 0, chart.layout.width, chart.layout.height).forEach(([x, y, width, height], itemIndex) => {
    itemRects.set(String(itemIndex), [
      outerX + x * scale,
      outerY + y * scale,
      outerX + (x + width) * scale,
      outerY + (y + height) * scale,
    ]);
  });

  return {
    groupRect: [outerX, outerY, outerWidth, outerHeight],
    itemRects,
  };
}

function queueRender() {
  cancelAnimationFrame(state.animationFrame);
  state.animationFrame = requestAnimationFrame(render);
}

function render() {
  state.animationFrame = 0;
  ensureSelectedItem();

  const bounds = svg.getBoundingClientRect();
  const width = Math.max(bounds.width, 480);
  const height = Math.max(bounds.height, 360);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  while (svg.firstChild) svg.firstChild.remove();

  const nextLayout = computeLayout(width, height);
  if (!state.displayGroupRect || !state.displayItemRects.size || state.dragState) {
    state.displayGroupRect = nextLayout.groupRect;
    state.displayItemRects = nextLayout.itemRects;
  } else {
    state.displayGroupRect = animateRect(state.displayGroupRect, nextLayout.groupRect);
    state.displayItemRects = animateMap(state.displayItemRects, nextLayout.itemRects);
  }

  state.targetGroupRect = nextLayout.groupRect;
  state.targetItemRects = nextLayout.itemRects;

  const [outerX, outerY, outerWidth, outerHeight] = state.displayGroupRect;
  const titleBoxWidth = Math.max(120, outerWidth * 0.55);
  const titleX = outerX + outerWidth / 2 - titleBoxWidth / 2;
  const titleY = outerY - 38;

  svg.appendChild(createSvg("rect", {
    x: outerX,
    y: outerY,
    width: outerWidth,
    height: outerHeight,
    class: "group-boundary",
  }));

  svg.appendChild(createSvg("rect", {
    x: titleX,
    y: titleY,
    width: titleBoxWidth,
    height: 24,
    class: "group-title-box",
  }));

  const titleEditor = getOrCreateTitleEditor();
  titleEditor.style.left = `${titleX}px`;
  titleEditor.style.top = `${titleY}px`;
  titleEditor.style.width = `${titleBoxWidth}px`;
  titleEditor.style.height = "24px";
  const titleInput = titleEditor.querySelector("input");
  if (document.activeElement !== titleInput) titleInput.value = state.chart.name;

  const activeItemEditors = new Set();
  let selectedRect = null;

  state.chart.items.forEach((item, itemIndex) => {
    const rect = state.displayItemRects.get(String(itemIndex));
    if (!rect) return;
    const [x1, y1, x2, y2] = rect;
    const rectWidth = x2 - x1;
    const rectHeight = y2 - y1;
    const fill = colorForItem(item);

    const block = createSvg("rect", {
      x: x1,
      y: y1,
      width: rectWidth,
      height: rectHeight,
      class: "treemap-block",
      fill,
      "data-item": itemIndex,
    });
    block.addEventListener("pointerdown", onBlockPointerDown);
    svg.appendChild(block);

    const editor = getOrCreateItemEditor(itemIndex);
    activeItemEditors.add(String(itemIndex));
    const textColor = textColorForFill(fill);
    editor.wrap.style.left = `${x1 + 6}px`;
    editor.wrap.style.top = `${y1 + 6}px`;
    editor.wrap.style.width = `${Math.max(0, rectWidth - 12)}px`;
    editor.wrap.style.height = `${Math.max(0, rectHeight - 12)}px`;
    editor.wrap.style.color = textColor;
    editor.labelInput.style.color = textColor;
    editor.valueInput.style.color = textColor;
    editor.labelInput.style.caretColor = textColor;
    editor.valueInput.style.caretColor = textColor;
    if (document.activeElement !== editor.labelInput) editor.labelInput.value = item.label;
    if (document.activeElement !== editor.valueInput) editor.valueInput.value = String(item.value);

    if (rectWidth >= MIN_EDITOR_WIDTH && rectHeight >= MIN_EDITOR_HEIGHT) {
      editor.wrap.style.display = "flex";
    } else {
      editor.wrap.style.display = "none";
      svg.appendChild(createSvg("text", {
        x: (x1 + x2) / 2,
        y: (y1 + y2) / 2 - 8,
        class: "tiny-label",
        fill: textColor,
      })).textContent = item.label;
      svg.appendChild(createSvg("text", {
        x: (x1 + x2) / 2,
        y: (y1 + y2) / 2 + 10,
        class: "tiny-label",
        fill: textColor,
      })).textContent = String(item.value);
    }

    if (state.selectedItemIndex === itemIndex) {
      selectedRect = { itemIndex, x1, y1, x2, y2 };
    }
  });

  removeStaleItemEditors(activeItemEditors);
  if (selectedRect) drawSelection(selectedRect);

  statusEl.textContent = `1 group, ${state.chart.items.length} blocks`;
}

function animateRect(current, target) {
  const updated = lerpRect(current, target, 0.55);
  if (rectClose(updated, target)) return target;
  requestAnimationFrame(render);
  return updated;
}

function animateMap(currentMap, targetMap) {
  let moving = false;
  const nextMap = new Map();
  for (const [key, target] of targetMap.entries()) {
    const current = currentMap.get(key) || target;
    const updated = lerpRect(current, target, 0.55);
    if (rectClose(updated, target)) {
      nextMap.set(key, target);
    } else {
      moving = true;
      nextMap.set(key, updated);
    }
  }
  if (moving) requestAnimationFrame(render);
  return nextMap;
}

function drawSelection({ itemIndex, x1, y1, x2, y2 }) {
  svg.appendChild(createSvg("rect", {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
    class: "selected-outline",
  }));

  [
    ["nw", x1, y1],
    ["ne", x2, y1],
    ["se", x2, y2],
    ["sw", x1, y2],
  ].forEach(([corner, cx, cy]) => {
    const handle = createSvg("circle", {
      cx,
      cy,
      r: HANDLE_RADIUS,
      class: `handle ${corner}`,
      "data-item": itemIndex,
      "data-corner": corner,
    });
    handle.addEventListener("pointerdown", onHandlePointerDown);
    svg.appendChild(handle);
  });
}

function onBlockPointerDown(event) {
  state.selectedItemIndex = Number(event.target.dataset.item);
  render();
}

function onHandlePointerDown(event) {
  event.stopPropagation();
  const itemIndex = Number(event.target.dataset.item);
  const corner = event.target.dataset.corner;
  const rect = state.displayItemRects.get(String(itemIndex));
  const outerRect = state.displayGroupRect;
  if (!rect || !outerRect) return;

  state.selectedItemIndex = itemIndex;

  const [left, top, right, bottom] = rect;
  let anchor;
  if (corner === "nw") anchor = [right, bottom];
  else if (corner === "ne") anchor = [left, bottom];
  else if (corner === "se") anchor = [left, top];
  else anchor = [right, top];

  state.dragState = {
    itemIndex,
    anchorX: anchor[0],
    anchorY: anchor[1],
    outerRect,
  };

  svg.setPointerCapture(event.pointerId);
}

svg.addEventListener("pointermove", (event) => {
  if (!state.dragState) return;
  const { itemIndex, anchorX, anchorY, outerRect } = state.dragState;
  const [outerLeft, outerTop, outerWidth, outerHeight] = outerRect;
  const outerRight = outerLeft + outerWidth;
  const outerBottom = outerTop + outerHeight;

  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const cursor = point.matrixTransform(svg.getScreenCTM().inverse());

  let currentX = clamp(cursor.x, outerLeft, outerRight);
  let currentY = clamp(cursor.y, outerTop, outerBottom);
  let left = Math.min(anchorX, currentX);
  let right = Math.max(anchorX, currentX);
  let top = Math.min(anchorY, currentY);
  let bottom = Math.max(anchorY, currentY);

  if (right - left < MIN_RESIZE_SPAN) {
    if (currentX <= anchorX) left = right - MIN_RESIZE_SPAN;
    else right = left + MIN_RESIZE_SPAN;
  }
  if (bottom - top < MIN_RESIZE_SPAN) {
    if (currentY <= anchorY) top = bottom - MIN_RESIZE_SPAN;
    else bottom = top + MIN_RESIZE_SPAN;
  }

  left = Math.max(left, outerLeft);
  top = Math.max(top, outerTop);
  right = Math.min(right, outerRight);
  bottom = Math.min(bottom, outerBottom);

  updateItemValueFromRect(itemIndex, left, top, right, bottom);
  render();
});

svg.addEventListener("pointerup", () => {
  state.dragState = null;
});

svg.addEventListener("pointercancel", () => {
  state.dragState = null;
});

function updateItemValueFromRect(itemIndex, left, top, right, bottom) {
  const outerRect = state.displayGroupRect;
  if (!outerRect) return;
  const [, , outerWidth, outerHeight] = outerRect;
  const resizedArea = Math.max(1, (right - left) * (bottom - top));
  const proportion = clamp(resizedArea / (outerWidth * outerHeight), 0.02, 0.95);
  const otherTotal = state.chart.items.reduce((sum, item, index) => sum + (index === itemIndex ? 0 : item.value), 0);
  const newValue = otherTotal <= 0
    ? Math.max(1, state.chart.items[itemIndex].value)
    : Math.max(1, Math.round((proportion * otherTotal) / Math.max(1e-6, 1 - proportion)));
  state.chart.items[itemIndex].value = newValue;
}

function sanitizeChart(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const legacyGroup = Array.isArray(source.groups) ? source.groups[0] : null;
  const chartSource = source.chart && typeof source.chart === "object"
    ? source.chart
    : legacyGroup && typeof legacyGroup === "object"
      ? legacyGroup
      : source;

  const items = Array.isArray(chartSource.items) ? chartSource.items : [];
  const normalizedItems = items
    .map((item, index) => ({
      label: String(item?.label || `Block ${index + 1}`).trim() || `Block ${index + 1}`,
      value: Math.max(1, Math.round(Number(item?.value) || 1)),
    }))
    .slice(0, 200);

  return {
    name: String(chartSource.name || "Main Group").trim() || "Main Group",
    layout: {
      width: clamp(Math.round(Number(chartSource.layout?.width) || 300), MIN_GROUP_WIDTH, MAX_GROUP_WIDTH),
      height: clamp(Math.round(Number(chartSource.layout?.height) || DEFAULT_GROUP_HEIGHT), MIN_GROUP_HEIGHT, MAX_GROUP_HEIGHT),
    },
    baseColor: normalizeHexColor(chartSource.baseColor, "#3b82f6"),
    items: normalizedItems.length ? normalizedItems : createDefaultChart().items,
  };
}

function serializeState() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    colorMode: state.colorMode,
    chart: {
      name: state.chart.name,
      layout: { ...state.chart.layout },
      baseColor: state.chart.baseColor,
      items: state.chart.items.map((item) => ({ ...item })),
    },
  };
}

function safeFileName(name, extension) {
  const stem = String(name || "treemap")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "treemap";
  return `${stem}.${extension}`;
}

function downloadTextFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildExportMarkup() {
  const chart = state.chart;
  const width = chart.layout.width + EXPORT_MARGIN * 2;
  const height = chart.layout.height + EXPORT_MARGIN * 2 + OUTER_TITLE_GAP;
  const outerX = EXPORT_MARGIN;
  const outerY = EXPORT_MARGIN + OUTER_TITLE_GAP;
  const titleBoxWidth = Math.max(120, chart.layout.width * 0.55);
  const titleX = outerX + chart.layout.width / 2 - titleBoxWidth / 2;
  const titleY = outerY - 38;

  const textChunks = [];
  textChunks.push(`<rect x="${outerX}" y="${outerY}" width="${chart.layout.width}" height="${chart.layout.height}" rx="20" ry="20" fill="#ffffff" stroke="#cbd5e1" stroke-width="2" />`);
  textChunks.push(`<rect x="${titleX}" y="${titleY}" width="${titleBoxWidth}" height="24" rx="12" ry="12" fill="#ffffff" fill-opacity="0.94" stroke="#dbe4ee" stroke-width="1.2" />`);
  textChunks.push(`<text x="${outerX + chart.layout.width / 2}" y="${titleY + 16}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="700" fill="#0f172a">${escapeXml(chart.name)}</text>`);

  const normalized = normalizeSizes(
    chart.items.map((item) => Math.max(item.value, 1)),
    chart.layout.width,
    chart.layout.height,
  );

  squarify(normalized, 0, 0, chart.layout.width, chart.layout.height).forEach(([x, y, rectWidth, rectHeight], itemIndex) => {
    const item = chart.items[itemIndex];
    const fill = colorForItem(item);
    const textColor = textColorForFill(fill);
    const blockX = outerX + x;
    const blockY = outerY + y;
    const innerWidth = Math.max(0, rectWidth - 12);
    const centerX = blockX + rectWidth / 2;
    const centerY = blockY + rectHeight / 2;

    textChunks.push(`<rect x="${blockX}" y="${blockY}" width="${rectWidth}" height="${rectHeight}" fill="${fill}" stroke="#ffffff" stroke-width="2" />`);

    if (rectWidth >= MIN_EDITOR_WIDTH && rectHeight >= MIN_EDITOR_HEIGHT) {
      textChunks.push(`<text x="${blockX + rectWidth / 2}" y="${blockY + rectHeight / 2 - 10}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="16" fill="${textColor}">${truncateText(item.label, innerWidth, 16)}</text>`);
      textChunks.push(`<text x="${blockX + rectWidth / 2}" y="${blockY + rectHeight / 2 + 14}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="16" font-weight="700" fill="${textColor}">${escapeXml(String(item.value))}</text>`);
    } else {
      textChunks.push(`<text x="${centerX}" y="${centerY - 6}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="10" font-weight="700" fill="${textColor}">${truncateText(item.label, rectWidth - 8, 10)}</text>`);
      textChunks.push(`<text x="${centerX}" y="${centerY + 10}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="10" font-weight="700" fill="${textColor}">${escapeXml(String(item.value))}</text>`);
    }
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(chart.name)}">
  <rect width="100%" height="100%" fill="#f8fafc" />
  ${textChunks.join("\n  ")}
</svg>`;
}

function truncateText(text, maxWidth, fontSize) {
  const safe = String(text || "");
  const estimatedChars = Math.max(4, Math.floor(maxWidth / (fontSize * 0.56)));
  if (safe.length <= estimatedChars) return escapeXml(safe);
  return `${escapeXml(safe.slice(0, Math.max(1, estimatedChars - 1)).trimEnd())}...`;
}

function escapeXml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

addItemButton.addEventListener("click", () => {
  const itemNumber = state.chart.items.length + 1;
  state.chart.items.push({ label: `Block ${itemNumber}`, value: Math.max(1, 20 - itemNumber * 2) });
  state.selectedItemIndex = state.chart.items.length - 1;
  render();
});

removeItemButton.addEventListener("click", () => {
  if (state.chart.items.length <= 1) return;
  state.chart.items.splice(state.selectedItemIndex, 1);
  ensureSelectedItem();
  render();
});

pickColorButton.addEventListener("click", () => {
  colorInput.value = normalizeHexColor(state.chart.baseColor);
  colorInput.oninput = () => {
    state.chart.baseColor = normalizeHexColor(colorInput.value, state.chart.baseColor);
    queueRender();
  };
  colorInput.click();
});

saveChartButton.addEventListener("click", () => {
  const json = JSON.stringify(serializeState(), null, 2);
  downloadTextFile(json, safeFileName(state.chart.name, "json"), "application/json");
});

loadChartButton.addEventListener("click", () => {
  chartFileInput.click();
});

chartFileInput.addEventListener("change", async () => {
  const [file] = chartFileInput.files || [];
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    state.chart = sanitizeChart(raw);
    state.colorMode = raw?.colorMode === "base-only" ? "base-only" : "value-shade";
    colorModeSelect.value = state.colorMode;
    state.selectedItemIndex = 0;
    state.displayGroupRect = null;
    state.displayItemRects = new Map();
    syncDimensionSliders();
    render();
  } catch (error) {
    statusEl.textContent = "Unable to open chart file";
  } finally {
    chartFileInput.value = "";
  }
});

exportSvgButton.addEventListener("click", () => {
  downloadTextFile(buildExportMarkup(), safeFileName(state.chart.name, "svg"), "image/svg+xml");
});

colorModeSelect.addEventListener("change", () => {
  state.colorMode = colorModeSelect.value;
  queueRender();
});

groupWidthSlider.addEventListener("input", () => {
  groupWidthValue.textContent = groupWidthSlider.value;
  if (state.syncWidthSlider) return;
  state.chart.layout.width = Number(groupWidthSlider.value);
  render();
});

groupHeightSlider.addEventListener("input", () => {
  groupHeightValue.textContent = groupHeightSlider.value;
  if (state.syncWidthSlider) return;
  state.chart.layout.height = Number(groupHeightSlider.value);
  render();
});

window.addEventListener("resize", queueRender);

syncDimensionSliders();
colorModeSelect.value = state.colorMode;
render();
