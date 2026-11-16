/**
 * Browser half of dsh-plugin-dbgpt: the `dbgpt` row's settings page on the
 * Plugins page. It edits the row's volatile fields through the shared
 * settings form and stores the custom API key in dsh's credential store, so
 * no key is written to a configuration file. Saving applies at once; the Host
 * half restarts DB-GPT when the model settings change.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-dbgpt',
  factory(require) {
    const React = require('react')
    const {
      SegmentedControl, SettingsForm, SettingsFormModel, SettingsSecretField, SettingsValueField,
      settingsNumberField, settingsTextField,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Settings namespace: the profile row id. */
    const NS = 'dbgpt'
    /** Plugins-page key of the row: `<package>#<row id>`. */
    const ROW_KEY = 'dsh-plugin-dbgpt#dbgpt'
    const LOCALE = 'dshPluginDbgpt'
    const DEFAULT_KEY_REF = 'DBGPT_LLM_API_KEY'

    const zh = {
      summary: '让 dsh 在需要查询数据时调用 DB-GPT',
      section_model: '模型',
      section_server: 'DB-GPT 服务',
      llmSource_label: '模型来源',
      llmSource_dsh: '复用 dsh 的 API',
      llmSource_custom: '单独配置',
      llmSource_dshHint: '使用 dsh 当前模型提供方的地址和 API Key。DB-GPT 走 OpenAI 兼容接口：/anthropic 结尾的地址会自动换成 /v1。',
      llmSource_customHint: 'DB-GPT 使用下面填写的地址、模型和 API Key，与 dsh 的设置互不影响。',
      llmModel_label: '模型名称',
      llmModel_dshHint: '留空表示使用 dsh 当前的默认模型。只支持 Anthropic 协议的模型（如 cl-op-5-5-a）不能用，请填 gpt-5.5、DeepSeek-V4-Pro-0813 等。',
      llmModel_customHint: '必填，例如 gpt-5.5。',
      llmBaseURL_label: 'API 地址',
      llmBaseURL_dshHint: '可选。填写后代替由 dsh 地址推算出的地址。',
      llmBaseURL_customHint: '必填，OpenAI 兼容地址，通常以 /v1 结尾。',
      apiKey_label: 'API Key',
      apiKey_hint: '保存在 dsh 的凭据存储中（凭据名 {ref}），不会写进配置文件。留空表示不修改。',
      apiKey_set: '已设置',
      apiKey_unset: '未设置',
      embeddingModel_label: 'Embedding 模型',
      embeddingModel_hint: 'DB-GPT 检索表结构和知识库时使用。',
      embeddingBaseURL_label: 'Embedding 地址',
      embeddingBaseURL_hint: '留空表示与模型使用同一个地址和 API Key。',
      dbgptHome_label: 'DB-GPT 目录',
      dbgptHome_hint: 'DB-GPT 项目所在的绝对路径；数据源和历史对话保存在其中的 pilot/ 目录。',
      port_label: '端口',
      port_hint: 'DB-GPT 网页和接口的端口，在网页里管理数据源。',
      invalidUrl: '请填写 http:// 或 https:// 开头的地址，或留空。',
      invalidPath: '请填写以 / 开头的绝对路径。',
      invalidPort: '请填写 1–65535 之间的整数。',
      overridden: '已修改',
      reset: '恢复默认',
      unavailable: 'DB-GPT 插件当前未启用，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '没有保存成功，修改已保留，请检查后重试。',
    }
    const en = {
      summary: 'Lets dsh call DB-GPT for data questions',
      section_model: 'Model',
      section_server: 'DB-GPT server',
      llmSource_label: 'Model source',
      llmSource_dsh: 'Reuse dsh\'s API',
      llmSource_custom: 'Separate',
      llmSource_dshHint: 'Uses the endpoint and API key of dsh\'s current model provider. DB-GPT speaks the OpenAI-compatible API: a URL ending in /anthropic becomes /v1.',
      llmSource_customHint: 'DB-GPT uses the endpoint, model, and API key below, independent of dsh.',
      llmModel_label: 'Model',
      llmModel_dshHint: 'Leave blank to use dsh\'s current default model. Models served only over the Anthropic API (such as cl-op-5-5-a) do not work; use gpt-5.5, DeepSeek-V4-Pro-0813, or similar.',
      llmModel_customHint: 'Required, for example gpt-5.5.',
      llmBaseURL_label: 'API URL',
      llmBaseURL_dshHint: 'Optional. Replaces the URL derived from dsh\'s endpoint.',
      llmBaseURL_customHint: 'Required. OpenAI-compatible URL, usually ending in /v1.',
      apiKey_label: 'API key',
      apiKey_hint: 'Stored in dsh\'s credential store as {ref}, never in a configuration file. Leave blank to keep it.',
      apiKey_set: 'Set',
      apiKey_unset: 'Not set',
      embeddingModel_label: 'Embedding model',
      embeddingModel_hint: 'Used by DB-GPT for schema retrieval and knowledge bases.',
      embeddingBaseURL_label: 'Embedding URL',
      embeddingBaseURL_hint: 'Leave blank to use the model\'s URL and API key.',
      dbgptHome_label: 'DB-GPT directory',
      dbgptHome_hint: 'Absolute path of the DB-GPT checkout; its pilot/ directory holds datasources and chat history.',
      port_label: 'Port',
      port_hint: 'Port of the DB-GPT web page and API; manage datasources on that page.',
      invalidUrl: 'Enter a URL starting with http:// or https://, or leave blank.',
      invalidPath: 'Enter an absolute path starting with /.',
      invalidPort: 'Enter a whole number from 1 to 65535.',
      overridden: 'Changed',
      reset: 'Reset to default',
      unavailable: 'The DB-GPT plugin is not enabled, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The settings were not saved; your edits are kept for you to check and retry.',
    }

    /** Minimal observable snapshot the slot renderer binds as `useDbgptForm`. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
        set(next) { value = next; for (const listener of [...listeners]) listener() },
      }
    }

    /** A field accepting `parse(trimmed)` drafts; an empty draft clears the field. */
    function checkedTextField(field, accept) {
      return {
        ...settingsTextField(field),
        parse(text) {
          const trimmed = text.trim()
          if (trimmed === '') return { kind: 'clear' }
          return accept(trimmed) ? { kind: 'set', value: trimmed.replace(/\/+$/, '') || trimmed } : undefined
        },
      }
    }
    const isUrl = value => /^https?:\/\/\S+$/.test(value)
    const portField = {
      ...settingsNumberField('port'),
      parse(text) {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        const port = Number(trimmed)
        return Number.isInteger(port) && port >= 1 && port <= 65535 ? { kind: 'set', value: port } : undefined
      },
    }
    const VALUE_FIELDS = ['llmSource', 'llmModel', 'llmBaseURL', 'embeddingModel', 'embeddingBaseURL', 'dbgptHome', 'port']

    /** Stages the row's edits and the API key, and publishes the page snapshot. */
    class DbgptSettingsController {
      constructor(ctx) {
        this.ctx = ctx
        this.scope = ctx.configForms.get(NS)
        this.disposed = false
        this.credential = { ref: this.ref(), configured: false, writable: true }
        this.form = new SettingsFormModel(this.scope, [
          settingsTextField('llmSource'),
          settingsTextField('llmModel'),
          checkedTextField('llmBaseURL', isUrl),
          settingsTextField('embeddingModel'),
          checkedTextField('embeddingBaseURL', isUrl),
          checkedTextField('dbgptHome', value => value.startsWith('/')),
          portField,
        ], [{ field: 'apiKey', write: text => this.writeKey(text) }])
        this.store = createStore(this.project())
        this.unsubscribe = [
          this.form.bind(() => ({})).subscribe(() => { this.publish() }),
          this.scope.subscribe(() => { void this.readCredential() }),
        ]
        void this.readCredential()
      }

      /** @returns {string} the credential reference the custom source reads. */
      ref() {
        const value = this.scope.getSnapshot().value
        return typeof value?.llmApiKeyEnv === 'string' && value.llmApiKeyEnv !== '' ? value.llmApiKeyEnv : DEFAULT_KEY_REF
      }

      project() {
        const state = { ...this.form.shell(), apiKey: { ...this.form.field('apiKey'), ...this.credential } }
        for (const field of VALUE_FIELDS) state[field] = this.form.field(field)
        return state
      }

      publish() { if (!this.disposed) this.store.set(this.project()) }

      /** Ask the Host whether the key is stored; only presence crosses the wire. */
      async readCredential() {
        const ref = this.ref()
        let response
        try { response = await this.ctx.remote.credentials.describe([ref]) }
        catch (_unreachable) { return /* The badge keeps its last answer until the connection returns. */ }
        if (this.disposed || response?.ok !== true) return
        const view = response.value[ref]
        this.credential = { ref, configured: view?.configured ?? false, writable: view?.writable ?? true }
        this.publish()
      }

      /** Store the typed key and report whether the Host now holds it. */
      async writeKey(text) {
        const ref = this.ref()
        await this.ctx.remote.credentials.set(ref, text.trim())
        await this.readCredential()
        return this.credential.ref === ref && this.credential.configured
      }

      face() { return { hooks: { dbgptForm: this.store }, ...this.form.actions() } }

      dispose() {
        this.disposed = true
        for (const off of this.unsubscribe) off()
        this.form.dispose()
      }
    }

    const headingStyle = { margin: '8px 0 0', fontSize: 13, fontWeight: 600 }
    const hintStyle = { margin: 0, fontSize: 12, opacity: 0.7 }

    /** The row page: model source, model fields, and the DB-GPT server fields. */
    function DbgptSettings(props) {
      const { t } = props
      const state = props.useDbgptForm(snapshot => snapshot)
      if (props.view === 'summary') return t('summary')
      const disabled = !state.writable || state.saving
      const custom = state.llmSource.text === 'custom'
      const mode = custom ? 'customHint' : 'dshHint'
      const value = (field, extra = {}) => h(SettingsValueField, {
        id: `dbgpt-config-${field}`,
        label: t(`${field}_label`),
        hint: extra.hint ?? t(`${field}_hint`),
        invalidLabel: extra.invalid ?? t('invalidUrl'),
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        disabled,
        ...state[field],
        ...extra.numeric === true ? { numeric: true } : {},
        ...extra.placeholder === undefined ? {} : { placeholder: extra.placeholder },
        onEdit: (text) => { props.edit(field, text) },
        onReset: () => { props.resetField(field) },
      })
      return h(SettingsForm, {
        labels: { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') },
        state,
        onSave: props.save,
        onDiscard: props.discard,
      },
      h('h4', { style: headingStyle }, t('section_model')),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('span', { style: { fontSize: 13 } }, t('llmSource_label')),
        h(SegmentedControl, {
          id: 'dbgpt-config-llmSource',
          label: t('llmSource_label'),
          value: custom ? 'custom' : 'dsh',
          options: [{ value: 'dsh', label: t('llmSource_dsh') }, { value: 'custom', label: t('llmSource_custom') }],
          disabled,
          onChange: (next) => { props.edit('llmSource', next) },
        }),
        h('p', { style: hintStyle }, t(`llmSource_${mode}`))),
      value('llmModel', { hint: t(`llmModel_${mode}`) }),
      value('llmBaseURL', { hint: t(`llmBaseURL_${mode}`), placeholder: 'https://modelservice.jdcloud.com/v1' }),
      custom
        ? h(SettingsSecretField, {
          id: 'dbgpt-config-apiKey',
          label: t('apiKey_label'),
          hint: t('apiKey_hint', { ref: state.apiKey.ref }),
          text: state.apiKey.text,
          configured: state.apiKey.configured,
          stateLabel: t(state.apiKey.configured ? 'apiKey_set' : 'apiKey_unset'),
          // The credential store accepts writes even when the settings document is read-only.
          disabled: !state.apiKey.writable || state.saving,
          onEdit: (text) => { props.edit('apiKey', text) },
        })
        : null,
      value('embeddingModel'),
      value('embeddingBaseURL'),
      h('h4', { style: headingStyle }, t('section_server')),
      value('dbgptHome', { invalid: t('invalidPath') }),
      value('port', { invalid: t('invalidPort'), numeric: true }))
    }

    return {
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.credentials'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE, { zh, en }), 'dbgpt: dictionaries')
        const controller = new DbgptSettingsController(ctx)
        ctx.effect(() => () => { controller.dispose() }, 'dbgpt: settings form')
        ctx.effect(() => ctx.remote.$on('credentials/reference-updated', (ref) => {
          if (ref === controller.ref()) void controller.readCredential()
        }), 'dbgpt: credential updates')
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: ROW_KEY, locale: LOCALE, inject: () => controller.face(),
        }, DbgptSettings))
      },
    }
  },
})
