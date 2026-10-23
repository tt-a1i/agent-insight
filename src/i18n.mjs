/** Report chrome locale and branding helpers. Default product locale is zh. */

export const DEFAULT_LOCALE = 'zh';

function citedContextDetail(context, zh = false) {
  const metric = (value, label, unknown, approximate = false) => {
    if (value.observed === null) return unknown;
    const number = `${approximate ? (zh ? '约 ' : '~') : ''}${value.observed}`;
    const partial = value.recorded < value.sessions;
    const coverage = partial ? (zh ? `（${value.recorded}/${value.sessions} 个已定位会话有记录）` : ` (${value.recorded}/${value.sessions} resolved sessions recorded)`)
      : context.unresolved ? (zh ? '（已知小计）' : ' (known subtotal)') : '';
    return `${number} ${label}${coverage}`;
  };
  return [
    zh ? `${context.sessions} 个已定位会话` : `${context.sessions} resolved session${context.sessions === 1 ? '' : 's'}`,
    ...(context.unresolved ? [zh ? `${context.unresolved} 个会话引用未能确定` : `${context.unresolved} unresolved session reference${context.unresolved === 1 ? '' : 's'}`] : []),
    metric(context.userTurns, zh ? '轮用户消息' : 'user turns', zh ? '用户消息轮数未知' : 'user turns unknown'),
    metric(context.toolErrors, zh ? '次工具错误' : 'tool errors', zh ? '工具错误数未知' : 'tool errors unknown'),
    metric(context.durationMinutes, zh ? '分钟' : 'min', zh ? '时长未知' : 'duration unknown', true)
  ].join(' · ');
}

const EN_CLAUDE = {
  brandTitle: 'Claude Code Insights',
  htmlLang: 'en',
  numberLocale: 'en-US',
  eyebrow: 'Coding-agent usage insights',
  navAria: 'Report navigation',
  subtitle: (messages, sessions, discoveredSuffix, range) => `${messages} messages across ${sessions} sessions${discoveredSuffix} | ${range}`,
  noEligibleSessions: 'No eligible sessions',
  analyzer: (host, model) => `Analyzer ${host} / ${model}`,
  metrics: {
    Messages: 'Messages',
    Lines: 'Lines',
    Files: 'Files',
    Days: 'Days',
    'Msgs/Day': 'Msgs/Day'
  },
  tocAria: 'Report sections',
  toc: {
    whatYouWorkOn: 'What You Work On',
    howYouUse: 'How You Use CC',
    impressiveThings: 'Impressive Things',
    whereThingsGoWrong: 'Where Things Go Wrong',
    featuresToTry: 'Features to Try',
    newUsagePatterns: 'New Usage Patterns',
    onTheHorizon: 'On the Horizon',
    teamFeedback: 'Team Feedback'
  },
  sections: {
    atAGlance: 'At a Glance',
    whatsWorking: "What's working",
    whatsHindering: "What's hindering you",
    quickWins: 'Quick wins to try',
    ambitiousWorkflows: 'Ambitious workflows',
    whatYouWorkOn: 'What You Work On',
    whatYouWanted: 'What You Wanted',
    goals: 'Goals',
    topTools: 'Top Tools Used',
    languages: 'Languages',
    sessionTypes: 'Session Types',
    howYouUse: 'How You Use Claude Code',
    interactionUnavailable: 'Interaction analysis unavailable.',
    noKeyPattern: 'No key pattern available.',
    responseTime: 'User Response Time Distribution',
    medianAverage: (median, average) => `Median ${median}s · Average ${average}s`,
    multiClauding: 'Multi-Clauding (Parallel Sessions)',
    overlapPairs: 'Overlap pairs',
    sessionsInvolved: 'Sessions involved',
    messagesDuringOverlap: 'Messages during overlap',
    noParallel: 'No parallel session usage was detected; you typically work with one session at a time.',
    timeOfDay: 'User Messages by Time of Day',
    timezone: 'Timezone',
    toolErrors: 'Tool Errors Encountered',
    impressiveThings: 'Impressive Things You Did',
    whatHelpedMost: "What Helped Most (Claude's Capabilities)",
    primarySuccesses: 'Primary successes',
    outcomes: 'Outcomes',
    whereThingsGoWrong: 'Where Things Go Wrong',
    primaryFriction: 'Primary Friction Types',
    frictionTypes: 'Friction types',
    inferredSatisfaction: 'Inferred Satisfaction',
    existingFeatures: 'Existing CC Features to Try',
    claudeMdAdditions: 'Suggested CLAUDE.md Additions',
    featuresToTry: 'Features to Try',
    newWays: 'New Ways to Use Claude Code',
    onTheHorizon: 'On the Horizon',
    memorableMoment: 'A memorable moment',
    noQualitativeMoment: 'No qualitative moment was available.',
    evidenceIndex: 'Evidence index',
    session: 'Session',
    agent: 'Agent',
    date: 'Date',
    project: 'Project',
    noEvidenceSessions: 'No semantic evidence sessions.',
    readCoverage: 'Read coverage',
    source: 'Source',
    coverage: 'Coverage',
    found: 'Found',
    selected: 'Selected',
    limited: 'Limited',
    partial: 'Partial',
    skipped: 'Skipped',
    notes: 'Notes',
    noSourceProbes: 'No source probes ran.',
    analysisUnavailable: 'Analysis unavailable.',
    sectionUnavailable: 'This section is unavailable for the current coverage.',
    sectionFailed: (reason) => `This section is unavailable because its analysis did not complete (${reason}).`,
    noAnalyzableSessions: 'No sessions completed semantic analysis. These sections are unavailable; check Read coverage for missing sources, exclusions, and analyzer failures.',
    noSupportedItems: 'Analysis completed; no evidence-backed items to report in this section.',
    sessionsCount: (n) => `${n} sessions`,
    estimatedSessionsCount: (n) => `Model estimate: ${n} sessions`,
    projectAreaCountUnknown: 'Estimated session count: unknown',
    projectAreaCountsNote: 'Counts reflect model grouping of analyzed sessions. Citations are representative evidence, not a complete membership list.',
    morning: 'Morning',
    afternoon: 'Afternoon',
    evening: 'Evening',
    night: 'Night',
    noData: 'No data',
    noResponseTimeData: 'No response time data',
    noTimeData: 'No time data',
    noToolErrors: 'No tool errors'
  },
  audit: {
    assessmentContext: 'Assessment context',
    assessmentContextNote: 'Derived analysis, not original evidence. It describes only the context that was provided.',
    threeHardTruths: 'Priority findings',
    threeHardTruthsLead: 'Evidence-backed observations to examine first. Inferences are labelled separately from established patterns.',
    sourceValidationNote: 'Quotation checks establish message provenance, not that the model interpretation or causal claim is correct.',
    incomplete: (reason) => `User audit extension coverage is incomplete (${reason}). Check Read coverage to see which baseline sections are available.`,
    allFindings: 'All findings',
    allFindingsLead: 'Every remaining distinct issue, severity-ordered.',
    selfDefeating: 'Habits that undercut you',
    selfDefeatingLead: 'Recurring self-defeating phrases and patterns, deduplicated by intent.',
    strengths: 'Habits worth keeping',
    strengthsLead: 'Effective interaction habits that should survive the roast.',
    automation: 'Automation candidates',
    automationLead: 'Advisory only. Report generation never writes Skills, commands, templates, or host config. Copy the draft below if you want to create one yourself.',
    leverage: 'One highest-leverage change',
    noSupportedChange: 'Current evidence does not support an additional change; keep the practices that worked.',
    leverageLead: 'One move. No streaks, no trackers, no longitudinal homework.',
    primaryAction: 'This run’s one change',
    primaryActionLead: 'Do this one thing next. Everything else can wait.',
    primaryActionFallback: 'From At a Glance quick wins',
    betterAlternative: 'Better alternative:',
    trySaying: 'Try saying this next:',
    draftBody: 'Copyable draft:',
    habitCost: 'Cited-session context only (not an estimate of cost caused by this habit):',
    habitCostDetail: (context) => citedContextDetail(context),
    reopen: 'Reopen:',
    intent: 'Intent:',
    trigger: 'Trigger:',
    inputs: 'Inputs:',
    outputs: 'Outputs:',
    overAutomationRisk: 'Over-automation risk:',
    seenAbout: (n) => `Seen about ${n} time${n === 1 ? '' : 's'}.`,
    evidence: 'Evidence:',
    unavailable: 'unavailable'
  },
  efficiency: {
    heading: 'Session metadata signals',
    lead: 'Measured counts and heuristic flags for reviewing sessions. They do not establish user intent, inefficient work, or missing verification.',
    clarificationDensity: 'Short-turn share',
    clarificationDensityHint: 'Recorded user turns of at most 40 UTF-16 code units / total user turns. Brief approvals and clear requests also count; this does not measure goal clarity.',
    correctionRate: 'Correction-keyword share',
    correctionRateHint: 'Recorded user turns matching correction keywords / total user turns. Constraints and quoted text can match too; this does not establish a change of direction.',
    dominantToolShare: 'Dominant tool share',
    dominantToolShareHint: 'Most-used tool calls / total tool calls. General-purpose tools can dominate successful workflows.',
    turnsPerHour: 'Turns per hour',
    turnsPerHourHint: 'Total turns / elapsed session hours, including pauses. This is not active work time or a productivity score.',
    verificationGap: 'No verification keyword in tool names',
    verificationGapHint: 'Share of sessions whose last five tool names contain no verification keyword. Shell commands, tool outcomes, and manual checks are not inspected; actual verification remains unknown.',
    flagged: 'Sessions to inspect',
    noFlags: 'No sessions crossed the metadata thresholds; this is not a quality assessment.',
    corpus: 'Corpus',
    mean: 'Mean',
    median: 'Median',
    threshold: 'Threshold',
    value: 'Value',
    signal: 'Signal',
    coverage: 'Coverage',
    partial: 'Partial — some signals unavailable (parse layer may not have retained turn text for this source).',
  },
  tocCoach: {
    primaryAction: 'One change',
    hardTruths: 'Priority findings',
    leverage: 'Leverage',
    automation: 'Automation',
    evidence: 'Evidence'
  },
  timezones: {
    pt: 'PT (UTC-8)',
    et: 'ET (UTC-5)',
    london: 'London (UTC)',
    cet: 'CET (UTC+1)',
    tokyo: 'Tokyo (UTC+9)',
    custom: 'Local / custom UTC offset',
    prompt: 'UTC offset in hours'
  }
};

const EN_AGENT = {
  ...EN_CLAUDE,
  brandTitle: 'Agent Insight',
  eyebrow: 'Agent usage insights',
  sections: {
    ...EN_CLAUDE.sections,
    howYouUse: 'How You Use Agents',
    whatHelpedMost: 'What Helped Most',
    multiClauding: 'Parallel Sessions',
    existingFeatures: 'Features to Try',
    claudeMdAdditions: 'Suggested project-instruction additions',
    newWays: 'New Ways to Use Agents'
  },
  audit: {
    ...EN_CLAUDE.audit,
    incomplete: (reason) => `User audit extension coverage is incomplete (${reason}). Check Read coverage to see which baseline sections are available.`
  },
  toc: {
    ...EN_CLAUDE.toc,
    howYouUse: 'How You Use Agents'
  }
};

const ZH = {
  brandTitle: 'Agent Insight',
  htmlLang: 'zh-CN',
  numberLocale: 'zh-CN',
  eyebrow: 'Agent 使用洞察',
  navAria: '报告导航',
  subtitle: (messages, sessions, discoveredSuffix, range) => `${messages} 条消息 · ${sessions} 个会话${discoveredSuffix} | ${range}`,
  noEligibleSessions: '没有合格会话',
  analyzer: (host, model) => `分析器 ${host} / ${model}`,
  metrics: {
    Messages: '消息',
    Lines: '代码行',
    Files: '文件',
    Days: '天数',
    'Msgs/Day': '消息/天'
  },
  tocAria: '报告章节',
  toc: {
    whatYouWorkOn: '你在做什么',
    howYouUse: '使用方式',
    impressiveThings: '亮点工作流',
    whereThingsGoWrong: '问题出在哪',
    featuresToTry: '可尝试的能力',
    newUsagePatterns: '新用法',
    onTheHorizon: '展望',
    teamFeedback: '团队反馈'
  },
  sections: {
    atAGlance: '一瞥',
    whatsWorking: '进展顺利的地方',
    whatsHindering: '拖后腿的地方',
    quickWins: '可马上做的改进',
    ambitiousWorkflows: '更大胆的工作流',
    whatYouWorkOn: '你在做什么',
    whatYouWanted: '你想完成什么',
    goals: '目标',
    topTools: '常用工具',
    languages: '语言',
    sessionTypes: '会话类型',
    howYouUse: '你如何使用 Agent',
    interactionUnavailable: '暂无交互风格分析。',
    noKeyPattern: '暂无关键模式。',
    responseTime: '用户响应时间分布',
    medianAverage: (median, average) => `中位数 ${median}s · 平均 ${average}s`,
    multiClauding: '并行会话',
    overlapPairs: '重叠对数',
    sessionsInvolved: '涉及会话',
    messagesDuringOverlap: '重叠期间消息',
    noParallel: '未检测到并行会话；你通常一次只开一个会话。',
    timeOfDay: '一天中的消息时段',
    timezone: '时区',
    toolErrors: '遇到的工具错误',
    impressiveThings: '你做过的亮点',
    whatHelpedMost: '最有帮助的能力',
    primarySuccesses: '主要成功类型',
    outcomes: '结果',
    whereThingsGoWrong: '问题出在哪',
    primaryFriction: '主要摩擦类型',
    frictionTypes: '摩擦类型',
    inferredSatisfaction: '推断满意度',
    existingFeatures: '可尝试的能力',
    claudeMdAdditions: '建议写入的项目说明',
    featuresToTry: '可尝试的能力',
    newWays: '新的使用方式',
    onTheHorizon: '展望',
    memorableMoment: '一个难忘瞬间',
    noQualitativeMoment: '暂无定性亮点。',
    evidenceIndex: '证据索引',
    session: '会话',
    agent: 'Agent',
    date: '日期',
    project: '项目',
    noEvidenceSessions: '没有语义证据会话。',
    readCoverage: '读取覆盖',
    source: '来源',
    coverage: '覆盖',
    found: '发现',
    selected: '选用',
    limited: '截断',
    partial: '部分',
    skipped: '跳过',
    notes: '备注',
    noSourceProbes: '未执行来源探测。',
    analysisUnavailable: '分析不可用。',
    sectionUnavailable: '当前覆盖下此章节不可用。',
    sectionFailed: (reason) => `本节分析未完成，结论不可用（${reason}）。`,
    noAnalyzableSessions: '没有会话完成语义分析，相关章节不可用；请查看读取覆盖中的来源、排除原因和分析失败记录。',
    noSupportedItems: '已完成分析，本节没有证据支持的条目。',
    sessionsCount: (n) => `${n} 个会话`,
    estimatedSessionsCount: (n) => `模型估计：${n} 个会话`,
    projectAreaCountUnknown: '估计会话数：未知',
    projectAreaCountsNote: '数量来自模型对已分析会话的归类；引用是代表性证据，并非完整的归类清单。',
    morning: '上午',
    afternoon: '下午',
    evening: '晚上',
    night: '凌晨',
    noData: '暂无数据',
    noResponseTimeData: '暂无响应时间数据',
    noTimeData: '暂无时段数据',
    noToolErrors: '没有工具错误'
  },
  audit: {
    assessmentContext: '判断背景',
    assessmentContextNote: '这是分析摘要，不是原始证据；仅覆盖已提供的上下文。',
    threeHardTruths: '优先关注的发现',
    threeHardTruthsLead: '优先回看的高影响交互观察；推断与有重复证据的模式分别标注。',
    sourceValidationNote: '引文核验只确认原话和消息出处，不能证明模型解释或因果归因成立。',
    incomplete: (reason) => `用户审计扩展不完整（${reason}）。请按读取覆盖判断哪些基线章节可用。`,
    allFindings: '全部发现',
    allFindingsLead: '其余互不相同的问题，按严重度排序。',
    selfDefeating: '会拆台的习惯',
    selfDefeatingLead: '反复出现的自我拆台说法与模式，按意图去重。',
    strengths: '值得保留的习惯',
    strengthsLead: '经得起吐槽、仍应留下的有效交互习惯。',
    automation: '可自动化候选',
    automationLead: '仅供参考。生成报告不会写入 Skill、命令、模板或宿主配置。需要时可自行复制下方草稿。',
    leverage: '一个最高杠杆改动',
    noSupportedChange: '当前没有证据支持额外改动；保留已验证有效的做法。',
    leverageLead: '只改一件事。没有连续打卡、追踪器或长期作业。',
    primaryAction: '这次只改这一件',
    primaryActionLead: '下次先做这一件事。其余可以稍后。',
    primaryActionFallback: '来自「一瞥」里的可马上做的改进',
    betterAlternative: '更好的做法：',
    trySaying: '下次可以这样说：',
    draftBody: '可复制草稿：',
    habitCost: '引用会话背景（这些统计不能估算该习惯导致的成本）：',
    habitCostDetail: (context) => citedContextDetail(context, true),
    reopen: '回开：',
    intent: '意图：',
    trigger: '触发：',
    inputs: '输入：',
    outputs: '输出：',
    overAutomationRisk: '过度自动化风险：',
    seenAbout: (n) => `大约出现 ${n} 次。`,
    evidence: '证据：',
    unavailable: '不可用'
  },
  efficiency: {
    heading: '会话统计信号',
    lead: '以下计数和启发式标记帮助定位值得回看的会话，不能单独证明用户意图、工作低效或缺少验证。',
    clarificationDensity: '短消息占比',
    clarificationDensityHint: '长度不超过 40 个 UTF-16 代码单元的记录用户轮 / 总用户轮。简短确认和清晰请求也会计入，不能据此判断目标模糊。',
    correctionRate: '纠正关键词命中率',
    correctionRateHint: '命中纠正关键词的记录用户轮 / 总用户轮。约束和引用也可能命中，不能据此判断方向反复。',
    dominantToolShare: '主导工具占比',
    dominantToolShareHint: '调用最多的工具次数 / 总工具调用。通用工具在成功工作流中也可能占很高比例。',
    turnsPerHour: '每小时轮次',
    turnsPerHourHint: '总轮次 / 会话经过时长（小时），包含暂停时间，不代表实际工作时长或生产效率。',
    verificationGap: '工具名未命中验证关键词',
    verificationGapHint: '末尾 5 次工具名均未命中验证关键词的会话占比。未检查 shell 命令、工具结果或人工验收，是否实际完成验证仍未知。',
    flagged: '值得回看的会话',
    noFlags: '没有会话越过统计阈值，这不代表工作质量已获验证。',
    corpus: '整体',
    mean: '均值',
    median: '中位数',
    threshold: '阈值',
    value: '值',
    signal: '信号',
    coverage: '覆盖',
    partial: '部分——某些信号不可用（解析层可能未为该来源保留轮次文本）。',
  },
  tocCoach: {
    primaryAction: '只改一件',
    hardTruths: '优先发现',
    leverage: '杠杆改动',
    automation: '自动化',
    evidence: '证据'
  },
  timezones: {
    pt: 'PT (UTC-8)',
    et: 'ET (UTC-5)',
    london: 'London (UTC)',
    cet: 'CET (UTC+1)',
    tokyo: 'Tokyo (UTC+9)',
    custom: '本地 / 自定义 UTC 偏移',
    prompt: 'UTC 偏移（小时）'
  }
};

export function normalizeLocale(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LOCALE;
  const locale = String(value).trim().toLowerCase().replace('_', '-');
  if (locale === 'zh' || locale === 'zh-cn' || locale.startsWith('zh-')) return 'zh';
  if (locale === 'en' || locale === 'en-us' || locale.startsWith('en-')) return 'en';
  throw new Error('--locale must be zh or en.');
}

export function useClaudeParityChrome(report) {
  return report?.semantic?.analyzer?.host === 'claude'
    || report?.parityProfile === 'claude-2.1.206';
}

export function reportChrome(report, { prose = false } = {}) {
  if (!prose && useClaudeParityChrome(report)) {
    return { brandTitle: EN_CLAUDE.brandTitle, locale: 'en', htmlLang: 'en', t: EN_CLAUDE, claudeParity: true };
  }
  const locale = normalizeLocale(report?.locale);
  const t = locale === 'zh' ? ZH : EN_AGENT;
  return { brandTitle: t.brandTitle, locale, htmlLang: t.htmlLang, t, claudeParity: false };
}

export function proseLocaleInstruction(locale) {
  if (normalizeLocale(locale) !== 'zh') return '';
  return '\nWrite all human-readable prose values in Simplified Chinese. Keep JSON keys and taxonomy enum values unchanged.';
}

export function appendProseLocale(prompt, locale) {
  return `${prompt}${proseLocaleInstruction(locale)}`;
}

// Only translate values within their declared taxonomy domain. Free-form labels
// (including tool and project names) must never pass through these mappings.
const TAXONOMY_ZH = {
  auditCategory: { goal_clarity: '目标清晰度', scope_boundaries: '范围边界', acceptance_criteria: '验收标准', premature_execution: '过早执行', vague_broad_commands: '宽泛指令', fragmented_requirements: '需求碎片化', direction_churn: '反复改变方向', repeated_instructions: '重复指令', over_control: '过度控制', outsourced_decisions: '委托决策', unverifiable_requests: '无法验证的请求', phase_confusion: '阶段混淆', correction_quality: '纠正质量', convergence: '收敛', freeform: '其他观察' },
  severity: { critical: '严重', high: '高', medium: '中', low: '低' },
  evidencePosture: { observed_instance: '本次直接观察', established_pattern: '有重复证据的模式', bold_inference: '大胆推断', limited_evidence: '证据有限' },
  sessionTypes: { single_task: '单一任务', multi_task: '多个任务', iterative_refinement: '迭代完善', exploration: '探索', quick_question: '简短问答' },
  goalCategories: { debug_investigate: '调试排查', implement_feature: '实现功能', fix_bug: '修复缺陷', write_script_tool: '编写脚本或工具', refactor: '重构', configure: '配置', create_pr_commit: '创建提交或PR', analyze_data: '分析数据', understand_codebase: '理解代码', tests: '测试', docs: '文档', deploy_infra: '部署基础设施', warmup_minimal: '简单预热' },
  outcomes: { fully_achieved: '完全达成', mostly_achieved: '大体达成', partially_achieved: '部分达成', not_achieved: '未达成', unclear_from_transcript: '记录不足以判断' },
  primarySuccesses: { none: '无', fast_accurate_search: '快速准确检索', correct_code_edits: '正确修改代码', good_explanations: '清晰解释', proactive_help: '主动协助', multi_file_changes: '多文件修改', good_debugging: '有效调试' },
  helpfulness: { unhelpful: '无帮助', slightly_helpful: '略有帮助', moderately_helpful: '有一定帮助', very_helpful: '很有帮助', essential: '关键帮助' },
  satisfaction: { frustrated: '受挫', dissatisfied: '不满意', likely_satisfied: '可能满意', satisfied: '满意', happy: '高兴', unsure: '不确定', neutral: '中性', delighted: '非常满意' },
  friction: { misunderstood_request: '误解请求', wrong_approach: '方向错误', buggy_code: '代码缺陷', rejected_action: '操作被拒绝', blocked: '受阻', stopped_early: '过早停止', wrong_file_location: '文件位置错误', excessive_changes: '改动过多', slow_verbose: '缓慢或冗长', tool_failed: '工具失败', user_unclear: '用户表达不明', external_issue: '外部问题' },
  multiClauding: { overlapEvents: '重叠会话对', sessionsInvolved: '涉及会话数', userMessagesDuring: '重叠期间用户消息数' },
  coverage: { available: '可用', empty: '无记录', partial: '部分', not_found: '未找到', unavailable: '不可用', experimental: '实验性支持' },
  toolErrorCategories: { 'Command Failed': '命令失败', 'User Rejected': '用户拒绝', 'Edit Failed': '编辑失败', 'File Changed': '文件已变化', 'File Too Large': '文件过大', 'File Not Found': '文件未找到', Other: '其他' },
  analysisStatus: { complete: '完整', partial: '部分', unavailable: '不可用' },
  automationType: { Skill: 'Skill', command: '命令', prompt_template: '提示词模板', automation: '自动化' }
};

export function taxonomyLabel(domain, value, locale = DEFAULT_LOCALE) {
  const mapping = Object.hasOwn(TAXONOMY_ZH, domain) ? TAXONOMY_ZH[domain] : null;
  if (!mapping || !Object.hasOwn(mapping, value)) return value;
  if (normalizeLocale(locale) === 'zh') return mapping[value];
  if (domain === 'multiClauding') return { overlapEvents: 'Overlap pairs', sessionsInvolved: 'Sessions involved', userMessagesDuring: 'User messages during overlap' }[value];
  return String(value).replaceAll('_', ' ');
}

export function tokenUsageLabels(locale) {
  return normalizeLocale(locale) === 'zh' ? {
    heading: 'Token 用量覆盖', subtotal: '已记录小计', detail: '记录完整性', kind: '用量类型',
    input: '输入 Token', output: '输出 Token', cacheRead: '缓存读取 Token', cacheWrite: '缓存写入 Token',
    complete: '完整记录', partial: '部分记录', unavailable: '未提供可核实用量', notProvided: '未提供', observedZero: '0（已记录为零）',
    total: '完整总量', unknownTotal: '无法确定，未将缺失用量当作零',
    sessionSummary: (s) => `${s.total} 个会话：${s.complete} 个完整记录，${s.partial} 个部分记录，${s.unavailable} 个未提供用量。`,
    recordSummary: (provided, missing, untracked, partial) => `${provided} 条已提供；${missing} 条已知记录缺失；${untracked} 个会话未提供；${partial} 个会话部分提供`,
    localOnly: '仅反映本地会话记录，不是账号账单。',
    incomplete: '未提供用量的会话仍可能消耗 Token，已记录小计可能偏低。缺失记录数仅统计已知记录，不推测未知会话的记录数。',
    activeBranch: (n) => `${n} 个会话只覆盖当前分支；Pi 的用量仅统计当前分支。`,
    selectedTranscript: (n) => `${n} 个会话采用选定会话记录的范围。`,
    unknownScope: (n) => `${n} 个会话的用量统计范围未说明。`
  } : {
    heading: 'Token usage coverage', subtotal: 'Recorded subtotal', detail: 'Completeness', kind: 'Usage type',
    input: 'Input tokens', output: 'Output tokens', cacheRead: 'Cache-read tokens', cacheWrite: 'Cache-write tokens',
    complete: 'Fully reported', partial: 'Partially reported', unavailable: 'No verifiable usage provided', notProvided: 'Not provided', observedZero: '0 (reported zero)',
    total: 'Complete total', unknownTotal: 'Unknown; missing usage has not been counted as zero',
    sessionSummary: (s) => `${s.total} sessions: ${s.complete} fully reported, ${s.partial} partially reported, ${s.unavailable} without usage.`,
    recordSummary: (provided, missing, untracked, partial) => `${provided} records provided; ${missing} known records missing; ${untracked} sessions unreported; ${partial} sessions partially reported`,
    localOnly: 'Reflects local session records, not an account bill.',
    incomplete: 'Sessions without usage may still consume tokens, so recorded subtotals may undercount usage. Missing-record counts cover known records only; no record count is guessed for unknown sessions.',
    activeBranch: (n) => `${n} sessions cover only the active branch; Pi usage includes only the current branch.`,
    selectedTranscript: (n) => `${n} sessions cover the selected transcript.`,
    unknownScope: (n) => `${n} sessions have an unspecified usage scope.`
  };
}

/** Show verified citation coverage; retain older prose as explicitly unverified. */
export function automationFrequencyLabel(item, locale = DEFAULT_LOCALE) {
  const coverage = evidenceCoverageLabel(item, locale);
  if (coverage) return coverage;
  if (!item.frequency) return '';
  return normalizeLocale(locale) === 'zh' ? `历史频率描述（未核验）：${item.frequency}` : `Legacy frequency description (unverified): ${item.frequency}`;
}

/** Counts describe validated quoted messages, never the frequency of a habit. */
export function evidenceCoverageLabel(item, locale = DEFAULT_LOCALE) {
  const { evidenceMessageCount: messages, evidenceSessionCount: sessions } = item;
  if (!Number.isSafeInteger(messages) || messages < 0 || !Number.isSafeInteger(sessions) || sessions < 0) return '';
  const zh = normalizeLocale(locale) === 'zh';
  const fmt = (n) => new Intl.NumberFormat(zh ? 'zh-CN' : 'en-US').format(n);
  return zh ? `已核验引用覆盖：${fmt(messages)} 条引用用户消息，来自 ${fmt(sessions)} 个会话` : `Verified citation coverage: ${fmt(messages)} cited user message${messages === 1 ? '' : 's'} across ${fmt(sessions)} session${sessions === 1 ? '' : 's'}`;
}

export function evidenceNavigationLabels(locale) {
  return normalizeLocale(locale) === 'zh' ? {
    sessionSupport: '会话证据',
    supportScope: '会话级引用指向已保留的会话证据组，不代表组内每条消息都证明当前结论。消息编号是分析输入的索引，不是原始 JSONL 行号。',
    noReference: '未提供支持本条结论的会话引用。',
    missing: '未找到对应会话，无法跳转核查。',
    ambiguous: '会话标识不唯一，未猜测来源。',
    noGrounding: '已定位会话，但未提供可展示的消息级证据。',
    exactUnavailable: '未找到可匹配的消息级引文；保留原定位供核查。'
  } : {
    sessionSupport: 'Session evidence',
    supportScope: 'Session references lead to retained session evidence, not proof that every message supports this claim. Message numbers are analysis-input indexes, not raw JSONL line numbers.',
    noReference: 'No supporting session reference was provided for this claim.',
    missing: 'The referenced session was not found; no navigation target is available.',
    ambiguous: 'The session identifier is ambiguous; no source was guessed.',
    noGrounding: 'The session was located, but no message-level evidence was provided for display.',
    exactUnavailable: 'No matching message-level quotation was found; the original locator is retained for inspection.'
  };
}
