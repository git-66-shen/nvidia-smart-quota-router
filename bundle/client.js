/**
 * Client half of llm-nvidia-router: a standalone configuration page in the
 * left-bottom Settings dialog (registered into the `settings.section` list
 * slot, beside 通用/模型/插件), plus the Plugins-page row form it previously
 * shipped (`plugins.row.config`, keyed `<package>#<row id>`) as a secondary
 * entry. Both share one ConfigCard: scheduler fields, a dynamic model
 * catalog fetched from the endpoint (never typed by hand), a per-model
 * latency probe, and an unbounded API-key table whose values go straight
 * into the credentials service (values never enter configuration files).
 * A second surface — a red/yellow/green badge carrying the configured-key
 * count — sits in the conversation header utilities slot and polls the
 * Host redacted health route. The settings page owns its form: it reads
 * llm-nvidia-router through ctx.configForms instead of waiting for the
 * Plugins page to hand one in, so it renders with a live snapshot
 * (useSyncExternalStore) anywhere the settings shell mounts it. The catalog
 * rides ctx.remote.llm.discoverModels, the shipped Models-page discovery
 * Remote, so the Host half stays the single source of what the endpoint
 * actually serves. Hand-written in the lazy-CJS factory format the module
 * loader serves, so no build step is needed for this linked package.
 */
window.__ModuleLoader__.load({
	id: "@local/dsh-llm-nvidia-router",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { jsx, jsxs } = require("react/jsx-runtime");
		const { useEffect, useState, useSyncExternalStore } = require("react");
		const { Button, Input, Switch, Tag } = require("@deepseek-ai/dsh-client-ui-primitives");

		const NS = "nvidiaRouter.config";
		const PKG = "@local/dsh-llm-nvidia-router";
		const ROW_KEY = `${PKG}#llm-nvidia-router`;
		const ENTRY_ID = "llm-nvidia-router";
		const SECTION_ID = "nvidia-router";
		const SECTION_ORDER = 16;
		const REF_GRAMMAR = /^[A-Za-z_][A-Za-z0-9_]*$/;
		const PROBE_ROUTE = "api/nvidia-router.probe";
		const STATUS_ROUTE = "api/nvidia-router.status";
		const HEALTH_POLL_MS = 15000;
		// The endpoint the Host itself falls back to when configuration names none;
		// sending it keeps discovery valid even before the field is ever typed.
		const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
		// HTTP answers that prove a model is unusable with this key: unknown model,
		// retired model (the endpoint answers 410 Gone for one it has taken down),
		// bad credentials, exhausted quota, or a malformed request. Rate limiting
		// (429) and transport faults are NOT proof — they are kept and re-testable.
		const UNUSABLE_STATUSES = [400, 401, 402, 403, 404, 410];

		const en = {
			nav: "NVIDIA Quota Router",
			summary: "Provider route, key table, model catalog, sticky-quota thresholds, cooldowns, and timeouts.",
			sectionKeys: "API keys",
			keysHint: "Each row is one key: a credential reference plus its redacted label. The table is unbounded — add as many keys as you have; the scheduler tracks every key independently. Store the key VALUE in the masked field — it goes to the credentials service, never into configuration files.",
			keyEnv: "Credential reference",
			keyLabel: "Display label",
			keyValue: "Key value",
			storeKey: "Store",
			clearKey: "Clear",
			stored: "stored",
			notStored: "not stored",
			storeFailed: "Storing the key failed; try again.",
			clearFailed: "Clearing the key failed; try again.",
			refInvalid: "References may use only letters, digits, and underscores, and cannot start with a digit.",
			addKey: "Add key",
			remove: "Remove",
			sectionEndpoint: "Endpoint and model catalog",
			baseURL: "Base URL",
			sectionQuota: "Sticky quota scheduling",
			safeThreshold: "Local safe threshold (per key per window)",
			windowMs: "Rolling window (ms)",
			maxFailoverAttempts: "Key failover attempts per request",
			allUnavailableWaitMs: "Bounded wait when all keys are unavailable (ms)",
			sectionTimeouts: "Cooldowns and timeouts (ms)",
			rateLimitCooldownMs: "429 backoff base",
			rateLimitCooldownMaxMs: "429 backoff cap",
			authErrorCooldownMs: "Auth/config error cooldown",
			quotaCooldownMs: "Quota exhaustion cooldown",
			requestTimeoutMs: "Request deadline (0 = none)",
			streamIdleTimeoutMs: "Stream idle timeout",
			sectionSwitches: "Behavior",
			streamUsage: "Request stream token usage (stream_options.include_usage)",
			enableStatusTool: "Register the nvidia_quota_status diagnostic tool",
			routeId: "Provider route id",
			routeIdNote: "The route id is fixed to nvidia-router because the pi-ai adapter already declares nvidia. Changing it requires editing the profile patch.",
			save: "Save",
			reset: "Discard changes",
			saved: "Saved.",
			dirty: "Unsaved changes.",
			busy: "Saving…",
			refused: "The Host refused this change; the form reloaded the accepted values.",
			failed: "Saving failed; try again.",
			unavailable: "This profile does not expose the plugin's configuration for editing.",
			readonly: "The profile document is read-only; the form is shown for reference.",
			loading: "Loading configuration…",
			invalid: "Fix the highlighted fields: thresholds and timeouts must be non-negative integers.",
			modelsHint: "The list is dynamic: store a key, then fetch the catalog straight from the endpoint. No model ids to type by hand.",
			discover: "Fetch model list",
			discovering: "Fetching model list…",
			discovered: "Models found",
			discoverFailed: "Fetching the model list failed",
			modelsEmpty: "No models yet — store an API key, then fetch the list.",
			probe: "Test all models",
			probing: "Testing models…",
			probeAvailable: "Available",
			probeFailed: "The model test could not run",
			probeHint: "Every model is called once; a large catalog takes a while.",
			usableOf: "usable",
			removedOf: "removed",
			keptOf: "kept",
			uncertainOf: "uncertain",
			onlyUsable: "Keep only usable",
			restoreAll: "Restore all models",
			prunedNote: "Unusable models were dropped automatically (rate-limited and untested ones are kept).",
			pruneAll: "Not one model answered, so the list was left untouched — that points at the key or the quota, not the catalog. Fix that and retry.",
			healthLabel: "Configured APIs and health",
			healthHint: "red = none usable, yellow = partial or unverified, green = all healthy",
			healthKeyOk: "ok",
			healthKeyCooling: "cooling",
			healthKeyAuth: "auth error",
			healthKeyMissing: "not stored",
		};

		const zh = {
			nav: "NVIDIA 配额路由",
			summary: "Provider 路由、Key 表、模型目录、粘性配额阈值、冷却与超时设置。",
			sectionKeys: "API Key",
			keysHint: "每行一个 Key：凭据引用名 + 脱敏标签。Key 数量不限——有多少加多少，调度器逐 Key 独立计数。密钥值填在遮盖输入框里——只存入 credentials 服务，绝不写入配置文件。",
			keyEnv: "凭据引用名",
			keyLabel: "显示标签",
			keyValue: "密钥值",
			storeKey: "存储",
			clearKey: "清除",
			stored: "已存储",
			notStored: "未存储",
			storeFailed: "密钥存储失败，请重试。",
			clearFailed: "密钥清除失败，请重试。",
			refInvalid: "引用名只能包含字母、数字、下划线，且不能以数字开头。",
			addKey: "添加 Key",
			remove: "移除",
			sectionEndpoint: "端点与模型目录",
			baseURL: "Base URL",
			sectionQuota: "粘性配额调度",
			safeThreshold: "本地安全阈值（每 Key 每窗口）",
			windowMs: "滚动窗口（毫秒）",
			maxFailoverAttempts: "每请求换 Key 次数上限",
			allUnavailableWaitMs: "全部 Key 不可用时的有界等待（毫秒）",
			sectionTimeouts: "冷却与超时（毫秒）",
			rateLimitCooldownMs: "429 退避基数",
			rateLimitCooldownMaxMs: "429 退避上限",
			authErrorCooldownMs: "认证/配置异常冷却",
			quotaCooldownMs: "配额耗尽冷却",
			requestTimeoutMs: "请求截止（0 = 不限）",
			streamIdleTimeoutMs: "流空闲超时",
			sectionSwitches: "行为开关",
			streamUsage: "请求流式 token 用量（stream_options.include_usage）",
			enableStatusTool: "注册 nvidia_quota_status 诊断工具",
			routeId: "Provider 路由 id",
			routeIdNote: "路由 id 固定为 nvidia-router（pi-ai 已占用 nvidia 目录）。修改需编辑 profile patch。",
			save: "保存",
			reset: "放弃修改",
			saved: "已保存。",
			dirty: "有未保存的修改。",
			busy: "保存中…",
			refused: "Host 拒绝了本次修改；表单已恢复为已接受的值。",
			failed: "保存失败，请重试。",
			unavailable: "当前 profile 未开放此插件配置的编辑。",
			readonly: "配置文档只读，表单仅供参考。",
			loading: "正在加载配置…",
			invalid: "请修正标红的字段：阈值与超时必须是非负整数。",
			modelsHint: "列表是动态的：先存储密钥，再从端点直接获取模型目录，无需手动填写模型 id。",
			discover: "获取模型列表",
			discovering: "正在获取模型列表…",
			discovered: "已获取模型",
			discoverFailed: "获取模型列表失败",
			modelsEmpty: "暂无模型——先存储 API Key，再获取列表。",
			probe: "测试所有模型",
			probing: "正在测试模型…",
			probeAvailable: "可用",
			probeFailed: "测试未能执行",
			probeHint: "每个模型各调用一次；目录较大时需要数十秒。",
			usableOf: "可用",
			removedOf: "已移除",
			keptOf: "保留",
			uncertainOf: "未确定",
			onlyUsable: "仅保留可用",
			restoreAll: "恢复全部模型",
			prunedNote: "已自动移除不可用的模型（被限流与未能测出的会保留）。",
			pruneAll: "没有一个模型应答，列表已原样保留——这指向 Key 或额度问题，不是目录问题。修好后重试。",
			healthLabel: "已配置的 API 与健康状态",
			healthHint: "红=全部不可用，黄=部分或未验证，绿=全部正常",
			healthKeyOk: "正常",
			healthKeyCooling: "冷却中",
			healthKeyAuth: "认证错误",
			healthKeyMissing: "未存储",
		};

		const NUMBER_FIELDS = [
			"windowMs",
			"safeThreshold",
			"rateLimitCooldownMs",
			"rateLimitCooldownMaxMs",
			"authErrorCooldownMs",
			"quotaCooldownMs",
			"maxFailoverAttempts",
			"allUnavailableWaitMs",
			"streamIdleTimeoutMs",
			"requestTimeoutMs",
		];

		const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

		const defaultDraft = () => ({
			baseURL: "",
			apiKeys: [],
			models: [],
			windowMs: 60000,
			safeThreshold: 38,
			rateLimitCooldownMs: 5000,
			rateLimitCooldownMaxMs: 300000,
			authErrorCooldownMs: 900000,
			quotaCooldownMs: 1800000,
			maxFailoverAttempts: 2,
			allUnavailableWaitMs: 15000,
			streamIdleTimeoutMs: 300000,
			requestTimeoutMs: 120000,
			streamUsage: true,
			enableStatusTool: true,
		});

		function numberInvalid(draft) {
			return NUMBER_FIELDS.some((field) => {
				const value = draft[field];
				return typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
					|| (field === "streamIdleTimeoutMs" && value < 1)
					|| (field === "safeThreshold" && value < 1)
					|| (field === "windowMs" && value < 1);
			});
		}

		const section = { display: "flex", flexDirection: "column", gap: 10, marginTop: 18 };
		const sectionTitle = { margin: 0, fontSize: 14, fontWeight: 600 };
		const hint = { margin: 0, fontSize: 12, opacity: 0.75 };
		const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 10 };
		const fieldBox = { display: "flex", flexDirection: "column", gap: 4 };
		const fieldLabel = { fontSize: 12, opacity: 0.8 };
		const rowLine = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
		const footer = { display: "flex", alignItems: "center", gap: 10, marginTop: 20, flexWrap: "wrap" };
		const note = { fontSize: 12, opacity: 0.75 };
		const warnText = { fontSize: 12, color: "var(--dsw-alias-state-danger, #d5304f)" };
		const invalidInput = { borderColor: "var(--dsw-alias-state-danger, #d5304f)" };
		const modelList = { display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto", border: "1px solid var(--dsw-alias-border-subtle, #0000001a)", borderRadius: 6, padding: 8 };
		const modelRow = { display: "flex", alignItems: "center", gap: 8, fontSize: 12 };
		const modelGrow = { flex: 1, wordBreak: "break-all" };
		const latencyText = { opacity: 0.75, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
		const dotOk = { flex: "none", color: "var(--dsw-alias-state-success, #2e9e5b)" };
		const dotBad = { flex: "none", color: "var(--dsw-alias-state-danger, #d5304f)" };

		function NumberField({ t, label, draft, field, setDraft, writable }) {
			const value = draft[field];
			const bad = typeof value !== "number" || !Number.isSafeInteger(value) || value < 0;
			return jsxs("div", { style: fieldBox, children: [
				jsx("label", { style: fieldLabel, children: label }),
				jsx(Input, {
					type: "number", value: typeof value === "number" ? value : "",
					disabled: !writable, style: bad ? invalidInput : undefined,
					"aria-invalid": bad,
					onChange: (event) => {
						const parsed = event.target.value === "" ? undefined : Number(event.target.value);
						setDraft((current) => ({ ...current, [field]: parsed }));
					},
				}),
			] });
		}

		function ConfigCard({ form, credentials, discoverModels, t }) {
			const state = form.state;
			const [draft, setDraft] = useState(() => ({ ...defaultDraft(), ...clone(state.value) }));
			const [outcome, setOutcome] = useState(null);
			const [busy, setBusy] = useState(false);
			const [credentialInfo, setCredentialInfo] = useState({});
			const [keyValues, setKeyValues] = useState({});
			const [keyOutcome, setKeyOutcome] = useState(null);
			const [discovering, setDiscovering] = useState(false);
			const [discoverOutcome, setDiscoverOutcome] = useState(null);
			const [probing, setProbing] = useState(false);
			const [probeResults, setProbeResults] = useState(null);
			const [fullCatalog, setFullCatalog] = useState(null);
			const [pruneSummary, setPruneSummary] = useState(null);
			const writable = state.status === "ready" && state.writable;

			useEffect(() => {
				if (state.status !== "ready") return;
				setDraft((current) => ({ ...defaultDraft(), ...clone(state.value) }));
				setOutcome(null);
			}, [state.revision, state.status]);

			const savedKeys = state.status === "ready" && Array.isArray(state.value?.apiKeys) ? state.value.apiKeys : [];
			useEffect(() => {
				const refs = [...new Set(savedKeys.map((key) => key.env).filter((ref) => REF_GRAMMAR.test(ref)))];
				if (refs.length === 0) { setCredentialInfo({}); return }
				let cancelled = false;
				credentials.describe(refs)
					.then((response) => { if (!cancelled && response.ok) setCredentialInfo(response.value) })
					.catch(() => {});
				return () => { cancelled = true };
			}, [state.revision, savedKeys]);

			if (state.status === "loading") {
				return jsx("p", { style: note, children: t("loading") });
			}
			if (state.status === "unavailable") {
				return jsx("p", { style: note, children: t("unavailable") });
			}

			const dirty = JSON.stringify(draft) !== JSON.stringify({ ...defaultDraft(), ...state.value });
			const invalid = numberInvalid(draft);
			const update = (field, value) => setDraft((current) => ({ ...current, [field]: value }));

			const refreshCredentials = async () => {
				const refs = [...new Set(savedKeys.map((key) => key.env).filter((ref) => REF_GRAMMAR.test(ref)))];
				if (refs.length === 0) return;
				try {
					const response = await credentials.describe(refs);
					if (response.ok) setCredentialInfo(response.value);
				} catch { /* the badge simply stays stale on a failed refresh */ }
			};

			// The endpoint the Host itself falls back to: sending it keeps a discovery
			// request valid even when the field has never been typed or saved.
			const effectiveBaseURL = () => {
				const typed = typeof draft.baseURL === "string" ? draft.baseURL.trim() : "";
				if (typed.length > 0) return typed;
				const saved = state.status === "ready" && typeof state.value?.baseURL === "string" ? state.value.baseURL.trim() : "";
				return saved.length > 0 ? saved : DEFAULT_BASE_URL;
			};

			const toCatalog = (list) => list
				.filter((model) => model !== null && typeof model === "object" && typeof model.id === "string" && model.id.length > 0)
				.map((model) => ({
					id: model.id,
					name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
					...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
					...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
				}));

			// One bounded pass over the given ids; the Host answers with ids, verdicts,
			// and milliseconds only — never a key.
			const runProbe = async (ids) => {
				try {
					const response = await fetch(PROBE_ROUTE, {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ models: ids }),
					});
					if (!response.ok) return { error: `HTTP ${response.status}`, results: [] };
					return await response.json();
				} catch (error) {
					return { error: String(error?.message ?? error), results: [] };
				}
			};

			// Drop only what a verdict PROVES unusable. Rate limiting and transport
			// faults prove nothing about a model, so they stay for a later retest.
			const pruneCatalog = (catalog, results) => {
				const dropped = new Set((results ?? [])
					.filter((result) => result && result.ok === false && UNUSABLE_STATUSES.includes(result.status))
					.map((result) => result.id));
				return catalog.filter((model) => !dropped.has(model.id));
			};

			const summarize = (catalog, kept, results) => ({
				total: catalog.length,
				kept: kept.length,
				usable: (results ?? []).filter((result) => result?.ok === true).length,
				uncertain: kept.filter((model) => !(results ?? []).some((result) => result?.id === model.id && result.ok === true)).length,
			});

			// Fetch the catalog straight from the endpoint through the Host discovery
			// Remote, then find out which entries this key can actually reach. The
			// listing is a plain OpenAI-style catalog: it carries no free/paid flag and
			// mixes in non-chat models, so "usable" can only be established by calling
			// each one. Whatever fails outright is dropped; the rest is kept.
			const discover = async () => {
				if (typeof discoverModels !== "function") return;
				setDiscovering(true);
				setDiscoverOutcome(null);
				setPruneSummary(null);
				setProbing(true);
				setProbeResults(null);
				try {
					const response = await discoverModels({ baseURL: effectiveBaseURL() });
					if (!response.ok) {
						setDiscoverOutcome({ kind: "error", message: response.error?.message ?? response.error?.code ?? "refused" });
						return;
					}
					const catalog = toCatalog(Array.isArray(response.value) ? response.value : []);
					setFullCatalog(catalog);
					setDiscoverOutcome({ kind: "ok", count: catalog.length });
					if (catalog.length === 0) return;
					setDraft((current) => ({ ...current, models: catalog }));
					const probe = await runProbe(catalog.map((model) => model.id));
					setProbeResults(probe);
					const kept = pruneCatalog(catalog, probe.results);
					// Nothing answered at all is a key/quota fact, not a catalog fact: keep the
					// fetched list rather than wiping it, so the page can never lock itself out.
					if (kept.length > 0) setDraft((current) => ({ ...current, models: kept }));
					setPruneSummary({ ...summarize(catalog, kept, probe.results), emptied: kept.length === 0 });
				} catch (error) {
					setDiscoverOutcome({ kind: "error", message: String(error?.message ?? error) });
				} finally {
					setDiscovering(false);
					setProbing(false);
				}
			};

			// Ask the Host to latency-test every catalog model in one bounded pass;
			// the response carries ids, verdicts, and milliseconds only.
			const testModels = async () => {
				setProbing(true);
				setProbeResults(null);
				try {
					setProbeResults(await runProbe(draft.models.map((model) => model.id).filter((id) => typeof id === "string" && id.length > 0)));
				} finally {
					setProbing(false);
				}
			};

			// Re-apply the drop rule to the current list using the last verdicts, and
			// undo it by restoring the untouched catalog from the last fetch.
			const keepOnlyUsable = () => {
					const results = Array.isArray(probeResults?.results) ? probeResults.results : [];
					if (results.length === 0) return;
					const source = fullCatalog ?? draft.models;
					const kept = pruneCatalog(source, results);
					if (kept.length === 0) {
						// Never trade a full catalog for an empty one — an all-fail pass is a
						// credential/quota signal. Report it and leave the list untouched.
						setPruneSummary({ ...summarize(source, kept, results), emptied: true });
						return;
					}
					setDraft((current) => ({ ...current, models: kept }));
					setPruneSummary(summarize(source, kept, results));
				};

			const restoreAllModels = () => {
				const source = fullCatalog ?? draft.models;
				setDraft((current) => ({ ...current, models: source }));
				setPruneSummary(null);
			};

			const storeKey = async (ref) => {
				const value = (keyValues[ref] ?? "").trim();
				if (value.length === 0 || !REF_GRAMMAR.test(ref)) { setKeyOutcome("refused"); return }
				try {
					const response = await credentials.set(ref, value);
					setKeyOutcome(response.ok ? "stored" : "failed");
					if (response.ok) setKeyValues((current) => ({ ...current, [ref]: "" }));
					await refreshCredentials();
					// A stored key is all the setup the dynamic catalog needs: pull the list now.
					if (response.ok) void discover();
				} catch { setKeyOutcome("failed") }
			};

			const clearKey = async (ref) => {
				try {
					const response = await credentials.unset(ref);
					setKeyOutcome(response.ok ? "cleared" : "clearFailed");
					await refreshCredentials();
				} catch { setKeyOutcome("clearFailed") }
			};

			const save = async () => {
				setBusy(true);
				setOutcome(null);
				const baseline = { ...defaultDraft(), ...state.value };
				const ops = [];
				for (const field of [...NUMBER_FIELDS, "baseURL", "streamUsage", "enableStatusTool"]) {
					if (JSON.stringify(draft[field]) !== JSON.stringify(baseline[field])) {
						ops.push({ op: "set", path: [field], value: draft[field] });
					}
				}
				if (JSON.stringify(draft.apiKeys) !== JSON.stringify(baseline.apiKeys)) {
					ops.push({ op: "set", path: ["apiKeys"], value: draft.apiKeys });
				}
				if (JSON.stringify(draft.models) !== JSON.stringify(baseline.models)) {
					ops.push({ op: "set", path: ["models"], value: draft.models });
				}
				try {
					const accepted = await form.mutate(ops, state.revision);
					setOutcome(accepted ? "saved" : "refused");
				} catch {
					setOutcome("failed");
				} finally {
					setBusy(false);
				}
			};

			return jsxs("div", { children: [
				jsxs("div", { style: section, children: [
					jsx("h4", { style: sectionTitle, children: t("sectionKeys") }),
					jsx("p", { style: hint, children: t("keysHint") }),
					...draft.apiKeys.map((key, index) => {
						const ref = (key.env ?? "").trim();
						const refBad = ref.length === 0 || !REF_GRAMMAR.test(ref);
						const info = credentialInfo[ref];
						return jsxs("div", { key: `k-${index}`, style: rowLine, children: [
							jsx(Input, {
								value: key.env ?? "", placeholder: t("keyEnv"), disabled: !writable, "aria-label": `${t("keyEnv")} ${index + 1}`,
								style: refBad ? invalidInput : undefined,
								onChange: (event) => setDraft((current) => {
									const apiKeys = current.apiKeys.map((entry, at) => at === index ? { ...entry, env: event.target.value } : entry);
									return { ...current, apiKeys };
								}),
							}),
							jsx(Input, {
								value: key.label ?? "", placeholder: t("keyLabel"), disabled: !writable, "aria-label": `${t("keyLabel")} ${index + 1}`,
								onChange: (event) => setDraft((current) => {
									const apiKeys = current.apiKeys.map((entry, at) => at === index ? { ...entry, label: event.target.value } : entry);
									return { ...current, apiKeys };
								}),
							}),
							jsx(Input, {
								type: "password", autoComplete: "off", value: keyValues[ref] ?? "", placeholder: t("keyValue"), "aria-label": `${t("keyValue")} ${index + 1}`,
								onChange: (event) => setKeyValues((current) => ({ ...current, [ref]: event.target.value })),
							}),
							jsx(Button, { variant: "outline", size: "sm", disabled: refBad, onClick: () => { void storeKey(ref); }, children: t("storeKey") }),
							jsx(Button, { variant: "ghost", size: "sm", disabled: info?.configured !== true, onClick: () => { void clearKey(ref); }, children: t("clearKey") }),
							jsx(Tag, { tone: info?.configured ? "info" : "neutral", children: info?.configured ? t("stored") : t("notStored") }),
							jsx(Button, {
								variant: "ghost", size: "sm", disabled: !writable, onClick: () => setDraft((current) => ({ ...current, apiKeys: current.apiKeys.filter((_, at) => at !== index) })),
								children: t("remove"),
							}),
						] });
					}),
					keyOutcome === "refused" ? jsx("p", { style: note, children: t("refInvalid") })
						: keyOutcome === "failed" ? jsx("p", { style: note, children: t("storeFailed") })
							: keyOutcome === "clearFailed" ? jsx("p", { style: note, children: t("clearFailed") }) : null,
					jsx(Button, {
						variant: "outline", size: "sm", disabled: !writable,
						onClick: () => setDraft((current) => ({ ...current, apiKeys: [...current.apiKeys, { env: "", label: "" }] })),
						children: t("addKey"),
					}),
				] }),
				jsxs("div", { style: section, children: [
					jsx("h4", { style: sectionTitle, children: t("sectionEndpoint") }),
					jsx("p", { style: hint, children: t("modelsHint") }),
					jsxs("div", { style: fieldBox, children: [
						jsx("label", { style: fieldLabel, children: t("baseURL") }),
						jsx(Input, {
							value: draft.baseURL ?? "", disabled: !writable, placeholder: "https://integrate.api.nvidia.com/v1",
							onChange: (event) => update("baseURL", event.target.value),
						}),
					] }),
					jsxs("div", { style: rowLine, children: [
						jsx(Button, {
							variant: "outline", size: "sm", disabled: !writable || discovering,
							onClick: () => { void discover(); }, children: discovering ? t("discovering") : t("discover"),
						}),
						jsx(Button, {
							variant: "outline", size: "sm", disabled: !writable || probing || draft.models.length === 0,
							onClick: () => { void testModels(); }, children: probing ? t("probing") : t("probe"),
						}),
						(probeResults?.results ?? []).length === 0 ? null : jsx(Button, {
							variant: "outline", size: "sm", disabled: !writable || probing,
							onClick: keepOnlyUsable, children: t("onlyUsable"),
						}),
						discoverOutcome === null ? null : jsx("span", { style: note, children: discoverOutcome.kind === "ok"
							? `${t("discovered")} ${discoverOutcome.count}`
							: `${t("discoverFailed")}: ${discoverOutcome.message}` }),
					] }),
					probing ? jsx("p", { style: note, children: t("probeHint") }) : null,
					pruneSummary === null ? null : jsxs("div", { style: rowLine, children: [
						jsx("span", { style: note, children: `${t("usableOf")} ${pruneSummary.usable}/${pruneSummary.total} · ${t("removedOf")} ${pruneSummary.total - pruneSummary.kept} · ${t("keptOf")} ${pruneSummary.kept}${pruneSummary.uncertain > 0 ? ` (${t("uncertainOf")} ${pruneSummary.uncertain})` : ""}` }),
						jsx(Button, { variant: "ghost", size: "sm", disabled: !writable, onClick: restoreAllModels, children: t("restoreAll") }),
					] }),
					pruneSummary === null ? null : jsx("p", { style: pruneSummary.emptied ? warnText : note, children: pruneSummary.emptied ? t("pruneAll") : t("prunedNote") }),
					draft.models.length === 0 ? jsx("p", { style: note, children: t("modelsEmpty") }) : jsx("div", { style: modelList, children: draft.models.map((model, index) => jsxs("div", { key: `m-${index}`, style: modelRow, children: [
						jsx("span", { style: modelGrow, children: typeof model.name === "string" && model.name.length > 0 && model.name !== model.id ? `${model.name}  ·  ${model.id}` : model.id }),
						jsx(Button, {
							variant: "ghost", size: "sm", disabled: !writable,
							onClick: () => setDraft((current) => ({ ...current, models: current.models.filter((_, at) => at !== index) })),
							children: t("remove"),
						}),
					] })) }),
					probeResults === null ? null : probeResults.error !== undefined
						? jsx("p", { style: note, children: `${t("probeFailed")} (${probeResults.error})` })
						: jsxs("div", { style: modelList, children: [
							jsx("p", { style: note, children: `${t("probeAvailable")}: ${(probeResults.results ?? []).filter((result) => result.ok).length}/${(probeResults.results ?? []).length}` }),
							...(probeResults.results ?? []).map((result, index) => jsxs("div", { key: `p-${index}`, style: modelRow, children: [
								jsx("span", { style: result.ok ? dotOk : dotBad, children: "●" }),
								jsx("span", { style: modelGrow, children: result.id }),
								jsx("span", { style: latencyText, children: result.ok ? `${result.latencyMs} ms` : `${result.latencyMs ?? "-"} ms · ${result.error ?? "error"}` }),
							] })),
						] }),
				] }),
				jsxs("div", { style: section, children: [
					jsx("h4", { style: sectionTitle, children: t("sectionQuota") }),
					jsxs("div", { style: grid, children: [
						jsx(NumberField, { t, label: t("safeThreshold"), draft, field: "safeThreshold", setDraft, writable }),
						jsx(NumberField, { t, label: t("windowMs"), draft, field: "windowMs", setDraft, writable }),
						jsx(NumberField, { t, label: t("maxFailoverAttempts"), draft, field: "maxFailoverAttempts", setDraft, writable }),
						jsx(NumberField, { t, label: t("allUnavailableWaitMs"), draft, field: "allUnavailableWaitMs", setDraft, writable }),
					] }),
				] }),
				jsxs("div", { style: section, children: [
					jsx("h4", { style: sectionTitle, children: t("sectionTimeouts") }),
					jsxs("div", { style: grid, children: [
						jsx(NumberField, { t, label: t("rateLimitCooldownMs"), draft, field: "rateLimitCooldownMs", setDraft, writable }),
						jsx(NumberField, { t, label: t("rateLimitCooldownMaxMs"), draft, field: "rateLimitCooldownMaxMs", setDraft, writable }),
						jsx(NumberField, { t, label: t("authErrorCooldownMs"), draft, field: "authErrorCooldownMs", setDraft, writable }),
						jsx(NumberField, { t, label: t("quotaCooldownMs"), draft, field: "quotaCooldownMs", setDraft, writable }),
						jsx(NumberField, { t, label: t("requestTimeoutMs"), draft, field: "requestTimeoutMs", setDraft, writable }),
						jsx(NumberField, { t, label: t("streamIdleTimeoutMs"), draft, field: "streamIdleTimeoutMs", setDraft, writable }),
					] }),
				] }),
				jsxs("div", { style: section, children: [
					jsx("h4", { style: sectionTitle, children: t("sectionSwitches") }),
					jsx(Switch, {
						checked: draft.streamUsage !== false, label: t("streamUsage"), disabled: !writable,
						onChange: (next) => update("streamUsage", next),
					}),
					jsx(Switch, {
						checked: draft.enableStatusTool !== false, label: t("enableStatusTool"), disabled: !writable,
						onChange: (next) => update("enableStatusTool", next),
					}),
					jsxs("div", { style: rowLine, children: [
						jsx(Tag, { tone: "neutral", children: `${t("routeId")}: ${state.value?.provider ?? "nvidia-router"}` }),
						jsx("span", { style: note, children: t("routeIdNote") }),
					] }),
				] }),
				writable ? null : jsx("p", { style: note, children: t("readonly") }),
				jsxs("div", { style: footer, children: [
					jsx(Button, {
						variant: "primary", disabled: !writable || busy || invalid || !dirty, onClick: () => { void save(); },
						children: t("save"),
					}),
					jsx(Button, {
						variant: "outline", disabled: !writable || busy || !dirty,
						onClick: () => { setDraft({ ...defaultDraft(), ...clone(state.value) }); setOutcome(null); },
						children: t("reset"),
					}),
					busy ? jsx("span", { style: note, children: t("busy") })
						: outcome === "saved" ? jsx("span", { style: note, children: t("saved") })
							: outcome === "refused" ? jsx("span", { style: note, children: t("refused") })
								: outcome === "failed" ? jsx("span", { style: note, children: t("failed") })
									: invalid ? jsx("span", { style: note, children: t("invalid") })
										: dirty ? jsx("span", { style: note, children: t("dirty") }) : null,
				] }),
			] });
		}

		function RowConfig({ view, form, credentials, discoverModels, t }) {
			if (view === "summary") return jsx("span", { children: t("summary") });
			if (form === undefined) return jsx("p", { style: note, children: t("unavailable") });
			return jsx(ConfigCard, { form, credentials, discoverModels, t });
		}

		function SettingsSection({ form, credentials, discoverModels, t }) {
			const state = useSyncExternalStore(form.subscribe, form.getSnapshot);
			return jsx(ConfigCard, { form: { state, mutate: form.mutate }, credentials, discoverModels, t });
		}

		// One key summarized by label and reference only — the value never rides here.
		function keyStatusText(key, t) {
			if (!key.configured) return t("healthKeyMissing");
			if (key.credentialError) return t("healthKeyAuth");
			if (key.cooling) return t("healthKeyCooling");
			return t("healthKeyOk");
		}

		// Conversation-header badge: the configured-key count plus the verdict
		// colour the Host health route computed. It polls on an interval and keeps
		// the last reading on a transient failure.
		function ApiHealthBadge({ t }) {
			const [status, setStatus] = useState(null);
			useEffect(() => {
				let live = true;
				const read = async () => {
					try {
						const response = await fetch(STATUS_ROUTE, { credentials: "same-origin" });
						if (!response.ok) return;
						const body = await response.json();
						if (live) setStatus(body);
					} catch { /* keep the previous reading */ }
				};
				void read();
				const timer = setInterval(() => { void read(); }, HEALTH_POLL_MS);
				return () => { live = false; clearInterval(timer); };
			}, []);
			const health = status === null ? "unknown" : status.health;
			const tone = health === "green" ? "var(--dsw-alias-state-success, #2e9e5b)"
				: health === "yellow" ? "var(--dsw-alias-state-warning, #d9a300)"
					: health === "red" ? "var(--dsw-alias-state-danger, #d5304f)" : "var(--dsw-alias-text-secondary, #8a8a8a)";
			const count = status === null ? "–" : String(status.keyCount);
			const detail = status === null ? t("loading") : [t("healthHint"), ...(status.keys ?? []).map((key) => `${key.label} (${key.credentialRef}): ${keyStatusText(key, t)}`)].join("\n");
			return jsxs("span", {
				title: `${t("healthLabel")}\n${detail}`,
				"aria-label": `${t("healthLabel")}: ${count}`,
				style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, lineHeight: 1, cursor: "default" },
				children: [
					jsx("span", { style: { width: 8, height: 8, borderRadius: "50%", background: tone, display: "inline-block", flex: "none" } }),
					jsx("span", { style: { fontVariantNumeric: "tabular-nums" }, children: count }),
				],
			});
		}

		exports.inject = ["slots", "locale", "remote", "remote.credentials", "remote.llm"];

		exports.apply = function apply(ctx) {
			const t = ctx.locale.bind(NS);
			const discoverModels = (request) => ctx.remote.llm.discoverModels(ENTRY_ID, request);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "llm-nvidia-router: client dictionaries");

			ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: ROW_KEY,
				locale: NS,
				label: () => t("summary"),
			}, (props) => jsx(RowConfig, { ...props, t, credentials: ctx.remote.credentials, discoverModels })));

			// The settings page owns its form: configForms serves the row's
			// namespace directly, so the page renders wherever the settings
			// shell mounts it, with no hand-off from the Plugins page. The
			// section follows the Host half: whileServed withdraws the nav
			// entry when this profile stops serving llm-nvidia-router.
			ctx.inject(["configForms"], (settingsCtx) => {
				const controller = settingsCtx.configForms.get(ENTRY_ID);
				const subscribe = (listener) => controller.subscribe(listener);
				const getSnapshot = () => controller.getSnapshot();
				const mutate = (ops, expectedRevision) => controller.mutate(ops, expectedRevision);
				settingsCtx.effect(() => settingsCtx.configForms.whileServed([ENTRY_ID], () =>
					settingsCtx.slots.inject("settings.section", () => settingsCtx.slots.register({
						name: "settings.section",
						id: SECTION_ID,
						order: SECTION_ORDER,
						label: () => t("nav"),
						locale: NS,
						inject: () => ({ form: { subscribe, getSnapshot, mutate }, credentials: ctx.remote.credentials, discoverModels }),
					}, SettingsSection))
				), "llm-nvidia-router: settings section");
			});

			// The conversation-header badge: configured-key count plus a
			// red/yellow/green verdict, read from the Host redacted health route.
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "nvidia-router-health",
				order: 30,
				locale: NS,
				label: () => t("healthLabel"),
			}, (props) => jsx(ApiHealthBadge, { ...props, t })));
		};

		return module.exports;
	}
});
