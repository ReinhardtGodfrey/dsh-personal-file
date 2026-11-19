// 个人档案 · 客户端半边：设置左侧栏多一项「个人档案」，里面看档案和记忆库。
window.__ModuleLoader__.load({
  id: 'dsh-profile-keeper',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React
    const ENDPOINT = '/dsh-profile-keeper/overview'
    const BANS_ENDPOINT = '/dsh-profile-keeper/bans'

    const WEIGHT_COLOR = {
      5: { color: '#c08a00', background: 'rgba(192, 138, 0, 0.14)', border: '1px solid rgba(192, 138, 0, 0.35)' },
      4: { color: '#2f6fd0', background: 'rgba(47, 111, 208, 0.13)', border: '1px solid rgba(47, 111, 208, 0.32)' },
      3: { color: '#6b7280', background: 'rgba(107, 114, 128, 0.14)', border: '1px solid rgba(107, 114, 128, 0.3)' },
      2: { color: '#8a6bbf', background: 'rgba(138, 107, 191, 0.13)', border: '1px solid rgba(138, 107, 191, 0.3)' },
    }

    const S = {
      root: { padding: '4px 2px 12px', fontSize: 13, lineHeight: 1.55, color: 'inherit' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
      title: { fontSize: 15, fontWeight: 600 },
      sub: { fontSize: 12, opacity: 0.65, marginTop: 2 },
      btn: {
        fontSize: 12,
        padding: '3px 10px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      tabs: { display: 'flex', gap: 6, margin: '10px 0 8px' },
      tab: {
        fontSize: 12,
        padding: '3px 12px',
        borderRadius: 999,
        border: '1px solid rgba(127,127,127,0.3)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      tabActive: { background: 'rgba(47, 111, 208, 0.16)', borderColor: 'rgba(47, 111, 208, 0.5)', fontWeight: 600 },
      filterRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 },
      chip: {
        fontSize: 12,
        padding: '2px 9px',
        borderRadius: 999,
        border: '1px solid rgba(127,127,127,0.28)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      chipActive: { background: 'rgba(127,127,127,0.16)', fontWeight: 600 },
      topic: { marginTop: 10 },
      topicHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        paddingBottom: 4,
        borderBottom: '1px solid rgba(127,127,127,0.22)',
      },
      topicName: { fontSize: 13, fontWeight: 600 },
      topicCount: { fontSize: 11, opacity: 0.6 },
      item: { padding: '6px 0 6px 2px' },
      itemHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      date: { fontSize: 11, opacity: 0.62, fontVariantNumeric: 'tabular-nums', minWidth: 72 },
      badge: { fontSize: 10, padding: '0 6px', borderRadius: 4, lineHeight: '16px', fontWeight: 600 },
      text: { flex: '1 1 240px' },
      quote: { fontSize: 11, opacity: 0.55, marginTop: 2, paddingLeft: 2 },
      empty: { fontSize: 12, opacity: 0.6, padding: '16px 0' },
      error: {
        fontSize: 12,
        color: '#c0392b',
        background: 'rgba(192, 57, 43, 0.1)',
        border: '1px solid rgba(192, 57, 43, 0.3)',
        borderRadius: 6,
        padding: '8px 10px',
        marginTop: 8,
        whiteSpace: 'pre-wrap',
      },
      foot: { fontSize: 11, opacity: 0.55, marginTop: 12, display: 'flex', gap: 12, flexWrap: 'wrap' },
      banBox: {
        marginTop: 8,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid rgba(127,127,127,0.28)',
        background: 'rgba(127,127,127,0.06)',
      },
      banHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      actions: { display: 'flex', gap: 6, marginTop: 6 },
      pass: { fontSize: 12, padding: '3px 12px', borderRadius: 6, border: '1px solid rgba(47, 111, 208, 0.5)', background: 'rgba(47, 111, 208, 0.14)', color: 'inherit', cursor: 'pointer', fontWeight: 600 },
      drop: { fontSize: 12, padding: '3px 12px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      notice: { fontSize: 12, color: '#2f6fd0', marginTop: 8 },
    }

    function trim(text, max) {
      const s = String(text || '')
      return s.length > max ? s.slice(0, max - 1) + '…' : s
    }

    function Badge(props) {
      const weight = props.weight
      const palette = WEIGHT_COLOR[weight]
      if (!palette) return null
      return h('span', { style: Object.assign({}, S.badge, palette) }, weight + ' 分')
    }

    function MemoryItem(props) {
      const item = props.item
      return h(
        'div',
        { style: S.item },
        h(
          'div',
          { style: S.itemHead },
          h('span', { style: S.date }, item.date || '未记日期'),
          h(Badge, { weight: item.weight }),
          h('span', { style: S.text }, item.text),
        ),
        item.quote ? h('div', { style: S.quote }, '依据：' + trim(item.quote, 110)) : null,
      )
    }

    function Topic(props) {
      const topic = props.topic
      const filter = props.filter
      const wanted = filter
      const items = filter ? topic.items.filter((item) => item.weight === wanted) : topic.items
      if (!items.length) return null
      return h(
        'div',
        { style: S.topic },
        h(
          'div',
          { style: S.topicHead },
          h('span', { style: S.topicName }, topic.name),
          h('span', { style: S.topicCount }, items.length + ' 条'),
        ),
        items.map((item, i) => h(MemoryItem, { key: topic.name + '-' + i, item })),
      )
    }

    function ArchiveSection(props) {
      const section = props.section
      return h(
        'div',
        { style: S.topic },
        h(
          'div',
          { style: S.topicHead },
          h('span', { style: S.topicName }, section.title),
          h('span', { style: S.topicCount }, section.items.length + ' 条'),
        ),
        section.items.map((line, i) =>
          h(
            'div',
            { key: i, style: S.item },
            h('div', { style: S.itemHead }, h(Badge, { weight: 5 }), h('span', { style: S.text }, line)),
          ),
        ),
      )
    }

    function BanRow(props) {
      const item = props.item
      const palette = WEIGHT_COLOR[item.banWeight] || WEIGHT_COLOR[4]
      return h(
        'div',
        { style: S.banBox },
        h(
          'div',
          { style: S.banHead },
          h('span', { style: Object.assign({}, S.badge, palette) }, '禁令 ' + item.banWeight + ' 分'),
          h('span', { style: S.text }, item.line),
        ),
        item.quote ? h('div', { style: S.quote }, '依据：' + trim(item.quote, 110)) : null,
        h('div', { style: S.quote }, (item.session || '') + (item.time ? ' · ' + item.time : '')),
        h(
          'div',
          { style: S.actions },
          h(
            'button',
            { style: S.pass, disabled: props.busy, onClick: () => props.onDecide(item.line, 'approve') },
            '通过',
          ),
          h(
            'button',
            { style: S.drop, disabled: props.busy, onClick: () => props.onDecide(item.line, 'reject') },
            '驳回',
          ),
        ),
      )
    }

    function Page() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      const [view, setView] = useState('memory')
      const [filter, setFilter] = useState(0)
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)

      const decide = async (line, action) => {
        if (busy) return
        setBusy(true)
        setNotice('')
        try {
          const payload = action === 'approve' ? { approve: [line] } : { reject: [line] }
          const response = await fetch(BANS_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const json = await response.json()
          if (!response.ok || (json && json.ok === false)) throw new Error((json && json.error) || '接口返回 HTTP ' + response.status)
          setNotice(action === 'approve' ? '已通过，写进规则文件的「明确禁令」节。' : '已驳回，这条从待审清单删掉。')
          await load()
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      const load = async () => {
        setLoading(true)
        setError('')
        try {
          const response = await fetch(ENDPOINT, { cache: 'no-store' })
          if (!response.ok) throw new Error('接口返回 HTTP ' + response.status)
          const json = await response.json()
          if (!json || json.ok === false) throw new Error((json && json.error) || '数据格式不对')
          setData(json)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setLoading(false)
        }
      }

      useEffect(() => {
        load()
      }, [])

      const counts = (data && data.memory && data.memory.counts) || {}
      const total = (data && data.memory && data.memory.total) || 0

      const tab = (key, text) =>
        h(
          'button',
          {
            style: view === key ? Object.assign({}, S.tab, S.tabActive) : S.tab,
            onClick: () => setView(key),
          },
          text,
        )

      const chip = (key, text) =>
        h(
          'button',
          {
            style: filter === key ? Object.assign({}, S.chip, S.chipActive) : S.chip,
            onClick: () => setFilter(key),
          },
          text,
        )

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.head },
          h(
            'div',
            null,
            h('div', { style: S.title }, '个人档案'),
            h(
              'div',
              { style: S.sub },
              data
                ? '记忆库 ' + total + ' 条 · 5 分 ' + (counts[5] || 0) + ' · 4 分 ' + (counts[4] || 0) + ' · 3 分 ' + (counts[3] || 0) +
                    (data.archive ? ' ｜ 档案 ' + data.archive.count + ' 条' : '')
                : loading
                  ? '读取中…'
                  : '还没有读到数据',
            ),
          ),
          h('button', { style: S.btn, onClick: load, disabled: loading }, loading ? '刷新中…' : '刷新'),
        ),

        error
          ? h('div', { style: S.error }, error + '\n如果一直这样，重启一次 DSH 再刷新这一页。')
          : null,

        data
          ? h(
              'div',
              null,
              h(
                'div',
                { style: S.tabs },
                tab('memory', '记忆库'),
                tab('archive', '个人档案正文'),
                tab('bans', '禁令待审' + (data.bans && data.bans.count ? '（' + data.bans.count + '）' : '')),
              ),
              view === 'memory'
                ? h(
                    'div',
                    null,
                    h(
                      'div',
                      { style: S.filterRow },
                      chip(0, '全部'),
                      chip(5, '5 分'),
                      chip(4, '4 分'),
                      chip(3, '3 分'),
                    ),
                    (data.memory.topics || []).length
                      ? data.memory.topics.map((topic, i) => h(Topic, { key: i, topic, filter }))
                      : h('div', { style: S.empty }, '记忆库还是空的。等插件跑过一轮，这里会按主题分组出现条目。'),
                    notice ? h('div', { style: S.notice }, notice) : null,
                  )
                : view === 'archive'
                  ? (data.archive.sections || []).length
                    ? data.archive.sections.map((section, i) => h(ArchiveSection, { key: i, section }))
                    : h('div', { style: S.empty }, '档案文件还没有内容。')
                  : h(
                      'div',
                      null,
                      (data.bans && data.bans.items ? data.bans.items : []).length
                        ? (data.bans.items || []).map((item, i) => h(BanRow, { key: i, item, busy, onDecide: decide }))
                        : h('div', { style: S.empty }, '暂时没有等你审批的禁令。插件发现新禁令会先放进这里，不会直接写进规则。'),
                      h('div', { style: S.quote }, '通过 = 写进硬性规则文件的「明确禁令」节，之后每个会话都生效；驳回 = 这条直接丢掉。'),
                      notice ? h('div', { style: S.notice }, notice) : null,
                    ),
            )
          : null,

        data
          ? h(
              'div',
              { style: S.foot },
              h('span', null, '档案更新：' + (data.archive.modifiedAt || '—')),
              h('span', null, '记忆库更新：' + (data.memory.modifiedAt || '—')),
              data.lastRun && data.lastRun.at
                ? h('span', null, '上次运行：' + data.lastRun.at + '（' + (data.lastRun.status || '未知') + '）')
                : null,
              data.pending && data.pending.count ? h('span', null, '待确认 ' + data.pending.count + ' 条') : null,
              h('span', null, '读取于 ' + (data.generatedAt || '—')),
            )
          : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'personal-file',
            order: 52,
            label: () => '个人档案',
          },
          () => h(Page),
        ),
      )
    }

    module.exports = { inject: ['slots'], apply }
    return module.exports
  },
})
