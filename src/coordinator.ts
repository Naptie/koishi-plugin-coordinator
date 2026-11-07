import { Bot, Context, h, Service, Session } from 'koishi';

export interface GroupLink {
  _id: number;
  qqSelfId: string;
  qqGroupOpenid: string;
  onebotSelfId: string;
  onebotGroupId: string;
  source: 'metadata' | 'manual';
  createdAt: string;
  updatedAt: string;
}

interface OneBotGroup {
  group_id: number | string;
  group_name: string;
  member_count: number;
}

interface OneBotMember {
  user_id: number | string;
}

interface OneBotInternal {
  getGroupList(): Promise<OneBotGroup[]>;
  getGroupMemberList(groupId: number | string): Promise<OneBotMember[]>;
}

interface QQGroupInfo {
  group_openid: string;
  group_name: string;
  group_member_num: number;
}

interface QQGroupState {
  allow_proactive_msg: boolean;
  recv_msg_setting: 'all' | 'only_mention' | 'mention_and_context';
}

interface QQGroupSnapshot {
  at: number;
  info?: QQGroupInfo;
  state?: QQGroupState;
}

interface QQGroupInternal {
  getMe(): Promise<{ id: string; username: string; share_url?: string }>;
  getGuildInfo(groupOpenid: string): Promise<QQGroupInfo>;
  getGuildBotState(groupOpenid: string): Promise<QQGroupState>;
}

interface AdapterBot {
  selfId: string;
  status: number;
  platform?: string;
  hidden?: boolean;
  internal: unknown;
}

interface QQBotLike extends AdapterBot {
  user?: { name?: string };
  guildBot?: {
    internal: QQGroupInternal;
  };
  sendMessage(
    channelId: string,
    content: h.Fragment,
    referrer?: unknown,
    options?: unknown
  ): Promise<string[]>;
}

export interface CoordinatorLinkConfig {
  onebotGroupId: string;
  qqGroupOpenid: string;
  qqSelfId?: string;
}

export interface CoordinatorConfig {
  enabled?: boolean;
  /**
   * 是否在被抑制（suppress）的会话上拦截所有命令执行。默认开启：关联群组内
   * 官方侧会话只作为"发言通道"，命令一律由 OneBot 侧会话执行。
   */
  suppressCommands?: boolean;
  onebotSelfId?: string;
  qqSelfId?: string;
  officialRobotUin?: string;
  links?: CoordinatorLinkConfig[];
}

export interface CoordinatorRoute {
  receivePlatform: string;
  sendPlatform: string;
  canonicalChannelId: string;
  suppress: boolean;
  linked: boolean;
  onebotGroupId?: string;
  qqGroupOpenid?: string;
  qqSelfId?: string;
  officialSession?: Session;
  /**
   * 官方侧收到的同一消息的引用索引（message_scene.ext 里的 msg_idx，
   * REFIDX_...）。QQ 官方 message_reference 引用回复需要该索引，
   * 而非 ROBOT1.0_... 消息 id。
   */
  officialQuoteId?: string;
}

interface OneBotGroupRef {
  bot: AdapterBot;
  id: string;
  name: string;
  memberCount: number;
}

interface OfficialObservation {
  session: Session;
  /** 跨适配器内容匹配键：首位为规范化文本，其余来自使用方注册的提取器 */
  keys: string[];
  timestamp: number;
  /** 引用索引（msg_idx），用于官方 message_reference 引用回复 */
  msgIdx?: string;
}

const GROUP_INFO_TTL = 5 * 60 * 1000;
const NEGATIVE_TTL = 30 * 1000;
const MEMBER_TTL = 60 * 1000;
const UNLINKED_TTL = 30 * 60 * 1000;
/** 当前已安装发送拦截的 OneBot 机器人（模块级标记，跨插件重载保持幂等） */
const interceptedBots = new WeakSet<Bot>();
const PASSIVE_WINDOW = 5 * 60 * 1000 - 2000;
const PASSIVE_MATCH_WINDOW = 10 * 1000;
const MAX_RECENT_OFFICIAL = 20;
const OFFICIAL_SEND_RETRY_DELAYS = [300, 800];

const isRetryableOfficialError = (error: unknown) => {
  const errors = [
    error,
    ...(((error as { errors?: unknown[] } | undefined)?.errors ?? []) as unknown[])
  ];
  return errors.some((item) => {
    const value = item as {
      response?: { status?: number; data?: { code?: number; err_code?: number } };
    };
    const code = value.response?.data?.code ?? value.response?.data?.err_code;
    return code === 50035006 || (value.response?.status ?? 0) >= 500;
  });
};

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** 会话发送选项附带内部绕行标记：bot 级发送拦截看到后直接放行 */
type SessionSendOptions = Parameters<Session['send']>[1];
const bypassSendOptions = (options?: SessionSendOptions): SessionSendOptions =>
  ({ ...options, bypassSendRouting: true }) as SessionSendOptions;

const normalizeGroupName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

const normalizeMessageContent = (content: string) =>
  content
    .replace(/<at[^>]*\/?>/g, '')
    .replace(/<quote[^>]*>[\s\S]*?<\/quote>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** 官方机器人身份（uin 为空表示尚未成功解析） */
interface OfficialIdentity {
  at: number;
  uin?: string;
  name?: string;
}

/** QQ 官方消息事件原始负载中与本插件相关的字段 */
interface OfficialRawEvent {
  message_scene?: {
    ext?: string[];
  };
}

const MSG_IDX_PREFIX = 'msg_idx=';

/**
 * 提取官方消息事件的引用索引（msg_idx）：QQ 官方 message_reference 的
 * message_id 需要消息事件 message_scene.ext 里的 msg_idx（REFIDX_...），
 * 而非 ROBOT1.0_... 消息 id。
 */
const extractOfficialQuoteId = (session: Session): string | undefined => {
  const d = (session.event._data as { d?: OfficialRawEvent } | undefined)?.d;
  const ext = d?.message_scene?.ext;
  return ext
    ?.find((item) => typeof item === 'string' && item.startsWith(MSG_IDX_PREFIX))
    ?.slice(MSG_IDX_PREFIX.length);
};

/** 去除消息中的引用元素：官方发送失败回退时，避免引用元素再次触发同类错误 */
const stripQuote = (content: h.Fragment): h.Fragment =>
  h.normalize(content).filter((element) => element.type !== 'quote');

const stripMarkdown = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');

/**
 * OneBot 无法渲染 QQ 官方的 markdown/键盘元素。官方发送失败回退到 OneBot 时，
 * 把这些元素降级为纯文本；图片等 OneBot 可渲染的元素保留。
 */
export const degradeForOneBot = (content: h.Fragment): h.Fragment => {
  const elements = h.normalize(content);
  const output: h[] = [];

  const appendText = (text: string) => {
    if (!text) return;
    const last = output[output.length - 1];
    if (last?.type === 'text') {
      last.attrs.content += text;
    } else {
      output.push(h.text(text));
    }
  };

  const visit = (element: h) => {
    switch (element.type) {
      case 'text':
        appendText(element.attrs.content ?? '');
        return;
      case 'br':
        appendText('\n');
        return;
      case 'p':
        if (!output.length || !output[output.length - 1]?.attrs.content?.endsWith('\n')) {
          appendText('\n');
        }
        element.children.forEach(visit);
        appendText('\n');
        return;
      case 'at':
      case 'quote':
      case 'passive':
      case 'button':
        return;
      case 'qq:markdown': {
        const text = element.children.map((child) => child.toString()).join('');
        appendText(stripMarkdown(text));
        return;
      }
      case 'img':
      case 'image':
        output.push(element);
        return;
      default:
        element.children.forEach(visit);
    }
  };

  elements.forEach(visit);
  return output;
};

export class Coordinator extends Service<CoordinatorConfig> {
  static inject = ['database'];

  /** 额外的跨适配器内容匹配键提取器，由使用方注册（用于无文本内容的消息匹配） */
  private matchKeyExtractors: Array<(session: Session) => string | undefined> = [];
  private routes = new WeakMap<Session, CoordinatorRoute>();
  /**
   * koishi/cordis 在事件分发、中间件链与命令执行各层会产生共享同一 session.id
   * 的影子会话对象（对象身份不同），上面的 WeakMap 按对象身份索引，命令守卫
   * （command/before-execute）里必然查不到路由，导致官方侧会话不被抑制、指令
   * 重复执行。补充一份按 session.id 索引的路由表作为回退；条目数有上限，按
   * 插入顺序淘汰。
   */
  private routesById = new Map<number, CoordinatorRoute>();
  private originalSends = new Map<Bot, Bot['sendMessage']>();
  private linksByOpenid = new Map<string, GroupLink>();
  private linksByOnebot = new Map<string, GroupLink>();
  private pendingLinks = new Map<string, Promise<GroupLink>>();
  private onebotGroups: OneBotGroupRef[] = [];
  private onebotGroupsAt = 0;
  private onebotGroupsPromise?: Promise<void>;
  private qqGroupCache = new Map<string, QQGroupSnapshot>();
  private memberCache = new Map<string, { at: number; members: Set<string> }>();
  private recentOfficial = new Map<string, OfficialObservation[]>();
  private unlinkedOfficial = new Map<string, { at: number; info: QQGroupInfo; qqSelfId: string }>();
  private officialIdentity = new Map<string, OfficialIdentity>();
  private linksLoaded = false;
  private linksPromise?: Promise<void>;
  private started = false;

  constructor(ctx: Context, config: CoordinatorConfig) {
    super(ctx, 'coordinator');
    this.config = config;
    this.logger = ctx.logger('coordinator');
    this.ctx.model.extend(
      'groupLinks',
      {
        _id: 'integer',
        qqSelfId: 'string',
        qqGroupOpenid: 'string',
        onebotSelfId: 'string',
        onebotGroupId: 'string',
        source: 'string',
        createdAt: 'string',
        updatedAt: 'string'
      },
      {
        primary: '_id',
        autoInc: true
      }
    );
    // 先于命令执行解析群组映射：OneBot 收到的消息需要在这里挂上官方发送通道，
    // 官方机器人收到的同一消息的命令则由命令守卫跳过。
    this.ctx.middleware(async (session, next) => {
      await this.prepare(session);
      return next();
    }, true);
    // 命令守卫：命令执行路径上的 session 是事件会话的影子克隆（共享
    // session.id，对象身份不同）。这里调用 prepare 把路由写入按 session.id
    // 索引的路由表，确保克隆对象也能解析路由；是否抑制、最终发送通道均由
    // 路由决定，发送通道裁决在 bot 级发送拦截（installSendIntercept）完成。
    this.ctx.before('command/execute', async (argv) => {
      const session = argv.session;
      if (!session || (session.platform !== 'onebot' && session.platform !== 'qq')) return;
      const route = await this.prepare(session);
      if (route?.suppress && this.config.suppressCommands !== false) return '';
    });
  }

  /**
   * OneBot 机器人级发送拦截：koishi/cordis 在事件分发、中间件链、命令执行各层
   * 都会产生影子会话对象，会话级 send 包装无法覆盖所有层；所有会话发送最终都会
   * 经过 bot.sendMessage，且 koishi 的 session.send 会把 session 挂在 options
   * 上，因此在这里按路由做最终的发送通道裁决（克隆免疫）。插件重载时 stop()
   * 会还原原始方法，避免包装器叠加。
   */
  private installSendIntercept(bot: Bot) {
    if (!bot || bot.platform !== 'onebot' || interceptedBots.has(bot)) return;
    interceptedBots.add(bot);
    const native = bot.sendMessage.bind(bot);
    this.originalSends.set(bot, native);
    bot.sendMessage = (channelId, content, referrer?, options?) =>
      this.interceptSend(native, channelId, content, referrer, options);
  }

  private uninstallSendIntercept() {
    for (const [bot, native] of this.originalSends) {
      bot.sendMessage = native;
      interceptedBots.delete(bot);
    }
    this.originalSends.clear();
  }

  /** 被拦截发送的路由决策；失败总是回退到 OneBot 原生发送，不丢失消息 */
  private async interceptSend(
    native: Bot['sendMessage'],
    channelId: string,
    content: h.Fragment,
    referrer?: string,
    options?: SessionSendOptions
  ) {
    const opts = options as { session?: Session; bypassSendRouting?: boolean } | undefined;
    if (opts?.bypassSendRouting) return native(channelId, content, referrer, options);
    const link = this.linksByOnebot.get(String(channelId));
    if (!link) return native(channelId, content, referrer, options);
    const session = opts?.session;
    let route = session ? this.routeFor(session) : undefined;
    if (session && !route) route = await this.prepare(session);
    if (!route?.linked || route.sendPlatform !== 'qq' || !route.qqGroupOpenid) {
      return native(channelId, content, referrer, options);
    }
    try {
      return await this.sendViaOfficial(session, route, content, options);
    } catch (error) {
      this.logger.warn('通过 QQ 官方适配器发送失败，回退到 OneBot：', error);
      // 回退内容按 OneBot 渲染能力降级（此时内容按官方侧渲染）
      return native(channelId, degradeForOneBot(content), referrer, options);
    }
  }

  protected async start(): Promise<void> {
    if (this.config.enabled === false || this.started) return;
    this.started = true;
    for (const bot of this.ctx.bots) this.installSendIntercept(bot);
    this.ctx.on('bot-added', (bot) => this.installSendIntercept(bot));
    this.ctx.on('ready', () => void this.refresh());
    this.ctx.on('guild-added', () => void this.refresh());
    this.ctx.on('guild-removed', () => void this.refresh());
    this.ctx.on('guild-member-added', () => void this.refresh());
    this.ctx.on('guild-member-removed', () => void this.refresh());
    this.ctx.on('guild-updated', () => void this.refresh());
    this.ctx.on('bot-added', () => void this.refresh());
    this.ctx.on('bot-removed', () => void this.refresh());
    this.ctx.on('bot-status-updated', () => void this.refresh());
    try {
      await this.loadLinks();
      await this.refresh();
    } catch (error) {
      this.logger.warn('初始化多适配器群组信息失败：', error);
    }
  }

  protected async stop(): Promise<void> {
    this.started = false;
    this.uninstallSendIntercept();
  }

  /**
   * 注册额外的跨适配器内容匹配键提取器。默认只按规范化文本匹配官方侧与
   * OneBot 侧收到的同一条消息；无文本内容的消息（如位置卡片）由使用方
   * 提供自己的键提取逻辑。
   */
  registerMatchKey(extract: (session: Session) => string | undefined): () => void {
    this.matchKeyExtractors.push(extract);
    return () => {
      const index = this.matchKeyExtractors.indexOf(extract);
      if (index >= 0) this.matchKeyExtractors.splice(index, 1);
    };
  }

  private collectMatchKeys(session: Session): string[] {
    const keys = [normalizeMessageContent(session.content ?? '')];
    for (const extract of this.matchKeyExtractors) {
      const key = extract(session);
      if (key) keys.push(key);
    }
    return keys;
  }

  private routeFor(session: Session) {
    return this.routes.get(session) ?? this.routesById.get(session.id);
  }

  getRoute(session: Session) {
    return this.routeFor(session);
  }

  getChannelId(session: Session) {
    return this.routeFor(session)?.canonicalChannelId ?? session.channelId;
  }

  getSendPlatform(session: Session) {
    return this.routeFor(session)?.sendPlatform ?? session.platform;
  }

  canForward(session: Session) {
    return this.getSendPlatform(session) === 'onebot';
  }

  shouldSuppress(session: Session) {
    return this.routeFor(session)?.suppress === true;
  }

  async prepare(session: Session): Promise<CoordinatorRoute | undefined> {
    const cached = this.routeFor(session);
    if (cached) return cached;
    if (this.config.enabled === false || session.isDirect) return;
    if (session.type !== 'message' && session.type !== 'message-created') return;
    if (session.platform !== 'onebot' && session.platform !== 'qq') return;

    let route: CoordinatorRoute | undefined;
    try {
      await this.loadLinks();
      route =
        session.platform === 'qq'
          ? await this.resolveQQ(session)
          : await this.resolveOnebot(session);
    } catch (error) {
      this.logger.warn('解析多适配器群组失败：', error);
      return;
    }

    if (!route) return;
    this.routes.set(session, route);
    this.routesById.set(session.id, route);
    if (this.routesById.size > 2000) {
      const oldest = this.routesById.keys().next().value;
      if (oldest !== undefined) this.routesById.delete(oldest);
    }
    return route;
  }

  private async resolveQQ(session: Session): Promise<CoordinatorRoute | undefined> {
    const openid = session.channelId;
    if (!openid) return;
    const qqBot = session.bot as unknown as QQBotLike;
    const snapshot = await this.getQQGroupInfo(qqBot, openid);
    const qqInfo = snapshot?.info;
    const observation = this.rememberOfficial(session, openid);
    if (qqInfo) {
      this.unlinkedOfficial.set(openid, {
        at: Date.now(),
        info: qqInfo,
        qqSelfId: qqBot.selfId
      });
    }

    let link = this.linksByOpenid.get(openid);
    if (!link && qqInfo) {
      const candidate = await this.findOnebotCandidate(qqInfo, qqBot);
      if (candidate) {
        link = await this.createLink(qqBot.selfId, openid, candidate, 'metadata');
      }
    }

    const onebotPresent = link ? await this.isOnebotPresent(link) : false;
    // 提及感知：官方机器人被 @ 时（atSelf），由官方侧会话亲自执行与应答；
    // 否则让位给 OneBot 侧会话（去重到官方声音发送）。
    const mentioned = session.stripped.atSelf;
    const route: CoordinatorRoute = {
      receivePlatform: onebotPresent ? 'onebot' : 'qq',
      sendPlatform: 'qq',
      canonicalChannelId: link?.onebotGroupId ?? openid,
      suppress: onebotPresent && !!link && !mentioned,
      linked: !!link,
      onebotGroupId: link?.onebotGroupId,
      qqGroupOpenid: openid,
      qqSelfId: qqBot.selfId,
      officialSession: session,
      officialQuoteId: observation.msgIdx
    };
    return route;
  }

  private async resolveOnebot(session: Session): Promise<CoordinatorRoute | undefined> {
    const groupId = session.channelId;
    if (!groupId) return;
    let link = this.linksByOnebot.get(groupId);

    if (!link) {
      const ref = await this.getOneBotGroupById(groupId);
      if (ref) {
        const candidate = await this.findOfficialCandidate(ref);
        if (candidate) {
          link = await this.createLink(candidate.bot.selfId, candidate.openid, ref, 'metadata');
        }
      }
    }

    const snapshot = link
      ? await this.getQQGroupInfo(this.getQQBot(link.qqSelfId), link.qqGroupOpenid)
      : undefined;
    const passive = link ? this.findPassive(link.qqGroupOpenid, session) : undefined;
    // If the Official bot is known to be in the group, prefer its sender and
    // let the send failure path decide whether a OneBot fallback is needed.
    // This avoids emitting an unnecessary OneBot message merely because the
    // cached bot-state response does not advertise proactive permission.
    const canUseOfficial = !!link && !!snapshot?.info;
    // 提及感知（双 bots 同时在场时的应答矩阵，官方侧优先）：
    //   - 官方机器人被 @：让位给官方侧会话，由其亲自执行与回复
    //     （即使同一条消息也 @ 了 OneBot 机器人，仍由官方侧应答，避免双重回复）；
    //   - 仅 OneBot 机器人被 @：亲自以 OneBot 名义应答（不经官方转发）；
    //   - 无提及的普通消息：按原设计去重到官方声音发送。
    // 昵称调用（无真实 @ 元素）按普通消息处理。
    const mentionedSelf = session.stripped.atSelf;
    const officialMentioned = await this.isOfficialMentioned(session);
    let sendPlatform: 'qq' | 'onebot';
    let suppress = false;
    if (officialMentioned) {
      suppress = true;
      sendPlatform = 'qq';
    } else if (mentionedSelf) {
      sendPlatform = 'onebot';
    } else {
      sendPlatform = canUseOfficial ? 'qq' : 'onebot';
    }
    const route: CoordinatorRoute = {
      receivePlatform: 'onebot',
      sendPlatform,
      canonicalChannelId: link?.onebotGroupId ?? groupId,
      suppress,
      linked: !!link,
      onebotGroupId: link?.onebotGroupId ?? groupId,
      qqGroupOpenid: link?.qqGroupOpenid,
      qqSelfId: link?.qqSelfId,
      officialSession: passive?.session,
      officialQuoteId: passive?.msgIdx
    };
    return route;
  }

  /** 检查 OneBot 侧收到的消息是否 @ 了官方机器人（用于让位给官方侧会话） */
  private async isOfficialMentioned(session: Session): Promise<boolean> {
    const qqBot = this.getQQBot(this.config.qqSelfId);
    if (!qqBot) return false;
    const identity = await this.getOfficialIdentity(qqBot);
    if (!identity.uin) return false;
    return (
      session.elements?.some(
        (element) => element.type === 'at' && String(element.attrs?.id) === identity.uin
      ) ?? false
    );
  }

  async send(session: Session, content: h.Fragment, options?: Parameters<Session['send']>[1]) {
    const route = await this.prepare(session);
    if (route?.sendPlatform !== 'qq' || !route.qqGroupOpenid) {
      return session.send(content, bypassSendOptions(options));
    }
    try {
      return await this.sendViaOfficial(session, route, content, options);
    } catch (error) {
      this.logger.warn('通过 QQ 官方适配器发送失败，回退到 OneBot：', error);
      // 回退到 OneBot 时同样去掉引用元素，避免同一错误再次出现
      const fallback =
        session.platform === 'onebot' ? degradeForOneBot(content) : stripQuote(content);
      return session.send(fallback, bypassSendOptions(options));
    }
  }

  /**
   * 通过官方适配器发送（自动等待被动回复上下文；可重试错误短延重试）。
   * 失败时抛出最后一次错误，由调用方决定回退方式。
   */
  private async sendViaOfficial(
    session: Session | undefined,
    route: CoordinatorRoute,
    content: h.Fragment,
    options?: SessionSendOptions
  ): Promise<string[]> {
    if (!route.qqGroupOpenid) throw new Error('缺少官方群 group_openid');
    if (!route.officialSession && session) {
      await this.waitForOfficialMatch(route.qqGroupOpenid, session, route);
    }
    const qqBot = this.getQQBot(route.qqSelfId);
    if (!qqBot) throw new Error('QQ 官方机器人不可用');
    let lastError: unknown;
    for (let attempt = 0; attempt <= OFFICIAL_SEND_RETRY_DELAYS.length; attempt++) {
      try {
        return await qqBot.sendMessage(
          route.qqGroupOpenid,
          content,
          null,
          route.officialSession ? { ...options, session: route.officialSession } : options
        );
      } catch (error) {
        lastError = error;
        if (attempt >= OFFICIAL_SEND_RETRY_DELAYS.length || !isRetryableOfficialError(error)) {
          break;
        }
        this.logger.warn(
          `QQ 官方发送出现临时错误，将在 ${OFFICIAL_SEND_RETRY_DELAYS[attempt]}ms 后重试：`,
          error
        );
        await wait(OFFICIAL_SEND_RETRY_DELAYS[attempt]);
      }
    }
    throw lastError ?? new Error('QQ 官方发送失败');
  }

  private async loadLinks() {
    if (this.linksLoaded) return;
    if (!this.linksPromise) {
      this.linksPromise = (async () => {
        const links = (await this.ctx.database.get('groupLinks', {})) as GroupLink[];
        for (const link of links) this.cacheLink(link);
        this.linksLoaded = true;
      })().finally(() => {
        this.linksPromise = undefined;
      });
    }
    return this.linksPromise;
  }

  private cacheLink(link: GroupLink) {
    this.linksByOpenid.set(link.qqGroupOpenid, link);
    this.linksByOnebot.set(link.onebotGroupId, link);
  }

  private async createLink(
    qqSelfId: string,
    openid: string,
    ref: OneBotGroupRef,
    source: GroupLink['source']
  ) {
    const key = `${qqSelfId}:${openid}:${ref.bot.selfId}:${ref.id}`;
    const pending = this.pendingLinks.get(key);
    if (pending) return pending;

    const operation = this.persistLink(qqSelfId, openid, ref, source);
    this.pendingLinks.set(key, operation);
    try {
      return await operation;
    } finally {
      this.pendingLinks.delete(key);
    }
  }

  private async persistLink(
    qqSelfId: string,
    openid: string,
    ref: OneBotGroupRef,
    source: GroupLink['source']
  ) {
    await this.loadLinks();
    const existing = this.linksByOpenid.get(openid) ?? this.linksByOnebot.get(ref.id);
    const now = new Date().toISOString();
    if (existing) {
      const updates: Partial<GroupLink> = {
        qqSelfId,
        qqGroupOpenid: openid,
        onebotSelfId: ref.bot.selfId,
        onebotGroupId: ref.id,
        updatedAt: now
      };
      if (existing.source !== 'manual') updates.source = source;
      if (existing.qqGroupOpenid !== openid) {
        this.linksByOpenid.delete(existing.qqGroupOpenid);
      }
      if (existing.onebotGroupId !== ref.id) {
        this.linksByOnebot.delete(existing.onebotGroupId);
      }
      await this.ctx.database.set('groupLinks', { _id: existing._id }, updates);
      Object.assign(existing, updates);
      this.cacheLink(existing);
      return existing;
    }

    const link = (await this.ctx.database.create('groupLinks', {
      qqSelfId,
      qqGroupOpenid: openid,
      onebotSelfId: ref.bot.selfId,
      onebotGroupId: ref.id,
      source,
      createdAt: now,
      updatedAt: now
    })) as GroupLink;
    this.cacheLink(link);
    this.logger.info(
      `已关联 OneBot 群 ${link.onebotGroupId}` +
        ` 与 QQ 官方群 ${link.qqGroupOpenid}，来源：${link.source}`
    );
    return link;
  }

  private refreshPromise?: Promise<void>;

  /** 刷新群组关联与缓存；多个触发事件并发时合并为一次执行 */
  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        this.onebotGroupsAt = 0;
        this.memberCache.clear();
        this.qqGroupCache.clear();
        await this.loadLinks();
        await this.refreshOnebotGroups();
        await this.loadKnownOfficialGroups();
        for (const ref of this.onebotGroups) {
          const candidate = await this.findOfficialCandidate(ref);
          if (!candidate) continue;
          await this.createLink(candidate.bot.selfId, candidate.openid, ref, 'metadata');
        }
        for (const manual of this.config.links ?? []) {
          if (!manual.onebotGroupId || !manual.qqGroupOpenid) continue;
          const ref = await this.getOneBotGroupById(manual.onebotGroupId);
          const qqBot = this.getQQBot(manual.qqSelfId);
          if (!ref || !qqBot) continue;
          const snapshot = await this.getQQGroupInfo(qqBot, manual.qqGroupOpenid, true);
          if (!snapshot?.info) continue;
          await this.createLink(qqBot.selfId, manual.qqGroupOpenid, ref, 'manual');
        }
      } catch (error) {
        this.logger.warn('刷新多适配器群组信息失败：', error);
      }
    })().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  /**
   * Koishi stores channel IDs after an adapter has observed a group. This is
   * not a QQ group-list API, but it lets a restart recover previously known
   * group_openids without waiting for another message.
   */
  private async loadKnownOfficialGroups() {
    for (const bot of this.getQQBots()) {
      try {
        const channels = (await this.ctx.database.get('channel', {
          platform: 'qq',
          assignee: bot.selfId
        })) as Array<{ id: string }>;
        for (const channel of channels) {
          const snapshot = await this.getQQGroupInfo(bot, channel.id);
          if (!snapshot?.info) continue;
          this.unlinkedOfficial.set(channel.id, {
            at: Date.now(),
            info: snapshot.info,
            qqSelfId: bot.selfId
          });
        }
      } catch (error) {
        this.logger.warn(`读取已知 QQ 官方群失败（${bot.selfId}）：`, error);
      }
    }
  }

  private getQQBots() {
    return this.ctx.bots.filter(
      (bot) => bot.platform === 'qq' && !bot.hidden && bot.status === 1
    ) as unknown as QQBotLike[];
  }

  private getOneBotBots(): AdapterBot[] {
    return this.ctx.bots.filter(
      (bot) =>
        bot.platform === 'onebot' &&
        !bot.hidden &&
        bot.status === 1 &&
        (!this.config.onebotSelfId || bot.selfId === this.config.onebotSelfId)
    ) as unknown as AdapterBot[];
  }

  private getQQBot(preferredSelfId?: string) {
    const bots = this.getQQBots();
    if (preferredSelfId) {
      const preferred = bots.find((bot) => bot.selfId === preferredSelfId);
      if (preferred) return preferred;
    }
    if (this.config.qqSelfId) {
      const configured = bots.find((bot) => bot.selfId === this.config.qqSelfId);
      if (configured) return configured;
    }
    return bots[0];
  }

  private async getOfficialIdentity(qqBot: QQBotLike): Promise<OfficialIdentity> {
    if (this.config.officialRobotUin) {
      return { at: 0, uin: this.config.officialRobotUin, name: qqBot.user?.name };
    }
    const cached = this.officialIdentity.get(qqBot.selfId);
    if (cached) {
      // 成功结果（有 uin）永久缓存；失败（无 uin）结果按 NEGATIVE_TTL 过期重试
      if (cached.uin || Date.now() - cached.at < NEGATIVE_TTL) return cached;
      this.officialIdentity.delete(qqBot.selfId);
    }
    try {
      const me = await qqBot.guildBot?.internal.getMe();
      const match = me?.share_url?.match(/[?&]robot_uin=(\d+)/);
      const identity = { at: Date.now(), uin: match?.[1], name: me?.username ?? qqBot.user?.name };
      this.officialIdentity.set(qqBot.selfId, identity);
      return identity;
    } catch (error) {
      this.logger.warn('获取官方机器人 UIN 失败：', error);
      const identity = { at: Date.now(), name: qqBot.user?.name };
      this.officialIdentity.set(qqBot.selfId, identity);
      return identity;
    }
  }

  private async refreshOnebotGroups() {
    if (this.onebotGroupsPromise) return this.onebotGroupsPromise;
    this.onebotGroupsPromise = (async () => {
      const groups: OneBotGroupRef[] = [];
      for (const bot of this.getOneBotBots()) {
        try {
          const list = await (bot.internal as OneBotInternal).getGroupList();
          for (const group of list ?? []) {
            groups.push({
              bot,
              id: String(group.group_id),
              name: group.group_name,
              memberCount: Number(group.member_count ?? 0)
            });
          }
        } catch (error) {
          this.logger.warn(`获取 OneBot 群列表失败（${bot.selfId}）：`, error);
        }
      }
      this.onebotGroups = groups;
      this.onebotGroupsAt = Date.now();
    })().finally(() => {
      this.onebotGroupsPromise = undefined;
    });
    return this.onebotGroupsPromise;
  }

  private async ensureOnebotGroups() {
    if (!this.onebotGroupsAt) {
      await this.refreshOnebotGroups();
    }
  }

  private async getOneBotGroupById(groupId: string) {
    await this.ensureOnebotGroups();
    let ref = this.onebotGroups.find((item) => item.id === groupId);
    if (!ref) {
      await this.refreshOnebotGroups();
      ref = this.onebotGroups.find((item) => item.id === groupId);
    }
    return ref;
  }

  private async getGroupMembers(ref: OneBotGroupRef) {
    const key = `${ref.bot.selfId}:${ref.id}`;
    const cached = this.memberCache.get(key);
    if (cached && Date.now() - cached.at < MEMBER_TTL) return cached.members;
    try {
      const list = await (ref.bot.internal as OneBotInternal).getGroupMemberList(ref.id);
      const members = new Set((list ?? []).map((member) => String(member.user_id)));
      this.memberCache.set(key, { at: Date.now(), members });
      return members;
    } catch (error) {
      this.logger.warn(`获取 OneBot 群成员失败（${ref.id}）：`, error);
      return;
    }
  }

  private async isOfficialInGroup(
    ref: OneBotGroupRef,
    qqBot = this.getQQBot(this.config.qqSelfId)
  ) {
    if (!qqBot) return false;
    const identity = await this.getOfficialIdentity(qqBot);
    if (!identity.uin) return false;
    const members = await this.getGroupMembers(ref);
    return members?.has(identity.uin) === true;
  }

  private async findOnebotCandidate(info: QQGroupInfo, qqBot: QQBotLike) {
    await this.ensureOnebotGroups();
    const name = normalizeGroupName(info.group_name);
    const candidates = new Map<string, OneBotGroupRef>();
    for (const ref of this.onebotGroups) {
      if (normalizeGroupName(ref.name) !== name) continue;
      if (ref.memberCount !== info.group_member_num) continue;
      if (!(await this.isOfficialInGroup(ref, qqBot))) continue;
      candidates.set(ref.id, ref);
    }
    if (candidates.size !== 1) return;
    return candidates.values().next().value as OneBotGroupRef;
  }

  private async findOfficialCandidate(ref: OneBotGroupRef) {
    const matches: Array<{ openid: string; info: QQGroupInfo; bot: QQBotLike }> = [];
    for (const [openid, item] of this.unlinkedOfficial) {
      if (Date.now() - item.at > UNLINKED_TTL) {
        this.unlinkedOfficial.delete(openid);
        continue;
      }
      if (normalizeGroupName(item.info.group_name) !== normalizeGroupName(ref.name)) continue;
      if (item.info.group_member_num !== ref.memberCount) continue;
      const bot = this.getQQBot(item.qqSelfId);
      if (!bot) continue;
      if (!(await this.isOfficialInGroup(ref, bot))) continue;
      matches.push({ openid, info: item.info, bot });
    }
    if (matches.length !== 1) return;
    return matches[0];
  }

  private async getQQGroupInfo(
    qqBot: QQBotLike | undefined,
    openid: string,
    force = false
  ): Promise<QQGroupSnapshot | undefined> {
    if (!qqBot) return;
    const key = `${qqBot.selfId}:${openid}`;
    const cached = this.qqGroupCache.get(key);
    if (
      !force &&
      cached &&
      Date.now() - cached.at < (cached.info ? GROUP_INFO_TTL : NEGATIVE_TTL)
    ) {
      return cached;
    }
    const [infoResult, stateResult] = await Promise.allSettled([
      (qqBot.internal as QQGroupInternal).getGuildInfo(openid),
      (qqBot.internal as QQGroupInternal).getGuildBotState(openid)
    ]);
    const info = infoResult.status === 'fulfilled' ? infoResult.value : undefined;
    const state = stateResult.status === 'fulfilled' ? stateResult.value : undefined;
    const snapshot = { at: Date.now(), info, state };
    this.qqGroupCache.set(key, snapshot);
    if (!info || !state) {
      const error =
        infoResult.status === 'rejected'
          ? infoResult.reason
          : stateResult.status === 'rejected'
            ? stateResult.reason
            : undefined;
      this.logger.warn(`获取 QQ 官方群状态不完整（${openid}）：`, error);
    }
    return snapshot;
  }

  private async isOnebotPresent(link: GroupLink) {
    const ref = await this.getOneBotGroupById(link.onebotGroupId);
    return !!ref && ref.bot.status === 1;
  }

  private rememberOfficial(session: Session, openid: string): OfficialObservation {
    const observation: OfficialObservation = {
      session,
      keys: this.collectMatchKeys(session),
      timestamp: session.timestamp ?? Date.now(),
      msgIdx: extractOfficialQuoteId(session)
    };
    const list = this.recentOfficial.get(openid) ?? [];
    list.push(observation);
    const cutoff = Date.now() - PASSIVE_WINDOW;
    this.recentOfficial.set(
      openid,
      list.filter((item) => item.timestamp >= cutoff).slice(-MAX_RECENT_OFFICIAL)
    );
    return observation;
  }

  private findPassive(openid: string, session: Session): OfficialObservation | undefined {
    const list = this.recentOfficial.get(openid);
    if (!list?.length) return;
    const timestamp = session.timestamp ?? Date.now();
    const keys = this.collectMatchKeys(session).filter((key) => key);
    for (const item of list) {
      if (Date.now() - item.timestamp > PASSIVE_WINDOW) continue;
      if (Math.abs(item.timestamp - timestamp) > PASSIVE_MATCH_WINDOW) continue;
      if (item.keys.some((key) => key && keys.includes(key))) return item;
    }
    return;
  }

  /**
   * 发送前重新匹配官方侧收到的同一消息。卡片消息的官方事件可能比 OneBot
   * 事件晚到，prepare 阶段匹配不到；发送前再试一次能显著提高命中率。
   */
  private refreshOfficialMatch(session: Session, route: CoordinatorRoute) {
    if (route.receivePlatform !== 'onebot' || !route.qqGroupOpenid) return;
    const passive = this.findPassive(route.qqGroupOpenid, session);
    if (passive) {
      route.officialSession = passive.session;
      route.officialQuoteId = passive.msgIdx;
    }
  }

  /**
   * 官方侧同源消息的观察通常比 OneBot 侧晚约 300ms 到达（两条适配器链路时延
   * 不同），而快速路径（命令回复）在官方侧会话被记录之前就要发送；缺少官方
   * 侧会话时，QQ 官方接口会因缺少被动回复上下文而拒绝。这里短暂轮询等待官方
   * 侧观察就绪，超时后交由调用方走各自的回退路径。
   */
  private async waitForOfficialMatch(
    openid: string,
    session: Session,
    route: CoordinatorRoute,
    timeoutMs = 1500,
    intervalMs = 120
  ): Promise<void> {
    if (route.officialSession) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await wait(intervalMs);
      const passive = this.findPassive(openid, session);
      if (passive) {
        route.officialSession = passive.session;
        route.officialQuoteId = passive.msgIdx;
        return;
      }
    }
  }

  /**
   * 获取官方侧引用回复所需的 msg_idx。官方机器人收到消息（无论经由本
   * session 还是经协调器匹配到的同一消息）时才有值；匹配不到时返回
   * undefined，调用方应退化为不引用发送。
   */
  getOfficialQuoteId(session: Session): string | undefined {
    const route = this.routeFor(session);
    if (!route) return;
    this.refreshOfficialMatch(session, route);
    return route.officialQuoteId;
  }
}
