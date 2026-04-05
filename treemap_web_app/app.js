const SVG_NS = "http://www.w3.org/2000/svg";

const PREVIEW_PADDING = 24;
const OUTER_TITLE_GAP = 48;
const OUTER_SPACING = 2;
const HANDLE_RADIUS = 5;
const MIN_RESIZE_SPAN = 24;
const MIN_EDITOR_WIDTH = 96;
const MIN_EDITOR_HEIGHT = 58;
const MIN_GROUP_WIDTH = 180;
const MAX_GROUP_WIDTH = 540;
const DEFAULT_GROUP_HEIGHT = 220;

const svg = document.getElementById("treemap-svg");
const addGroupButton = document.getElementById("add-group");
const addItemButton = document.getElementById("add-item");
const removeItemButton = document.getElementById("remove-item");
const colorModeSelect = document.getElementById("color-mode");
const groupWidthSlider = document.getElementById("group-width");
const groupWidthValue = document.getElementById("group-width-value");
const groupHeightSlider = document.getElementById("group-height");
const groupHeightValue = document.getElementById("group-height-value");
const statusEl = document.getElementById("status");
const colorInput = document.getElementById("group-color-input");

const state = {
  groups: [
    {
      name: "Group 1",
      layout: { width: 300, height: DEFAULT_GROUP_HEIGHT },
      baseColor: "#3b82f6",
      items: [
        { label: "Block 1", value: 18 },
        { label: "Block 2", value: 12 },
      ],
    },
    {
      name: "Group 2",
      layout: { width: 300, height: DEFAULT_GROUP_HEIGHT },
      baseColor: "#16a34a",
      items: [
        { label: "Block 1", value: 16 },
        { label: "Block 2", value: 14 },
      ],
    },
  ],
  selectedGroupIndex: 0,
  selectedItemKey: [0, 0],
  colorMode: "value-shade",
  sharedHeight: DEFAULT_GROUP_HEIGHT,
  displayGroupRects: new Map(),
  displayItemRects: new Map(),
  targetGroupRects: new Map(),
  targetItemRects: new Map(),
  titleEditors: new Map(),
  itemEditors: new Map(),
  dragState: null,
  animationFrame: 0,
  syncWidthSlider: false,
};

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
  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function blendColor(color, target, amount) {
  const [r1, g1, b1] = hexToRgb(color);
  const [r2, g2, b2] = hexToRgb(target);
  const ratio = Math.max(0, Math.min(1, amount));
  return rgbToHex([
    Math.round(r1 + (r2 - r1) * ratio),
    Math.round(g1 + (g2 - g1) * ratio),
    Math.round(b1 + (b2 - b1) * ratio),
  ]);
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

function setSelectedGroup(index) {
  state.selectedGroupIndex = index;
  if (!state.selectedItemKey || state.selectedItemKey[0] !== index) {
    state.selectedItemKey = [index, 0];
  }
  syncWidthSlider();
}

function syncWidthSlider() {
  const group = state.groups[state.selectedGroupIndex];
  if (!group) return;
  state.syncWidthSlider = true;
  groupWidthSlider.value = String(group.layout.width);
  groupWidthValue.textContent = String(Math.round(group.layout.width));
  state.syncWidthSlider = false;
}

function removeStaleTitleEditors(activeKeys) {
  for (const [key, node] of state.titleEditors.entries()) {
    if (!activeKeys.has(key)) {
      node.remove();
      state.titleEditors.delete(key);
    }
  }
}

function removeStaleItemEditors(activeKeys) {
  for (const [key, editor] of state.itemEditors.entries()) {
    if (!activeKeys.has(key)) {
      editor.wrap.remove();
      state.itemEditors.delete(key);
    }
  }
}

function createSvg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

function getOrCreateTitleEditor(groupIndex) {
  if (state.titleEditors.has(groupIndex)) return state.titleEditors.get(groupIndex);
  const wrap = document.createElement("div");
  wrap.className = "title-editor";
  const input = document.createElement("input");
  input.className = "title-input";
  input.type = "text";
  input.addEventListener("focus", () => setSelectedGroup(groupIndex));
  input.addEventListener("blur", () => {
    const text = input.value.trim();
    if (text) {
      state.groups[groupIndex].name = text;
      queueRender();
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
  });
  wrap.appendChild(input);
  svg.parentElement.appendChild(wrap);
  state.titleEditors.set(groupIndex, wrap);
  return wrap;
}

function getOrCreateItemEditor(groupIndex, itemIndex) {
  const key = `${groupIndex}:${itemIndex}`;
  if (state.itemEditors.has(key)) return state.itemEditors.get(key);

  const wrap = document.createElement("div");
  wrap.className = "html-editor";

  const labelInput = document.createElement("input");
  labelInput.className = "block-input";
  labelInput.type = "text";
  labelInput.addEventListener("focus", () => {
    state.selectedGroupIndex = groupIndex;
    state.selectedItemKey = [groupIndex, itemIndex];
    syncWidthSlider();
  });
  labelInput.addEventListener("blur", () => {
    const text = labelInput.value.trim();
    if (text) {
      state.groups[groupIndex].items[itemIndex].label = text;
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
    state.selectedGroupIndex = groupIndex;
    state.selectedItemKey = [groupIndex, itemIndex];
    syncWidthSlider();
  });
  valueInput.addEventListener("blur", () => {
    const current = state.groups[groupIndex].items[itemIndex].value;
    const value = Math.max(1, Math.round(Number(valueInput.value) || current));
    state.groups[groupIndex].items[itemIndex].value = value;
    valueInput.value = String(value);
    queueRender();
  });
  valueInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") valueInput.blur();
  });

  wrap.append(labelInput, valueInput);
  wrap.addEventListener("pointerdown", () => {
    state.selectedGroupIndex = groupIndex;
    state.selectedItemKey = [groupIndex, itemIndex];
    syncWidthSlider();
  });
  wrap.addEventListener("dblclick", () => openGroupColorPicker(groupIndex, itemIndex));
  svg.parentElement.appendChild(wrap);

  const editor = { wrap, labelInput, valueInput };
  state.itemEditors.set(key, editor);
  return editor;
}

function openGroupColorPicker(groupIndex, itemIndex) {
  state.selectedGroupIndex = groupIndex;
  state.selectedItemKey = [groupIndex, itemIndex];
  syncWidthSlider();
  colorInput.value = normalizeHexColor(state.groups[groupIndex].baseColor);
  colorInput.oninput = () => {
    state.groups[groupIndex].baseColor = normalizeHexColor(colorInput.value, state.groups[groupIndex].baseColor);
    queueRender();
  };
  colorInput.click();
}

function queueRender() {
  cancelAnimationFrame(state.animationFrame);
  state.animationFrame = requestAnimationFrame(render);
}

function render() {
  state.animationFrame = 0;
  const bounds = svg.getBoundingClientRect();
  const width = Math.max(bounds.width, 480);
  const height = Math.max(bounds.height, 360);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  while (svg.firstChild) svg.firstChild.remove();

  for (const group of state.groups) group.layout.height = state.sharedHeight;

  const totalWidth = state.groups.reduce((sum, group) => sum + group.layout.width, 0)
    + OUTER_SPACING * Math.max(0, state.groups.length - 1);
  const tallest = Math.max(...state.groups.map((group) => group.layout.height));
  const usableWidth = Math.max(100, width - PREVIEW_PADDING * 2);
  const usableHeight = Math.max(100, height - PREVIEW_PADDING * 2 - OUTER_TITLE_GAP);
  const scale = Math.min(usableWidth / totalWidth, usableHeight / tallest);

  let cursorX = PREVIEW_PADDING;
  const baseY = PREVIEW_PADDING + OUTER_TITLE_GAP;
  const nextGroupRects = new Map();
  const nextItemRects = new Map();

  state.groups.forEach((group, groupIndex) => {
    const outerWidth = group.layout.width * scale;
    const outerHeight = group.layout.height * scale;
    const outerX = cursorX;
    const outerY = baseY;
    cursorX += outerWidth + OUTER_SPACING * scale;
    nextGroupRects.set(groupIndex, [outerX, outerY, outerWidth, outerHeight]);

    const normalized = normalizeSizes(group.items.map((item) => Math.max(item.value, 1)), group.layout.width, group.layout.height);
    const rects = squarify(normalized, 0, 0, group.layout.width, group.layout.height);
    rects.forEach(([x, y, rectWidth, rectHeight], itemIndex) => {
      nextItemRects.set(`${groupIndex}:${itemIndex}`, [
        outerX + x * scale,
        outerY + y * scale,
        outerX + (x + rectWidth) * scale,
        outerY + (y + rectHeight) * scale,
      ]);
    });
  });

  if (!state.displayGroupRects.size || !state.displayItemRects.size || state.dragState) {
    state.displayGroupRects = new Map(nextGroupRects);
    state.displayItemRects = new Map(nextItemRects);
  } else {
    state.displayGroupRects = animateMap(state.displayGroupRects, nextGroupRects);
    state.displayItemRects = animateMap(state.displayItemRects, nextItemRects);
  }

  state.targetGroupRects = nextGroupRects;
  state.targetItemRects = nextItemRects;

  const activeTitleEditors = new Set();
  const activeItemEditors = new Set();
  let selectedRect = null;

  state.groups.forEach((group, groupIndex) => {
    const groupRect = state.displayGroupRects.get(groupIndex);
    if (!groupRect) return;
    const [outerX, outerY, outerWidth] = groupRect;

    const titleBoxWidth = Math.max(100, outerWidth * 0.55);
    const titleX = outerX + outerWidth / 2 - titleBoxWidth / 2;
    const titleY = outerY - 34;
    svg.appendChild(createSvg("rect", {
      x: titleX,
      y: titleY,
      width: titleBoxWidth,
      height: 24,
      class: "group-title-box",
    }));

    const titleEditor = getOrCreateTitleEditor(groupIndex);
    activeTitleEditors.add(groupIndex);
    titleEditor.style.left = `${titleX}px`;
    titleEditor.style.top = `${titleY}px`;
    titleEditor.style.width = `${titleBoxWidth}px`;
    titleEditor.style.height = "24px";
    const titleInput = titleEditor.querySelector("input");
    if (document.activeElement !== titleInput) titleInput.value = group.name;

    const values = group.items.map((item) => item.value);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const spread = maxValue - minValue;

    group.items.forEach((item, itemIndex) => {
      const key = `${groupIndex}:${itemIndex}`;
      const rect = state.displayItemRects.get(key);
      if (!rect) return;
      const [x1, y1, x2, y2] = rect;
      const rectWidth = x2 - x1;
      const rectHeight = y2 - y1;

      let fill = group.baseColor;
      if (state.colorMode === "value-shade") {
        const intensity = spread <= 0 ? 0.5 : (item.value - minValue) / spread;
        fill = blendColor(group.baseColor, "#ffffff", 0.22 + (1 - intensity) * 0.25);
        fill = blendColor(fill, "#000000", 0.08 + intensity * 0.14);
      }

      const block = createSvg("rect", {
        x: x1,
        y: y1,
        width: rectWidth,
        height: rectHeight,
        class: "treemap-block",
        fill,
        "data-group": groupIndex,
        "data-item": itemIndex,
      });
      block.addEventListener("pointerdown", onBlockPointerDown);
      block.addEventListener("dblclick", () => openGroupColorPicker(groupIndex, itemIndex));
      svg.appendChild(block);

      const editor = getOrCreateItemEditor(groupIndex, itemIndex);
      activeItemEditors.add(key);
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

      if (state.selectedItemKey && state.selectedItemKey[0] === groupIndex && state.selectedItemKey[1] === itemIndex) {
        selectedRect = { groupIndex, itemIndex, x1, y1, x2, y2 };
      }
    });
  });

  removeStaleTitleEditors(activeTitleEditors);
  removeStaleItemEditors(activeItemEditors);

  if (selectedRect) drawSelection(selectedRect);

  const totalItems = state.groups.reduce((sum, group) => sum + group.items.length, 0);
  statusEl.textContent = `${state.groups.length} outer rectangles, ${totalItems} inner blocks`;
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

function drawSelection({ groupIndex, itemIndex, x1, y1, x2, y2 }) {
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
      "data-group": groupIndex,
      "data-item": itemIndex,
      "data-corner": corner,
    });
    handle.addEventListener("pointerdown", onHandlePointerDown);
    svg.appendChild(handle);
  });
}

function onBlockPointerDown(event) {
  const groupIndex = Number(event.target.dataset.group);
  const itemIndex = Number(event.target.dataset.item);
  state.selectedGroupIndex = groupIndex;
  state.selectedItemKey = [groupIndex, itemIndex];
  syncWidthSlider();
  render();
}

function onHandlePointerDown(event) {
  event.stopPropagation();
  const groupIndex = Number(event.target.dataset.group);
  const itemIndex = Number(event.target.dataset.item);
  const corner = event.target.dataset.corner;
  const rect = state.displayItemRects.get(`${groupIndex}:${itemIndex}`);
  const outerRect = state.displayGroupRects.get(groupIndex);
  if (!rect || !outerRect) return;

  state.selectedGroupIndex = groupIndex;
  state.selectedItemKey = [groupIndex, itemIndex];
  syncWidthSlider();

  const [left, top, right, bottom] = rect;
  let anchor;
  if (corner === "nw") anchor = [right, bottom];
  else if (corner === "ne") anchor = [left, bottom];
  else if (corner === "se") anchor = [left, top];
  else anchor = [right, top];

  state.dragState = {
    groupIndex,
    itemIndex,
    anchorX: anchor[0],
    anchorY: anchor[1],
    outerRect,
  };

  svg.setPointerCapture(event.pointerId);
}

svg.addEventListener("pointermove", (event) => {
  if (!state.dragState) return;
  const { groupIndex, itemIndex, anchorX, anchorY, outerRect } = state.dragState;
  const [outerLeft, outerTop, outerWidth, outerHeight] = outerRect;
  const outerRight = outerLeft + outerWidth;
  const outerBottom = outerTop + outerHeight;

  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const cursor = point.matrixTransform(svg.getScreenCTM().inverse());

  let currentX = Math.min(Math.max(cursor.x, outerLeft), outerRight);
  let currentY = Math.min(Math.max(cursor.y, outerTop), outerBottom);
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

  updateItemValueFromRect(groupIndex, itemIndex, left, top, right, bottom);
  render();
});

svg.addEventListener("pointerup", () => {
  state.dragState = null;
});

function updateItemValueFromRect(groupIndex, itemIndex, left, top, right, bottom) {
  const group = state.groups[groupIndex];
  const outerRect = state.displayGroupRects.get(groupIndex);
  if (!group || !outerRect) return;
  const [, , outerWidth, outerHeight] = outerRect;
  const resizedArea = Math.max(1, (right - left) * (bottom - top));
  const proportion = Math.min(0.95, Math.max(0.02, resizedArea / (outerWidth * outerHeight)));
  const otherTotal = group.items.reduce((sum, item, index) => sum + (index === itemIndex ? 0 : item.value), 0);
  const newValue = otherTotal <= 0
    ? Math.max(1, group.items[itemIndex].value)
    : Math.max(1, Math.round((proportion * otherTotal) / Math.max(1e-6, 1 - proportion)));
  group.items[itemIndex].value = newValue;
}

addGroupButton.addEventListener("click", () => {
  const index = state.groups.length;
  state.groups.push({
    name: `Group ${index + 1}`,
    layout: { width: 300, height: state.sharedHeight },
    baseColor: ["#3b82f6", "#16a34a", "#f97316", "#dc2626", "#8b5cf6", "#0f766e"][index % 6],
    items: [
      { label: "Block 1", value: 18 },
      { label: "Block 2", value: 12 },
    ],
  });
  state.selectedGroupIndex = index;
  state.selectedItemKey = [index, 0];
  syncWidthSlider();
  render();
});

addItemButton.addEventListener("click", () => {
  const group = state.groups[state.selectedGroupIndex];
  if (!group) return;
  const itemNumber = group.items.length + 1;
  group.items.push({ label: `Block ${itemNumber}`, value: Math.max(1, 20 - itemNumber * 2) });
  state.selectedItemKey = [state.selectedGroupIndex, group.items.length - 1];
  render();
});

removeItemButton.addEventListener("click", () => {
  const selected = state.selectedItemKey;
  if (!selected) return;
  const [groupIndex, itemIndex] = selected;
  const group = state.groups[groupIndex];
  if (!group || group.items.length <= 1) return;
  group.items.splice(itemIndex, 1);
  state.selectedItemKey = [groupIndex, Math.min(itemIndex, group.items.length - 1)];
  render();
});

colorModeSelect.addEventListener("change", () => {
  state.colorMode = colorModeSelect.value;
  queueRender();
});

groupWidthSlider.addEventListener("input", () => {
  groupWidthValue.textContent = groupWidthSlider.value;
  if (state.syncWidthSlider) return;
  const group = state.groups[state.selectedGroupIndex];
  if (!group) return;
  group.layout.width = Number(groupWidthSlider.value);
  render();
});

groupHeightSlider.addEventListener("input", () => {
  state.sharedHeight = Number(groupHeightSlider.value);
  groupHeightValue.textContent = groupHeightSlider.value;
  render();
});

window.addEventListener("resize", queueRender);

groupWidthValue.textContent = groupWidthSlider.value;
groupHeightValue.textContent = groupHeightSlider.value;
render();
