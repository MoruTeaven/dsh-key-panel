/**
 * @moruteaven/dsh-key-panel — client half (browser bundle).
 *
 * Registered as a `settings.section` in the DSH settings page. Talks to the
 * host through the shared connection RPC channel (endpoints `keyPanel/*`,
 * served by the `KeyPanelGateway` Typert remote in ./index.js).
 *
 * Bundle contract (see @deepseek-ai/dsh-client-modules):
 *  - The file is loaded as lazily-executed CJS: the body only REGISTERS a
 *    factory via `window.__ModuleLoader__.load({ id, factory })`. Module
 *    side effects (including the CSS injection below) run at materialization.
 *  - Only the seed module table may be required by bare specifier. For this
 *    bundle that means `react`, `react/jsx-runtime`, and
 *    `@deepseek-ai/dsh-client-ui-primitives` (all seed words). `slots`,
 *    `locale` and `connection` are cordis services, not modules — they arrive
 *    through `inject` and are read with `ctx.get`.
 *
 * Security posture: the panel can reveal values and is the only surface that
 * can change the access policy. The model's half (./index.js) registers tools
 * according to that policy — none of which ever returns a key value.
 *
 * The loader id below MUST equal the package name: the host keys the client
 * module graph by package name and rejects a bundle that registers anything
 * else ("bundle ... loaded without registering ... via __ModuleLoader__.load").
 */
window.__ModuleLoader__.load({
	id: "@moruteaven/dsh-key-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { jsx, jsxs, Fragment } = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const {
			Button, Input, Tag, StateDot, Modal, Toast,
			IconLinkOutline16, IconPlusOutline16, IconTrashOutline16, IconEditOutline16,
			IconCopyOutline16, IconLoadingOutline16, IconWarningOutline16,
			IconCheckOutline16, IconCloseOutline16, IconClockOutline16, writeClipboard,
		} = primitives;

		// ─────────────────────────────────────────────────────────────────────
		// Styles. Shipped as a string and injected once, the idiom every built-in
		// client plugin uses: a `data-plugin-css` guard makes it idempotent under
		// hot reload.
		// ─────────────────────────────────────────────────────────────────────
		const css = `
.kp-section{max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}
.kp-lead{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.kp-card{border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.kp-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.kp-head-title{font-size:13px;font-weight:500;flex:1;min-width:0}
.kp-body{padding:14px}
.kp-row{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.kp-row:last-child{border-bottom:none}
.kp-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.kp-name{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13px;line-height:20px}
.kp-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kp-value{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.kp-actions{display:flex;align-items:center;gap:2px;flex:0 0 auto}
.kp-meta{font-size:11px;color:var(--dsw-alias-label-dimmed);white-space:nowrap}
.kp-empty{padding:22px 14px;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.kp-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.kp-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.kp-hint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-dimmed)}
.kp-error{display:flex;align-items:flex-start;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.kp-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
.kp-code{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;background:var(--dsw-alias-markdown-code-block);border-radius:6px;padding:2px 6px}
.kp-status{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.kp-mono{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace)}
.kp-full{width:100%}
.kp-input-grow{flex:1;min-width:0}
.kp-input-grow > span{flex:1;min-width:0}
.kp-modes{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.kp-mode{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;background:transparent}
.kp-mode:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kp-mode[data-active="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}
.kp-mode-radio{margin-top:2px;flex:0 0 auto}
.kp-mode-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.kp-mode-name{font-size:13px;line-height:20px;font-weight:500}
.kp-mode-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.kp-callout{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:8px;font-size:12px;line-height:18px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label)}
.kp-row-inline{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}
.kp-origin{font-size:11px;color:var(--dsw-alias-label-dimmed)}
.kp-subcard{margin-top:10px;padding:12px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.kp-group{margin-top:10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
.kp-group-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}
.kp-group-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:0.5px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.kp-usage-row{display:flex;align-items:baseline;gap:8px;padding:6px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.kp-usage-row:last-of-type{border-bottom:none}
.kp-usage-time{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-dimmed);flex:0 0 auto}
.kp-usage-tag{font-size:11px;padding:1px 6px;border-radius:5px;flex:0 0 auto;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary)}
.kp-usage-tag-said{background:var(--dsw-alias-state-info-tertiary);color:var(--dsw-alias-state-info-label)}
.kp-usage-body{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-width:0}
.kp-usage-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.kp-select{padding:6px 8px;border-radius:6px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
`;

		const cssTagId = "dsh-key-panel/KeyPanelSection.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(cssTagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-key-panel";
			tag.dataset.pluginCss = cssTagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ─────────────────────────────────────────────────────────────────────
		// Dictionary. `label` on a slot entry may be a thunk, so the section's
		// own nav label follows the active locale.
		// ─────────────────────────────────────────────────────────────────────
		const NS = "settings.key-panel";

		const zh = {
			nav: "密钥",
			title: "密钥",
			lead: "存在这里的密钥会注入到助手的 shell 环境。助手用 $变量名 引用，值不会被读进对话。",
			addKey: "添加密钥",
			empty: "还没有密钥。添加后，助手就能在命令里用 $名称 引用它。",
			status: "状态",
			storePath: "存储位置",
			count: "共 {n} 个",
			modelAccess: "助手权限",
			injectHint: "给的变量",
			refresh: "刷新",
			edit: "编辑",
			remove: "删除",
			reveal: "显示",
			hide: "隐藏",
			copy: "复制",
			copied: "已复制",
			save: "保存",
			cancel: "取消",
			removeConfirmTitle: "删除这个密钥？",
			removeConfirmBody: "删除后助手立刻无法使用 {name}，此操作不可撤销。",
			removeConfirmOk: "删除",
			nameLabel: "名称",
			nameHint: "必须以 DSH_ 开头，只能包含大写字母、数字和下划线。例如 DSH_OPENAI_KEY",
			descLabel: "用途（可选）",
			descHint: "给助手看的说明，会出现在 shell 变量描述里。例如 OpenAI API 密钥",
			valueLabel: "值",
			valueHint: "密钥原文。保存后只以掩码显示，需要时可点“显示”。",
			valueKeepHint: "留空表示不修改当前值。",
			required: "必填",
			badName: "名称必须以 DSH_ 开头，且只能包含大写字母、数字和下划线",
			saveFailed: "保存失败",
			loadFailed: "加载失败",
			// ── 权限 ──
			policyTitle: "助手权限",
			policyLead: "控制助手能对这些密钥做什么。改动立即生效，无需重启。",
			modeReadonly: "只读",
			modeReadonlyDesc: "助手只能用，不能新增、修改或删除。不注册任何工具。",
			modeWrite: "可写",
			modeWriteDesc: "助手能新增密钥，并能更新它自己创建的。不能删除，也不能碰你创建的。",
			modeEdit: "可编辑",
			modeEditDesc: "助手能新增、修改、删除。删除仍需二次确认。",
			modeCurrent: "当前",
			scopeLabel: "限制到特定名称（可选）",
			scopeHint: "例如 DSH_AGENT_* 表示助手只能操作这个前缀下的密钥。留空表示不限。",
			scopeInvalid: "前缀必须以 DSH_ 开头，只能包含大写字母、数字、下划线，可带 *",
			policySaved: "权限已更新",
			policyFailed: "权限保存失败",
			warnEdit: "「可编辑」给了助手删除密钥的能力。只有在你确实需要时才使用。",
			originOperator: "你创建",
			originModel: "助手创建",
			// ── 平台与账号 ──
			groupTitle: "平台与账号",
			groupLead: "把同一服务商的账号 id 和密钥归到一起。变量名由插件用平台和账号标识符拼出。",
			groupEmpty: "还没有平台。密钥可以直接添加，不归组也能用。",
			platformAdd: "添加平台",
			platformLabel: "平台标识符",
			platformHint: "会拼进变量名。只用大写字母、数字和下划线，例如 CF。",
			platformDisplay: "显示名（可选）",
			platformDisplayHint: "只影响面板上的显示，不改变量名。例如 Cloudflare",
			accountAdd: "添加账号",
			accountLabel: "账号标识符",
			accountHint: "会拼进变量名。只用大写字母、数字和下划线，例如 WORK。",
			accountDisplay: "显示名（可选）",
			accountDisplayHint: "只影响面板上的显示，不改变量名。例如 工作账号",
			ungrouped: "未分组",
			ungroupedHint: "没有归属平台的密钥。",
			previewNames: "将生成这两个变量名",
			badIdentifier: "只能包含大写字母、数字和下划线，且以字母开头",
			platformExists: "这个平台标识符已被使用",
			accountExists: "这个平台下已有同名账号",
			groupRemoved: "已删除",
			groupRemoveTitle: "删除这个平台？",
			groupRemoveBody: "它下面的账号会一并删除。如果还有密钥挂在这里，需要先处理它们。",
			accountRemoveTitle: "删除这个账号？",
			accountRemoveBody: "如果还有密钥挂在它下面，需要先处理它们。",
			forceRemove: "仍然删除（密钥退回未分组）",
			groupLoadFailed: "平台和账号加载失败",
			groupSaveFailed: "保存失败",
			relabel: "重命名显示名",
			relabelHint: "只改显示名，变量名不受影响。",
			namesClash: "这个名称已被占用：{names}。继续保存会覆盖它原有的值。",
			usageTitle: "最近活动",
			usageLead: "下面是两条独立的记录流，按时间排列。一种助手自己申报的意图，另一种是命令执行时实际注入的变量。两者不配对——时间接近不代表同一次操作，请自行对照。",
			usageEmpty: "还没有记录。",
			usageLoadFailed: "读取记录失败",
			usageTotal: "条数",
			usageIntents: "其中申报",
			usageCap: "上限",
			usageSaid: "助手申报",
			usageHanded: "注入命令",
			usageMore: "展开更多",
			usageLess: "收起",
			usageCaveat: "「注入命令」只说明这些变量在那一刻被交给了 shell，不表示命令真的读了它们，也不表示用它们做了什么。",
			refresh: "刷新",
		};

		const en = {
			nav: "Keys",
			title: "Keys",
			lead: "Keys stored here are injected into the assistant's shell environment. It references them as $NAME; values never enter the conversation.",
			addKey: "Add key",
			empty: "No keys yet. Once you add one, the assistant can reference it as $NAME in a command.",
			status: "Status",
			storePath: "Stored at",
			count: "{n} total",
			modelAccess: "Assistant access",
			injectHint: "Exposed as",
			refresh: "Refresh",
			edit: "Edit",
			remove: "Delete",
			reveal: "Show",
			hide: "Hide",
			copy: "Copy",
			copied: "Copied",
			save: "Save",
			cancel: "Cancel",
			removeConfirmTitle: "Delete this key?",
			removeConfirmBody: "The assistant loses access to {name} immediately. This cannot be undone.",
			removeConfirmOk: "Delete",
			nameLabel: "Name",
			nameHint: "Must start with DSH_ and use only A-Z, 0-9 and underscore. For example DSH_OPENAI_KEY",
			descLabel: "Purpose (optional)",
			descHint: "Shown to the assistant as the shell variable's description. For example OpenAI API key",
			valueLabel: "Value",
			valueHint: "The secret itself. After saving it is only ever shown masked; press Show when you need it.",
			valueKeepHint: "Leave blank to keep the current value.",
			required: "Required",
			badName: "Name must start with DSH_ and use only A-Z, 0-9 and underscore",
			saveFailed: "Save failed",
			loadFailed: "Load failed",
			// ── Access policy ──
			policyTitle: "Assistant access",
			policyLead: "Controls what the assistant may do with these keys. Changes take effect immediately.",
			modeReadonly: "Read-only",
			modeReadonlyDesc: "The assistant can use keys but never change them. No tool is registered at all.",
			modeWrite: "Writable",
			modeWriteDesc: "The assistant can add keys and update the ones it created. It cannot delete, or touch yours.",
			modeEdit: "Editable",
			modeEditDesc: "The assistant can add, change and delete. Deletion still needs a second confirmation.",
			modeCurrent: "Current",
			scopeLabel: "Restrict to matching names (optional)",
			scopeHint: "For example DSH_AGENT_* limits the assistant to that prefix. Blank means unrestricted.",
			scopeInvalid: "Must start with DSH_ and use only A-Z, 0-9, underscore and *",
			policySaved: "Access updated",
			policyFailed: "Could not update access",
			warnEdit: "\"Editable\" gives the assistant the ability to delete keys. Use it only when you need to.",
			originOperator: "yours",
			originModel: "assistant-made",
			// ── Platforms and accounts ──
			groupTitle: "Platforms and accounts",
			groupLead: "Keep one provider's account id and token together. The variable names are built from the platform and account identifiers.",
			groupEmpty: "No platforms yet. Keys work fine on their own without one.",
			platformAdd: "Add platform",
			platformLabel: "Platform identifier",
			platformHint: "Becomes part of the variable name. Uppercase letters, digits and underscore only — e.g. CF.",
			platformDisplay: "Display name (optional)",
			platformDisplayHint: "Shown in the panel only; does not change any variable name. E.g. Cloudflare",
			accountAdd: "Add account",
			accountLabel: "Account identifier",
			accountHint: "Becomes part of the variable name. Uppercase letters, digits and underscore only — e.g. WORK.",
			accountDisplay: "Display name (optional)",
			accountDisplayHint: "Shown in the panel only; does not change any variable name. E.g. Work",
			ungrouped: "Ungrouped",
			ungroupedHint: "Keys with no platform.",
			previewNames: "These two variable names will be created",
			badIdentifier: "Uppercase letters, digits and underscore only, starting with a letter",
			platformExists: "That platform identifier is already taken",
			accountExists: "This platform already has an account with that identifier",
			groupRemoved: "Removed",
			groupRemoveTitle: "Delete this platform?",
			groupRemoveBody: "Its accounts go too. If keys are still filed under it, deal with those first.",
			accountRemoveTitle: "Delete this account?",
			accountRemoveBody: "If keys are still filed under it, deal with those first.",
			forceRemove: "Delete anyway (keys move to ungrouped)",
			groupLoadFailed: "Could not load platforms and accounts",
			groupSaveFailed: "Could not save",
			relabel: "Rename display name",
			relabelHint: "Changes the display name only; variable names are unaffected.",
			namesClash: "These names are already taken: {names}. Saving will overwrite their existing values.",
			usageTitle: "Recent activity",
			usageLead: "Two independent records below, in time order. The upper kind is a purpose the assistant declared; the lower kind is what a command was actually handed. They are not paired — being close in time does not make two entries one action. Correlate them yourself.",
			usageEmpty: "Nothing recorded yet.",
			usageLoadFailed: "Could not read the log",
			usageTotal: "entries",
			usageIntents: "declared",
			usageCap: "cap",
			usageSaid: "declared",
			usageHanded: "handed to command",
			usageMore: "Show more",
			usageLess: "Show less",
			usageCaveat: "\"Handed to command\" means these variables were in scope at that moment. It does not mean the command read them, or what it did with them — the host cannot see command contents.",
			refresh: "Refresh",
		};

		// ─────────────────────────────────────────────────────────────────────
		// Panel
		// ─────────────────────────────────────────────────────────────────────

		/** Cheap shape check mirroring the host's KEY_NAME_PATTERN. */
		const NAME_PATTERN = /^DSH_[A-Z][A-Z0-9_]*$/;

// Identifier grammar and the credential-name splice, duplicated from the host's
// lib/store.js on purpose: the client half is a browser bundle and cannot import
// host modules, so a shared constant is not available to it. The host remains the
// authority — it validates independently and refuses anything this lets through,
// so the copy here is for immediate feedback, not enforcement. Keep the two in
// step; the host's copy carries the reasoning for the grammar itself.
const IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function isValidIdentifier(value) {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function credentialName(platform, account, field) {
	return `DSH_${platform}_${account}_${field.toUpperCase()}`;
}

		/** RPC failure wrapping: keep the host's code visible in the message. */
		function failMessage(method, error) {
			const code = error?.code ?? "unknown";
			const message = error?.message ?? String(error);
			return `keyPanel.${method}: ${code}: ${message}`;
		}

		function formatTime(value) {
			if (typeof value !== "number" || value <= 0) return "";
			try {
				return new Date(value).toLocaleString();
			} catch {
				return "";
			}
		}

		/** The three access modes, in the order the panel presents them. */
		const ACCESS_MODES = [
			{ id: "readonly", nameKey: "modeReadonly", descKey: "modeReadonlyDesc" },
			{ id: "write", nameKey: "modeWrite", descKey: "modeWriteDesc" },
			{ id: "edit", nameKey: "modeEdit", descKey: "modeEditDesc" },
		];

		/**
		 * Platform and account manager.
		 *
		 * Deliberately NOT a tree of every key. The key list below stays flat and
		 * complete, because that flat list is what the shell actually exposes —
		 * making it look nested would misrepresent the namespace. This card only
		 * manages the grouping itself and reports how many keys each slot holds.
		 *
		 * The clash check runs before an account is created: the names are derived
		 * from identifiers, so creating an account can land on a name that already
		 * exists as an ungrouped key. The host treats a set() as an overwrite, so
		 * without this the operator would lose a secret to a silent replace.
		 */
		function PlatformGroup({ t, groups, keys, busy, onAddPlatform, onAddAccount, onRenamePlatform, onRenameAccount, onRemovePlatform, onRemoveAccount, onError }) {
			const [platformDraft, setPlatformDraft] = react.useState(null); // {identifier, label}
			const [accountDraft, setAccountDraft] = react.useState(null); // {platform, identifier, label}
			const [clash, setClash] = react.useState(null); // {platform, identifier, names: string[]}
			const [confirmRemove, setConfirmRemove] = react.useState(null); // {kind, platform, identifier}
			const [relabelDraft, setRelabelDraft] = react.useState(null); // {kind, platform, identifier, label}

			const platforms = groups?.platforms ?? [];
			const accounts = groups?.accounts ?? [];

			/**
			 * Existing variable names, for the clash check. Values are never involved.
			 *
			 * Rebuilt on every render rather than memoised: the React shim this
			 * bundle runs against supplies useMemo as a bare `fn => fn()` with no
			 * dependency tracking, so a memo here would be a lie. The list is small
			 * (it is a key panel, not a database) and the section re-renders on
			 * explicit refresh only.
			 */
			const takenNames = new Set((keys ?? []).map(row => row.name));

			const submitPlatform = react.useCallback(async () => {
				if (platformDraft === null) return;
				const identifier = platformDraft.identifier.trim().toUpperCase();
				if (!isValidIdentifier(identifier)) {
					onError(t("badIdentifier"));
					return;
				}
				try {
					await onAddPlatform(identifier, platformDraft.label.trim());
					setPlatformDraft(null);
					onError(null);
				} catch (cause) {
					onError(`${t("groupSaveFailed")}: ${cause?.message ?? String(cause)}`);
				}
			}, [platformDraft, onAddPlatform, onError, t]);

			/**
			 * Create the account, after checking the two names it implies.
			 *
			 * A clash does not block: the operator may well intend to replace an
			 * ungrouped key with a filed one. It asks, states exactly which names
			 * are affected, and lets them decide — because the alternative is
			 * either a silent overwrite or a refusal they cannot override.
			 */
			const submitAccount = react.useCallback(async (force) => {
				const draft = clash !== null ? { platform: clash.platform, identifier: clash.identifier, label: clash.label } : accountDraft;
				if (draft === undefined || draft === null) return;
				const identifier = draft.identifier.trim().toUpperCase();
				if (!isValidIdentifier(identifier)) {
					onError(t("badIdentifier"));
					return;
				}
				if (!force) {
					const names = [credentialName(draft.platform, identifier, "id"), credentialName(draft.platform, identifier, "key")];
					const hit = names.filter(name => takenNames.has(name));
					if (hit.length > 0) {
						setClash({ platform: draft.platform, identifier, label: draft.label, names: hit });
						return;
					}
				}
				try {
					await onAddAccount(draft.platform, identifier, draft.label.trim());
					setAccountDraft(null);
					setClash(null);
					onError(null);
				} catch (cause) {
					onError(`${t("groupSaveFailed")}: ${cause?.message ?? String(cause)}`);
				}
			}, [accountDraft, clash, takenNames, onAddAccount, onError, t]);

			const doRemove = react.useCallback(async (force) => {
				if (confirmRemove === null) return;
				try {
					if (confirmRemove.kind === "platform") {
						await onRemovePlatform(confirmRemove.platform, force);
					} else {
						await onRemoveAccount(confirmRemove.platform, confirmRemove.identifier, force);
					}
					setConfirmRemove(null);
					onError(null);
				} catch (cause) {
					// A refusal here is the host telling us keys are still filed under
					// it. Re-reading would not change that, so surface it and let the
					// operator choose the forced path from the same dialog.
					onError(`${cause?.message ?? String(cause)}`);
				}
			}, [confirmRemove, onRemovePlatform, onRemoveAccount, onError]);

			const preview = accountDraft !== null && isValidIdentifier(accountDraft.platform) && isValidIdentifier(accountDraft.identifier.trim().toUpperCase())
				? [credentialName(accountDraft.platform, accountDraft.identifier.trim().toUpperCase(), "id"), credentialName(accountDraft.platform, accountDraft.identifier.trim().toUpperCase(), "key")]
				: null;

			return jsxs("div", {
				className: "kp-card",
				children: [
					jsxs("div", {
						className: "kp-head",
						children: [
							jsx(IconPlusOutline16, {}),
							jsx("span", { className: "kp-head-title", children: t("groupTitle") }),
							jsx(Button, {
								size: "sm",
								disabled: busy,
								onClick: () => {
									setPlatformDraft({ identifier: "", label: "" });
									onError(null);
								},
								children: t("platformAdd"),
							}),
						],
					}),
					jsxs("div", {
						className: "kp-body",
						children: [
							jsx("div", { className: "kp-lead", children: t("groupLead") }),

							// ── New platform ──────────────────────────────────
							platformDraft !== null && jsxs("div", {
								className: "kp-subcard",
								children: [
									jsxs("div", {
										className: "kp-field",
										children: [
											jsx("span", { className: "kp-label", children: t("platformLabel") }),
											jsx(Input, {
												value: platformDraft.identifier,
												placeholder: "CF",
												disabled: busy,
												onChange: event => setPlatformDraft(prev => ({ ...prev, identifier: event.target.value.toUpperCase() })),
											}),
											jsx("span", { className: "kp-hint", children: t("platformHint") }),
										],
									}),
									jsxs("div", {
										className: "kp-field",
										children: [
											jsx("span", { className: "kp-label", children: t("platformDisplay") }),
											jsx(Input, {
												value: platformDraft.label,
												placeholder: "Cloudflare",
												disabled: busy,
												onChange: event => setPlatformDraft(prev => ({ ...prev, label: event.target.value })),
											}),
											jsx("span", { className: "kp-hint", children: t("platformDisplayHint") }),
										],
									}),
									jsxs("div", {
										className: "kp-foot",
										children: [
											jsx(Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => setPlatformDraft(null), children: t("cancel") }),
											jsx(Button, { size: "sm", variant: "primary", disabled: busy, onClick: submitPlatform, children: t("save") }),
										],
									}),
								],
							}),

							// ── New account ───────────────────────────────────
							accountDraft !== null && jsxs("div", {
								className: "kp-subcard",
								children: [
									jsxs("div", {
										className: "kp-field",
										children: [
											jsx("span", { className: "kp-label", children: t("groupTitle") }),
											// A native select: the primitive set has no Select, and a
											// platform is a choice from a fixed list, so a dropdown is
											// the right control rather than a free-text box.
											jsx("select", {
												className: "kp-select",
												value: accountDraft.platform,
												disabled: busy,
												onChange: event => setAccountDraft(prev => ({ ...prev, platform: event.target.value })),
												children: platforms.map(p => jsx("option", { value: p.identifier, children: p.label === p.identifier ? p.identifier : `${p.label} (${p.identifier})` }, p.identifier)),
											}),
										],
									}),
									jsxs("div", {
										className: "kp-field",
										children: [
											jsx("span", { className: "kp-label", children: t("accountLabel") }),
											jsx(Input, {
												value: accountDraft.identifier,
												placeholder: "WORK",
												disabled: busy,
												onChange: event => {
													setAccountDraft(prev => ({ ...prev, identifier: event.target.value.toUpperCase() }));
													setClash(null);
												},
											}),
											jsx("span", { className: "kp-hint", children: t("accountHint") }),
										],
									}),
									jsxs("div", {
										className: "kp-field",
										children: [
											jsx("span", { className: "kp-label", children: t("accountDisplay") }),
											jsx(Input, {
												value: accountDraft.label,
												placeholder: "Work",
												disabled: busy,
												onChange: event => setAccountDraft(prev => ({ ...prev, label: event.target.value })),
											}),
											jsx("span", { className: "kp-hint", children: t("accountDisplayHint") }),
										],
									}),

									// Show the two names before committing, so nothing about
									// the resulting shell namespace is a surprise.
									preview !== null && jsxs("div", {
										className: "kp-status",
										children: [
											jsx("span", { children: `${t("previewNames")}:` }),
											...preview.map(name => jsx("span", { className: "kp-code", children: `$${name}` }, name)),
										],
									}),

									clash !== null && jsxs("div", {
										className: "kp-error",
										children: [
											jsx(IconWarningOutline16, { size: 14 }),
											jsx("span", { children: t("namesClash").replace("{names}", clash.names.map(n => `$${n}`).join(", ")) }),
										],
									}),

									jsxs("div", {
										className: "kp-foot",
										children: [
											jsx(Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => { setAccountDraft(null); setClash(null); }, children: t("cancel") }),
											clash === null
												? jsx(Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => submitAccount(false), children: t("save") })
												: jsx(Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => submitAccount(true), children: t("save") }),
										],
									}),
								],
							}),

							// ── Existing groups ───────────────────────────────
							platforms.length === 0 && accountDraft === null && platformDraft === null && jsx("div", { className: "kp-empty", children: t("groupEmpty") }),

							platforms.map(platform => {
								const owned = accounts.filter(a => a.platform === platform.identifier);
								return jsxs("div", {
									className: "kp-group",
									children: [
										jsxs("div", {
											className: "kp-group-head",
											children: [
												jsx("span", { className: "kp-name", children: platform.label }),
												platform.label !== platform.identifier && jsx("span", { className: "kp-code", children: platform.identifier }),
												jsx(Button, {
													size: "sm",
													disabled: busy,
													onClick: () => {
														// Inline edit rather than a modal prompt: this panel
														// never blocks on a native dialog, and a prompt() would
														// also be unavailable in the host's webview.
														setRelabelDraft({ kind: "platform", platform: platform.identifier, label: platform.label });
													},
													children: t("relabel"),
												}),
												jsx(Button, {
													size: "sm",
													disabled: busy,
													onClick: () => {
														setAccountDraft({ platform: platform.identifier, identifier: "", label: "" });
														setClash(null);
														onError(null);
													},
													children: t("accountAdd"),
												}),
												jsx(Button, {
													size: "sm",
													title: t("remove"),
													icon: jsx(IconTrashOutline16, {}),
													disabled: busy,
													onClick: () => setConfirmRemove({ kind: "platform", platform: platform.identifier }),
												}),
											],
										}),
										owned.length === 0
											? jsx("div", { className: "kp-hint", style: { paddingLeft: 10 }, children: "—" })
											: owned.map(account => jsxs("div", {
												className: "kp-group-row",
												children: [
													jsx("span", { className: "kp-name", children: account.label }),
													account.label !== account.identifier && jsx("span", { className: "kp-code", children: account.identifier }),
													jsx("span", { className: "kp-code", children: `$${credentialName(platform.identifier, account.identifier, "id")}` }),
													jsx("span", { className: "kp-code", children: `$${credentialName(platform.identifier, account.identifier, "key")}` }),
													jsx(Button, {
														size: "sm",
														disabled: busy,
														onClick: () => setRelabelDraft({ kind: "account", platform: platform.identifier, identifier: account.identifier, label: account.label }),
														children: t("relabel"),
													}),
													jsx(Button, {
														size: "sm",
														title: t("remove"),
														icon: jsx(IconTrashOutline16, {}),
														disabled: busy,
														onClick: () => setConfirmRemove({ kind: "account", platform: platform.identifier, identifier: account.identifier }),
													}),
												],
											}, `${account.platform}/${account.identifier}`)),
									],
								}, platform.identifier);
							}),

							// ── Relabel ───────────────────────────────────────
							relabelDraft !== null && jsxs("div", {
								className: "kp-subcard",
								children: [
									jsxs("div", {
										className: "kp-field",
										children: [
											jsx("span", { className: "kp-label", children: relabelDraft.kind === "platform" ? t("platformDisplay") : t("accountDisplay") }),
											jsx(Input, {
												value: relabelDraft.label,
												disabled: busy,
												onChange: event => setRelabelDraft(prev => ({ ...prev, label: event.target.value })),
											}),
											jsx("span", { className: "kp-hint", children: t("relabelHint") }),
										],
									}),
									jsxs("div", {
										className: "kp-foot",
										children: [
											jsx(Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => setRelabelDraft(null), children: t("cancel") }),
											jsx(Button, {
												size: "sm",
												variant: "primary",
												disabled: busy,
												onClick: async () => {
													if (relabelDraft.kind === "platform") {
														await onRenamePlatform(relabelDraft.platform, relabelDraft.label);
													} else {
														await onRenameAccount(relabelDraft.platform, relabelDraft.identifier, relabelDraft.label);
													}
													setRelabelDraft(null);
												},
												children: t("save"),
											}),
										],
									}),
								],
							}),

							// ── Removal confirmation ──────────────────────────
							confirmRemove !== null && jsxs("div", {
								className: "kp-subcard",
								children: [
									jsx("div", { className: "kp-label", children: confirmRemove.kind === "platform" ? t("groupRemoveTitle") : t("accountRemoveTitle") }),
									jsx("div", { className: "kp-hint", children: confirmRemove.kind === "platform" ? t("groupRemoveBody") : t("accountRemoveBody") }),
									jsxs("div", {
										className: "kp-foot",
										children: [
											jsx(Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => setConfirmRemove(null), children: t("cancel") }),
											jsx(Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => doRemove(false), children: t("remove") }),
											jsx(Button, { size: "sm", disabled: busy, onClick: () => doRemove(true), children: t("forceRemove") }),
										],
									}),
								],
							}),
						],
					}),
				],
			});
		}

		/**
		 * Recent activity: the two usage streams, merged by time and tagged.
		 *
		 * They are SHOWN side by side, not paired. An intent and a use that sit
		 * next to each other may well belong together, but nothing in the data
		 * says so, and drawing a line between them would assert a fact nobody
		 * observed. The timestamps are right there; the reader correlates.
		 *
		 * The wording of the "use" rows is deliberately weak — "handed to a
		 * command", not "used". The host resolves the whole environment on every
		 * shell call and cannot see what the command does with it, so a use entry
		 * is evidence that a value was IN SCOPE, never that it was read.
		 */
		function UsageCard({ t, load, limit }) {
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [expanded, setExpanded] = react.useState(false);

			const refresh = react.useCallback(async () => {
				setBusy(true);
				try {
					setData(await load(limit));
					setError(null);
				} catch (cause) {
					setError(`${t("usageLoadFailed")}: ${cause?.message ?? String(cause)}`);
				} finally {
					setBusy(false);
				}
			}, [load, limit, t]);

			react.useEffect(() => {
				refresh();
			}, [refresh]);

			/** HH:MM:SS in the operator's own timezone. Local time is right here:
			 *  they are matching it against their own memory of what they ran. */
			const stamp = (value) => {
				const date = new Date(value);
				if (Number.isNaN(date.getTime())) return "?";
				const pad = (n) => String(n).padStart(2, "0");
				return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
			};

			const entries = data?.entries ?? [];
			const shown = expanded ? entries : entries.slice(0, 12);
			const intents = entries.filter(e => e.kind === "intent").length;

			return jsxs("div", {
				className: "kp-card",
				children: [
					jsxs("div", {
						className: "kp-head",
						children: [
							jsx(IconClockOutline16, {}),
							jsx("span", { className: "kp-head-title", children: t("usageTitle") }),
							jsx(Button, { size: "sm", disabled: busy, onClick: refresh, children: t("refresh") }),
						],
					}),
					jsxs("div", {
						className: "kp-body",
						children: [
							jsx("div", { className: "kp-lead", children: t("usageLead") }),

							error !== null && jsxs("div", {
								className: "kp-error",
								children: [jsx(IconWarningOutline16, { size: 14 }), jsx("span", { children: error })],
							}),

							entries.length === 0 && jsx("div", { className: "kp-empty", children: t("usageEmpty") }),

							entries.length > 0 && jsxs("div", {
								className: "kp-status",
								children: [
									jsx("span", { children: `${t("usageTotal")}: ${data?.total ?? entries.length}` }),
									jsx("span", { children: `${t("usageIntents")}: ${intents}` }),
									jsx("span", { className: "kp-hint", children: `${t("usageCap")}: ${data?.limit ?? "—"}` }),
								],
							}),

							shown.map((entry, index) => jsxs("div", {
								className: "kp-usage-row",
								children: [
									jsx("span", { className: "kp-usage-time", children: stamp(entry.t) }),
									jsx("span", {
										className: entry.kind === "intent" ? "kp-usage-tag kp-usage-tag-said" : "kp-usage-tag",
										children: entry.kind === "intent" ? t("usageSaid") : t("usageHanded"),
									}),
									jsxs("span", {
										className: "kp-usage-body",
										children: [
											entry.note !== undefined && jsx("span", { className: "kp-usage-note", children: entry.note }),
											jsx("span", { className: "kp-code", children: entry.names.map(n => `$${n}`).join(", ") }),
										],
									}),
								],
							}, `${entry.t}-${entry.kind}-${index}`)),

							entries.length > 12 && jsx(Button, {
								size: "sm",
								variant: "outline",
								onClick: () => setExpanded(prev => !prev),
								children: expanded ? t("usageLess") : `${t("usageMore")} (${entries.length - 12})`,
							}),

							jsx("div", { className: "kp-hint", children: t("usageCaveat") }),
						],
					}),
				],
			});
		}
		/**
		 * Access-policy card: pick the assistant's mode, optionally restrict it to
		 * a name prefix. Changes are saved immediately, which is why there is no
		 * Save button — a policy that needed an extra confirmation step would be
		 * one more thing to get wrong in a hurry.
		 *
		 * The scope field is a local draft until it validates, so a half-typed
		 * pattern never reaches the host.
		 */
		function PolicyCard({ t, policy, setPolicy }) {
			const [draftScope, setDraftScope] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [toast, setToast] = react.useState(null);

			const mode = policy?.accessMode ?? "readonly";
			const scope = draftScope ?? policy?.scopePattern ?? "";
			const modeOf = id => ACCESS_MODES.find(m => m.id === id);

			const apply = react.useCallback(async (nextMode, nextScope) => {
				setBusy(true);
				try {
					await setPolicy(nextMode, nextScope);
					setDraftScope(null);
					setError(null);
					setToast(t("policySaved"));
				}
				catch (cause) {
					setError(`${t("policyFailed")}: ${cause?.message ?? String(cause)}`);
				}
				finally {
					setBusy(false);
				}
			}, [setPolicy, t]);

			const commitScope = react.useCallback(() => {
				const value = scope.trim();
				if (value.length > 0 && !/^DSH_[A-Z0-9_*]*$/.test(value)) {
					setError(t("scopeInvalid"));
					return;
				}
				apply(mode, value.length === 0 ? null : value);
			}, [scope, mode, apply, t]);

			return jsxs("div", {
				className: "kp-card",
				children: [
					jsxs("div", {
						className: "kp-head",
						children: [
							jsx(IconLinkOutline16, { size: 16 }),
							jsx("span", { className: "kp-head-title", children: t("policyTitle") }),
							busy && jsx(IconLoadingOutline16, {}),
						],
					}),
					jsxs("div", {
						className: "kp-body",
						children: [
							jsx("div", { className: "kp-lead", children: t("policyLead") }),
							jsx("div", {
								className: "kp-modes",
								children: ACCESS_MODES.map(entry => jsxs("label", {
									className: "kp-mode",
									"data-active": String(entry.id === mode),
									children: [
										jsx("input", {
											className: "kp-mode-radio",
											type: "radio",
											name: "kp-access-mode",
											checked: entry.id === mode,
											disabled: busy,
											onChange: () => apply(entry.id, policy?.scopePattern ?? null),
										}),
										jsxs("span", {
											className: "kp-mode-text",
											children: [
												jsxs("span", {
													className: "kp-mode-name",
													children: [
														t(entry.nameKey),
														entry.id === mode ? ` · ${t("modeCurrent")}` : "",
													],
												}),
												jsx("span", { className: "kp-mode-desc", children: t(entry.descKey) }),
											],
										}),
									],
								}, entry.id)),
							}),

							mode === "edit" && jsxs("div", {
								className: "kp-callout",
								style: { marginTop: 10 },
								children: [jsx(IconWarningOutline16, { size: 14 }), jsx("span", { children: t("warnEdit") })],
							}),

							jsxs("div", {
								className: "kp-field",
								style: { marginTop: 14, marginBottom: 0 },
								children: [
									jsx("span", { className: "kp-label", children: t("scopeLabel") }),
									jsxs("div", {
										className: "kp-row-inline",
										style: { marginTop: 0 },
										children: [
											jsx(Input, {
												value: scope,
												placeholder: "DSH_AGENT_*",
												disabled: busy || mode === "readonly",
												onChange: event => setDraftScope(event.target.value),
												onKeyDown: event => { if (event.key === "Enter") commitScope(); },
											}),
											jsx(Button, {
												size: "sm",
												variant: "outline",
												disabled: busy || mode === "readonly" || draftScope === null,
												onClick: commitScope,
												children: t("save"),
											}),
										],
									}),
									jsx("span", { className: "kp-hint", children: t("scopeHint") }),
								],
							}),

							error !== null && jsxs("div", {
								className: "kp-error",
								style: { marginTop: 10 },
								children: [jsx(IconWarningOutline16, { size: 14 }), jsx("span", { children: error })],
							}),

							toast !== null && jsx(Toast, {
								text: toast,
								icon: jsx(IconCheckOutline16, {}),
								onDone: () => setToast(null),
							}),
						],
					}),
				],
			});
		}

		/**
		 * Render the Keys settings section.
		 *
		 * @param props.injected - payload supplied by the registration's `inject`
		 *   thunk; carries `t` and the five RPC calls.
		 * @param props.renderSlot - reserved for child slots; the panel currently
		 *   renders everything inline, so it is accepted but unused.
		 */
		function KeyPanelSection({ t, status, list, setKey, removeKey, revealKey, getPolicy, setPolicy, groups, addPlatform, setPlatformLabel, removePlatform, addAccount, setAccountLabel, removeAccount, usage, renderSlot }) {
			const [rows, setRows] = react.useState(null);
			const [groupRows, setGroupRows] = react.useState(null);
			const [info, setInfo] = react.useState(null);
			const [policy, setPolicyState] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);

			const [editor, setEditor] = react.useState(null); // {mode:'add'|'edit', name, description, value}
			const [revealed, setRevealed] = react.useState({}); // name -> plaintext
			const [confirmRemove, setConfirmRemove] = react.useState(null);
			const [toast, setToast] = react.useState(null);

			const refresh = react.useCallback(async () => {
				try {
					const [nextRows, nextGroups, nextInfo, nextPolicy] = await Promise.all([list(), groups(), status(), getPolicy()]);
					setRows(nextRows);
					setGroupRows(nextGroups);
					setInfo(nextInfo);
					setPolicyState(nextPolicy);
					setError(null);
				} catch (cause) {
					setError(`${t("loadFailed")}: ${cause?.message ?? String(cause)}`);
					setRows([]);
				}
			}, [list, groups, status, getPolicy, t]);

			/** Persist one policy change and reflect the stored result. */
			const savePolicy = react.useCallback(async (accessMode, scopePattern) => {
				const stored = await setPolicy(accessMode, scopePattern);
				setPolicyState(stored);
				return stored;
			}, [setPolicy]);

			react.useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const [nextRows, nextGroups, nextInfo, nextPolicy] = await Promise.all([list(), groups(), status(), getPolicy()]);
						if (!alive) return;
						setRows(nextRows);
						setGroupRows(nextGroups);
						setInfo(nextInfo);
						setPolicyState(nextPolicy);
					} catch (cause) {
						if (!alive) return;
						setError(`${t("loadFailed")}: ${cause?.message ?? String(cause)}`);
						setRows([]);
					}
				})();
				return () => {
					alive = false;
				};
			}, [list, groups, status, getPolicy, t]);

			const submit = react.useCallback(async () => {
				if (editor === null) return;
				const name = editor.name.trim();
				if (!NAME_PATTERN.test(name)) {
					setError(t("badName"));
					return;
				}
				if (editor.mode === "add" && editor.value.length === 0) {
					setError(`${t("valueLabel")}: ${t("required")}`);
					return;
				}
				setBusy(true);
				try {
					// On edit an empty value means "keep the existing secret": the
					// host requires a value argument, so re-send the current one.
					let value = editor.value;
					if (editor.mode === "edit" && value.length === 0) {
						value = await revealKey(name).then(r => r.value);
					}
					await setKey(name, value, editor.description);
					setEditor(null);
					setError(null);
					setToast(t("save"));
					await refresh();
				} catch (cause) {
					setError(`${t("saveFailed")}: ${cause?.message ?? String(cause)}`);
				} finally {
					setBusy(false);
				}
			}, [editor, setKey, revealKey, refresh, t]);

			/**
			 * Wrap one group mutation: run it, then re-read so the panel reflects
			 * what the host actually stored rather than what we hoped it did.
			 *
			 * Errors propagate on purpose — the group card catches them and shows a
			 * message, because a refusal here ("still holds keys") is information the
			 * operator needs, not something to swallow.
			 */
			const groupAction = react.useCallback(async (run) => {
				setBusy(true);
				try {
					await run();
					await refresh();
				} finally {
					setBusy(false);
				}
			}, [refresh]);

			const onAddPlatform = react.useCallback((identifier, label) => groupAction(() => addPlatform(identifier, label)), [groupAction, addPlatform]);
			const onRenamePlatform = react.useCallback((identifier, label) => groupAction(() => setPlatformLabel(identifier, label)), [groupAction, setPlatformLabel]);
			const onRemovePlatform = react.useCallback((identifier, force) => groupAction(() => removePlatform(identifier, force)), [groupAction, removePlatform]);
			const onAddAccount = react.useCallback((platform, identifier, label) => groupAction(() => addAccount(platform, identifier, label)), [groupAction, addAccount]);
			const onRenameAccount = react.useCallback((platform, identifier, label) => groupAction(() => setAccountLabel(platform, identifier, label)), [groupAction, setAccountLabel]);
			const onRemoveAccount = react.useCallback((platform, identifier, force) => groupAction(() => removeAccount(platform, identifier, force)), [groupAction, removeAccount]);

			const confirmDelete = react.useCallback(async () => {
				if (confirmRemove === null) return;
				setBusy(true);
				try {
					await removeKey(confirmRemove);
					setRevealed(prev => {
						const next = { ...prev };
						delete next[confirmRemove];
						return next;
					});
					setConfirmRemove(null);
					setError(null);
					await refresh();
				} catch (cause) {
					setError(`${cause?.message ?? String(cause)}`);
				} finally {
					setBusy(false);
				}
			}, [confirmRemove, removeKey, refresh]);

			const toggleReveal = react.useCallback(async (name) => {
				if (revealed[name] !== undefined) {
					setRevealed(prev => {
						const next = { ...prev };
						delete next[name];
						return next;
					});
					return;
				}
				try {
					const record = await revealKey(name);
					setRevealed(prev => ({ ...prev, [name]: record.value }));
				} catch (cause) {
					setError(`${cause?.message ?? String(cause)}`);
				}
			}, [revealed, revealKey]);

			const copy = react.useCallback(async (name) => {
				try {
					const record = await revealKey(name);
					await writeClipboard(record.value);
					setToast(t("copied"));
				} catch (cause) {
					setError(`${cause?.message ?? String(cause)}`);
				}
			}, [revealKey, t]);

			const empty = rows !== null && rows.length === 0;

			return jsxs("div", {
				className: "kp-section",
				children: [
					// ── Access policy ─────────────────────────────────────────
					policy !== null && jsx(PolicyCard, { t, policy, setPolicy: savePolicy }),

					// ── Platforms and accounts ────────────────────────────────
					groupRows !== null && jsx(PlatformGroup, {
						t,
						groups: groupRows,
						keys: rows ?? [],
						busy,
						onAddPlatform,
						onAddAccount,
						onRenamePlatform,
						onRenameAccount,
						onRemovePlatform,
						onRemoveAccount,
						onError: setError,
					}),

					// ── Recent activity ───────────────────────────────────────
					jsx(UsageCard, { t, load: usage, limit: 200 }),

					// ── Header ────────────────────────────────────────────────
					jsxs("div", {
						className: "kp-card",
						children: [
							jsxs("div", {
								className: "kp-head",
								children: [
									jsx("span", { className: "kp-head-title", children: t("title") }),
									info !== null && jsx(Tag, {
										tone: "outline",
										children: t("count").replace("{n}", String(info.count)),
									}),
									jsx(Button, {
										size: "sm",
										icon: jsx(IconPlusOutline16, {}),
										onClick: () => {
											setEditor({ mode: "add", name: "", description: "", value: "" });
											setError(null);
										},
										children: t("addKey"),
									}),
								],
							}),
							jsx("div", {
								className: "kp-body",
								children: [
									jsx("div", { className: "kp-lead", children: t("lead") }),
									info !== null && jsxs("div", {
										className: "kp-status",
										style: { marginTop: 10 },
										children: [
											jsx(StateDot, { state: info.count > 0 ? "ok" : "idle" }),
											jsx("span", { children: `${t("storePath")}:` }),
											jsx("span", { className: "kp-mono", children: info.storePath }),
										],
									}),
									info !== null && jsxs("div", {
										className: "kp-status",
										style: { marginTop: 6 },
										children: [
											jsx("span", { children: `${t("modelAccess")}:` }),
											jsx("span", { children: info.modelAccess }),
										],
									}),
									info !== null && info.count > 0 && jsxs("div", {
										className: "kp-status",
										style: { marginTop: 6 },
										children: [
											jsx("span", { children: `${t("injectHint")}:` }),
											...info.names.map(name => jsx("span", {
												className: "kp-code",
												key: name,
												children: `$${name}`,
											}, name)),
										],
									}),
								],
							}),
						],
					}),

					// ── Inline editor ─────────────────────────────────────────
					editor !== null && jsxs("div", {
						className: "kp-card",
						children: [
							jsxs("div", {
								className: "kp-head",
								children: [
									jsx(IconLinkOutline16, { size: 16 }),
									jsx("span", {
										className: "kp-head-title",
										children: t("addKey"),
									}),
								],
							}),
							jsxs("div", {
								className: "kp-body",
								children: [
									jsxs("div", {
										className: "kp-field",
										children: [
											jsx("span", { className: "kp-label", children: t("nameLabel") }),
											jsx(Input, {
												value: editor.name,
												placeholder: "DSH_OPENAI_KEY",
												disabled: editor.mode === "edit" || busy,
												onChange: event => setEditor(prev => ({ ...prev, name: event.target.value })),
											}),
											jsx("span", { className: "kp-hint", children: t("nameHint") }),
										],
									}),
									jsxs("div", {
										className: "kp-field",
										children: [
											jsx("span", { className: "kp-label", children: t("descLabel") }),
											jsx(Input, {
												value: editor.description,
												disabled: busy,
												onChange: event => setEditor(prev => ({ ...prev, description: event.target.value })),
											}),
											jsx("span", { className: "kp-hint", children: t("descHint") }),
										],
									}),
									jsxs("div", {
										className: "kp-field",
										children: [
											jsx("span", { className: "kp-label", children: t("valueLabel") }),
											jsx(Input, {
												type: "password",
												value: editor.value,
												disabled: busy,
												onChange: event => setEditor(prev => ({ ...prev, value: event.target.value })),
											}),
											jsx("span", {
												className: "kp-hint",
												children: editor.mode === "edit" ? t("valueKeepHint") : t("valueHint"),
											}),
										],
									}),
									error !== null && jsxs("div", {
										className: "kp-error",
										style: { marginBottom: 10 },
										children: [jsx(IconWarningOutline16, { size: 14 }), jsx("span", { children: error })],
									}),
									jsxs("div", {
										className: "kp-foot",
										children: [
											jsx(Button, {
												size: "sm",
												variant: "outline",
												disabled: busy,
												onClick: () => {
													setEditor(null);
													setError(null);
												},
												children: t("cancel"),
											}),
											jsx(Button, {
												size: "sm",
												variant: "primary",
												disabled: busy,
												icon: busy ? jsx(IconLoadingOutline16, {}) : jsx(IconCheckOutline16, {}),
												onClick: submit,
												children: t("save"),
											}),
										],
									}),
								],
							}),
						],
					}),

					// ── Key list ──────────────────────────────────────────────
					jsx("div", {
						className: "kp-card",
						children: rows === null
							? jsx("div", { className: "kp-empty", children: jsx(IconLoadingOutline16, {}) })
							: empty
								? jsx("div", { className: "kp-empty", children: t("empty") })
								: rows.map(row => {
									const plain = revealed[row.name];
									const shown = plain !== undefined;
									return jsxs("div", {
										className: "kp-row",
										children: [
											jsxs("div", {
												className: "kp-row-main",
												children: [
													jsx("span", { className: "kp-name", children: row.name }),
													shown
														? jsx("span", { className: "kp-value", children: plain })
														: jsx("span", { className: "kp-value", children: row.masked }),
													jsxs("span", {
														className: "kp-desc",
														children: [
															row.description || "—",
															row.updatedAt > 0 ? ` · ${formatTime(row.updatedAt)}` : "",
														],
													}),
													jsx("span", {
														className: "kp-origin",
														children: row.origin === "model" ? t("originModel") : t("originOperator"),
													}),
												],
											}),
											jsxs("div", {
												className: "kp-actions",
												children: [
													jsx(Button, {
														size: "sm",
														title: shown ? t("hide") : t("reveal"),
														onClick: () => toggleReveal(row.name),
														children: shown ? t("hide") : t("reveal"),
													}),
													jsx(Button, {
														size: "sm",
														title: t("copy"),
														icon: jsx(IconCopyOutline16, {}),
														onClick: () => copy(row.name),
													}),
													jsx(Button, {
														size: "sm",
														title: t("edit"),
														icon: jsx(IconEditOutline16, {}),
														onClick: () => {
															setEditor({
																mode: "edit",
																name: row.name,
																description: row.description ?? "",
																value: "",
															});
															setError(null);
														},
													}),
													jsx(Button, {
														size: "sm",
														title: t("remove"),
														icon: jsx(IconTrashOutline16, {}),
														onClick: () => setConfirmRemove(row.name),
													}),
												],
											}),
										],
									}, row.name);
								}),
					}),

					// ── Error (list-level) ────────────────────────────────────
					error !== null && editor === null && jsxs("div", {
						className: "kp-error",
						children: [jsx(IconWarningOutline16, { size: 14 }), jsx("span", { children: error })],
					}),

					// ── Delete confirmation ───────────────────────────────────
					confirmRemove !== null && jsx(Modal, {
						open: true,
						onClose: () => setConfirmRemove(null),
						title: t("removeConfirmTitle"),
						closeLabel: t("cancel"),
						description: t("removeConfirmBody").replace("{name}", confirmRemove),
						footer: [
							jsx(Button, {
								key: "cancel",
								size: "sm",
								variant: "outline",
								disabled: busy,
								onClick: () => setConfirmRemove(null),
								children: t("cancel"),
							}, "cancel"),
							jsx(Button, {
								key: "ok",
								size: "sm",
								variant: "primary",
								disabled: busy,
								onClick: confirmDelete,
								children: t("removeConfirmOk"),
							}, "ok"),
						],
						children: jsxs("div", {
							className: "kp-status",
							children: [
								jsx(StateDot, { state: "error" }),
								jsx("span", { className: "kp-mono", children: confirmRemove }),
							],
						}),
					}),

					// ── Toast ─────────────────────────────────────────────────
					toast !== null && jsx(Toast, {
						text: toast,
						icon: jsx(IconCheckOutline16, {}),
						onDone: () => setToast(null),
					}),
				],
			});
		}

		// ─────────────────────────────────────────────────────────────────────
		// Registration
		// ─────────────────────────────────────────────────────────────────────

		/** Dictionary namespace owned by this plugin. */
		const inject = ["slots", "locale", "connection"];

		/**
		 * Register the Keys section once `settings.section` is on the ledger.
		 *
		 * `settings.section` is a `list` slot declared by
		 * `@deepseek-ai/dsh-client-ui-settings-general`, so an `id` is mandatory.
		 * `order: 40` places it after General (0), Models (10) and Vault (30).
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-key-panel: dictionaries");
			const t = ctx.locale.bind(NS);
			const connection = ctx.get("connection");

			/** Invoke one host keyPanel remote and normalize the RPC envelope. */
			async function invoke(method, args = {}) {
				const result = await connection.rpc.call("/api", `keyPanel/${method}`, { args });
				if (!result.ok) throw new Error(failMessage(method, result.error));
				return result.value;
			}

			const injected = () => ({
				t,
				list: () => invoke("list"),
				status: () => invoke("status"),
				setKey: (name, value, description, slot) => invoke("set", { keyName: name, value, description, ...(slot ?? {}) }),
				removeKey: (name) => invoke("remove", { keyName: name }),
				revealKey: (name) => invoke("reveal", { keyName: name }),
				getPolicy: () => invoke("getPolicy"),
				setPolicy: (accessMode, scopePattern) => invoke("setPolicy", { accessMode, scopePattern }),
				// Grouping. Each of these is a separate remote, so a method that
				// is missing from the host's markRemoteMethods list fails here as
				// an unknown-method error rather than silently doing nothing.
				groups: () => invoke("groups"),
				addPlatform: (identifier, label) => invoke("addPlatform", { identifier, label }),
				setPlatformLabel: (identifier, label) => invoke("setPlatformLabel", { identifier, label }),
				removePlatform: (identifier, force) => invoke("removePlatform", { identifier, force }),
				addAccount: (platform, identifier, label) => invoke("addAccount", { platform, identifier, label }),
				setAccountLabel: (platform, identifier, label) => invoke("setAccountLabel", { platform, identifier, label }),
				removeAccount: (platform, identifier, force) => invoke("removeAccount", { platform, identifier, force }),
				credentialNames: (platform, account) => invoke("credentialNames", { platform, account }),
				// The usage log. Two record kinds come back in ONE array, each
				// entry tagged, and the panel aligns them by timestamp when it
				// draws them — the host never pairs an intent with a use.
				usage: (limit) => invoke("usage", { limit }),
			});

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "key-panel",
				order: 40,
				label: () => t("nav"),
				locale: NS,
				inject: injected,
			}, KeyPanelSection));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		exports.KeyPanelSection = KeyPanelSection;
		// Exported so the client suite can render it in isolation. The section
		// mounts it behind an async load, which makes it invisible to a suite
		// that never runs effects; this hatch keeps the grouping UI testable
		// without standing up the whole section.
		exports.PlatformGroup = PlatformGroup;
		exports.UsageCard = UsageCard;
		exports.isValidIdentifier = isValidIdentifier;
		exports.credentialName = credentialName;
		return module.exports;
	},
});
