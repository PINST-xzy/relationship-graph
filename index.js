/**
 * 人物双向关系图谱 - SillyTavern 扩展
 * 
 * 核心理念：
 * - 数据绑定到当前角色卡（不污染其他 RP）
 * - 双向关系卡 + 共享信息差 + 维度拆分
 * - 自动同步到一个专属 World Info（Lorebook）作为注入通道
 * 
 * 字段结构（与设计稿一致）：
 * - 信息差（共享）：A 知 B 不知 / B 知 A 不知 / 互不知
 * - 认知（单边）：A→B 怎么定义 B / B→A 怎么定义 A
 * - 互动（单边）：行为模式 [user 相关卡此字段可空]
 * - 近况（单边）：最近一次显著互动 + 时间锚点
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, characters, this_chid, eventSource, event_types } from "../../../../script.js";
import { loadWorldInfo, saveWorldInfo, createNewWorldInfo } from "../../../world-info.js";

const MODULE_NAME = "relationship_graph";
const LOREBOOK_PREFIX = "RG_"; // 自动生成的 Lorebook 前缀
const DEFAULT_DEPTH = 4;       // World Info 注入深度（@D 4）
const DEFAULT_PROBABILITY = 100;

// ============================================================
// 数据结构
// ============================================================

/**
 * 默认设置（按当前角色卡存储）
 * 结构：
 *   {
 *     characters: { [name]: { aliases: [...] } },  // 角色名册
 *     cards: [
 *       {
 *         id: "uuid",
 *         actorA: "贺涵", actorB: "徐依一",
 *         dimension: "" | "工作" | "情感" | ...,    // 多卡拆分用
 *         infoGap: "...",
 *         a2b: { baseline, position, interaction, recent },
 *         b2a: { baseline, position, interaction, recent },
 *         enabled: true,
 *         depth: 4,
 *         probability: 100,
 *         updatedAt: timestamp
 *       }
 *     ]
 *   }
 */
function getCharData() {
    const charId = this_chid;
    if (charId === undefined || charId === null) return null;

    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    const root = extension_settings[MODULE_NAME];

    // 用角色卡的 avatar 文件名作为 key（比 chid 稳定）
    const charKey = characters[charId]?.avatar || `chid_${charId}`;
    if (!root[charKey]) {
        root[charKey] = { characters: {}, cards: [] };
    }
    return { key: charKey, data: root[charKey] };
}

function saveData() {
    saveSettingsDebounced();
}

function uuid() {
    return 'xxxxxxxxyxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ============================================================
// 角色名册
// ============================================================

function addActor(name, aliases) {
    const ctx = getCharData();
    if (!ctx) return;
    ctx.data.characters[name] = {
        aliases: (aliases || "").split(",").map(s => s.trim()).filter(Boolean)
    };
    saveData();
}

function removeActor(name) {
    const ctx = getCharData();
    if (!ctx) return;
    delete ctx.data.characters[name];
    // 同时删除涉及该角色的所有卡片
    ctx.data.cards = ctx.data.cards.filter(c => c.actorA !== name && c.actorB !== name);
    saveData();
}

function getActorList() {
    const ctx = getCharData();
    if (!ctx) return [];
    return Object.keys(ctx.data.characters);
}

function getActorAliases(name) {
    const ctx = getCharData();
    if (!ctx) return [];
    const a = ctx.data.characters[name]?.aliases || [];
    return [name, ...a];
}

// ============================================================
// 关系卡 CRUD
// ============================================================

function createCard(card) {
    const ctx = getCharData();
    if (!ctx) return null;
    const newCard = {
        id: uuid(),
        actorA: "", actorB: "",
        dimension: "",
        infoGap: "",
        // 字段说明（写作规则）：
        // baseline (底色): 沉淀式生长。多层情绪/记忆/印象，用 + 号连接，从早到近排序。
        // position (定位): 切换式。当前应对模式。用 / 号连接的引导性短语（带方向感，非定义）。
        // interaction (互动): 行为模式。可与好感度卡分工，user 相关卡可空。
        // recent (近况): 替换式。最近一次显著互动 + 时间锚点。
        a2b: { baseline: "", position: "", interaction: "", recent: "" },
        b2a: { baseline: "", position: "", interaction: "", recent: "" },
        enabled: true,
        depth: DEFAULT_DEPTH,
        probability: DEFAULT_PROBABILITY,
        updatedAt: Date.now(),
        ...card
    };
    // 数据迁移：旧版本只有 cognition 字段
    for (const side of ["a2b", "b2a"]) {
        if (newCard[side].cognition !== undefined && !newCard[side].position) {
            newCard[side].position = newCard[side].cognition;
            delete newCard[side].cognition;
        }
        if (newCard[side].baseline === undefined) newCard[side].baseline = "";
    }
    ctx.data.cards.push(newCard);
    saveData();
    return newCard;
}

function updateCard(id, patch) {
    const ctx = getCharData();
    if (!ctx) return;
    const card = ctx.data.cards.find(c => c.id === id);
    if (!card) return;
    Object.assign(card, patch, { updatedAt: Date.now() });
    saveData();
}

function deleteCard(id) {
    const ctx = getCharData();
    if (!ctx) return;
    ctx.data.cards = ctx.data.cards.filter(c => c.id !== id);
    saveData();
}

function getAllCards() {
    const ctx = getCharData();
    if (!ctx) return [];
    return ctx.data.cards;
}

// ============================================================
// token 估算（粗略：中文 1.5 字/token，英文 4 字符/token）
// ============================================================

function estimateTokens(text) {
    if (!text) return 0;
    // 简单估算：中文字符 / 1.5 + 其他字符 / 4
    let chinese = 0, other = 0;
    for (const ch of text) {
        if (/[\u4e00-\u9fff]/.test(ch)) chinese++;
        else other++;
    }
    return Math.ceil(chinese / 1.5 + other / 4);
}

function renderCardToText(card) {
    const dimension = card.dimension ? `（${card.dimension}维度）` : "";
    const lines = [];
    lines.push(`[${card.actorA} × ${card.actorB}]${dimension}`);
    lines.push("");
    if (card.infoGap?.trim()) {
        lines.push("【信息差】");
        lines.push(card.infoGap.trim());
        lines.push("");
    }
    // 兼容旧数据：cognition → position
    const sideA = card.a2b || {};
    const sideB = card.b2a || {};
    const posA = sideA.position ?? sideA.cognition ?? "";
    const posB = sideB.position ?? sideB.cognition ?? "";

    lines.push(`[${card.actorA} → ${card.actorB}]`);
    if (sideA.baseline?.trim()) lines.push(`底色：${sideA.baseline.trim()}`);
    if (posA?.trim()) lines.push(`定位：${posA.trim()}`);
    if (sideA.interaction?.trim()) lines.push(`互动：${sideA.interaction.trim()}`);
    if (sideA.recent?.trim()) lines.push(`近况：${sideA.recent.trim()}`);
    lines.push("");
    lines.push(`[${card.actorB} → ${card.actorA}]`);
    if (sideB.baseline?.trim()) lines.push(`底色：${sideB.baseline.trim()}`);
    if (posB?.trim()) lines.push(`定位：${posB.trim()}`);
    if (sideB.interaction?.trim()) lines.push(`互动：${sideB.interaction.trim()}`);
    if (sideB.recent?.trim()) lines.push(`近况：${sideB.recent.trim()}`);
    return lines.join("\n");
}

function estimateCardTokens(card) {
    return estimateTokens(renderCardToText(card));
}

// ============================================================
// World Info 同步
// ============================================================

/**
 * 把当前角色卡的所有关系卡同步到一个专属 Lorebook
 * Lorebook 名称：RG_<角色名>
 * 每张卡 → 一个 entry，双关键词 AND 触发
 */
async function syncToWorldInfo() {
    const ctx = getCharData();
    if (!ctx) {
        toastr.error("没有当前角色卡，无法同步");
        return;
    }
    const charName = characters[this_chid]?.name || "Unknown";
    const lorebookName = `${LOREBOOK_PREFIX}${charName}`;

    let wi;
    try {
        wi = await loadWorldInfo(lorebookName);
    } catch (e) {
        wi = null;
    }
    if (!wi) {
        await createNewWorldInfo(lorebookName);
        wi = await loadWorldInfo(lorebookName);
    }

    // 清空现有 entries（我们用插件做唯一数据源）
    wi.entries = {};

    // 为每张启用的卡片生成 entry
    let entryUid = 0;
    for (const card of ctx.data.cards) {
        if (!card.enabled) continue;
        if (!card.actorA || !card.actorB) continue;

        const keysA = getActorAliases(card.actorA);
        const keysB = getActorAliases(card.actorB);

        // ST 的 Selective + secondary keys 实现 AND 逻辑
        // primary keys = A 的所有别名（任一命中）
        // secondary keys = B 的所有别名（任一命中）
        // selective = true → 必须 secondary 也命中
        const dimensionTag = card.dimension ? `[${card.dimension}]` : "";
        const comment = `${card.actorA} × ${card.actorB} ${dimensionTag}`.trim();

        wi.entries[entryUid] = {
            uid: entryUid,
            key: keysA,
            keysecondary: keysB,
            comment: comment,
            content: renderCardToText(card),
            constant: false,
            selective: true,
            selectiveLogic: 0, // AND ANY
            order: 100,
            position: 4,       // @D (in chat at depth)
            depth: card.depth ?? DEFAULT_DEPTH,
            probability: card.probability ?? DEFAULT_PROBABILITY,
            useProbability: true,
            disable: false,
            addMemo: true,
            displayIndex: entryUid,
            group: "",
            groupOverride: false,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            automationId: "",
            role: 0,
            vectorized: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
        };
        entryUid++;
    }

    await saveWorldInfo(lorebookName, wi, true);
    toastr.success(`已同步 ${entryUid} 张关系卡到「${lorebookName}」\n请到角色卡的 World Info 设置中挂载该 Lorebook`);
}

// ============================================================
// 导入/导出
// ============================================================

function exportData() {
    const ctx = getCharData();
    if (!ctx) return;
    const json = JSON.stringify(ctx.data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const charName = characters[this_chid]?.name || "char";
    a.href = url;
    a.download = `relationship_graph_${charName}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function importData(jsonStr) {
    try {
        const parsed = JSON.parse(jsonStr);
        if (!parsed.characters || !parsed.cards) {
            toastr.error("文件格式不正确");
            return;
        }
        const ctx = getCharData();
        if (!ctx) return;
        // 合并策略：用导入数据覆盖
        ctx.data.characters = parsed.characters;
        ctx.data.cards = parsed.cards;
        saveData();
        renderUI();
        toastr.success("导入成功");
    } catch (e) {
        toastr.error("导入失败：" + e.message);
    }
}

// ============================================================
// UI 渲染
// ============================================================

function renderUI() {
    const $panel = $("#rg_panel");
    if (!$panel.length) return;
    $panel.empty();

    const ctx = getCharData();
    if (!ctx) {
        $panel.append(`<div class="rg-empty">请先选择一个角色卡</div>`);
        return;
    }

    // —— 顶部工具栏 ——
    const $toolbar = $(`
        <div class="rg-toolbar">
            <button class="menu_button" id="rg_btn_new_card">＋ 新建关系卡</button>
            <button class="menu_button" id="rg_btn_manage_actors">角色名册</button>
            <button class="menu_button" id="rg_btn_sync">同步到 World Info</button>
            <button class="menu_button" id="rg_btn_export">导出</button>
            <button class="menu_button" id="rg_btn_import">导入</button>
            <input type="file" id="rg_import_file" accept=".json" style="display:none">
        </div>
    `);
    $panel.append($toolbar);

    // —— 关系卡列表 ——
    const $list = $(`<div class="rg-card-list"></div>`);
    const cards = ctx.data.cards;

    if (cards.length === 0) {
        $list.append(`<div class="rg-empty">还没有关系卡。点"角色名册"先添加几个角色，再点"新建关系卡"。</div>`);
    } else {
        // 总 token 预估
        const totalTokens = cards.filter(c => c.enabled).reduce((sum, c) => sum + estimateCardTokens(c), 0);
        $list.append(`<div class="rg-stats">已启用关系卡 ${cards.filter(c => c.enabled).length} / ${cards.length} ｜ 总 token 约 ${totalTokens}（仅同时触发时占用，单卡最多约 ${cards.length ? Math.max(...cards.map(estimateCardTokens)) : 0}）</div>`);

        for (const card of cards) {
            const tokens = estimateCardTokens(card);
            const dimTag = card.dimension ? `<span class="rg-dim-tag">${card.dimension}</span>` : "";
            const enabledClass = card.enabled ? "" : "rg-disabled";
            // 兼容旧数据
            const a2bPos = card.a2b?.position ?? card.a2b?.cognition ?? "";
            const b2aPos = card.b2a?.position ?? card.b2a?.cognition ?? "";
            const a2bBase = card.a2b?.baseline ?? "";
            const b2aBase = card.b2a?.baseline ?? "";
            const $card = $(`
                <div class="rg-card ${enabledClass}" data-id="${card.id}">
                    <div class="rg-card-header">
                        <span class="rg-card-title">${card.actorA || "?"} × ${card.actorB || "?"}</span>
                        ${dimTag}
                        <span class="rg-card-tokens">~${tokens} tk</span>
                        <label class="rg-toggle">
                            <input type="checkbox" class="rg-card-enable" ${card.enabled ? "checked" : ""}> 启用
                        </label>
                        <button class="menu_button rg-card-edit">编辑</button>
                        <button class="menu_button rg-card-delete">删除</button>
                    </div>
                    <div class="rg-card-preview">
                        ${card.infoGap ? `<div><b>信息差：</b>${escapeHtml(truncate(card.infoGap, 80))}</div>` : ""}
                        ${a2bBase ? `<div><b>${card.actorA}底色：</b>${escapeHtml(truncate(a2bBase, 80))}</div>` : ""}
                        <div><b>${card.actorA}→${card.actorB}：</b>${escapeHtml(truncate(a2bPos, 60))}</div>
                        ${b2aBase ? `<div><b>${card.actorB}底色：</b>${escapeHtml(truncate(b2aBase, 80))}</div>` : ""}
                        <div><b>${card.actorB}→${card.actorA}：</b>${escapeHtml(truncate(b2aPos, 60))}</div>
                    </div>
                </div>
            `);
            $list.append($card);
        }
    }

    $panel.append($list);

    // —— 事件绑定 ——
    $("#rg_btn_new_card").on("click", () => openCardEditor(null));
    $("#rg_btn_manage_actors").on("click", openActorManager);
    $("#rg_btn_sync").on("click", syncToWorldInfo);
    $("#rg_btn_export").on("click", exportData);
    $("#rg_btn_import").on("click", () => $("#rg_import_file").click());
    $("#rg_import_file").on("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => importData(ev.target.result);
        reader.readAsText(file);
    });

    $(".rg-card-edit").on("click", function () {
        const id = $(this).closest(".rg-card").data("id");
        openCardEditor(id);
    });
    $(".rg-card-delete").on("click", function () {
        const id = $(this).closest(".rg-card").data("id");
        if (confirm("确定删除这张关系卡？")) {
            deleteCard(id);
            renderUI();
        }
    });
    $(".rg-card-enable").on("change", function () {
        const id = $(this).closest(".rg-card").data("id");
        updateCard(id, { enabled: this.checked });
        renderUI();
    });
}

function escapeHtml(s) {
    if (!s) return "";
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function truncate(s, n) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
}

// ============================================================
// 角色名册管理弹窗
// ============================================================

function openActorManager() {
    const ctx = getCharData();
    if (!ctx) return;

    const $modal = $(`
        <div class="rg-modal-overlay">
            <div class="rg-modal">
                <h3>角色名册</h3>
                <div class="rg-modal-hint">每个角色一个主名 + 别名（逗号分隔）。别名用于 World Info 关键词触发。<br>例：主名"徐依一"，别名"依一, user, 小徐"</div>
                <div id="rg_actor_list"></div>
                <div class="rg-actor-add">
                    <input type="text" id="rg_actor_new_name" placeholder="主名">
                    <input type="text" id="rg_actor_new_aliases" placeholder="别名（逗号分隔，可空）">
                    <button class="menu_button" id="rg_btn_actor_add">添加</button>
                </div>
                <div class="rg-modal-footer">
                    <button class="menu_button" id="rg_btn_actor_close">关闭</button>
                </div>
            </div>
        </div>
    `);
    $("body").append($modal);

    function renderActorList() {
        const $list = $("#rg_actor_list");
        $list.empty();
        const actors = ctx.data.characters;
        if (Object.keys(actors).length === 0) {
            $list.append(`<div class="rg-empty">暂无角色</div>`);
        } else {
            for (const [name, info] of Object.entries(actors)) {
                const $row = $(`
                    <div class="rg-actor-row">
                        <span class="rg-actor-name">${escapeHtml(name)}</span>
                        <input type="text" class="rg-actor-aliases" data-name="${escapeHtml(name)}" value="${escapeHtml((info.aliases || []).join(", "))}" placeholder="别名">
                        <button class="menu_button rg-actor-delete" data-name="${escapeHtml(name)}">删除</button>
                    </div>
                `);
                $list.append($row);
            }
        }
        $(".rg-actor-aliases").on("change", function () {
            const name = $(this).data("name");
            ctx.data.characters[name].aliases = $(this).val().split(",").map(s => s.trim()).filter(Boolean);
            saveData();
        });
        $(".rg-actor-delete").on("click", function () {
            const name = $(this).data("name");
            if (confirm(`删除角色「${name}」？\n注意：所有涉及该角色的关系卡也会被删除。`)) {
                removeActor(name);
                renderActorList();
                renderUI();
            }
        });
    }
    renderActorList();

    $("#rg_btn_actor_add").on("click", () => {
        const name = $("#rg_actor_new_name").val().trim();
        const aliases = $("#rg_actor_new_aliases").val().trim();
        if (!name) return;
        if (ctx.data.characters[name]) {
            toastr.warning("该角色已存在");
            return;
        }
        addActor(name, aliases);
        $("#rg_actor_new_name").val("");
        $("#rg_actor_new_aliases").val("");
        renderActorList();
    });

    $("#rg_btn_actor_close").on("click", () => $modal.remove());
}

// ============================================================
// 关系卡编辑器弹窗
// ============================================================

function openCardEditor(cardId) {
    const ctx = getCharData();
    if (!ctx) return;
    const actors = Object.keys(ctx.data.characters);
    if (actors.length < 2) {
        toastr.warning("请先在「角色名册」中至少添加 2 个角色");
        openActorManager();
        return;
    }

    let card;
    if (cardId) {
        card = ctx.data.cards.find(c => c.id === cardId);
        if (!card) return;
        // 兼容旧数据：cognition → position；补 baseline 默认空
        for (const side of ["a2b", "b2a"]) {
            if (card[side]?.cognition !== undefined && !card[side]?.position) {
                card[side].position = card[side].cognition;
                delete card[side].cognition;
            }
            if (card[side] && card[side].baseline === undefined) card[side].baseline = "";
        }
    } else {
        card = {
            id: null,
            actorA: actors[0], actorB: actors[1],
            dimension: "",
            infoGap: "",
            a2b: { baseline: "", position: "", interaction: "", recent: "" },
            b2a: { baseline: "", position: "", interaction: "", recent: "" },
            enabled: true,
            depth: DEFAULT_DEPTH,
            probability: DEFAULT_PROBABILITY,
        };
    }

    const actorOptions = (selected) => actors.map(a =>
        `<option value="${escapeHtml(a)}" ${a === selected ? "selected" : ""}>${escapeHtml(a)}</option>`
    ).join("");

    const $modal = $(`
        <div class="rg-modal-overlay">
            <div class="rg-modal rg-modal-large">
                <h3>${cardId ? "编辑" : "新建"}关系卡</h3>
                
                <div class="rg-form-row">
                    <label>角色 A：</label>
                    <select id="rg_edit_actorA">${actorOptions(card.actorA)}</select>
                    <label>角色 B：</label>
                    <select id="rg_edit_actorB">${actorOptions(card.actorB)}</select>
                </div>

                <div class="rg-form-row">
                    <label>维度（可空，用于同一对人物多卡拆分）：</label>
                    <input type="text" id="rg_edit_dimension" value="${escapeHtml(card.dimension)}" placeholder="例：工作 / 情感 / 家庭">
                </div>

                <div class="rg-form-row rg-form-block">
                    <label>【信息差】共享内容</label>
                    <textarea id="rg_edit_infoGap" rows="4" placeholder="A 知 B 不知：...&#10;B 知 A 不知：...&#10;互不知：...">${escapeHtml(card.infoGap)}</textarea>
                </div>

                <div class="rg-form-row rg-form-block">
                    <label class="rg-form-section">[A → B] <span id="rg_label_a2b"></span></label>
                    <label>底色 <span class="rg-hint">沉淀式生长。多层情绪/记忆/印象，用 + 号连接，从早到近排序。</span></label>
                    <textarea id="rg_edit_a2b_base" rows="2" placeholder="例：少女时代的惊艳深埋 + 重逢后被无视的微妙不甘 + 工作场合的克制专业">${escapeHtml(card.a2b.baseline || "")}</textarea>
                    <label>定位 <span class="rg-hint">切换式。当前应对模式。用 / 号连接的引导性短语（带方向感、非定义）。</span></label>
                    <textarea id="rg_edit_a2b_pos" rows="2" placeholder="例：基层联络员（松动中）/ 还在以工具性视角看她">${escapeHtml(card.a2b.position || "")}</textarea>
                    <label>互动 <span class="rg-hint">行为模式。user 相关卡可空（由好感度卡接管）。</span></label>
                    <textarea id="rg_edit_a2b_int" rows="2">${escapeHtml(card.a2b.interaction || "")}</textarea>
                    <label>近况 <span class="rg-hint">替换式。最近一次显著互动 + 时间锚点。</span></label>
                    <textarea id="rg_edit_a2b_rec" rows="2">${escapeHtml(card.a2b.recent || "")}</textarea>
                </div>

                <div class="rg-form-row rg-form-block">
                    <label class="rg-form-section">[B → A] <span id="rg_label_b2a"></span></label>
                    <label>底色 <span class="rg-hint">沉淀式生长。多层情绪/记忆/印象，用 + 号连接，从早到近排序。</span></label>
                    <textarea id="rg_edit_b2a_base" rows="2">${escapeHtml(card.b2a.baseline || "")}</textarea>
                    <label>定位 <span class="rg-hint">切换式。当前应对模式。用 / 号连接的引导性短语。</span></label>
                    <textarea id="rg_edit_b2a_pos" rows="2">${escapeHtml(card.b2a.position || "")}</textarea>
                    <label>互动：</label>
                    <textarea id="rg_edit_b2a_int" rows="2">${escapeHtml(card.b2a.interaction || "")}</textarea>
                    <label>近况：</label>
                    <textarea id="rg_edit_b2a_rec" rows="2">${escapeHtml(card.b2a.recent || "")}</textarea>
                </div>

                <div class="rg-form-row">
                    <label>注入深度（@D）：</label>
                    <input type="number" id="rg_edit_depth" value="${card.depth}" min="0" max="20" style="width:60px">
                    <label>触发概率：</label>
                    <input type="number" id="rg_edit_prob" value="${card.probability}" min="0" max="100" style="width:60px">%
                </div>

                <div class="rg-token-preview">预估 token：<span id="rg_token_count">0</span></div>

                <div class="rg-modal-footer">
                    <button class="menu_button" id="rg_btn_card_save">保存</button>
                    <button class="menu_button" id="rg_btn_card_cancel">取消</button>
                </div>
            </div>
        </div>
    `);
    $("body").append($modal);

    function updateLabels() {
        $("#rg_label_a2b").text(`${$("#rg_edit_actorA").val()} → ${$("#rg_edit_actorB").val()}`);
        $("#rg_label_b2a").text(`${$("#rg_edit_actorB").val()} → ${$("#rg_edit_actorA").val()}`);
    }
    function updateTokenCount() {
        const tmp = {
            actorA: $("#rg_edit_actorA").val(),
            actorB: $("#rg_edit_actorB").val(),
            dimension: $("#rg_edit_dimension").val(),
            infoGap: $("#rg_edit_infoGap").val(),
            a2b: {
                baseline: $("#rg_edit_a2b_base").val(),
                position: $("#rg_edit_a2b_pos").val(),
                interaction: $("#rg_edit_a2b_int").val(),
                recent: $("#rg_edit_a2b_rec").val(),
            },
            b2a: {
                baseline: $("#rg_edit_b2a_base").val(),
                position: $("#rg_edit_b2a_pos").val(),
                interaction: $("#rg_edit_b2a_int").val(),
                recent: $("#rg_edit_b2a_rec").val(),
            },
        };
        $("#rg_token_count").text(estimateCardTokens(tmp));
    }
    updateLabels();
    updateTokenCount();

    $("#rg_edit_actorA, #rg_edit_actorB").on("change", updateLabels);
    $modal.find("textarea, input").on("input change", updateTokenCount);

    $("#rg_btn_card_save").on("click", () => {
        const a = $("#rg_edit_actorA").val();
        const b = $("#rg_edit_actorB").val();
        if (a === b) {
            toastr.error("角色 A 和角色 B 不能相同");
            return;
        }
        const patch = {
            actorA: a, actorB: b,
            dimension: $("#rg_edit_dimension").val().trim(),
            infoGap: $("#rg_edit_infoGap").val(),
            a2b: {
                baseline: $("#rg_edit_a2b_base").val(),
                position: $("#rg_edit_a2b_pos").val(),
                interaction: $("#rg_edit_a2b_int").val(),
                recent: $("#rg_edit_a2b_rec").val(),
            },
            b2a: {
                baseline: $("#rg_edit_b2a_base").val(),
                position: $("#rg_edit_b2a_pos").val(),
                interaction: $("#rg_edit_b2a_int").val(),
                recent: $("#rg_edit_b2a_rec").val(),
            },
            depth: parseInt($("#rg_edit_depth").val()) || DEFAULT_DEPTH,
            probability: parseInt($("#rg_edit_prob").val()) || DEFAULT_PROBABILITY,
        };
        if (cardId) {
            updateCard(cardId, patch);
        } else {
            createCard(patch);
        }
        $modal.remove();
        renderUI();
    });
    $("#rg_btn_card_cancel").on("click", () => $modal.remove());
}

// ============================================================
// 入口：把面板挂到扩展菜单
// ============================================================

jQuery(async () => {
    // 在扩展设置区添加一个折叠面板
    const settingsHtml = `
        <div id="rg_extension_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>人物双向关系图谱</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="rg-intro">
                        关系卡按当前角色卡独立存储。点"同步到 World Info"后会生成一个 Lorebook，需在角色卡的 World Info 设置中挂载。
                    </div>
                    <div id="rg_panel"></div>
                </div>
            </div>
        </div>
    `;
    $("#extensions_settings2").append(settingsHtml);

    // 切换角色卡 / 切换聊天时重新渲染
    if (typeof eventSource !== "undefined" && event_types?.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            renderUI();
        });
    }

    renderUI();
});
