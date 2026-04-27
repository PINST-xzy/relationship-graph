import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, characters, this_chid, eventSource, event_types } from "../../../../script.js";
import { loadWorldInfo, saveWorldInfo, createNewWorldInfo } from "../../../world-info.js";

const MODULE_NAME = "relationship_graph";
const LOREBOOK_PREFIX = "RG_";
const DEFAULT_DEPTH = 4;
const DEFAULT_PROBABILITY = 100;

// ============================================================
// 数据结构
// ============================================================

function getCharData() {
    const charId = this_chid;
    if (charId === undefined || charId === null) return null;

    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    const root = extension_settings[MODULE_NAME];

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
        a2b: { cognition: "", interaction: "", recent: "" },
        b2a: { cognition: "", interaction: "", recent: "" },
        enabled: true,
        depth: DEFAULT_DEPTH,
        probability: DEFAULT_PROBABILITY,
        updatedAt: Date.now(),
        ...card
    };
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
// token 估算
// ============================================================

function estimateTokens(text) {
    if (!text) return 0;
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
    lines.push(`[${card.actorA} → ${card.actorB}]`);
    if (card.a2b.cognition?.trim()) lines.push(`认知：${card.a2b.cognition.trim()}`);
    if (card.a2b.interaction?.trim()) lines.push(`互动：${card.a2b.interaction.trim()}`);
    if (card.a2b.recent?.trim()) lines.push(`近况：${card.a2b.recent.trim()}`);
    lines.push("");
    lines.push(`[${card.actorB} → ${card.actorA}]`);
    if (card.b2a.cognition?.trim()) lines.push(`认知：${card.b2a.cognition.trim()}`);
    if (card.b2a.interaction?.trim()) lines.push(`互动：${card.b2a.interaction.trim()}`);
    if (card.b2a.recent?.trim()) lines.push(`近况：${card.b2a.recent.trim()}`);
    return lines.join("\n");
}

function estimateCardTokens(card) {
    return estimateTokens(renderCardToText(card));
}

// ============================================================
// World Info 同步
// ============================================================

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

    wi.entries = {};

    let entryUid = 0;
    for (const card of ctx.data.cards) {
        if (!card.enabled) continue;
        if (!card.actorA || !card.actorB) continue;

        const keysA = getActorAliases(card.actorA);
        const keysB = getActorAliases(card.actorB);

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
            selectiveLogic: 0,
            order: 100,
            position: 4,
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

    const $list = $(`<div class="rg-card-list"></div>`);
    const cards = ctx.data.cards;

    if (cards.length === 0) {
        $list.append(`<div class="rg-empty">还没有关系卡。点"角色名册"先添加几个角色，再点"新建关系卡"。</div>`);
    } else {
        const totalTokens = cards.filter(c => c.enabled).reduce((sum, c) => sum + estimateCardTokens(c), 0);
        const maxTokens = cards.length ? Math.max(...cards.map(estimateCardTokens)) : 0;
        $list.append(`<div class="rg-stats">已启用关系卡 ${cards.filter(c => c.enabled).length} / ${cards.length} ｜ 总 token 约 ${totalTokens}（仅同时触发时占用，单卡最多约 ${maxTokens}）</div>`);

        for (const card of cards) {
            const tokens = estimateCardTokens(card);
            const dimTag = card.dimension ? `<span class="rg-dim-tag">${card.dimension}</span>` : "";
            const enabledClass = card.enabled ? "" : "rg-disabled";
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
                        <div><b>${card.actorA}→${card.actorB}：</b>${escapeHtml(truncate(card.a2b.cognition, 60))}</div>
                        <div><b>${card.actorB}→${card.actorA}：</b>${escapeHtml(truncate(card.b2a.cognition, 60))}</div>
                    </div>
                </div>
            `);
            $list.append($card);
        }
    }

    $panel.append($list);

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
    } else {
        card = {
            id: null,
            actorA: actors[0], actorB: actors[1],
            dimension: "",
            infoGap: "",
            a2b: { cognition: "", interaction: "", recent: "" },
            b2a: { cognition: "", interaction: "", recent: "" },
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
                    <label>认知：</label>
                    <textarea id="rg_edit_a2b_cog" rows="2">${escapeHtml(card.a2b.cognition)}</textarea>
                    <label>互动（user 相关卡可空）：</label>
                    <textarea id="rg_edit_a2b_int" rows="2">${escapeHtml(card.a2b.interaction)}</textarea>
                    <label>近况（带时间锚点）：</label>
                    <textarea id="rg_edit_a2b_rec" rows="2">${escapeHtml(card.a2b.recent)}</textarea>
                </div>
                <div class="rg-form-row rg-form-block">
                    <label class="rg-form-section">[B → A] <span id="rg_label_b2a"></span></label>
                    <label>认知：</label>
                    <textarea id="rg_edit_b2a_cog" rows="2">${escapeHtml(card.b2a.cognition)}</textarea>
                    <label>互动（user 相关卡可空）：</label>
                    <textarea id="rg_edit_b2a_int" rows="2">${escapeHtml(card.b2a.interaction)}</textarea>
                    <label>近况（带时间锚点）：</label>
                    <textarea id="rg_edit_b2a_rec" rows="2">${escapeHtml(card.b2a.recent)}</textarea>
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
                cognition: $("#rg_edit_a2b_cog").val(),
                interaction: $("#rg_edit_a2b_int").val(),
                recent: $("#rg_edit_a2b_rec").val(),
            },
            b2a: {
                cognition: $("#rg_edit_b2a_cog").val(),
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
                cognition: $("#rg_edit_a2b_cog").val(),
                interaction: $("#rg_edit_a2b_int").val(),
                recent: $("#rg_edit_a2b_rec").val(),
            },
            b2a: {
                cognition: $("#rg_edit_b2a_cog").val(),
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
// 入口
// ============================================================

jQuery(async () => {
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

    if (typeof eventSource !== "undefined" && event_types?.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            renderUI();
        });
    }

    renderUI();
});
